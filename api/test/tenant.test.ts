import { clearFirestore, db, doc, seed } from './helpers';
import { adjustInventory, createProduct } from '../src/services/catalog';
import { assignBatch, setOrderDelivery } from '../src/services/delivery';
import { markOrderPaid } from '../src/services/on-paid';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });

// Every call below is made in business B's scope, aimed at business A's data.

test('tenant: inventory adjust rejects another business product', async () => {
  await assert.rejects(adjustInventory(db, fx.a.product, fx.b.id, -5, 'adjustment', 'owner'), /NOT_FOUND/);
  assert.equal((await doc('products', fx.a.product)).stock, 5);
  assert.equal(await adjustInventory(db, fx.a.product, fx.a.id, 3, 'restock', 'owner'), 8);
  await assert.rejects(adjustInventory(db, fx.a.product, fx.a.id, -9, 'adjustment', 'owner'), /INSUFFICIENT_STOCK/);
  assert.equal(await adjustInventory(db, fx.a.product, fx.a.id, -3, 'adjustment', 'owner'), 5);
});

test('tenant: delivery method rejects another business order', async () => {
  await assert.rejects(setOrderDelivery(db, fx.a.order, fx.b.id, { method: 'pickup', feeKobo: 0, timeframe: 'Today' }), /ORDER_NOT_FOUND/);
  assert.equal((await doc('orders', fx.a.order)).delivery, null);
});

test('tenant: batch assignment rejects another business order', async () => {
  const at = new Date().toISOString();
  await db.set(db.doc('deliveryBatches', 'batch-b'), { id: 'batch-b', businessId: fx.b.id, zoneId: 'z', name: 'Evening', cutoffAt: at, dispatchAt: at, status: 'open', createdAt: at });
  await assert.rejects(assignBatch(db, fx.a.order, fx.b.id, 'batch-b'), /ORDER_NOT_FOUND/);
  assert.equal((await doc('orders', fx.a.order)).delivery, null);
});

test('tenant: product create cannot overwrite another business product', async () => {
  await assert.rejects(createProduct(db, { id: fx.a.product, businessId: fx.b.id, name: 'Hijacked', priceKobo: 1 }), /PRODUCT_ID_TAKEN/);
  const product = await doc('products', fx.a.product);
  assert.equal(product.businessId, fx.a.id);
  assert.equal(product.name, `Product ${fx.a.id}`);
  assert.equal(product.stock, 5);
});

test('tenant: marking paid rejects another business order', async () => {
  const r = await markOrderPaid(db, fx.a.order, fx.b.id, 'manual_x');
  assert.equal(r.applied, false);
  assert.equal((await doc('orders', fx.a.order)).status, 'expired');
});

test('catalog: product input is validated', async () => {
  await assert.rejects(createProduct(db, { businessId: fx.a.id, name: '', priceKobo: 100 }));
  await assert.rejects(createProduct(db, { businessId: fx.a.id, name: 'Rice', priceKobo: 10.5 }));
  await assert.rejects(createProduct(db, { businessId: fx.a.id, name: 'Rice', priceKobo: -1 }));
  const p = await createProduct(db, { businessId: fx.a.id, name: 'Rice', priceKobo: 5_000_00, stock: 10 });
  assert.equal((await doc('products', p.id)).stock, 10);
});
