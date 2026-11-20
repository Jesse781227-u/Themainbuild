import { Bot, clearFirestore, db, doc, env, seed, signUp } from './helpers';
import { createApp } from '../src/app';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

before(async () => { await clearFirestore(); await seed(); });

test('TEST: the owner shops in their own shop from the Relay chat; nothing real is created', async () => {
  const bot = new Bot();
  const from = '2348036661111';
  const { businessId, last } = await signUp(bot, from, { shop: 'Tolu Treats', product: 'Chin chin 1500' });
  assert.deepEqual(last.at(-1)!.options, ['test:start', 'ob:connect']);
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Tolu' });

  const start = await say('Test my shop', 'test:start');
  assert.match(start[0].text, /🧪 \*Test mode\.\* You're now a customer of Tolu Treats/);
  assert.match(start[1].text, /Tolu Treats|Chin chin/, 'the shop greets the owner like a customer');
  assert.ok(start.every(m => m.phoneNumberId === 'pn-admin'), 'replies come from the Relay chat');

  const added = await say('Buy', `buy:${(await db.query('products', [['businessId', '==', businessId]]))[0]._id}`);
  assert.match(added[0].text, /Added 1 × Chin chin[\s\S]*Subtotal: ₦1,500/);
  const confirm = await say('Checkout', 'checkout');
  assert.match(confirm[0].text, /Please confirm your order[\s\S]*Service fee: ₦68\.53/);
  const pay = await say('Confirm order', 'confirm');
  assert.match(pay[0].text, /🧪 Test order TEST-[A-Z0-9]{4}: ₦1,568\.53/);
  const token = pay[0].options[0].slice('testpay:'.length);

  const paid = await say('Pay (test)', `testpay:${token}`);
  const receipt = paid[0].content as { type: string; link: string; caption: string; filename: string };
  assert.equal(receipt.type, 'document');
  assert.match(receipt.filename, /^Receipt-TEST-[A-Z0-9]{4}\.pdf$/);
  assert.match(paid[1].text, /You'd also get a \*Paid\* alert[\s\S]*Relay's fee on this order: ₦68\.53, paid by the customer\. You'd receive ₦1,500/);
  const pdf = await createApp().request(new URL(receipt.link).pathname, {}, env);
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

  // Nothing real: no orders, no stock holds, no owner alerts, no customer record.
  assert.equal((await db.query('orders', [['businessId', '==', businessId]])).length, 0);
  assert.equal((await db.query('outbox', [['businessId', '==', businessId]])).length, 0);
  assert.equal((await db.query('customers', [['businessId', '==', businessId]])).length, 0);

  const back = await say('EXIT');
  assert.match(back[0].text, /You're back with Relay 👋[\s\S]*Ready to connect/);
  assert.deepEqual(back[0].options, ['ob:connect', 'test:start']);
  assert.equal((await doc('conversations', `admin_${from}`)).testMode, null);
  assert.match((await say('Connect now', 'ob:connect'))[0].text, /Is your shop's number on the \*WhatsApp Business\* app/, 'signup carries on where it was');
});

test('TEST: when the owner pays the fee, customers see the shop\'s prices only', async () => {
  const bot = new Bot();
  const from = '2348036662222';
  const { businessId } = await signUp(bot, from, { shop: 'Owner Pays', product: 'Gift box 10000' });
  await db.update(db.doc('businesses', businessId), { feePayer: 'owner' });
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice });
  await say('TEST');
  const [p] = await db.query('products', [['businessId', '==', businessId]]);
  await say('Buy', `buy:${p._id}`);
  const confirm = await say('Checkout', 'checkout');
  assert.doesNotMatch(confirm[0].text, /Service fee/);
  assert.match(confirm[0].text, /Total: ₦10,000\n/);
  const pay = await say('Confirm order', 'confirm');
  assert.match(pay[0].text, /₦10,000\./);
  const paid = await say('Pay (test)', pay[0].options[0]);
  assert.match(paid[1].text, /Relay's fee on this order: ₦450, paid by you\. You'd receive ₦9,550/);
});
