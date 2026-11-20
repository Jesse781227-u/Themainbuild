import { C } from '../db';
import type { Config } from '../config';
import type { Firestore, Transaction } from '../lib/firestore';
import { increment } from '../lib/firestore';
import { formatKobo, orderFees, pct, type FeePolicy } from '../lib/money';
import { addMinutes } from '../lib/time';
import { orderRef, randomId } from '../lib/crypto';
import { freeOffer, redeemOffer } from './offers';
import type { Business } from '../domain/business';
import type { Cart, CartLine, Order, OrderDelivery, OrderLine, Product } from '../domain/commerce';
import { hasStock, lineName, priceOf, stockPatch, variantOf } from '../domain/commerce';

// feePayer: who pays the fees (Relay's and Bachs's together). 'owner' means customers pay the shop's
// prices and the fees come out of what the shop receives.
export interface OrderPolicy extends FeePolicy { holdMinutes: number; feePayer?: 'customer' | 'owner' }

// What the customer is charged on top of the goods for the fees (nothing when the owner pays them).
export const customerFee = (fee: number, policy: Pick<OrderPolicy, 'feePayer'>) => (policy.feePayer === 'owner' ? 0 : fee);

export function policyFor(business: Pick<Business, 'feeBps' | 'holdMinutes' | 'feePayer'> | null, cfg: Pick<Config, 'FEE_BPS' | 'FEE_CAP_KOBO' | 'PROCESSOR_FEE_BPS' | 'PROCESSOR_FEE_CAP_KOBO' | 'HOLD_MINUTES'>): OrderPolicy {
  return { bps: business?.feeBps ?? cfg.FEE_BPS, capKobo: cfg.FEE_CAP_KOBO, processorBps: cfg.PROCESSOR_FEE_BPS, processorCapKobo: cfg.PROCESSOR_FEE_CAP_KOBO, holdMinutes: business?.holdMinutes ?? cfg.HOLD_MINUTES, feePayer: business?.feePayer ?? 'customer' };
}

// The fee as owners see it: one rate and one maximum, e.g. "4.5% of each sale, at most ₦4,000".
// (Inside it: Relay's fee and Bachs's processing; owners never see the split.)
export const feeRate = (cfg: Pick<Config, 'FEE_BPS' | 'PROCESSOR_FEE_BPS'>) => pct(cfg.FEE_BPS + cfg.PROCESSOR_FEE_BPS);
export const feeTerms = (cfg: Pick<Config, 'FEE_BPS' | 'FEE_CAP_KOBO' | 'PROCESSOR_FEE_BPS' | 'PROCESSOR_FEE_CAP_KOBO'>) =>
  `${feeRate(cfg)} of each sale, at most ${formatKobo(cfg.FEE_CAP_KOBO + (cfg.PROCESSOR_FEE_BPS ? cfg.PROCESSOR_FEE_CAP_KOBO : 0))}`;

// After a hold expires its amount stays claimed for this long, so a late transfer for the old order
// can't be matched to a new order that happens to reuse the same amount.
export const LATE_PAYMENT_GRACE_MINUTES = 24 * 60;
const MAX_UNIQUE_OFFSET_KOBO = 999; // the offset is at most ₦9.99 on top
const CANDIDATES = 25;

// The same product and option on two cart lines counts as one line.
export const mergeCartLines = (items: CartLine[]) => {
  const lines = new Map<string, { productId: string; variantId: string | null; qty: number }>();
  for (const item of items) {
    const key = `${item.productId}#${item.variantId ?? ''}`;
    const prev = lines.get(key);
    lines.set(key, { productId: item.productId, variantId: item.variantId ?? null, qty: (prev?.qty ?? 0) + item.qty });
  }
  return [...lines.values()];
};

// Holds, releases or sells the stock for an order's lines, one update per product (several sizes
// of one product are one write). Each line gets its stock movement.
export function moveStock(tx: Transaction, db: Firestore, products: Map<string, Product | null>, lines: { productId: string; variantId?: string | null; qty: number }[], sign: 1 | -1, m: { businessId: string; orderId: string; reason: 'hold' | 'release' | 'sale'; suffix: string; actor: string; at: string }) {
  const byProduct = new Map<string, { variantId?: string | null; delta: number }[]>();
  for (const l of lines) byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), { variantId: l.variantId ?? null, delta: sign * l.qty }]);
  for (const [productId, changes] of byProduct) {
    const p = products.get(productId);
    if (!p) continue; // removed: nothing to move
    const patch = stockPatch(p, changes);
    if (!patch) continue; // no stock count: nothing to move
    tx.update(db.doc(C.products, productId), { ...patch, updatedAt: m.at });
    for (const c of changes) {
      const mid = `${m.orderId}_${productId}${c.variantId ? `_${c.variantId}` : ''}_${m.suffix}`;
      tx.create(db.doc(C.stockMovements, mid), { id: mid, businessId: m.businessId, productId, ...(c.variantId ? { variantId: c.variantId } : {}), delta: c.delta, reason: m.reason, orderId: m.orderId, actor: m.actor, at: m.at });
    }
  }
}

