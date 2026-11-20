import { C } from '../db';
import { moveStock } from './orders';
import type { Firestore, Transaction } from '../lib/firestore';
import { increment } from '../lib/firestore';
import { formatKobo } from '../lib/money';
import { lagosDate } from '../lib/time';
import type { Business } from '../domain/business';
import type { Customer, Order, Product } from '../domain/commerce';
import { hasStock, tracksStock } from '../domain/commerce';
import { claimId } from './orders';
import { renderMessage } from './shop-messages';
import { receiptFilename, receiptPath } from './receipt';
import { randomId } from '../lib/crypto';
import { adminConversationId, customerConversationId } from './conversations';

// Template names live in config (they're created in Meta), resolved when the message is sent.
export type TemplateKey = 'daily_summary' | 'broadcast' | 'receipt';

export interface OutboxMessage {
  id: string; businessId: string; audience: 'customer' | 'owner'; channel: 'whatsapp' | 'instagram';
  to: string; conversationId: string; kind: string; text: string;
  status: 'pending' | 'sending' | 'sent' | 'blocked_window' | 'failed'; attempts: number;
  createdAt: string; leaseUntil?: string | null; sentAt?: string | null; providerMessageId?: string | null;
  // Sent instead of the text when the 24-hour window is closed. Body parameters fill the template's
  // {{1}}, {{2}}, … in order. Messages without one are not sent outside the window.
  template?: { key: TemplateKey; params: string[] } | null;
  // Reply buttons under the text (a document, if any, goes on top as the header).
  buttons?: { id: string; title: string }[] | null; // Firestore keeps no arrays inside arrays
  // Smart Reach's paid route: this approved marketing template is the message (not a fallback).
  paidTemplate?: { name: string; params: string[]; headerImage?: string | null } | null;
  // A full message (buttons, a list, an image) instead of plain text; text stays as a summary.
  content?: import('./channel').OutboundContent | null;
  // Sent as a document with the text as its caption (e.g. the PDF receipt). path is under API_BASE_URL.
  document?: { path: string; filename: string } | null;
}

import { explicitOptIn, triggerOn, type ReachCustomer } from './reach';

export type PaidResult = { applied: false; reason: 'not_found' | 'already_paid' | 'cancelled' } | { applied: true; order: Order; late: boolean; outboxIds: string[] };

