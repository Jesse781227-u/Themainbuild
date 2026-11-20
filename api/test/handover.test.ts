// While the owner handles a chat, the customer is never met with silence and the owner is reminded.
import { Bot, clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { handoverSweep } from '../src/services/handover';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
let n = 0;
const phone = () => `2348077600${String(++n).padStart(3, '0')}`;
const conv = (p: string) => `${fx.a.id}_wa_${p}`;
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, getConfig(env), { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
  const iso = new Date().toISOString();
  await db.set(db.doc('products', 'fr'), { id: 'fr', businessId: fx.a.id, name: 'Fried Rice', description: '', priceKobo: 350_000, images: [], categoryId: null, available: true, stock: 20, lowStockThreshold: 2, createdAt: iso, updatedAt: iso, deletedAt: null });
});

test('handover: while the owner handles the chat, messages get a short note (at most every 10 minutes) and tracking still works', async () => {
  const bot = new Bot();
  const p = phone();
  const c = { from: p, to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'hi' });
  const [over] = await bot.send('shop', { ...c, text: 'I want to talk to the owner please' });
  assert.match(over.text, /They'll reply to you here shortly/);
  const saved = await doc('conversations', conv(p));
  assert.equal(saved.mode, 'owner');
  assert.equal(saved.handoverRequest, 'I want to talk to the owner please');
  // Right after the hand-over message: nothing more (no spam).
  assert.equal((await bot.send('shop', { ...c, text: 'hello?' })).length, 0);
  // Tracking still answers.
  const [track] = await bot.send('shop', { ...c, text: 'where is my order?' });
  assert.match(track.text, /don't have any orders/);
  // 10 minutes later: one note.
  await db.update(db.doc('conversations', conv(p)), { handoverAckAt: minsAgo(11) });
  const [note] = await bot.send('shop', { ...c, text: 'are you there?' });
  assert.equal(note.text, 'Business biz-a has your message and will reply here.');
  assert.equal((await bot.send('shop', { ...c, text: 'hello??' })).length, 0, 'then quiet again');
  // Closed: the note says when they open.
  await db.update(db.doc('businesses', fx.a.id), { hours: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(d => [d, { open: '03:00', close: '03:01' }])) });
  await db.update(db.doc('conversations', conv(p)), { handoverAckAt: minsAgo(11) });
  const [closed] = await bot.send('shop', { ...c, text: 'abeg una dey?' });
  assert.match(closed.text, /^Business biz-a don get your message\. Dem go open .+ and reply you here\.$/);
  await db.update(db.doc('businesses', fx.a.id), { hours: null });
});

test('handover: the owner is reminded at 10 and 30 minutes; at 45 the customer can carry on and the request stays with the owner', async () => {
  const bot = new Bot();
  const p = phone();
  const c = { from: p, to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'hi' });
  await bot.send('shop', { ...c, text: 'cancel my order' });
  const owner = async () => (await db.query('outbox', [['businessId', '==', fx.a.id], ['audience', '==', 'owner']])).filter(o => String(o.id).startsWith(conv(p))).map(o => String(o.text));

  await db.update(db.doc('conversations', conv(p)), { handoverAt: minsAgo(11) });
  await handoverSweep(db);
  assert.match((await owner())[0], /^⏰ .* has been waiting 10 minutes for your reply: "cancel my order"\. Reply in your WhatsApp Business app\.$/);
  await handoverSweep(db);
  assert.equal((await owner()).length, 1, 'once');

  await db.update(db.doc('conversations', conv(p)), { handoverAt: minsAgo(31) });
  await handoverSweep(db);
  assert.match((await owner()).find(t => /30 minutes/.test(t))!, /If you haven't replied in 15 minutes, I'll let them keep ordering and tracking with me; their request stays with you\./);

  await db.update(db.doc('conversations', conv(p)), { handoverAt: minsAgo(46) });
  await handoverSweep(db);
  const after = await doc('conversations', conv(p));
  assert.equal(after.mode, 'bot', 'the chat is back with Relay for new messages');
  assert.ok((await owner()).some(t => /^I've taken back the chat with .* Their request is still waiting for you: "cancel my order"/.test(t)));
  const told = (await db.query('outbox', [['conversationId', '==', conv(p)], ['kind', '==', 'handover_takeback']]))[0];
  assert.match(String(told.text), /hasn't replied yet\. Your message is with them, and you can still order or track your order here\./);
  // Asking to change the order again still goes to the owner.
  const [again] = await bot.send('shop', { ...c, text: 'cancel my order' });
  assert.match(again.text, /I can't change an order here, so I've passed this to/);
});

test('handover: once the owner replies, there are no reminders and no take-back', async () => {
  const bot = new Bot();
  const p = phone();
  const c = { from: p, to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'hi' });
  await bot.send('shop', { ...c, text: 'talk to the owner' });
  await db.update(db.doc('conversations', conv(p)), { handoverAt: minsAgo(50) });
  await bot.send('echo', { ...c, text: 'Hi, Ada here. How can I help?' });
  await handoverSweep(db);
  assert.equal((await doc('conversations', conv(p))).mode, 'owner');
  assert.equal((await db.query('outbox', [['conversationId', '==', conv(p)], ['kind', '==', 'handover_takeback']])).length, 0);
});

test('price: "how much be the fried rice? i want 2" offers Add 2 to cart, and it adds 2', async () => {
  const bot = new Bot();
  const p = phone();
  const c = { from: p, to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'hi' });
  const [m] = await bot.send('shop', { ...c, text: 'abeg how much be the fried rice? i want 2' });
  assert.match(m.text, /^\*Fried Rice\* na ₦3,500\./);
  assert.deepEqual(m.options, ['add:fr:2', 'menu']);
  assert.match(JSON.stringify(m.content), /Add 2 to cart/);
  await bot.send('shop', { ...c, choice: 'add:fr:2', text: 'Add 2 to cart' });
  assert.equal((await doc('carts', conv(p))).items[0].qty, 2);
});
