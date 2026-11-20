// Order tracking: the customer sees a step tracker for each open order with the rider and arrival
// time; the owner adds both in one line when an order goes out for delivery.
import { Bot, clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { parseRider, stepper } from '../src/services/tracking';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
let owner: string;
const PHONE = '2348077400001';
let customerId: string;
const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const order = (id: string, ref: string, status: string, fulfilment: string, extra: Record<string, unknown> = {}) =>
  db.set(db.doc('orders', id), { id, ref, businessId: fx.a.id, customerId, channel: 'whatsapp', items: [{ productId: fx.a.product, name: 'Ankara Top (12)', priceKobo: 1_850_000, qty: 1 }], subtotalKobo: 1_850_000, deliveryFeeKobo: 250_000, feeKobo: 0, uniqueKobo: 0, payAmountKobo: 2_100_000, status, fulfilment, delivery: { method: 'self_arranged', feeKobo: 250_000, address: 'Ikeja' }, holdExpiresAt: at(-30), createdAt: at(60), updatedAt: at(60), ...extra });

before(async () => {
  await clearFirestore();
  fx = await seed();
  owner = fx.a.ownerPhone.slice(1);
  customerId = `${fx.a.id}_wa_${PHONE}`;
  await saveWhatsAppConnection(db, getConfig(env), { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
  await db.set(db.doc('customers', customerId), { id: customerId, businessId: fx.a.id, channel: 'whatsapp', phone: PHONE, name: 'Tolu', marketingOptIn: false, orderCount: 2, totalSpentKobo: 0, createdAt: at(999), updatedAt: at(1) });
});

test('tracking: the rider and arrival time are read from the owner\'s own words', () => {
  assert.deepEqual(parseRider('Musa 0803 123 4567, 1 hour'), { rider: { name: 'Musa', phone: '0803 123 4567' }, eta: 'about 1 hour' });
  assert.deepEqual(parseRider('with Tunde, e go reach by 3pm'), { rider: { name: 'Tunde', phone: null }, eta: 'by 3pm' });
  assert.deepEqual(parseRider('+2348091234567 30mins'), { rider: { name: null, phone: '0809 123 4567' }, eta: 'about 30 minutes' });
  assert.deepEqual(parseRider('tomorrow morning'), { rider: null, eta: 'tomorrow morning' });
});

test('tracking: Out for delivery asks who is taking it; one line gives the rider and arrival time, and the customer is told', async () => {
  await order('tr-1', 'RLY-TR001', 'paid', 'pending');
  const bot = new Bot();
  // Mark ready → the next button is Out for delivery.
  const ready = await bot.send('admin', { from: owner, choice: 'act:ready:RLY-TR001', text: 'Mark ready' });
  assert.deepEqual(ready[0].options, ['act:out:RLY-TR001', 'act:orders', 'act:menu']);
  const ask = await bot.send('admin', { from: owner, choice: 'act:out:RLY-TR001', text: 'Out for delivery' });
  assert.match(ask[0].text, /Who's taking \*RLY-TR001\*, and when should it arrive\?/);
  assert.deepEqual(ask[0].options, ['act:outskip:RLY-TR001', 'act:cancel', 'act:menu']);
  const done = await bot.send('admin', { from: owner, text: 'Musa 0803 123 4567, 1 hour' });
  assert.match(done[0].text, /RLY-TR001: out for delivery\. Rider: Musa, 0803 123 4567, arriving about 1 hour\. The customer has been told\./);
  assert.deepEqual(done[0].options, ['act:delivered:RLY-TR001', 'act:orders', 'act:menu']);
  const saved = await doc('orders', 'tr-1');
  assert.equal(saved.fulfilment, 'out_for_delivery');
  assert.deepEqual(saved.rider, { name: 'Musa', phone: '0803 123 4567' });
  assert.equal(saved.eta, 'about 1 hour');
  assert.ok(saved.readyAt && saved.outAt);
  const told = await doc('outbox', 'tr-1_out_for_delivery');
  assert.match(told.text, /Left the shop at \d{2}:\d{2} · Rider: Musa, 0803 123 4567\nArriving about 1 hour$/);

  // Typed in one go, in Pidgin; Skip works too.
  await order('tr-2', 'RLY-TR002', 'paid', 'ready');
  const typed = await bot.send('admin', { from: owner, text: 'RLY-TR002 don leave with Kunle 07012345678, by 3pm' });
  assert.match(typed[0].text, /RLY-TR002: out for delivery\. Rider: Kunle, 0701 234 5678, arriving by 3pm\./);
  await order('tr-3', 'RLY-TR003', 'paid', 'ready');
  await bot.send('admin', { from: owner, choice: 'act:out:RLY-TR003', text: 'Out for delivery' });
  const skipped = await bot.send('admin', { from: owner, choice: 'act:outskip:RLY-TR003', text: 'Skip' });
  assert.match(skipped[0].text, /RLY-TR003: out for delivery\./);
  assert.equal((await doc('orders', 'tr-3')).rider ?? null, null);
});

test('tracking: "where is my order?" shows each open order with its steps, rider and arrival time', async () => {
  await db.update(db.doc('orders', 'tr-3'), { fulfilment: 'delivered', deliveredAt: at(1) });
  await order('tr-4', 'RLY-TR004', 'awaiting_payment', 'pending', { createdAt: at(2) });
  const bot = new Bot();
  const c = { from: PHONE, to: fx.a.pnid };
  for (const ask of ['where is my order?', 'abeg where the rider dey?', 'when e go reach?']) {
    const out = await bot.send('shop', { ...c, text: ask });
    assert.equal(out.length, 1, ask);
    const text = out[0].text;
    assert.match(text, /💸 \*RLY-TR004\* · Ankara Top \(12\)\nWaiting for payment of ₦21,000/, 'unpaid order first (newest)');
    assert.match(text, /📦 \*RLY-TR001\* · Ankara Top \(12\)\n✅ Paid  ✅ Ready  🛵 \*Out for delivery\*  ⬜ Delivered\nLeft the shop at \d{2}:\d{2} · Rider: Musa, 0803 123 4567\nArriving about 1 hour/);
    assert.match(text, /RLY-TR002[\s\S]*Arriving by 3pm/);
    assert.ok(!text.includes('RLY-TR003'), 'a delivered order is no longer open');
    assert.deepEqual(out[0].options, ['track', 'menu']);
  }
  // Nothing open: the last order is shown, delivered.
  for (const id of ['tr-1', 'tr-2']) await db.update(db.doc('orders', id), { fulfilment: 'delivered', deliveredAt: at(0) });
  await db.update(db.doc('orders', 'tr-4'), { status: 'expired' });
  const last = await bot.send('shop', { ...c, text: 'track my order' });
  assert.match(last[0].text, /This order was not paid in time|Delivered at \d{2}:\d{2}/);
  // Pickup orders have their own steps.
  assert.equal(stepper({ fulfilment: 'ready', delivery: { method: 'pickup', feeKobo: 0 } } as never), '✅ Paid  📦 *Ready for pickup*  ⬜ Picked up');
});
