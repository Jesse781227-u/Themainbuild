import { api, Bot, clearFirestore, db, doc, seed, testEnv } from './helpers';
import { getWallet, requestPayout, settlePayout } from '../src/services/wallet';
import { markOrderPaid } from '../src/services/on-paid';
import type { Business } from '../src/domain/business';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });
const owner = () => fx.a.ownerPhone.slice(1);
const biz = async () => (await doc('businesses', fx.a.id)) as unknown as Business;
const at = () => new Date().toISOString();

test('wallet: older sales are counted from the ledger; a new payment is added at once', async () => {
  await db.set(db.doc('ledger', 'old-sale'), { id: 'old-sale', businessId: fx.a.id, type: 'sale', merchantNetKobo: 2_000_000, at: at() });
  assert.equal((await getWallet(db, fx.a.id)).availableKobo, 2_000_000);
  await db.set(db.doc('orders', 'o-w1'), { id: 'o-w1', ref: 'RLY-WALL1', businessId: fx.a.id, customerId: 'cust-w', channel: 'whatsapp', status: 'awaiting_payment', fulfilment: 'pending', items: [], subtotalKobo: 1_000_000, deliveryFeeKobo: 0, feeKobo: 10_000, uniqueKobo: 0, payAmountKobo: 1_010_000, delivery: null, holdExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: at(), updatedAt: at() });
  await markOrderPaid(db, 'o-w1', fx.a.id, 'cash-1');
  const w = await getWallet(db, fx.a.id);
  assert.equal(w.availableKobo, 3_000_000, 'the order total minus Relay\'s fee');
  assert.equal(w.lifetimeInKobo, 3_000_000);
});

test('verify: name → BVN → bank → account → read back → verified; the numbers are stored encrypted; a command interrupts it', async () => {
  const bot = new Bot();
  const say = (text: string, choice?: string) => bot.send('admin', { from: owner(), text, choice });
  const money = (await say('/wallet'))[0];
  assert.match(money.text, /Wallet: \*₦30,000\* available/);
  assert.equal(money.options[0], 'act:verify');
  await say('Verify now', 'act:verify');
  assert.deepEqual((await say('menu'))[0].options[0], 'act:orders', 'MENU instead of an answer leaves the flow');
  await say('verify');
  assert.match((await say('Ada'))[0].text, /first and last name/);
  assert.match((await say('Ada Obi'))[0].text, /2 of 4[\s\S]*BVN/);
  assert.match((await say('1234'))[0].text, /11 digits/);
  const banks = await say('2223 3344 455');
  assert.ok(banks[0].options.includes('bank:GTBank'));
  assert.match((await say('GTBank', 'bank:GTBank'))[0].text, /4 of 4/);
  const check = await say('0123456789');
  assert.match(check[0].text, /Name: \*Ada Obi\*\n• Bank: \*GTBank\*\n• Account: \*0123456789\*\n• BVN: ending 4455/);
  assert.match((await say("Yes, that's right", 'kyc:ok'))[0].text, /You're verified ✅ Withdrawals go to GTBank ••6789 \(ADA OBI\)/);
  const k = await doc('kyc', fx.a.id);
  assert.equal(k.status, 'verified');
  assert.doesNotMatch(JSON.stringify(k), /22233344455|0123456789/, 'BVN and account number are encrypted');
  assert.equal((await doc('conversations', `admin_${owner()}`)).kycDraft, null);
});

test('withdraw: minimum, daily limit, confirm once, paid at once in test mode', async () => {
  const bot = new Bot();
  const say = (text: string, choice?: string) => bot.send('admin', { from: owner(), text, choice });
  const start = await say('/withdraw');
  assert.deepEqual(start[0].options, ['wd:amt:3000000', 'wd:other', 'act:menu']);
  await say('Another amount', 'wd:other');
  assert.match((await say('500'))[0].text, /smallest withdrawal is ₦1,000/);
  await say('Another amount', 'wd:other');
  const ok = await say('10k');
  assert.match(ok[0].text, /^Send \*₦10,000\* to GTBank ••6789 \(ADA OBI\)\? No fee\./);
  const go = ok[0].options[0];
  assert.match((await say('Yes, send it', go))[0].text, /✅ Sent ₦10,000 to GTBank ••6789\. \(Test mode/);
  assert.match((await say('Yes, send it', go))[0].text, /expired/, 'a second tap sends nothing');
  assert.equal((await getWallet(db, fx.a.id)).availableKobo, 2_000_000);
  // The daily limit.
  await db.update(db.doc('businesses', fx.a.id), { payoutDailyLimitKobo: 1_500_000 });
  assert.deepEqual((await say('/withdraw'))[0].options[0], 'wd:amt:500000', 'only ₦5,000 left of today\'s ₦15,000');
  const r = await requestPayout(db, await biz(), 600_000);
  assert.deepEqual(r, { ok: false, reason: 'over_daily_limit', maxKobo: 500_000 });
  await db.update(db.doc('businesses', fx.a.id), { payoutDailyLimitKobo: null });
  assert.match((await say('history', 'act:payouts'))[0].text, /P-[A-Z0-9]+: ₦10,000 to GTBank ••6789 · paid ✅/);
});

test('internal: off without a key; Relay\'s team sees the account, marks payouts paid or failed (money back), and reviews KYC', async () => {
  const p = await requestPayout(db, await biz(), 200_000);
  assert.ok(p.ok);
  const id = p.ok ? p.payout.id : '';
  assert.equal((await api('GET', `/api/v1/internal/payouts/${id}`, {})).status, 404, 'off unless OPS_API_KEY is set');
  const e = testEnv({ OPS_API_KEY: 'k'.repeat(32) });
  const auth = { authorization: `Bearer ${'k'.repeat(32)}` };
  assert.equal((await api('GET', `/api/v1/internal/payouts/${id}`, { env: e, headers: { authorization: 'Bearer wrong' } })).status, 401);
  const seen = await api('GET', `/api/v1/internal/payouts/${id}`, { env: e, headers: auth });
  assert.equal(seen.body.bank.accountNumber, '0123456789');
  const before = (await getWallet(db, fx.a.id)).availableKobo;
  const failed = await api('POST', `/api/v1/internal/payouts/${id}`, { env: e, headers: auth, body: { status: 'failed', reason: 'Account closed' } });
  assert.equal(failed.body.payout.status, 'failed');
  assert.equal((await getWallet(db, fx.a.id)).availableKobo, before + 200_000, 'the money goes back');
  assert.match((await doc('outbox', `${fx.a.id}_payout_failed_${id}`)).text, /didn't go through \(Account closed\)\. The money is back in your wallet/);
  assert.equal((await api('POST', `/api/v1/internal/payouts/${id}`, { env: e, headers: auth, body: { status: 'paid' } })).status, 409, 'settled once');
  assert.deepEqual(await settlePayout(db, 'someone-else', id, { status: 'paid' }), { ok: false, reason: 'not_found' });
  const rejected = await api('POST', `/api/v1/internal/kyc/${fx.a.id}`, { env: e, headers: auth, body: { status: 'rejected', reason: 'Name does not match the account' } });
  assert.equal(rejected.body.status, 'rejected');
  assert.deepEqual(await requestPayout(db, await biz(), 200_000), { ok: false, reason: 'not_verified' });
});
