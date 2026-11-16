import { clearFirestore, db, doc, env, FakeTransport, queueMessage, seed, seedCart } from './helpers';
import worker from '../src/worker';
import { getConfig } from '../src/config';
import { checkout } from '../src/services/orders';
import { markOrderPaid } from '../src/services/on-paid';
import { queueDailySummaries } from '../src/services/summary';
import { CRON_DAILY_SUMMARY } from '../src/services/jobs';
import { handleQueueBatch } from '../src/services/queue';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });

test('summary: daily summary uses Lagos day', async () => {
  await seedCart('cart-s', fx.a.id, fx.a.customer, [{ productId: fx.a.product, qty: 2 }]);
  const order = await checkout(db, { cartId: 'cart-s', businessId: fx.a.id, policy: { bps: 100, capKobo: 200_000, holdMinutes: 30 } });
  // 23:30 UTC on 1 Dec is 00:30 on 2 Dec in Lagos: the sale belongs to 2 Dec.
  await markOrderPaid(db, order.id, fx.a.id, 'manual_s', '2026-12-01T23:30:00.000Z');

  const dec1 = await queueDailySummaries(db, new Date('2026-12-01T19:00:00Z'));
  assert.ok(dec1.includes(`${fx.a.id}_summary_2026-12-01`));
  assert.match((await doc('outbox', `${fx.a.id}_summary_2026-12-01`)).text, /Paid orders: 0\nSales: ₦0/);

  // The cron fires at 19:00 UTC = 20:00 Lagos.
  env.EVENTS.sent.length = 0;
  await worker.scheduled({ cron: CRON_DAILY_SUMMARY, scheduledTime: Date.parse('2026-12-02T19:00:00Z') }, env);
  const s = await doc('outbox', `${fx.a.id}_summary_2026-12-02`);
  assert.match(s.text, /^📊 Business biz-a, Wed,? 2 Dec/);
  assert.match(s.text, /Paid orders: 1\nSales: ₦2,000/);
  assert.equal(s.to, fx.a.ownerPhone);
  assert.deepEqual(env.EVENTS.sent.map(j => j.kind === 'outbox' && j.messageId).sort(), [`${fx.a.id}_summary_2026-12-02`, `${fx.b.id}_summary_2026-12-02`]);
  // One summary per business per Lagos day, however often the cron fires.
  assert.deepEqual(await queueDailySummaries(db, new Date('2026-12-02T19:05:00Z')), []);
});

test('summary: uses a template outside the 24-hour window', async () => {
  const now = new Date('2026-12-03T19:00:00Z');
  const ids = await queueDailySummaries(db, now);
  // Owner A last wrote to the Admin Bot three days ago; owner B an hour ago.
  await db.set(db.doc('conversations', `admin_${fx.a.ownerPhone.slice(1)}`), { id: `admin_${fx.a.ownerPhone.slice(1)}`, businessId: fx.a.id, lastInboundAt: new Date(now.getTime() - 3 * 86_400_000).toISOString() });
  await db.set(db.doc('conversations', `admin_${fx.b.ownerPhone.slice(1)}`), { id: `admin_${fx.b.ownerPhone.slice(1)}`, businessId: fx.b.id, lastInboundAt: new Date(now.getTime() - 3_600_000).toISOString() });
  const transport = new FakeTransport();
  await handleQueueBatch({ queue: 't', messages: ids.map(messageId => queueMessage({ kind: 'outbox', messageId })) }, env, { transport, now: () => now });

  const toA = transport.sent.find(m => m.to === fx.a.ownerPhone)!;
  assert.equal(toA.content.type, 'template');
  const t = toA.content as { name: string; language: string; components: { parameters: { text: string }[] }[] };
  assert.equal(t.name, getConfig(env).DAILY_SUMMARY_TEMPLATE);
  assert.equal(t.language, 'en');
  assert.deepEqual(t.components[0].parameters.map(p => p.text).slice(0, 1), ['Business biz-a']);
  assert.equal((await doc('outbox', `${fx.a.id}_summary_2026-12-03`)).viaTemplate, true);

  const toB = transport.sent.find(m => m.to === fx.b.ownerPhone)!;
  assert.equal(toB.content.type, 'text', 'inside the window the full text is sent');
  assert.equal(toB.phoneNumberId, 'pn-admin');
});

test('outbox: messages without a template are held outside the window', async () => {
  const transport = new FakeTransport();
  const at = new Date().toISOString();
  await db.set(db.doc('outbox', 'no-template'), { id: 'no-template', businessId: fx.a.id, audience: 'owner', channel: 'whatsapp', to: fx.a.ownerPhone, conversationId: 'admin_nobody', kind: 'x', text: 'hello', status: 'pending', attempts: 0, createdAt: at });
  await handleQueueBatch({ queue: 't', messages: [queueMessage({ kind: 'outbox', messageId: 'no-template' })] }, env, { transport });
  assert.equal(transport.sent.length, 0);
  assert.equal((await doc('outbox', 'no-template')).status, 'blocked_window');
});
