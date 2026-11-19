import { api, clearFirestore, db, doc, testEnv } from './helpers';
import { getConfig } from '../src/config';
import { createSignupSession } from '../src/services/signup';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

before(async () => { await clearFirestore(); });

test('dev chat: hidden unless running locally in log mode', async () => {
  const live = testEnv(); // development, but META_SEND_MODE defaults to live
  for (const [method, path] of [['GET', '/dev/owner'], ['GET', '/dev/customer'], ['GET', '/dev/shop?owner=1'], ['POST', '/dev/connect/abcdefghijkl'], ['POST', '/dev/send'], ['POST', '/dev/clear'], ['GET', '/dev/messages?phone=1&bot=x']] as const) {
    assert.equal((await api(method, path, { env: live, body: method === 'POST' ? {} : undefined })).status, 404, `${method} ${path}`);
  }
});

test('dev chat: the customer tab finds the owner\'s shop once it is connected in test mode', async () => {
  const e = testEnv({ META_SEND_MODE: 'log' });
  assert.match((await api('GET', '/dev/owner', { env: e })).body, /"botNumber":"pn-admin"/);
  assert.doesNotMatch((await api('GET', '/dev/customer', { env: e })).body, /Mama Put/);
  assert.deepEqual((await api('GET', '/dev/shop?owner=2348031112222', { env: e })).body, { shop: null, reason: 'no_business' });

  const at = new Date().toISOString();
  await db.set(db.doc('businesses', 'biz-new'), { id: 'biz-new', name: 'Ada Kicks', category: 'fashion_retail', ownerPhone: '+2348031112222', status: 'onboarding', timezone: 'Africa/Lagos', createdAt: at, updatedAt: at });
  await db.set(db.doc('ownerPhones', '+2348031112222'), { businessId: 'biz-new' });
  assert.deepEqual((await api('GET', '/dev/shop?owner=2348031112222', { env: e })).body, { shop: null, reason: 'not_connected', name: 'Ada Kicks' });

  // The connect link from signup shows a test-mode button in the local chat.
  const link = await createSignupSession(db, getConfig(e), 'biz-new');
  const token = link.split('/connect/')[1];
  assert.match((await api('GET', `/connect/${token}`, { env: e })).body, /Connect \(test mode\)/);
  assert.deepEqual((await api('POST', `/dev/connect/${token}`, { env: e })).body, { success: true });
  assert.equal((await doc('businesses', 'biz-new')).status, 'active');
  const shop = (await api('GET', '/dev/shop?owner=2348031112222', { env: e })).body.shop;
  assert.equal(shop.name, 'Ada Kicks');

  // A customer message to that shop goes through the real signed webhook route.
  const sent = await api('POST', '/dev/send', { env: e, body: { botNumber: shop.botNumber, phone: '2348077770001', text: 'hi' } });
  assert.deepEqual(sent.body, { success: true, status: 200 });
  assert.equal(e.EVENTS.sent.filter(j => j.kind === 'inbound').length, 1, 'queued for the Shop Bot');
  const messages = await api('GET', `/dev/messages?phone=2348077770001&bot=${shop.botNumber}`, { env: e });
  assert.deepEqual(messages.body.map((m: { direction: string; content: { text: string } }) => [m.direction, m.content.text]), [['in', 'hi']]);
  assert.equal((await api('POST', '/dev/clear', { env: e, body: { botNumber: shop.botNumber, phone: '2348077770001' } })).body.cleared, 1);
  assert.equal((await api('POST', `/dev/connect/${token}`, { env: e })).status, 404, 'a used link can\'t connect again');
});