// The on-paid pipeline, inside the caller's transaction. Every side effect lands in the same commit
// and only when the order isn't already paid, so it runs exactly once however often it is called:
// order → paid, the amount claim is freed, customer stats, a ledger entry, the day's stats, and two
// queued messages (customer receipt, owner alert).
//
// A payment that arrives after the hold expired still marks the order paid. If the stock is still
// there it is taken again; otherwise the order is flagged for the owner.
export async function applyPaid(tx: Transaction, db: Firestore, orderId: string, payment: { paymentId: string; paidAt: string }): Promise<PaidResult> {
  const order = (await tx.get(db.doc(C.orders, orderId))) as Order | null;
  if (!order) return { applied: false, reason: 'not_found' };
  if (order.status === 'paid') return { applied: false, reason: 'already_paid' };
  if (order.status === 'cancelled') return { applied: false, reason: 'cancelled' };
  const [business, customer] = (await tx.getAll([db.doc(C.businesses, order.businessId), db.doc(C.customers, order.customerId)])) as [Business | null, Customer | null];

  const late = order.status === 'expired';
  let needsAttention: string | null = null;
  const at = payment.paidAt;
  if (late) {
    const ids = [...new Set(order.items.map(l => l.productId))];
    const docs = (await tx.getAll(ids.map(id => db.doc(C.products, id)))) as (Product | null)[];
    const products = new Map(ids.map((id, i) => [id, docs[i]]));
    // Enough of each line (sizes of one product added up).
    const want = new Map<string, number>();
    for (const l of order.items) want.set(`${l.productId}#${l.variantId ?? ''}`, (want.get(`${l.productId}#${l.variantId ?? ''}`) ?? 0) + l.qty);
    const allThere = [...want].every(([k, q]) => { const [pid, vid] = k.split('#'); const p = products.get(pid); return !!p && hasStock(p, q, vid || null); });
    if (allThere) moveStock(tx, db, products, order.items, -1, { businessId: order.businessId, orderId: order.id, reason: 'sale', suffix: 'late', actor: 'system', at });
    else needsAttention = 'paid_after_expiry_out_of_stock';
  }

  // The receipt PDF's private link (/receipts/<token>), made on request from the order.
  const receiptToken = randomId(18).replace(/[^A-Za-z0-9]/g, 'x');
  const receipt = { path: receiptPath(receiptToken), filename: receiptFilename(order) };
  tx.update(db.doc(C.orders, order.id), { status: 'paid', paidAt: at, paymentId: payment.paymentId, needsAttention, receiptToken, updatedAt: at });
  tx.delete(db.doc(C.amountClaims, claimId(order.businessId, order.payAmountKobo)));

  const spent = order.subtotalKobo + order.deliveryFeeKobo;
  tx.set(db.doc(C.customers, order.customerId), { businessId: order.businessId, orderCount: increment(1), totalSpentKobo: increment(spent), lastOrderAt: at, updatedAt: at }, { merge: true });

  // Smart Reach: what they bought (ids only).
  for (const l of order.items) {
    const sid = `${order.customerId}_bought_${l.productId}_${order.id}`.replace(/[^A-Za-z0-9_-]/g, '_');
    tx.set(db.doc(C.customerSignals, sid), { id: sid, businessId: order.businessId, customerId: order.customerId, type: 'bought', productId: l.productId, categoryId: null, variant: l.variantId ?? null, at });
  }

  tx.create(db.doc(C.ledger, order.id), {
    id: order.id, businessId: order.businessId, orderId: order.id, type: 'sale', at,
    grossKobo: order.payAmountKobo, goodsKobo: order.subtotalKobo, deliveryKobo: order.deliveryFeeKobo,
    relayFeeKobo: order.feeKobo, merchantNetKobo: order.payAmountKobo - order.feeKobo,
  });

  // The shop's wallet: available as soon as it's paid.
  const net = order.payAmountKobo - order.feeKobo;
  tx.set(db.doc(C.wallets, order.businessId), { businessId: order.businessId, availableKobo: increment(net), lifetimeInKobo: increment(net), updatedAt: at }, { merge: true });

  const date = lagosDate(new Date(at));
  tx.set(db.doc(C.dailyStats, `${order.businessId}_${date}`), {
    businessId: order.businessId, date, ordersPaid: increment(1), salesKobo: increment(order.subtotalKobo),
    deliveryKobo: increment(order.deliveryFeeKobo), relayFeeKobo: increment(order.feeKobo), updatedAt: at,
  }, { merge: true });

  const outboxIds: string[] = [];
  const queue = (m: Omit<OutboxMessage, 'status' | 'attempts' | 'createdAt' | 'businessId'>) => {
    tx.create(db.doc(C.outbox, m.id), { ...m, businessId: order.businessId, status: 'pending', attempts: 0, createdAt: at });
    outboxIds.push(m.id);
  };
  if (customer?.phone) queue({
    id: `${order.id}_receipt`, audience: 'customer', channel: order.channel, to: customer.phone,
    conversationId: customerConversationId(order.businessId, order.channel, customer.phone), kind: 'order_paid_receipt',
    // Template body (Y11): {{1}} order number, {{2}} amount paid.
    template: { key: 'receipt', params: [order.ref, formatKobo(order.payAmountKobo)] },
    document: receipt,
    // The shop's own thank-you (MESSAGES); inside the 24-hour window, else the receipt template.
    text: business ? renderMessage(business, 'paymentThanks', { customer: customer.name, order: order.ref, amount: formatKobo(order.payAmountKobo) }) : `Payment received for order ${order.ref}: ${formatKobo(order.payAmountKobo)}. Thank you!`,
  });
  if (business?.ownerPhone) queue({
    id: `${order.id}_owner_paid`, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone,
    conversationId: adminConversationId(business.ownerPhone), kind: 'owner_order_paid', document: receipt,
    text: `Paid: order ${order.ref}, ${formatKobo(order.payAmountKobo)} (${order.items.map(l => `${l.qty}× ${l.name}`).join(', ')}).${order.feeKobo ? `
Relay fee (1%${order.feePaidBy === 'owner' ? ', paid by you' : ', paid by the customer'}): ${formatKobo(order.feeKobo)}. You receive ${formatKobo(order.payAmountKobo - order.feeKobo)}.` : ''}${needsAttention ? ' ⚠️ It was paid after the hold expired and some items are out of stock. Please check with the customer.' : late ? ' It was paid after the hold expired; the stock was still available and is reserved again.' : ''}`,
    buttons: [{ id: `act:order:${order.ref}`, title: 'View order' }, { id: `act:ready:${order.ref}`, title: 'Mark ready' }, { id: 'act:menu', title: 'Menu' }],
  });

  // Smart Reach: a new customer's first order: thanks, and the "send me updates" ask (only when they
  // haven't said yes yet; the receipt already says thank you).
  if (business && customer?.phone && !(customer.orderCount ?? 0) && triggerOn(business, 'first_order_thanks') && !explicitOptIn(customer as ReachCustomer)) queue({
    id: `${order.id}_first_thanks`, audience: 'customer', channel: order.channel, to: customer.phone,
    conversationId: customerConversationId(order.businessId, order.channel, customer.phone), kind: 'first_order_thanks',
    text: `Thanks for your first order with ${business.name}! 🙏 Want news when new things arrive? (At most once a week.)`,
    buttons: [{ id: 'optin', title: 'Yes, send updates' }, { id: 'menu', title: 'See the menu' }],
  });

  if (business?.ownerPhone && !business.firstSaleAt) {
    tx.update(db.doc(C.businesses, business.id), { firstSaleAt: at });
    queue({
      id: `${business.id}_first_sale`, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone,
      conversationId: adminConversationId(business.ownerPhone), kind: 'first_sale',
      text: `🎉 You just made your first sale on Relay: ${formatKobo(order.payAmountKobo - order.feeKobo)}! Your money is safe in your Relay wallet.\n\nTo withdraw it, you'll verify your account once. Reply *VERIFY* to start.`,
    });
  }

  return { applied: true, order: { ...order, status: 'paid', paidAt: at, paymentId: payment.paymentId, needsAttention }, late, outboxIds };
}

// For "mark order paid" from the owner (cash, transfer seen in the bank app).
export function markOrderPaid(db: Firestore, orderId: string, businessId: string, paymentId: string, paidAt = new Date().toISOString()) {
  return db.runTransaction(async tx => {
    const order = (await tx.get(db.doc(C.orders, orderId))) as Order | null;
    if (!order || order.businessId !== businessId) return { applied: false, reason: 'not_found' } as PaidResult;
    return applyPaid(tx, db, orderId, { paymentId, paidAt });
  });
}
