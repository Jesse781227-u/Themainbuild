import { adminDb, clearFirestore, doc, seed, startApi, stopApi } from './helpers';
import { adjustInventory, createProduct } from '../src/services/firestore-commerce';
import { setOrderDelivery } from '../src/services/delivery';
import { assignBatch } from '../src/services/delivery-batches';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); await startApi(); });
after(stopApi);

// Every call below is made in business B's scope, aimed at business A's data.

test('tenant: inventory adjust rejects another business product', async () => {
  await assert.rejects(adjustInventory(fx.a.product, fx.b.id, -5, 'test', fx.b.owner), /NOT_FOUND/);
  assert.equal((await doc('products', fx.a.product))!.inventoryQty, 5);
  assert.equal((await doc('inventory', fx.a.product))!.quantity, 5);
});

test('tenant: delivery method rejects another business order', async () => {
  await assert.rejects(setOrderDelivery(fx.a.order, fx.b.id, { method: 'pickup', fee: 0, timeframe: 'Today' }), /ORDER_NOT_FOUND/);
  assert.equal((await doc('orders', fx.a.order))!.deliveryMethod, undefined);
});

test('tenant: batch assignment rejects another business order', async () => {
  const at = new Date().toISOString();
  await adminDb.collection('deliveryBatches').doc('batch-b').set({ id: 'batch-b', businessId: fx.b.id, zoneId: 'z', name: 'Evening', cutoffAt: at, dispatchAt: at, status: 'open', createdAt: at });
  await assert.rejects(assignBatch(fx.a.order, fx.b.id, 'batch-b'), /ORDER_NOT_FOUND/);
  assert.equal((await doc('orders', fx.a.order))!.deliveryBatchId, undefined);
});

test('tenant: product create cannot overwrite another business product', async () => {
  const hijack = { id: fx.a.product, businessId: fx.b.id, name: 'Hijacked', description: '', price: 1, currency: 'NGN', images: [], availability: true, inventoryQty: 0, lowStockThreshold: 5, channels: { web: false, whatsapp: true }, deletedAt: null };
  await assert.rejects(createProduct(hijack), /PRODUCT_ID_TAKEN/);
  const product = (await doc('products', fx.a.product))!;
  assert.equal(product.businessId, fx.a.id);
  assert.equal(product.name, `Product ${fx.a.id}`);
  assert.equal((await doc('inventory', fx.a.product))!.quantity, 5);
});
