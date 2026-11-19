import { Bot, clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveInstagramConnection, saveWhatsAppConnection } from '../src/services/whatsapp';
import { saveZone } from '../src/services/delivery';
import { recentOrders } from '../src/services/orders';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
const cfg = getConfig(env);
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, cfg, { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
  await db.set(db.doc('categories', 'cat-food'), { id: 'cat-food', businessId: fx.a.id, name: 'Food', sortOrder: 1 });
  await db.update(db.doc('products', fx.a.product), { categoryId: 'cat-food', stock: 50 });
  await db.update(db.doc('businesses', fx.a.id), { paymentDetails: 'GTBank 0123456789 Business A' });
});

const shop = (bot: Bot, from: string, o: { text?: string; choice?: string; name?: string } = {}) => bot.send('shop', { from, to: fx.a.pnid, ...o });
const convId = (phone: string) => `${fx.a.id}_wa_${phone}`;

test('shop: with one category the greeting goes straight to its products', async () => {
  const bot = new Bot();
  const [r] = await shop(bot, '2348091110001', { text: 'Hello', name: 'Chidi Okafor' });
  assert.equal(r.phoneNumberId, fx.a.pnid, "replies come from the merchant's own number");
  assert.equal(r.to, '+2348091110001');
  assert.match(r.text, /^Hi Chidi, welcome to Business biz-a 👋\n\n\*Product biz-a\*\n₦1,000/);
  assert.deepEqual(r.options, [`buy:${fx.a.product}`, 'menu', 'cart']);
});

test('shop: checkout flow creates order awaiting payment', async () => {
  const bot = new Bot();
  const me = '2348091110002';
  await shop(bot, me, { text: 'hi' });
  assert.deepEqual((await shop(bot, me, { choice: 'cat:cat-food', text: 'Food' }))[0].options, [`buy:${fx.a.product}`, 'menu', 'cart']);
  const cart = await shop(bot, me, { text: '1' }); // typed number picks the first option (Buy)
  assert.match(cart[0].text, /Added 1 × Product biz-a\.[\s\S]*Subtotal: ₦1,000/);
  const more = await shop(bot, me, { text: '2 product biz-a' });
  assert.match(more[0].text, /• 3 × Product biz-a: ₦3,000/);
  // No delivery zones yet → pickup confirmation directly.
  const confirm = await shop(bot, me, { choice: 'checkout', text: 'Checkout' });
  assert.match(confirm[0].text, /Pickup: free\nService fee: ₦30\nTotal: ₦3,030\n/);
  const stockBefore = (await doc('products', fx.a.product)).stock;
  const paid = await shop(bot, me, { choice: 'confirm', text: 'Confirm order' });
  // Test environments use simulated payments: a "Pay ₦X" button to the payment page.
  assert.equal((paid[0].content as unknown as { interactive: { type: string } }).interactive.type, 'cta_url');
  assert.match(paid[0].text, /Order RLY-[A-Z0-9]{5}\n3 × Product biz-a\n\nTotal: \*₦3,0\d\d(\.\d\d)?\*[\s\S]*holding your items for 30 minutes\.\nPay ₦3,0[\d.,]*: https?:\/\/[^/]+\/pay\/[A-Za-z0-9]+/);

  const [order] = await recentOrders(db, [['customerId', '==', convId(me)]], 1);
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.subtotalKobo, 300_000);
  assert.equal(order.feeKobo, 3_000);
  assert.equal((await doc('products', fx.a.product)).stock, stockBefore - 3, 'stock is reserved');
  assert.equal(await doc('carts', convId(me)), null, 'the cart became the order');
  assert.ok(await doc('outbox', `${fx.a.id}_order_placed_${order.id}`), 'the owner is told');
  assert.match((await shop(bot, me, { text: 'where is my order' }))[0].text, new RegExp(`Order ${order.ref}: waiting for payment`));
});