const productMap = async (tx: Transaction, db: Firestore, ids: string[]) => {
  const unique = [...new Set(ids)];
  const docs = (await tx.getAll(unique.map(id => db.doc(C.products, id)))) as (Product | null)[];
  return new Map(unique.map((id, i) => [id, docs[i]]));
};

export const claimId = (businessId: string, amountKobo: number) => `${businessId}_${amountKobo}`;

// Picks a pay amount no other open (or recently expired) order of this business is using. The first
// candidate is the exact total; the rest add a random offset of 1–999 kobo.
async function claimUniqueAmount(tx: Transaction, db: Firestore, businessId: string, baseKobo: number, now: Date) {
  const offsets = [0];
  while (offsets.length < CANDIDATES) {
    const o = 1 + Math.floor(Math.random() * MAX_UNIQUE_OFFSET_KOBO);
    if (!offsets.includes(o)) offsets.push(o);
  }
  const claims = await tx.getAll(offsets.map(o => db.doc(C.amountClaims, claimId(businessId, baseKobo + o))));
  const free = offsets.findIndex((_, i) => !claims[i] || String(claims[i]!.reusableAt) <= now.toISOString());
  if (free < 0) throw new Error('NO_UNIQUE_AMOUNT');
  return offsets[free];
}

// Turns a cart into an order. Inside one transaction it re-reads the cart (so it can be checked out
// only once), checks every product belongs to the cart's business and is in stock, reserves the stock
// by subtracting it, prices the order (goods + delivery + Relay's fee on goods only), and claims a
// unique pay amount. The stock comes back if the order isn't paid before holdExpiresAt.
export async function checkout(db: Firestore, args: { cartId: string; businessId: string; policy: OrderPolicy; delivery?: OrderDelivery | null; now?: Date; offerCode?: string | null }): Promise<Order> {
  const now = args.now ?? new Date();
  return db.runTransaction(async tx => {
    const cart = (await tx.get(db.doc(C.carts, args.cartId))) as Cart | null;
    if (!cart || cart.businessId !== args.businessId) throw new Error('CART_NOT_FOUND');
    if (!(cart.expiresAt > now.toISOString())) throw new Error('CART_EXPIRED');
    const lines = mergeCartLines(cart.items);
    if (!lines.length) throw new Error('CART_EMPTY');
    const products = await productMap(tx, db, lines.map(l => l.productId));

    const items: OrderLine[] = [];
    let subtotalKobo = 0;
    for (const l of lines) {
      const p = products.get(l.productId);
      if (!p || p.businessId !== cart.businessId || p.deletedAt || !p.available) throw new Error('PRODUCT_UNAVAILABLE');
      // A product with options needs one picked (and that option must still exist).
      if (p.variants?.length ? !variantOf(p, l.variantId) : l.variantId) throw new Error('PRODUCT_UNAVAILABLE');
      if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new Error('INVALID_QTY');
      if (!hasStock(p, l.qty, l.variantId)) throw new Error('INSUFFICIENT_STOCK');
      const price = priceOf(p, l.variantId);
      items.push({ productId: p.id, name: lineName(p, l.variantId), priceKobo: price, qty: l.qty, ...(l.variantId ? { variantId: l.variantId } : {}) });
      subtotalKobo += price * l.qty;
    }

    const delivery = args.delivery ?? null;
    const deliveryFeeKobo = delivery?.feeKobo ?? 0;
    // A personal offer code: checked (theirs, unused, not expired) and reserved by this order.
    const orderId = randomId(12);
    const offer = args.offerCode ? await redeemOffer(tx, db, args.offerCode, { businessId: cart.businessId, customerId: cart.customerId, orderId }, subtotalKobo, now) : null;
    const discountKobo = offer?.discountKobo ?? 0;
    const fees = orderFees(subtotalKobo - discountKobo, deliveryFeeKobo, args.policy, args.policy.feePayer !== 'owner');
    const fee = fees.total;
    const baseKobo = subtotalKobo - discountKobo + deliveryFeeKobo + customerFee(fee, args.policy);
    const uniqueKobo = await claimUniqueAmount(tx, db, cart.businessId, baseKobo, now);
    const payAmountKobo = baseKobo + uniqueKobo;

    const at = now.toISOString();
    const holdExpiresAt = addMinutes(now, args.policy.holdMinutes).toISOString();
    const order: Order = {
      id: orderId, ref: orderRef(), businessId: cart.businessId, customerId: cart.customerId, channel: cart.channel,
      items, subtotalKobo, deliveryFeeKobo, feeKobo: fee, relayFeeKobo: fees.relay, processorFeeKobo: fees.processor, feePaidBy: args.policy.feePayer ?? 'customer', uniqueKobo, payAmountKobo,
      ...(offer ? { discountKobo, offerCode: offer.offer.code } : {}),
      status: 'awaiting_payment', fulfilment: 'pending', delivery, holdExpiresAt,
      paidAt: null, paymentId: null, needsAttention: null, createdAt: at, updatedAt: at,
    };

    moveStock(tx, db, products, items, -1, { businessId: order.businessId, orderId: order.id, reason: 'hold', suffix: 'hold', actor: 'system', at });
    tx.create(db.doc(C.orders, order.id), { ...order });
    tx.set(db.doc(C.amountClaims, claimId(order.businessId, payAmountKobo)), {
      businessId: order.businessId, amountKobo: payAmountKobo, orderId: order.id, holdExpiresAt,
      reusableAt: addMinutes(new Date(holdExpiresAt), LATE_PAYMENT_GRACE_MINUTES).toISOString(),
    });
    tx.delete(db.doc(C.carts, cart.id));
    return order;
  });
}

