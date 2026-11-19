import { C } from '../db';
import type { Config } from '../config';
import type { Firestore, Transaction } from '../lib/firestore';
import { increment } from '../lib/firestore';
import { feeKobo, type FeePolicy } from '../lib/money';
import { addMinutes } from '../lib/time';
import { orderRef, randomId } from '../lib/crypto';
import type { Business } from '../domain/business';
import type { Cart, CartLine, Order, OrderDelivery, OrderLine, Product } from '../domain/commerce';
import { hasStock, tracksStock } from '../domain/commerce';

// feePayer: who pays Relay's fee. 'owner' means customers pay the shop's prices and the fee comes out
// of what the shop receives.
export interface OrderPolicy extends FeePolicy { holdMinutes: number; feePayer?: 'customer' | 'owner' }

// What the customer is charged on top of the goods for Relay's fee (nothing when the owner pays it).
export const customerFee = (fee: number, policy: Pick<OrderPolicy, 'feePayer'>) => (policy.feePayer === 'owner' ? 0 : fee);

export function policyFor(business: Pick<Business, 'feeBps' | 'holdMinutes' | 'feePayer'> | null, cfg: Pick<Config, 'FEE_BPS' | 'FEE_CAP_KOBO' | 'HOLD_MINUTES'>): OrderPolicy {
  return { bps: business?.feeBps ?? cfg.FEE_BPS, capKobo: cfg.FEE_CAP_KOBO, holdMinutes: business?.holdMinutes ?? cfg.HOLD_MINUTES, feePayer: business?.feePayer ?? 'customer' };
}

// After a hold expires its amount stays claimed for this long, so a late transfer for the old order
// can't be matched to a new order that happens to reuse the same amount.
export const LATE_PAYMENT_GRACE_MINUTES = 24 * 60;
const MAX_UNIQUE_OFFSET_KOBO = 999; // the offset is at most ₦9.99 on top
const CANDIDATES = 25;

export const mergeCartLines = (items: CartLine[]) => {
  const qty = new Map<string, number>();
  for (const item of items) qty.set(item.productId, (qty.get(item.productId) ?? 0) + item.qty);
  return qty;
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
export async function checkout(db: Firestore, args: { cartId: string; businessId: string; policy: OrderPolicy; delivery?: OrderDelivery | null; now?: Date }): Promise<Order> {
  const now = args.now ?? new Date();
  return db.runTransaction(async tx => {
    const cart = (await tx.get(db.doc(C.carts, args.cartId))) as Cart | null;
    if (!cart || cart.businessId !== args.businessId) throw new Error('CART_NOT_FOUND');
    if (!(cart.expiresAt > now.toISOString())) throw new Error('CART_EXPIRED');
    const qty = mergeCartLines(cart.items);
    const ids = [...qty.keys()];
    if (!ids.length) throw new Error('CART_EMPTY');
    const products = (await tx.getAll(ids.map(id => db.doc(C.products, id)))) as (Product | null)[];

    const items: OrderLine[] = [];
    let subtotalKobo = 0;
    products.forEach((p, i) => {
      const wanted = qty.get(ids[i])!;
      if (!p || p.businessId !== cart.businessId || p.deletedAt || !p.available) throw new Error('PRODUCT_UNAVAILABLE');
      if (!Number.isSafeInteger(wanted) || wanted <= 0) throw new Error('INVALID_QTY');
      if (!hasStock(p, wanted)) throw new Error('INSUFFICIENT_STOCK');
      items.push({ productId: p.id, name: p.name, priceKobo: p.priceKobo, qty: wanted });
      subtotalKobo += p.priceKobo * wanted;
    });

    const delivery = args.delivery ?? null;
    const deliveryFeeKobo = delivery?.feeKobo ?? 0;
    const fee = feeKobo(subtotalKobo, args.policy);
    const baseKobo = subtotalKobo + deliveryFeeKobo + customerFee(fee, args.policy);
    const uniqueKobo = await claimUniqueAmount(tx, db, cart.businessId, baseKobo, now);
    const payAmountKobo = baseKobo + uniqueKobo;

    const at = now.toISOString();
    const holdExpiresAt = addMinutes(now, args.policy.holdMinutes).toISOString();
    const order: Order = {
      id: randomId(12), ref: orderRef(), businessId: cart.businessId, customerId: cart.customerId, channel: cart.channel,
      items, subtotalKobo, deliveryFeeKobo, feeKobo: fee, feePaidBy: args.policy.feePayer ?? 'customer', uniqueKobo, payAmountKobo,
      status: 'awaiting_payment', fulfilment: 'pending', delivery, holdExpiresAt,
      paidAt: null, paymentId: null, needsAttention: null, createdAt: at, updatedAt: at,
    };

    products.forEach((p, i) => {
      const wanted = qty.get(ids[i])!;
      if (!tracksStock(p!)) return; // no stock count: nothing to reserve
      tx.update(db.doc(C.products, p!.id), { stock: p!.stock - wanted, updatedAt: at });
      const mid = `${order.id}_${p!.id}_hold`;
      tx.create(db.doc(C.stockMovements, mid), { id: mid, businessId: order.businessId, productId: p!.id, delta: -wanted, reason: 'hold', orderId: order.id, actor: 'system', at });
    });
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
    const products = await tx.getAll(order.items.map(l => db.doc(C.products, l.productId)));
    const at = now.toISOString();
    order.items.forEach((line, i) => {
      if (!products[i] || !tracksStock(products[i] as unknown as Product)) return; // removed, or no stock count: nothing to restock
      tx.update(db.doc(C.products, line.productId), { stock: increment(line.qty), updatedAt: at });
      const mid = `${order.id}_${line.productId}_release`;
      tx.create(db.doc(C.stockMovements, mid), { id: mid, businessId: order.businessId, productId: line.productId, delta: line.qty, reason: 'release', orderId: order.id, actor: 'system', at });
    });
    tx.update(db.doc(C.orders, order.id), { status: 'expired', updatedAt: at });
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
      const products = await tx.getAll(order.items.map(l => db.doc(C.products, l.productId)));
      order.items.forEach((line, i) => {
        if (!products[i] || !tracksStock(products[i] as unknown as Product)) return;
        tx.update(db.doc(C.products, line.productId), { stock: increment(line.qty), updatedAt: at });
        const mid = `${order.id}_${line.productId}_release`;
        tx.create(db.doc(C.stockMovements, mid), { id: mid, businessId, productId: line.productId, delta: line.qty, reason: 'release', orderId: order.id, actor: 'owner', at });
      });
    }
    tx.update(db.doc(C.orders, order.id), { status: 'cancelled', updatedAt: at });
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
