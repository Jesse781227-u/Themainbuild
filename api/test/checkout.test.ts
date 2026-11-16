import { clearFirestore, db, doc, seed, seedCart } from './helpers';
import { checkout, releaseHold, type OrderPolicy } from '../src/services/orders';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });

const policy: OrderPolicy = { bps: 100, capKobo: 200_000, holdMinutes: 30 };
const order = (cartId: string, now?: Date) => checkout(db, { cartId, businessId: fx.a.id, policy, now });
const stock = async () => (await doc('products', fx.a.product)).stock as number;

test('checkout: duplicate lines cannot oversell', async () => {
  await seedCart('cart-dup', fx.a.id, fx.a.customer, [{ productId: fx.a.product, qty: 3 }, { productId: fx.a.product, qty: 3 }]);
  await assert.rejects(order('cart-dup'), /INSUFFICIENT_STOCK/);
  assert.equal(await stock(), 5);
});

test('checkout: expired cart is rejected', async () => {
  await seedCart('cart-old', fx.a.id, fx.a.customer, [{ productId: fx.a.product, qty: 1 }], new Date(Date.now() - 1000).toISOString());
  await assert.rejects(order('cart-old'), /CART_EXPIRED/);
  assert.equal(await stock(), 5);
});

test('checkout: another business cannot check out the cart', async () => {
  await seedCart('cart-a', fx.a.id, fx.a.customer, [{ productId: fx.a.product, qty: 1 }]);
  await assert.rejects(checkout(db, { cartId: 'cart-a', businessId: fx.b.id, policy }), /CART_NOT_FOUND/);
  await seedCart('cart-mixed', fx.b.id, fx.b.customer, [{ productId: fx.a.product, qty: 1 }]);
  await assert.rejects(checkout(db, { cartId: 'cart-mixed', businessId: fx.b.id, policy }), /PRODUCT_UNAVAILABLE/);
  assert.equal(await stock(), 5);
});

test('checkout: order snapshots item name and price', async () => {
  await seedCart('cart-ok', fx.a.id, fx.a.customer, [{ productId: fx.a.product, qty: 2 }]);
  const o = await order('cart-ok');
  await db.update(db.doc('products', fx.a.product), { name: 'Renamed later', priceKobo: 9_999_900 });
  const stored = await doc('orders', o.id);
  assert.equal(stored.items[0].name, `Product ${fx.a.id}`);
  assert.equal(stored.items[0].priceKobo, 100_000);
  assert.equal(stored.subtotalKobo, 200_000);
  assert.equal(stored.feeKobo, 2_000);                  // 1% of ₦2,000
  assert.equal(stored.payAmountKobo, 202_000 + stored.uniqueKobo);
  // The cart is consumed: a second checkout cannot create a second order.
  await assert.rejects(order('cart-ok'), /CART_NOT_FOUND/);
  await db.update(db.doc('products', fx.a.product), { name: `Product ${fx.a.id}`, priceKobo: 100_000 });
  await releaseHold(db, o.id, new Date(Date.now() + 31 * 60_000));
});

test('checkout: delivery fee is charged but carries no Relay fee', async () => {
  await seedCart('cart-del', fx.a.id, fx.a.customer, [{ productId: fx.a.product, qty: 1 }]);
  const o = await checkout(db, { cartId: 'cart-del', businessId: fx.a.id, policy, delivery: { method: 'self_arranged', feeKobo: 150_000, timeframe: 'Today' } });
  assert.equal(o.subtotalKobo, 100_000);
  assert.equal(o.deliveryFeeKobo, 150_000);
  assert.equal(o.feeKobo, 1_000);
  assert.equal(o.payAmountKobo, 251_000 + o.uniqueKobo);
  await releaseHold(db, o.id, new Date(Date.now() + 31 * 60_000));
});

test('hold: checkout reserves stock until timeout', async () => {
  const t0 = new Date();
  await seedCart('cart-hold', fx.a.id, fx.a.customer, [{ productId: fx.a.product, qty: 4 }]);
  const o = await order('cart-hold', t0);
  assert.equal(o.status, 'awaiting_payment');
  assert.equal(o.holdExpiresAt, new Date(t0.getTime() + 30 * 60_000).toISOString());
  assert.equal(await stock(), 1);
  // Reserved stock can't be sold to someone else.
  await seedCart('cart-other', fx.a.id, fx.a.customer, [{ productId: fx.a.product, qty: 2 }]);
  await assert.rejects(order('cart-other'), /INSUFFICIENT_STOCK/);
  // Before the hold ends nothing is released.
  assert.equal(await releaseHold(db, o.id, new Date(t0.getTime() + 29 * 60_000)), false);
  assert.equal(await stock(), 1);
  assert.equal(await releaseHold(db, o.id, new Date(t0.getTime() + 30 * 60_000)), true);
  assert.equal(await stock(), 5);
});

test('hold: expired unpaid order releases stock', async () => {
  const t0 = new Date();
  await seedCart('cart-exp', fx.a.id, fx.a.customer, [{ productId: fx.a.product, qty: 2 }]);
  const o = await order('cart-exp', t0);
  assert.equal(await stock(), 3);
  assert.equal(await releaseHold(db, o.id, new Date(t0.getTime() + 31 * 60_000)), true);
  assert.equal(await stock(), 5);
  assert.equal((await doc('orders', o.id)).status, 'expired');
  assert.equal((await doc('stockMovements', `${o.id}_${fx.a.product}_release`)).delta, 2);
});

test('hold: release is idempotent', async () => {
  const t0 = new Date();
  await seedCart('cart-idem', fx.a.id, fx.a.customer, [{ productId: fx.a.product, qty: 3 }]);
  const o = await order('cart-idem', t0);
  const later = new Date(t0.getTime() + 31 * 60_000);
  const results = await Promise.all([releaseHold(db, o.id, later), releaseHold(db, o.id, later), releaseHold(db, o.id, later)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await releaseHold(db, o.id, later), false);
  assert.equal(await stock(), 5);
});

test('payments: pending orders get unique amounts per business', async () => {
  const amounts = new Set<number>();
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    await seedCart(`cart-u${i}`, fx.a.id, fx.a.customer, [{ productId: fx.a.product, qty: 1 }]);
    const o = await order(`cart-u${i}`);
    amounts.add(o.payAmountKobo);
    ids.push(o.id);
    assert.ok(o.uniqueKobo >= 0 && o.uniqueKobo <= 999);
    assert.equal((await doc('amountClaims', `${fx.a.id}_${o.payAmountKobo}`)).orderId, o.id);
  }
  assert.equal(amounts.size, 4);
  // Business B can use the same amount: matching is per business.
  await seedCart('cart-ub', fx.b.id, fx.b.customer, [{ productId: fx.b.product, qty: 1 }]);
  const b = await checkout(db, { cartId: 'cart-ub', businessId: fx.b.id, policy });
  assert.equal(b.uniqueKobo, 0);
  for (const id of ids) await releaseHold(db, id, new Date(Date.now() + 31 * 60_000));
});
