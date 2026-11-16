import { adminDb, clearFirestore, doc, seed, startApi, stopApi } from './helpers';
import { checkout } from '../src/services/firestore-commerce';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); await startApi(); });
after(stopApi);

type Line = { productId: string; qty: number; priceAtAdd: number };
const future = () => new Date(Date.now() + 3600_000).toISOString();
async function seedCart(id: string, items: Line[], expiresAt = future()) {
  const cart = { id, businessId: fx.a.id, sessionId: 'session-test', items, expiresAt };
  await adminDb.collection('carts').doc(id).set(cart);
  return cart;
}

test('checkout: duplicate lines cannot oversell', async () => {
  const cart = await seedCart('cart-dup', [{ productId: fx.a.product, qty: 3, priceAtAdd: 1000 }, { productId: fx.a.product, qty: 3, priceAtAdd: 1000 }]);
  await assert.rejects(checkout(cart, undefined, 'whatsapp'), /INSUFFICIENT_STOCK/);
  assert.equal((await doc('products', fx.a.product))!.inventoryQty, 5);
});

test('checkout: expired cart is rejected', async () => {
  const cart = await seedCart('cart-old', [{ productId: fx.a.product, qty: 1, priceAtAdd: 1000 }], new Date(Date.now() - 1000).toISOString());
  await assert.rejects(checkout(cart, undefined, 'whatsapp'), /CART_EXPIRED/);
  assert.equal((await doc('products', fx.a.product))!.inventoryQty, 5);
});

test('checkout: order snapshots item name and price', async () => {
  const cart = await seedCart('cart-ok', [{ productId: fx.a.product, qty: 2, priceAtAdd: 1000 }]);
  const order = await checkout(cart, undefined, 'whatsapp');
  await adminDb.collection('products').doc(fx.a.product).update({ name: 'Renamed later', price: 99999 });
  const stored = (await doc('orders', order.id))!;
  assert.equal(stored.items[0].name, `Product ${fx.a.id}`);
  assert.equal(stored.items[0].price, 1000);
  assert.equal(stored.subtotal, 2000);
  assert.equal((await doc('products', fx.a.product))!.inventoryQty, 3);
  // The cart is consumed: a second checkout cannot create a second order.
  await assert.rejects(checkout(cart, undefined, 'whatsapp'), /CART_NOT_FOUND/);
});
