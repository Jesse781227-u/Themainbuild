// TEST: the owner shops in their own shop from the Relay chat, exactly as a customer would
// (greeting, categories, carousels, cart, checkout), with replies from the Admin Bot.
// Nothing real happens: no orders, no stock holds, no owner alerts, no money. The "order" is kept in
// testReceipts so the PDF receipt can be shown. EXIT goes back to Relay. Available any time.
import { C } from '../db';
import { lineName, priceOf } from '../domain/commerce';
import type { Business } from '../domain/business';
import type { Cart, Order, OrderDelivery, OrderLine, Product } from '../domain/commerce';
import { randomId } from '../lib/crypto';
import { formatKobo, orderFees } from '../lib/money';
import type { OutboundContent } from '../services/channel';
import { customerFee, policyFor } from '../services/orders';
import { renderMessage } from '../services/shop-messages';
import { receiptFilename } from '../services/receipt';
import type { AdminContext, ShopContext } from '../services/router';
import { listProducts } from '../services/catalog';
import { buttons, type BotDeps } from './common';
import { handleShop } from './shop';

type Reply = (content: OutboundContent | string, next?: { step: 'browse' }) => Promise<void>;

export const testConversationId = (businessId: string, ownerPhone: string) => `test_${businessId}_${ownerPhone.replace(/\D/g, '')}`;
export const TEST_START = /^(test|test my shop|try my shop|test shop)$/i;
export const TEST_EXIT = /^(exit|exit test|end test|stop test|back to relay|quit)$/i;

export async function startTest(ctx: AdminContext, deps: BotDeps, business: Business | null, reply: (c: OutboundContent | string) => Promise<unknown>) {
  if (!business) return reply('Set up your shop first, then type TEST to try it.');
  if (!(await listProducts(ctx.db, business.id, { availableOnly: true })).length) return reply('Add a product first, then type TEST to see your shop as a customer.');
  const id = testConversationId(business.id, ctx.ownerPhone);
  // A fresh start each time: empty cart, no leftover choices.
  await ctx.db.delete(ctx.db.doc(C.carts, id));
  await ctx.db.set(ctx.db.doc(C.conversations, id), { shop: null }, { merge: true });
  await ctx.db.set(ctx.db.doc(C.conversations, ctx.conversationId), { testMode: { businessId: business.id, startedAt: new Date().toISOString() } }, { merge: true });
  await reply(`🧪 *Test mode.* You're now a customer of ${business.name}. Everything works like the real thing, but payments are pretend and no real orders are made.\n\nType *EXIT* any time to come back to Relay (every message here reminds you).`);
  return runTest(ctx, deps, business.id, { text: 'hi' });
}

export async function runTest(ctx: AdminContext, deps: BotDeps, businessId: string, override?: { text: string }) {
  const id = testConversationId(businessId, ctx.ownerPhone);
  const at = new Date().toISOString();
  await ctx.db.set(ctx.db.doc(C.conversations, id), { id, businessId, channel: 'whatsapp', customerId: id, lastInboundAt: at, test: true, updatedAt: at }, { merge: true });
  const event = override ? { ...ctx.event, text: override.text, message: { type: 'text', text: { body: override.text } } } : ctx.event;
  await handleShop({ db: ctx.db, cfg: ctx.cfg, event, businessId, conversationId: id, test: true }, deps);
}

export async function exitTest(ctx: AdminContext, readyToConnect: boolean, reply: (c: OutboundContent | string) => Promise<unknown>, opts: { quiet?: boolean } = {}) {
  await ctx.db.set(ctx.db.doc(C.conversations, ctx.conversationId), { testMode: null }, { merge: true });
  if (opts.quiet) return reply("You're back with Relay 👋");
  if (readyToConnect) return reply("You're back with Relay 👋 That's exactly what your customers will see."); // the Connect button follows (admin.ts)
  return reply("You're back with Relay 👋 Send HELP to see what I can do, or TEST to try your shop again.");
}

