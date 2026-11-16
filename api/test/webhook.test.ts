import { ADMIN_PNID, api, clearFirestore, db, doc, env, postMeta, queueMessage, seed, testEnv, waMessage } from './helpers';
import { handleQueueBatch } from '../src/services/queue';
import { eventId, parseMetaWebhook } from '../src/services/inbound';
import type { Handlers } from '../src/services/router';
import type { QueueJob } from '../src/env';
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });
beforeEach(() => { env.EVENTS.sent.length = 0; });

function spyHandlers(opts: { failTimes?: number } = {}) {
  const calls = { admin: [] as { businessId: string | null; text: string | null }[], shop: [] as { businessId: string; text: string | null }[] };
  let failures = opts.failTimes ?? 0;
  const handlers: Handlers = {
    async admin(ctx) { calls.admin.push({ businessId: ctx.businessId, text: ctx.event.text }); },
    async shop(ctx) {
      if (failures > 0) { failures--; throw new Error('handler exploded'); }
      calls.shop.push({ businessId: ctx.businessId, text: ctx.event.text });
    },
  };
  return { calls, handlers };
}

const drain = async (handlers: Handlers, attempts = 1) => {
  const msgs = env.EVENTS.sent.splice(0).map(job => queueMessage(job, attempts));
  await handleQueueBatch({ queue: 'test', messages: msgs }, env, { handlers });
  return msgs;
};

test('webhook: rejects a bad signature', async () => {
  const raw = JSON.stringify(waMessage({ phoneNumberId: fx.a.pnid, from: '2348090000009', id: 'wamid.sig' }));
  const res = await api('POST', '/api/v1/webhooks/meta', { raw, headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } });
  assert.equal(res.status, 401);
  assert.equal(await doc('inboundEvents', eventId('whatsapp', 'wamid.sig')), null);
  const unsigned = await api('POST', '/api/v1/webhooks/meta', { raw });
  assert.equal(unsigned.status, 401);
});

test('router: admin bot number routes to admin handler', async () => {
  const { calls, handlers } = spyHandlers();
  assert.equal((await postMeta(waMessage({ phoneNumberId: ADMIN_PNID, from: fx.a.ownerPhone.slice(1), id: 'wamid.admin1', text: 'add rice' }))).status, 200);
  await drain(handlers);
  assert.deepEqual(calls.admin, [{ businessId: fx.a.id, text: 'add rice' }]);
  assert.equal(calls.shop.length, 0);
  // An owner the system doesn't know yet still reaches the admin bot (onboarding), with no business.
  await postMeta(waMessage({ phoneNumberId: ADMIN_PNID, from: '2348031112222', id: 'wamid.admin2', text: 'hello' }));
  await drain(handlers);
  assert.deepEqual(calls.admin[1], { businessId: null, text: 'hello' });
  assert.ok((await doc('conversations', 'admin_2348031112222')).lastInboundAt);
});

test('router: merchant number routes to shop handler', async () => {
  const { calls, handlers } = spyHandlers();
  await postMeta(waMessage({ phoneNumberId: fx.b.pnid, from: '2348090000002', id: 'wamid.shop1', text: 'menu' }));
  await drain(handlers);
  assert.deepEqual(calls.shop, [{ businessId: fx.b.id, text: 'menu' }]);
  assert.equal(calls.admin.length, 0);
  const conv = await doc('conversations', fx.b.customer);
  assert.equal(conv.businessId, fx.b.id);
  assert.equal(conv.mode, 'bot');
  assert.ok(conv.lastInboundAt);
  const event = await doc('inboundEvents', eventId('whatsapp', 'wamid.shop1'));
  assert.equal(event.status, 'processed');
  assert.equal(event.route, 'shop');
  assert.ok(event.expireAt, 'events carry a TTL timestamp');
  assert.equal(event.text, null, 'message text is not kept after processing');
  assert.equal(event.message, null);
});

test('router: unknown number is ignored', async () => {
  const { calls, handlers } = spyHandlers();
  await postMeta(waMessage({ phoneNumberId: 'pn-unknown', from: '2348090000003', id: 'wamid.unknown' }));
  await drain(handlers);
  assert.equal(calls.shop.length + calls.admin.length, 0);
  assert.equal((await doc('inboundEvents', eventId('whatsapp', 'wamid.unknown'))).route, 'ignored');
});

test('webhook: duplicate message is processed once', async () => {
  const { calls, handlers } = spyHandlers();
  const payload = waMessage({ phoneNumberId: fx.a.pnid, from: '2348090000001', id: 'wamid.dup', text: 'twice' });
  assert.equal((await postMeta(payload)).status, 200);
  assert.equal((await postMeta(payload)).status, 200); // Meta retry
  assert.equal(env.EVENTS.sent.length, 1);
  // Even if the queue delivers the job twice, the handler runs once.
  env.EVENTS.sent.push(env.EVENTS.sent[0]);
  const msgs = await drain(handlers);
  assert.equal(calls.shop.length, 1);
  assert.ok(msgs.every(m => m.acked));
});

test('webhook: queued event is retried after a failure', async () => {
  const { calls, handlers } = spyHandlers({ failTimes: 1 });
  await postMeta(waMessage({ phoneNumberId: fx.a.pnid, from: '2348090000001', id: 'wamid.retry', text: 'again' }));
  const [job] = env.EVENTS.sent as QueueJob[];
  const [first] = await drain(handlers, 1);
  assert.equal(first.retried, true);
  assert.equal(first.acked, false);
  const id = eventId('whatsapp', 'wamid.retry');
  assert.equal((await doc('inboundEvents', id)).status, 'pending');
  assert.equal((await doc('inboundEvents', id)).lastError, 'handler exploded');
  env.EVENTS.sent.push(job);
  const [second] = await drain(handlers, 2);
  assert.equal(second.acked, true);
  assert.equal(calls.shop.length, 1);
  assert.equal((await doc('inboundEvents', id)).status, 'processed');
  assert.equal((await doc('inboundEvents', id)).attempts, 2);
});

test('webhook: Instagram DMs are parsed and echoes skipped', () => {
  const items = parseMetaWebhook({ object: 'instagram', entry: [{ id: 'ig-1', messaging: [
    { sender: { id: 'igsid-9' }, recipient: { id: 'ig-1' }, timestamp: 1_700_000_000_000, message: { mid: 'm_1', text: 'price?' } },
    { sender: { id: 'ig-1' }, recipient: { id: 'igsid-9' }, timestamp: 1_700_000_000_000, message: { mid: 'm_2', text: 'reply', is_echo: true } },
  ] }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'instagram');
  assert.equal(items[0].from, 'igsid-9');
  assert.equal(items[0].text, 'price?');
});

test('webhook: missing queue binding still saves the event for the sweep', async () => {
  const e = testEnv({ EVENTS: undefined });
  assert.equal((await postMeta(waMessage({ phoneNumberId: fx.a.pnid, from: '2348090000001', id: 'wamid.noqueue' }), e)).status, 200);
  assert.equal((await doc('inboundEvents', eventId('whatsapp', 'wamid.noqueue'))).status, 'pending');
  void db;
});
