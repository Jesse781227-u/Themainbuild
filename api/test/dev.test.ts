import { api, clearFirestore, db, testEnv } from './helpers';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

before(async () => { await clearFirestore(); });

test('dev chat: hidden unless running locally in log mode', async () => {
  const live = testEnv(); // development, but META_SEND_MODE defaults to live
  for (const [method, path] of [['GET', '/dev/owner'], ['GET', '/dev/customer'], ['POST', '/dev/seed'], ['POST', '/dev/send'], ['POST', '/dev/clear'], ['GET', '/dev/messages?phone=1&bot=x']] as const) {
    assert.equal((await api(method, path, { env: live, body: method === 'POST' ? {} : undefined })).status, 404, `${method} ${path}`);
  }
});

test('dev chat: the screens create the demo shop, typed messages become signed webhooks, and Clear chat forgets them', async () => {
  const e = testEnv({ META_SEND_MODE: 'log' });
  const owner = await api('GET', '/dev/owner', { env: e });
  assert.equal(owner.status, 200);
  assert.match(owner.body, /"botNumber":"pn-admin"/);
  const customer = await api('GET', '/dev/customer', { env: e });
  assert.match(customer.body, /Mama Put Kitchen/);
  assert.ok(await db.get(db.doc('businesses', 'biz-demo')), 'opening a screen created the demo shop');

  const sent = await api('POST', '/dev/send', { env: e, body: { botNumber: 'pn-demo', phone: '2348077770001', text: 'hi' } });
  assert.deepEqual(sent.body, { success: true, status: 200 }, 'the real webhook route accepted the signed message');
  assert.equal(e.EVENTS.sent.length, 1, 'the message was queued for the Shop Bot');
  const messages = await api('GET', '/dev/messages?phone=2348077770001&bot=pn-demo', { env: e });
  assert.deepEqual(messages.body.map((m: { direction: string; content: { text: string } }) => [m.direction, m.content.text]), [['in', 'hi']]);

  assert.equal((await api('POST', '/dev/clear', { env: e, body: { botNumber: 'pn-demo', phone: '2348077770001' } })).body.cleared, 1);
  assert.deepEqual((await api('GET', '/dev/messages?phone=2348077770001&bot=pn-demo', { env: e })).body, []);
});
