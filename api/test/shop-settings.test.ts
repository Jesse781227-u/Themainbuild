import { Bot, clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, getConfig(env), { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
});

const CLOSED_ALL_WEEK = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };
const ALWAYS_OPEN = Object.fromEntries(Object.keys(CLOSED_ALL_WEEK).map(d => [d, { open: '00:00', close: '23:59' }]));
const shop = (bot: Bot, from: string, text: string, choice?: string) => bot.send('shop', { from, to: fx.a.pnid, text, choice, name: 'Kemi Ade' });
const setBiz = (patch: Record<string, unknown>) => db.update(db.doc('businesses', fx.a.id), patch);

test('shop: closed shops say so; "take orders" lets customers order, "menu only" does not', async () => {
  const bot = new Bot();
  await setBiz({ hours: CLOSED_ALL_WEEK, afterHours: 'orders' });
  const hi = await shop(bot, '2348091112001', 'hi');
  assert.match(hi[0].text, /🌙 We're closed right now\. You can still order, and we'll get it ready when we open\./);
  await shop(bot, '2348091112001', 'Buy', `buy:${fx.a.product}`);
  assert.match((await shop(bot, '2348091112001', 'Checkout', 'checkout'))[0].text, /Please confirm your order/);

  await setBiz({ afterHours: 'menu' });
  const menu = await shop(bot, '2348091112002', 'hi');
  assert.match(menu[0].text, /closed right now\. Have a look at what we have meanwhile/);
  await shop(bot, '2348091112002', 'Buy', `buy:${fx.a.product}`);
  assert.match((await shop(bot, '2348091112002', 'Checkout', 'checkout'))[0].text, /Sorry, we're closed right now\. Your cart is saved/);
  await setBiz({ hours: null, afterHours: 'orders' });
});

test('shop: questions about policies, hours, location and delivery are answered from the settings', async () => {
  const bot = new Bot();
  const me = '2348091112003';
  await setBiz({ policies: { returns: 'Exchange within 3 days if unworn.', issues: 'Tell us within 24 hours.' }, hours: ALWAYS_OPEN, area: 'Yaba', city: 'Lagos', fulfilment: 'both', shipsInterstate: true, interstatePricing: 'quote' });
  await db.set(db.doc('deliveryZones', 'z-yaba'), { id: 'z-yaba', businessId: fx.a.id, name: 'Yaba', match: 'Yaba', feeKobo: 150_000, timeframe: '', active: true, priority: 2 });
  await db.set(db.doc('deliveryZones', 'z-lagos'), { id: 'z-lagos', businessId: fx.a.id, name: 'Lagos', match: 'Lagos', feeKobo: 300_000, timeframe: '', active: true });
  assert.match((await shop(bot, me, 'Can I return it if it does not fit?'))[0].text, /Our policy at Business biz-a:\n• Exchange within 3 days if unworn\.\n• Tell us within 24 hours\./);
  assert.match((await shop(bot, me, 'what time do you close?'))[0].text, /Our opening hours: Every day midnight–11:59pm\. We're open now\./);
  assert.match((await shop(bot, me, 'where are you located'))[0].text, /📍 Business biz-a: Yaba, Lagos\./);
  assert.match((await shop(bot, me, 'do you deliver'))[0].text, /• Yaba: ₦1,500\n• Lagos: ₦3,000\n• Other states: price confirmed per order\nPickup is free\./);

  // Delivery: the most specific zone wins; anywhere else is quoted by the shop.
  await shop(bot, me, 'Buy', `buy:${fx.a.product}`);
  await shop(bot, me, 'Checkout', 'checkout');
  await shop(bot, me, 'Delivery', 'deliver');
  assert.match((await shop(bot, me, '12 Herbert Macaulay Way, Yaba, Lagos'))[0].text, /Delivery to \*Yaba\*: ₦1,500\n📍 12 Herbert Macaulay Way, Yaba, Lagos/);
  await shop(bot, me, 'Not yet', 'menu');
  await shop(bot, me, 'Checkout', 'checkout');
  await shop(bot, me, 'Delivery', 'deliver');
  assert.match((await shop(bot, me, '5 Ring Road, Ibadan'))[0].text, /Delivery to you: delivery price to be confirmed by Business biz-a\n📍 5 Ring Road, Ibadan[\s\S]*Total: about ₦[\d,.]+ plus delivery/);
});

test('shop: pickup-only shops skip the delivery question and show the prep time', async () => {
  const bot = new Bot();
  await setBiz({ fulfilment: 'pickup', prepTime: '30–60 min' });
  await shop(bot, '2348091112004', 'Buy', `buy:${fx.a.product}`);
  const confirm = await shop(bot, '2348091112004', 'Checkout', 'checkout');
  assert.match(confirm[0].text, /Please confirm your order[\s\S]*Pickup: free, ready in about 30–60 min/);
  await setBiz({ fulfilment: 'delivery' });
  assert.match((await shop(bot, '2348091112004', 'Checkout', 'checkout'))[0].text, /Please send your delivery address/);
  await setBiz({ fulfilment: 'both', prepTime: null });
});

test('admin: HOURS, AFTER HOURS, POLICIES and FEE change the settings any time', async () => {
  const bot = new Bot();
  const o = fx.a.ownerPhone.slice(1);
  const say = (text: string, choice?: string) => bot.send('admin', { from: o, text, choice });
  assert.match((await say('hours Mon-Sat 8am-9pm, Sun closed'))[0].text, /^Mon–Sat 8am–9pm · Sun closed\. Correct\?/, 'checked before saving');
  assert.match((await say('Yes', 'hrv:ok'))[0].text, /Saved ✅ Mon–Sat 8am–9pm · Sun closed/);
  assert.match((await say('hours'))[0].text, /Your opening hours: Mon–Sat 8am–9pm · Sun closed/);
  assert.match((await say('hours whenever'))[0].text, /couldn't read those hours/);
  const ah = await say('after hours');
  assert.deepEqual(ah[0].options, ['ah:orders', 'ah:menu']);
  assert.match((await say('Menu only', 'ah:menu'))[0].text, /can't order/);
  assert.equal((await doc('businesses', fx.a.id)).afterHours, 'menu');
  assert.match((await say('policies: Swaps within 2 days. No refunds.'))[0].text, /Saved ✅/);
  assert.match((await say('policies'))[0].text, /Swaps within 2 days\. No refunds\./);
  const fee = await say('fee');
  assert.match(fee[0].text, /You only pay when you get paid: 4\.5% of each sale, at most ₦4,000/);
  assert.match((await say("I'll pay it", 'fee:owner'))[0].text, /You pay Relay's fee from now on/);
  assert.equal((await doc('businesses', fx.a.id)).feePayer, 'owner');
  assert.match((await say('Relay fee', 'act:fee'))[0].text, /Who should pay it\?/, 'settings are in the MENU now, not in HELP');
});

test('admin: the defaults signup no longer asks can be changed any time (NAME, PREP, OTHER STATES, GREETING)', async () => {
  const bot = new Bot();
  const o = fx.a.ownerPhone.slice(1);
  const say = (text: string, choice?: string) => bot.send('admin', { from: o, text, choice });
  await db.update(db.doc('businesses', fx.a.id), { shipsInterstate: false, interstatePricing: null });
  assert.match((await say('name Tola Bello'))[0].text, /I'll call you Tola/);
  assert.match((await say('prep'))[0].text, /Prep time: \*.+\*\. To change it, send e\.g\. \*PREP 30 minutes\*/);
  assert.match((await say('prep 45 minutes'))[0].text, /✅ Prep time: 45 minutes/);
  assert.match((await say('delivery'))[0].text, /Other states: no \(\*OTHER STATES\* to change\)/);
  const states = await say('other states');
  assert.deepEqual(states[0].options, ['act:osquote', 'act:osno']);
  assert.match((await say('Yes, I quote per order', 'act:osquote'))[0].text, /other states can order/);
  const biz = (await db.get(db.doc('businesses', fx.a.id)))!;
  assert.deepEqual([biz.ownerName, biz.prepTime, biz.shipsInterstate, biz.interstatePricing], ['Tola Bello', '45 minutes', true, 'quote']);
  assert.match(JSON.stringify((await say('greeting'))[0].content), /Pick a message/);
});
