import { api, clearFirestore, db, testEnv } from './helpers';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

before(async () => { await clearFirestore(); });

test('dev chat: hidden unless running locally in log mode', async () => {
  const live = testEnv(); // development, but META_SEND_MODE defaults to live
  for (const [method, path] of [['GET', '/dev'], ['GET', '/dev/bots'], ['POST', '/dev/seed'], ['POST', '/dev/send'], ['GET', '/dev/messages?phone=1&bot=x']] as const) {
    assert.equal((await api(method, path, { env: live, body: method === 'POST' ? {} : undefined })).status, 404, `${method} ${path}`);
  }
});

test('dev chat: seeds the demo shop and turns a typed message into a signed webhook', async () => {
  const e = testEnv({ META_SEND_MODE: 'log' });
  assert.equal((await api('GET', '/dev', { env: e })).status, 200);
  const seeded = await api('POST', '/dev/seed', { env: e });
  assert.equal(seeded.body.phoneNumberId, 'pn-demo');
  const bots = await api('GET', '/dev/bots', { env: e });
  assert.ok(bots.body.shops.some((s: { botNumber: string }) => s.botNumber === 'pn-demo'));

  const sent = await api('POST', '/dev/send', { env: e, body: { botNumber: 'pn-demo', phone: '2348077770001', text: 'hi' } });
  assert.deepEqual(sent.body, { success: true, status: 200 }, 'the real webhook route accepted the signed message');
  assert.equal(e.EVENTS.sent.length, 1, 'the message was queued for the Shop Bot');

  const messages = await api('GET', '/dev/messages?phone=2348077770001&bot=pn-demo', { env: e });
  assert.deepEqual(messages.body.map((m: { direction: string; content: { text: string } }) => [m.direction, m.content.text]), [['in', 'hi']]);
  assert.equal((await db.query('devMessages', [['phone', '==', '+2348077770001']])).length, 1);
});
