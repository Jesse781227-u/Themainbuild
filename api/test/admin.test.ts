import crypto from 'node:crypto';
import { api, Bot, clearFirestore, db, doc, env, seed, testEnv, passBranding } from './helpers';
import { getConfig } from '../src/config';
import { decrypt } from '../src/lib/crypto';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });

const NEW_OWNER = '2348035550000';

// The full onboarding conversation is covered in onboarding.test.ts.
test('admin: the connect link from onboarding renders and unknown ones 404', async () => {
  const { createSignupSession } = await import('../src/services/signup');
  const link = await createSignupSession(db, getConfig(env), fx.a.id);
  const token = /\/connect\/([A-Za-z0-9]+)/.exec(link)![1];
  assert.ok(await doc('signupSessions', token));
  // The connect page renders for a live link and refuses an unknown one.
  const e = testEnv({ META_APP_ID: '1234', META_ES_CONFIG_ID: '5678' });
  const pageRes = await api('GET', `/connect/${token}`, { env: e });
  assert.equal(pageRes.status, 200);
  assert.match(pageRes.body, /Connect WhatsApp/);
  assert.equal((await api('GET', '/connect/notarealtoken123', { env: e })).status, 404);
});

test('admin: embedded signup writes waNumbers', async () => {
  const e = testEnv({ META_APP_ID: 'app-1', META_APP_SECRET: 'test-app-secret' });
  const { createSignupSession } = await import('../src/services/signup');
  const link = await createSignupSession(db, getConfig(e), fx.b.id);
  const token = link.split('/connect/')[1];
  await db.update(db.doc('businesses', fx.b.id), { status: 'onboarding' });

  const calls: string[] = [];
  const fakeMeta: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url.replace(/client_secret=[^&]+/, 'client_secret=***')}`);
    if (url.includes('/oauth/access_token')) return Response.json({ access_token: 'merchant-business-token' });
    if (url.endsWith('/phone_numbers')) return Response.json({ data: [{ id: '1098765432101', display_phone_number: '+234 809 000 0002' }] });
    if (url.endsWith('/subscribed_apps')) return Response.json({ success: true });
    return new Response('{}', { status: 404 });
  };
  const body = { token, code: 'AQ-embedded-signup-code', wabaId: '2233445566', phoneNumberId: '1098765432101' };
  const res = await api('POST', '/api/v1/signup/complete', { body, env: e, fetch: fakeMeta });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const account = await doc('channelAccounts', 'whatsapp_1098765432101');
  assert.equal(account.businessId, fx.b.id, 'the number now routes to business B');
  const conn = await doc('whatsappConnections', fx.b.id);
  assert.equal(conn.phoneNumberId, '1098765432101');
  assert.notEqual(conn.accessTokenEncrypted, 'merchant-business-token');
  assert.equal(decrypt(conn.accessTokenEncrypted, getConfig(e)), 'merchant-business-token');
  assert.equal((await doc('businesses', fx.b.id)).status, 'active');
  assert.ok(calls.some(c => c.startsWith('POST') && c.endsWith('/2233445566/subscribed_apps')));
  assert.ok(await doc('outbox', `${fx.b.id}_connected`), 'the owner is told it worked');

  // One-time link; and a number already used by another business can't be claimed.
  assert.equal((await api('POST', '/api/v1/signup/complete', { body, env: e, fetch: fakeMeta })).status, 400);
  const other = (await createSignupSession(db, getConfig(e), fx.a.id)).split('/connect/')[1];
  const steal = await api('POST', '/api/v1/signup/complete', { body: { ...body, token: other }, env: e, fetch: fakeMeta });
  assert.equal(steal.status, 400);
  assert.equal(steal.body.error.code, 'NUMBER_IN_USE');
  // A number that isn't in the shared WABA is refused.
  const third = (await createSignupSession(db, getConfig(e), fx.a.id)).split('/connect/')[1];
  assert.equal((await api('POST', '/api/v1/signup/complete', { body: { ...body, token: third, phoneNumberId: '99999999' }, env: e, fetch: fakeMeta })).body.error.code, 'NUMBER_NOT_IN_WABA');
});

test('admin: owner commands manage stock, orders and payment details', async () => {
  const bot = new Bot();
  const o = fx.a.ownerPhone.slice(1);
  assert.match((await bot.send('admin', { from: o, text: `restock Product ${fx.a.id} 7` }))[0].text, /\+7, now 12 in stock/);
  assert.match((await bot.send('admin', { from: o, text: `sold 2 Product ${fx.a.id}` }))[0].text, /-2, now 10 in stock/);
  assert.match((await bot.send('admin', { from: o, text: `price Product ${fx.a.id} 1,200` }))[0].text, /now ₦1,200 \(was ₦1,000\)/);
  assert.match((await bot.send('admin', { from: o, text: 'payment details GTBank 0123456789 Business A' }))[0].text, /GTBank 0123456789/);
  assert.equal((await doc('businesses', fx.a.id)).paymentDetails, 'GTBank 0123456789 Business A');
  assert.match((await bot.send('admin', { from: o, text: 'delivery zone Lekki, 1500, same day' }))[0].text, /Delivery to Lekki: ₦1,500, same day/);
  assert.match((await bot.send('admin', { from: o, text: 'sales today' }))[0].text, /^Today: 0 paid orders/);
});

test('admin: delete my data removes the owner account after confirmation', async () => {
  const bot = new Bot();
  const o = '2348035559999';
  for (const text of ['hi', 'Tayo', 'Shop To Delete']) await bot.send('admin', { from: o, text });
  await bot.send('admin', { from: o, choice: 'btype:other', text: 'Other' });
  await bot.send('admin', { from: o, text: 'Lagos, Ikeja' });
  await passBranding(bot, o);
  const { businessId } = await doc('ownerPhones', `+${o}`);
  await bot.send('admin', { from: o, choice: 'cat:use', text: 'Use these' });
  await bot.send('admin', { from: o, choice: 'cat:ok', text: 'Looks good' });
  await bot.send('admin', { from: o, text: 'Gift box 5000' });
  await bot.send('admin', { from: o, text: 'done' });
  await db.set(db.doc('channelAccounts', 'whatsapp_555'), { businessId, channel: 'whatsapp', accountId: '555' });
  assert.match((await bot.send('admin', { from: o, text: 'delete my data' }))[0].text, /Delete your Relay account\?/);
  const done = await bot.send('admin', { from: o, text: 'YES' });
  const code = /Reference: (DEL-[A-Z0-9]+)/.exec(done[0].text)?.[1];
  assert.ok(code);
  assert.equal(await doc('ownerPhones', `+${o}`), null);
  assert.equal(await doc('channelAccounts', 'whatsapp_555'), null, 'the bots stop for that number');
  const b = await doc('businesses', businessId);
  assert.equal(b.status, 'deleted');
  assert.equal(b.ownerPhone, null);
  assert.equal(await doc('conversations', `admin_${o}`), null);
  assert.equal((await doc('deletionRequests', code!)).kind, 'owner');
});

test('meta: data deletion callback verifies the signed request', async () => {
  const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '1234567890', issued_at: 1 })).toString('base64url');
  const sig = crypto.createHmac('sha256', 'test-app-secret').update(payload).digest('base64url');
  const post = (signed: string) => api('POST', '/api/v1/meta/data-deletion', { raw: new URLSearchParams({ signed_request: signed }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, env });
  const ok = await post(`${sig}.${payload}`);
  assert.equal(ok.status, 200);
  assert.match(ok.body.confirmation_code, /^DEL-/);
  assert.match(ok.body.url, /data-deletion\?code=DEL-/);
  assert.equal((await doc('deletionRequests', ok.body.confirmation_code)).metaUserId, '1234567890');
  assert.equal((await post(`${'A'.repeat(43)}.${payload}`)).status, 400);
});