// Returns an unpaid order's reserved stock once its hold has passed. Safe to call any number of
// times, concurrently: only the call that sees status "awaiting_payment" changes anything.
export async function releaseHold(db: Firestore, orderId: string, now = new Date()) {
  return db.runTransaction(async tx => {
    const order = (await tx.get(db.doc(C.orders, orderId))) as Order | null;
    if (!order || order.status !== 'awaiting_payment' || order.holdExpiresAt > now.toISOString()) return false;
    const products = await productMap(tx, db, order.items.map(l => l.productId));
    const at = now.toISOString();
    moveStock(tx, db, products, order.items, 1, { businessId: order.businessId, orderId: order.id, reason: 'release', suffix: 'release', actor: 'system', at });
    tx.update(db.doc(C.orders, order.id), { status: 'expired', updatedAt: at });
    freeOffer(tx, db, order);
    return true;
  });
}

export async function releaseExpiredHolds(db: Firestore, now = new Date(), limit = 100) {
  const due = await db.query(C.orders, [['status', '==', 'awaiting_payment'], ['holdExpiresAt', '<=', now.toISOString()]], { orderBy: [['holdExpiresAt', 'asc']], limit });
  let released = 0;
  for (const o of due) if (await releaseHold(db, o._id, now)) released++;
  return released;
}

// Owner cancels an order. An unpaid order gives its stock back; a paid order can't be cancelled
// here (the money has moved; the owner refunds and adjusts stock themselves).
export async function cancelOrder(db: Firestore, orderId: string, businessId: string, now = new Date()) {
  return db.runTransaction(async tx => {
    const order = (await tx.get(db.doc(C.orders, orderId))) as Order | null;
    if (!order || order.businessId !== businessId) return 'not_found' as const;
    if (order.status === 'paid') return 'paid' as const;
    if (order.status === 'cancelled') return 'already_cancelled' as const;
    const at = now.toISOString();
    if (order.status === 'awaiting_payment') {
      const products = await productMap(tx, db, order.items.map(l => l.productId));
      moveStock(tx, db, products, order.items, 1, { businessId, orderId: order.id, reason: 'release', suffix: 'release', actor: 'owner', at });
    }
    tx.update(db.doc(C.orders, order.id), { status: 'cancelled', updatedAt: at });
    if (order.status === 'awaiting_payment') freeOffer(tx, db, order);
    return 'cancelled' as const;
  });
}

export async function findOrderByRef(db: Firestore, businessId: string, ref: string) {
  const [o] = await db.query(C.orders, [['businessId', '==', businessId], ['ref', '==', ref.trim().toUpperCase()]], { limit: 1 });
  return (o as unknown as Order) ?? null;
}

export async function recentOrders(db: Firestore, filters: [string, '==', unknown][], limit = 50) {
  return (await db.query(C.orders, filters, { orderBy: [['createdAt', 'desc']], limit })) as unknown as Order[];
}