// Checkout in test mode: the same totals a customer would see, kept only for the receipt.
export async function testOrder(ctx: ShopContext, business: Business, cart: Cart, delivery: OrderDelivery | null, reply: Reply) {
  const products = (await ctx.db.getAll(cart.items.map(i => ctx.db.doc(C.products, i.productId)))) as (Product | null)[];
  const items: OrderLine[] = cart.items.map((i, n) => ({ i, p: products[n] })).filter(x => x.p && !x.p.deletedAt).map(({ i, p }) => ({ productId: p!.id, name: lineName(p!, i.variantId), priceKobo: priceOf(p!, i.variantId), qty: i.qty, ...(i.variantId ? { variantId: i.variantId } : {}) }));
  if (!items.length) return reply(buttons('Your cart is empty.', [['menu', 'See the menu']]), { step: 'browse' });
  const subtotalKobo = items.reduce((s, l) => s + l.priceKobo * l.qty, 0);
  const policy = policyFor(business, ctx.cfg);
  const deliveryFeeKobo = delivery?.feeKobo ?? 0;
  const fees = orderFees(subtotalKobo, deliveryFeeKobo, policy, policy.feePayer !== 'owner');
  const fee = fees.total;
  const payAmountKobo = subtotalKobo + deliveryFeeKobo + customerFee(fee, policy);
  const token = randomId(20).replace(/[^A-Za-z0-9]/g, 'x');
  const at = new Date().toISOString();
  const order: Order = {
    id: token, ref: `TEST-${randomId(6).toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(4, 'X').slice(0, 4)}`, businessId: business.id, customerId: ctx.conversationId, channel: 'whatsapp',
    items, subtotalKobo, deliveryFeeKobo, feeKobo: fee, relayFeeKobo: fees.relay, processorFeeKobo: fees.processor, feePaidBy: policy.feePayer ?? 'customer', uniqueKobo: 0, payAmountKobo,
    status: 'awaiting_payment', fulfilment: 'pending', delivery, holdExpiresAt: at, paidAt: null, paymentId: null, needsAttention: null, createdAt: at, updatedAt: at,
  };
  await ctx.db.create(ctx.db.doc(C.testReceipts, token), { token, businessId: business.id, order: { ...order }, createdAt: at });
  const confirmed = renderMessage(business, 'orderConfirmed', { order: order.ref, amount: formatKobo(payAmountKobo) });
  return reply(buttons(`${confirmed}\n\n🧪 Test order ${order.ref}: ${formatKobo(payAmountKobo)}.\n\nIn your real shop the customer gets a *Pay ${formatKobo(payAmountKobo)}* button here and pays by card or transfer. Tap *Pay now (test)* to see what happens next. No real money moves.`, [[`testpay:${token}`, 'Pay now (test)'], ['menu', 'Back to menu']]), { step: 'browse' });
}

export async function testPaid(ctx: ShopContext, business: Business, token: string, reply: Reply) {
  const ref = ctx.db.doc(C.testReceipts, token);
  const saved = (await ctx.db.get(ref)) as { businessId: string; order: Order } | null;
  if (!saved || saved.businessId !== business.id) return reply(buttons('That test order has gone. Add something to your cart and check out again.', [['menu', 'See the menu']]), { step: 'browse' });
  const at = new Date().toISOString();
  const order: Order = { ...saved.order, status: 'paid', paidAt: saved.order.paidAt ?? at, paymentId: `test_${token}`, updatedAt: at };
  await ctx.db.update(ref, { order: { ...order } });
  await ctx.db.delete(ctx.db.doc(C.carts, ctx.conversationId));
  const thanks = renderMessage(business, 'paymentThanks', { order: order.ref, amount: formatKobo(order.payAmountKobo) });
  await reply({ type: 'document', link: `${ctx.cfg.API_BASE_URL}/receipts/test/${token}`, filename: receiptFilename(order), caption: thanks });
  const fee = order.feeKobo ? `\nRelay's fee on this order: ${formatKobo(order.feeKobo)}, ${order.feePaidBy === 'owner' ? 'paid by you' : 'paid by the customer'}. You'd receive ${formatKobo(order.payAmountKobo - order.feeKobo)}.` : '';
  return reply(buttons(`🧪 That's what your customer gets after paying: your thank-you message and a PDF receipt. You'd also get a *Paid* alert here with the same receipt, and the money goes to your Relay wallet.${fee}\n\nKeep testing, or type *EXIT* to go back.`, [['menu', 'Shop again'], ['test:exit', 'Back to Relay']]), { step: 'browse' });
}
