import { adminDb, api, clearFirestore, doc, seed, startApi, stopApi } from './helpers';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); await startApi(); });
after(stopApi);

// Every request below is made by business B's owner, aimed at business A's data.
const asB = (body?: unknown) => ({ as: fx.b.owner, business: fx.b.id, body });

test('tenant: inventory adjust rejects another business product', async () => {
  const res = await api('POST', `/api/v1/products/${fx.a.product}/inventory/adjust`, asB({ delta: -5 }));
  assert.equal(res.status, 404);
  assert.equal((await doc('products', fx.a.product))!.inventoryQty, 5);
  assert.equal((await doc('inventory', fx.a.product))!.quantity, 5);
});

test('tenant: delivery method rejects another business order', async () => {
  const res = await api('POST', `/api/v1/orders/${fx.a.order}/delivery-method`, asB({ method: 'pickup', fee: 0, timeframe: 'Today' }));
  assert.equal(res.status, 404);
  assert.equal((await doc('orders', fx.a.order))!.deliveryMethod, undefined);
});

test('tenant: batch assignment rejects another business order', async () => {
  const at = new Date().toISOString();
  await adminDb.collection('deliveryBatches').doc('batch-b').set({ id: 'batch-b', businessId: fx.b.id, zoneId: 'z', name: 'Evening', cutoffAt: at, dispatchAt: at, status: 'open', createdAt: at });
  const res = await api('POST', `/api/v1/orders/${fx.a.order}/delivery-batch`, asB({ batchId: 'batch-b' }));
  assert.equal(res.status, 404);
  assert.equal((await doc('orders', fx.a.order))!.deliveryBatchId, undefined);
});

test('tenant: cannot publish over another business slug', async () => {
  const res = await api('POST', `/api/v1/businesses/${fx.b.id}/storefront`, asB({ slug: fx.a.slug, name: 'Taken', templateId: 'kitchen-table' }));
  assert.equal(res.status, 409);
  const store = (await doc('storefronts', fx.a.slug))!;
  assert.equal(store.businessId, fx.a.id);
  assert.equal(store.name, `Shop ${fx.a.id}`);
});

test('tenant: cannot rename onto another business slug', async () => {
  const res = await api('PATCH', `/api/v1/businesses/${fx.b.id}/storefront`, asB({ slug: fx.a.slug }));
  assert.equal(res.status, 409);
  assert.equal((await doc('storefronts', fx.a.slug))!.businessId, fx.a.id);
  assert.equal((await doc('storefronts', fx.b.slug))!.businessId, fx.b.id);
});

test('tenant: product create cannot overwrite another business product', async () => {
  const res = await api('POST', `/api/v1/businesses/${fx.b.id}/products`, asB({ id: fx.a.product, name: 'Hijacked', price: 1, inventoryQty: 0 }));
  assert.equal(res.status, 409);
  const product = (await doc('products', fx.a.product))!;
  assert.equal(product.businessId, fx.a.id);
  assert.equal(product.name, `Product ${fx.a.id}`);
  assert.equal((await doc('inventory', fx.a.product))!.quantity, 5);
});

test('business: lists memberships for signed-in user', async () => {
  const res = await api('GET', '/api/v1/me/businesses', { as: fx.a.owner });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((b: { id: string; role: string }) => [b.id, b.role]), [[fx.a.id, 'owner']]);
  assert.equal((await api('GET', '/api/v1/me/businesses')).status, 401);
});
