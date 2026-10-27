import { adminDb, api, clearFirestore, doc, seed, startApi, stopApi } from './helpers';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); await startApi(); });
after(stopApi);

const future = () => new Date(Date.now() + 3600_000).toISOString();
const seedCart = (id: string, items: { productId: string; qty: number; priceAtAdd: number }[], expiresAt = future()) =>
  adminDb.collection('carts').doc(id).set({ id, businessId: fx.a.id, sessionId: 'session-test', items, expiresAt });

test('checkout: duplicate lines cannot oversell', async () => {
  const viaApi = await api('POST', `/api/v1/storefronts/${fx.a.slug}/cart`, { body: { sessionId: 'session-test', items: [{ productId: fx.a.product, qty: 3 }, { productId: fx.a.product, qty: 3 }] } });
  assert.equal(viaApi.status, 409);
  await seedCart('cart-dup', [{ productId: fx.a.product, qty: 3, priceAtAdd: 1000 }, { productId: fx.a.product, qty: 3, priceAtAdd: 1000 }]);
  const res = await api('POST', `/api/v1/storefronts/${fx.a.slug}/cart/cart-dup/checkout`, { body: {} });
  assert.equal(res.status, 409);
  assert.equal((await doc('products', fx.a.product))!.inventoryQty, 5);
});

test('checkout: expired cart is rejected', async () => {
  await seedCart('cart-old', [{ productId: fx.a.product, qty: 1, priceAtAdd: 1000 }], new Date(Date.now() - 1000).toISOString());
  const res = await api('POST', `/api/v1/storefronts/${fx.a.slug}/cart/cart-old/checkout`, { body: {} });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'CART_EXPIRED');
  assert.equal((await doc('products', fx.a.product))!.inventoryQty, 5);
});

test('checkout: order snapshots item name and price', async () => {
  const cart = await api('POST', `/api/v1/storefronts/${fx.a.slug}/cart`, { body: { sessionId: 'session-test', items: [{ productId: fx.a.product, qty: 2 }] } });
  assert.equal(cart.status, 201);
  const res = await api('POST', `/api/v1/storefronts/${fx.a.slug}/cart/${cart.body.data.id}/checkout`, { body: {} });
  assert.equal(res.status, 201);
  const orderId = res.body.data.order.id;
  await adminDb.collection('products').doc(fx.a.product).update({ name: 'Renamed later', price: 99999 });
  const view = await api('GET', `/api/v1/storefronts/${fx.a.slug}/orders/${orderId}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.data.items[0].name, `Product ${fx.a.id}`);
  assert.equal(view.body.data.items[0].price, 1000);
  assert.equal(view.body.data.subtotal, 2000);
  // The cart is consumed: a second checkout cannot create a second order.
  assert.equal((await api('POST', `/api/v1/storefronts/${fx.a.slug}/cart/${cart.body.data.id}/checkout`, { body: {} })).status, 404);
});
