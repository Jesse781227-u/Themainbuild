import { api, clearFirestore, db, doc, env, seed, seedCart, testEnv } from './helpers';
import worker from '../src/worker';
import { checkout } from '../src/services/orders';
import { CRON_DAILY_SUMMARY, CRON_EVERY_MINUTE } from '../src/services/jobs';
import { eventId } from '../src/services/inbound';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });

test('jobs: scheduled handler releases expired holds', async () => {
  const t0 = new Date();
  await seedCart('cart-j', fx.a.id, fx.a.customer, [{ productId: fx.a.product, qty: 2 }]);
  const o = await checkout(db, { cartId: 'cart-j', businessId: fx.a.id, policy: { bps: 100, capKobo: 200_000, holdMinutes: 30 }, now: t0 });
  assert.equal((await doc('products', fx.a.product)).stock, 3);
  await worker.scheduled({ cron: CRON_EVERY_MINUTE, scheduledTime: t0.getTime() + 10 * 60_000 }, env);
  assert.equal((await doc('orders', o.id)).status, 'awaiting_payment');
  await worker.scheduled({ cron: CRON_EVERY_MINUTE, scheduledTime: t0.getTime() + 31 * 60_000 }, env);
  assert.equal((await doc('orders', o.id)).status, 'expired');
  assert.equal((await doc('products', fx.a.product)).stock, 5);
  await worker.scheduled({ cron: CRON_DAILY_SUMMARY, scheduledTime: t0.getTime() }, env);
});

test('jobs: sweep re-queues events whose queue message was lost', async () => {
  const id = eventId('whatsapp', 'wamid.lost');
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  await db.set(db.doc('inboundEvents', id), { id, source: 'whatsapp', kind: 'message', accountId: fx.a.pnid, messageId: 'wamid.lost', from: fx.a.customerPhone, status: 'pending', attempts: 0, receivedAt: old, leaseUntil: null });
  env.EVENTS.sent.length = 0;
  await worker.scheduled({ cron: CRON_EVERY_MINUTE, scheduledTime: Date.now() }, env);
  assert.deepEqual(env.EVENTS.sent, [{ kind: 'inbound', eventId: id }]);
});

test('worker: refuses to serve with invalid config', async () => {
  await assert.rejects(async () => worker.fetch(new Request('http://x/health'), testEnv({ RELAY_ENV: 'production' }), { waitUntil() {} }), /Firebase/);
});

test('harness: emulator reachable', async () => {
  await db.set(db.doc('_harness', 'probe'), { ok: true });
  assert.equal((await doc('_harness', 'probe')).ok, true);
  const res = await api('GET', '/health/deep');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.checks.firestore, 'ok');
});

test('media: serves product images from R2 and nothing else', async () => {
  const objects = new Map([['businesses/biz-a/products/p1.jpg', 'jpeg-bytes']]);
  const r2 = { async get(k: string) { const v = objects.get(k); return v ? { body: new Response(v).body!, httpEtag: '"e"', httpMetadata: { contentType: 'image/jpeg' } } : null; }, async put() { return null; } };
  const e = testEnv({ PRODUCT_IMAGES: r2 });
  const ok = await api('GET', '/media/businesses/biz-a/products/p1.jpg', { env: e });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'jpeg-bytes');
  assert.equal((await api('GET', '/media/businesses/biz-a/products/missing.jpg', { env: e })).status, 404);
  assert.equal((await api('GET', '/media/businesses/biz-a/secrets.json', { env: e })).status, 404);
  assert.equal((await api('GET', '/media/businesses/biz-a/products/..%2F..%2Fx.jpg', { env: e })).status, 404);
});
