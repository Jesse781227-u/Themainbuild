import { Bot, clearFirestore, db, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { createCategories, createProduct } from '../src/services/catalog';
import { saveZone } from '../src/services/delivery';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

// A customer's first message: the welcome first, then an answer to what they actually said.
let fx: Awaited<ReturnType<typeof seed>>;
const ALWAYS_OPEN = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(d => [d, { open: '00:00', close: '23:59' }]));
const CLOSED_ALL_WEEK = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(d => [d, null]));
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, getConfig(env), { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
  await db.update(db.doc('products', fx.a.product), { available: false });
  await db.update(db.doc('businesses', fx.a.id), { name: "Tee's Thrift", category: 'fashion_retail', city: 'Lagos', area: 'Yaba', address: '12 Herbert Macaulay Way', landmark: 'Tejuosho Market', hours: ALWAYS_OPEN, afterHours: 'orders', fulfilment: 'both' });
  const [clothing, shoes] = await createCategories(db, fx.a.id, ['Clothing', 'Shoes']);
  for (const [name, price, cat] of [['Plaid Flannel Shirt', 650_000, clothing.id], ['Denim Jacket', 1_200_000, clothing.id], ['Black Ankle Boots', 1_500_000, shoes.id], ['Brown Chelsea Boots', 1_700_000, shoes.id], ['White Sneakers', 1_800_000, shoes.id]] as const) {
    await createProduct(db, { businessId: fx.a.id, name, priceKobo: price, categoryId: cat });
  }
  await saveZone(db, { id: 'z-yaba', businessId: fx.a.id, name: 'Yaba', match: 'Yaba', feeKobo: 150_000, timeframe: '', active: true, priority: 2 });
  await saveZone(db, { id: 'z-lagos', businessId: fx.a.id, name: 'Lagos', match: 'Lagos', feeKobo: 300_000, timeframe: '', active: true, priority: 1 });
});

let n = 0;
const first = (text: string) => new Bot().send('shop', { from: `23480912000${String(++n).padStart(2, '0')}`, to: fx.a.pnid, text, name: '' });
const carousel = (m: { content: unknown }) => (m.content as { interactive?: { type: string } }).interactive?.type === 'carousel';

test('first message: "hi" gets the welcome and three options, no carousel', async () => {
  const r = await first('hi');
  assert.equal(r.length, 1);
  assert.match(r[0].text, /^Hi! 👋 Welcome to \*Tee's Thrift\*\. How can we help you today\?\n/);
  assert.deepEqual(r[0].options, ['menu', 'ask', 'track']);
  assert.ok(!r.some(carousel));
});

test('first message: "do you have boots?" gets a short welcome and only the boots', async () => {
  const r = await first('do you have boots?');
  assert.equal(r.length, 1);
  assert.ok(carousel(r[0]));
  assert.match(r[0].text, /^Hi! 👋 Welcome to \*Tee's Thrift\*\./);
  assert.doesNotMatch(r[0].text, /How can we help/, 'the closing question goes when we answer straight away');
  assert.match(r[0].text, /Black Ankle Boots[\s\S]*Brown Chelsea Boots/);
  assert.doesNotMatch(r[0].text, /Flannel|Sneakers/);
  // Nothing like it: say so, and offer the shop.
  const none = await first('do you have ankara gowns?');
  assert.match(none[0].text, /Sorry, we don't have "ankara gowns" right now\./);
});

test('first message: "send menu" gets the welcome and the sections', async () => {
  const r = await first('send menu');
  assert.equal(r.length, 1);
  assert.ok(carousel(r[0]));
  assert.match(r[0].text, /^Hi! 👋 Welcome to \*Tee's Thrift\*\.\n\nHere's what we have 👇\n1\. Clothing/);
});

test('first message: "where una dey?" gets the address and hours, in light Pidgin', async () => {
  const r = await first('where una dey?');
  assert.match(r[0].text, /^Hi! 👋 Welcome to \*Tee's Thrift\*\.\n\nNa here we dey: 📍 12 Herbert Macaulay Way, Yaba, Lagos — near Tejuosho Market\.\nWe dey open /);
  assert.deepEqual(r[0].options, ['menu', 'ask']);
  assert.match(JSON.stringify(r[0].content), /See wetin we get/);
});

test('first message: "hi" when closed gets the closed message and can still browse', async () => {
  await db.update(db.doc('businesses', fx.a.id), { hours: CLOSED_ALL_WEEK });
  const r = await first('hi');
  assert.match(r[0].text, /Welcome to \*Tee's Thrift\*[\s\S]*🌙 We're closed right now\. You can still order, and we'll get it ready when we open\./);
  assert.deepEqual(r[0].options, ['menu', 'ask', 'track']);
  await db.update(db.doc('businesses', fx.a.id), { hours: ALWAYS_OPEN });
});

test('delivery: a Yaba address gets the Yaba price, not the Lagos one', async () => {
  const bot = new Bot();
  const me = '2348091209999';
  const [p] = (await db.query('products', [['businessId', '==', fx.a.id]])).filter(x => x.name === 'Denim Jacket');
  await bot.send('shop', { from: me, to: fx.a.pnid, choice: `buy:${p._id}`, text: 'Add to cart' });
  await bot.send('shop', { from: me, to: fx.a.pnid, choice: 'checkout', text: 'Checkout' });
  await bot.send('shop', { from: me, to: fx.a.pnid, choice: 'deliver', text: 'Deliver to me' });
  const c = await bot.send('shop', { from: me, to: fx.a.pnid, text: '12 Herbert Macaulay Way, Yaba, Lagos' });
  assert.match(c[0].text, /Delivery \(12 Herbert Macaulay Way, Yaba, Lagos\): ₦1,500/);
  // Pickup shows where.
  const pick = await bot.send('shop', { from: me, to: fx.a.pnid, choice: 'pickup', text: "I'll pick it up" });
  assert.match(pick[0].text, /📍 Pick up from: 12 Herbert Macaulay Way, Yaba, Lagos — near Tejuosho Market/);
});