test('shop: delivery is quoted from the merchant zones', async () => {
  await saveZone(db, { id: 'z-lekki', businessId: fx.a.id, name: 'Lekki', match: 'lekki', feeKobo: 150_000, timeframe: 'same day', active: true });
  const bot = new Bot();
  const me = '2348091110003';
  await shop(bot, me, { choice: `add:${fx.a.product}`, text: 'Add to cart' });
  assert.deepEqual((await shop(bot, me, { text: 'checkout' }))[0].options, ['deliver', 'pickup']);
  assert.match((await shop(bot, me, { choice: 'deliver', text: 'Delivery' }))[0].text, /delivery address/);
  assert.match((await shop(bot, me, { text: 'Ikeja GRA' }))[0].text, /doesn't deliver to "Ikeja GRA"/);
  await shop(bot, me, { choice: 'deliver', text: 'Delivery' });
  const c = await shop(bot, me, { text: '5 Admiralty Way, Lekki Phase 1' });
  assert.match(c[0].text, /Delivery \(5 Admiralty Way, Lekki Phase 1\): ₦1,500, same day\nService fee: ₦10\n/);
  await shop(bot, me, { text: 'yes' });
  const [order] = await recentOrders(db, [['customerId', '==', convId(me)]], 1);
  assert.equal(order.deliveryFeeKobo, 150_000);
  assert.equal(order.feeKobo, 1_000, 'no Relay fee on delivery');
  await db.delete(db.doc('deliveryZones', 'z-lekki'));
});

test('shop: returning customer is recognised', async () => {
  await db.update(db.doc('customers', fx.a.customer), { orderCount: 2, name: 'Ada Eze' });
  const [r] = await shop(new Bot(), '2348090000001', { text: 'hi', name: 'Ada Eze' });
  assert.match(r.text, /^Welcome back, Ada! 👋/);
});

test('shop: off-topic and unknown products are handled without guessing', async () => {
  const bot = new Bot();
  const me = '2348091110004';
  assert.match((await shop(bot, me, { text: '3 shawarma' }))[0].text, /welcome to Business biz-a/, 'without an LLM, unknown text shows the menu');
  const llmBot = new Bot({ async chooseTool() { return { tool: 'offTopic', args: {} }; } });
  assert.match((await shop(llmBot, me, { text: 'who will win the election?' }))[0].text, /only help with our products and your orders/);
});

test('takeover: owner reply silences the bot', async () => {
  const bot = new Bot();
  const me = '2348091110005';
  assert.equal((await shop(bot, me, { text: 'hi' })).length, 1);
  // The owner answers from the WhatsApp Business app (coexistence echo).
  assert.equal((await bot.send('echo', { from: me, to: fx.a.pnid, text: 'Hi, this is Tola, how can I help?' })).length, 0);
  assert.equal((await doc('conversations', convId(me))).mode, 'owner');
  assert.equal((await shop(bot, me, { text: 'I want 2 jollof' })).length, 0, 'the bot stays silent');
  assert.equal((await shop(bot, me, { text: 'hello?' })).length, 0);
  assert.ok((await doc('conversations', convId(me))).lastInboundAt, 'the window is still tracked');

  // A customer can also ask for a person.
  const other = '2348091110006';
  const r = await shop(bot, other, { text: 'Please let me talk to a human' });
  assert.match(r[0].text, /I've let Business biz-a know/);
  assert.equal((await doc('conversations', convId(other))).mode, 'owner');
  assert.equal((await shop(bot, other, { text: 'hi' })).length, 0);
});

test('takeover: handback resumes the bot', async () => {
  const bot = new Bot();
  const owner = fx.a.ownerPhone.slice(1);
  const one = '2348091110005';
  const r = await bot.send('admin', { from: owner, text: `handback ${one}` });
  assert.match(r[0].text, /answering that chat again/);
  assert.equal((await doc('conversations', convId(one))).mode, 'bot');
  assert.equal((await doc('conversations', convId('2348091110006'))).mode, 'owner', 'other chats stay with the owner');
  assert.equal((await shop(bot, one, { text: 'hi' })).length, 1, 'the bot answers again');
  assert.match((await bot.send('admin', { from: owner, text: 'handback' }))[0].text, /answering that chat again/);
  assert.equal((await doc('conversations', convId('2348091110006'))).mode, 'bot');
  assert.match((await bot.send('admin', { from: owner, text: 'handback' }))[0].text, /already answering all your chats/);
});

test('instagram: DM routes to the shop handler', async () => {
  await saveInstagramConnection(db, cfg, { businessId: fx.a.id, igAccountId: 'ig-a', accessToken: 'ig-token' });
  const bot = new Bot();
  const [r] = await bot.send('instagram', { from: 'igsid-42', to: 'ig-a', text: 'hi' });
  assert.equal(r.channel, 'instagram');
  assert.equal(r.phoneNumberId, 'ig-a');
  assert.equal(r.to, 'igsid-42');
  // Instagram has no buttons or carousels: the same message arrives as numbered text.
  assert.match(r.text, /welcome to Business biz-a 👋[\s\S]*Product biz-a[\s\S]*1\. Add to cart\n2\. Browse the shop\n3\. My cart\nReply with a number\./);
  const [added] = await bot.send('instagram', { from: 'igsid-42', to: 'ig-a', text: '1' });
  assert.match(added.text, /Added 1 × Product biz-a/);
  assert.equal((await doc('conversations', `${fx.a.id}_ig_igsid42`)).channel, 'instagram');
});

test('shop: delete my data removes the customer after confirmation', async () => {
  const bot = new Bot();
  const me = '2348091110007';
  await shop(bot, me, { choice: `add:${fx.a.product}`, text: 'Add to cart', name: 'Bisi' });
  assert.ok(await doc('customers', convId(me)));
  assert.deepEqual((await shop(bot, me, { text: 'delete my data' }))[0].options, ['delete_yes', 'delete_no']);
  const done = await shop(bot, me, { choice: 'delete_yes', text: 'Yes, delete' });
  const ref = /Reference: (DEL-[A-Z0-9]+)/.exec(done[0].text)?.[1];
  assert.ok(ref);
  assert.equal(await doc('customers', convId(me)), null);
  assert.equal(await doc('conversations', convId(me)), null);
  assert.equal(await doc('carts', convId(me)), null);
  const events = await db.query('inboundEvents', [['from', '==', `+${me}`]]);
  assert.equal(events.length, 0, 'webhook logs no longer hold the number');
  assert.equal((await doc('deletionRequests', ref!)).kind, 'shopper');
});
