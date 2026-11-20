import { api, Bot, clearFirestore, db, doc, env, seed, testEnv } from './helpers';
import { getConfig, parseConfig } from '../src/config';
import { createApp } from '../src/app';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, getConfig(env), { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
  await db.update(db.doc('products', fx.a.product), { stock: 10 });
  await db.update(db.doc('businesses', fx.a.id), { paymentDetails: 'GTBank 0123456789 Business A', messages: { paymentThanks: 'Thank you {customer}! We got {amount} for {order} 💛' } });
});

const shop = (bot: Bot, from: string, o: { text?: string; choice?: string; name?: string }) => bot.send('shop', { from, to: fx.a.pnid, name: 'Kemi Ade', ...o });

async function orderUpTo(bot: Bot, me: string) {
  await shop(bot, me, { text: 'hi', name: 'Kemi Ade' });
  await shop(bot, me, { choice: `buy:${fx.a.product}`, text: 'Buy' });
  await shop(bot, me, { choice: 'checkout', text: 'Checkout' });
  const [pay] = await shop(bot, me, { choice: 'confirm', text: 'Confirm order' });
  const token = /\/pay\/([A-Za-z0-9]+)/.exec(pay.text)![1];
  return { pay, token };
}

test('payments: never simulated in production; production defaults to bank transfer', () => {
  const prod = { RELAY_ENV: 'production', FIREBASE_PROJECT_ID: 'p', FIREBASE_CLIENT_EMAIL: 'e', FIREBASE_PRIVATE_KEY: 'k', TOKEN_ENCRYPTION_KEY: 'a'.repeat(64), META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v'.repeat(16) };
  assert.equal(parseConfig(prod).PAYMENTS_MODE, 'transfer');
  assert.throws(() => parseConfig({ ...prod, PAYMENTS_MODE: 'simulated' }), /must not be "simulated" in production/);
  assert.equal(parseConfig({ RELAY_ENV: 'development' }).PAYMENTS_MODE, 'simulated');
});

test('payments: checkout sends a pay link; paying on the page marks the order paid and thanks the customer in the shop\'s words', async () => {
  const bot = new Bot();
  const me = '2348091119001';
  const { pay, token } = await orderUpTo(bot, me);
  assert.equal(pay.options.length, 0);
  await bot.send('admin', { from: fx.a.ownerPhone.slice(1), text: 'hi' }); // the owner's 24-hour window is open

  const page = await api('GET', `/pay/${token}`, {});
  assert.equal(page.status, 200);
  assert.match(page.body, /Business biz-a[\s\S]*Test payment\.[\s\S]*1 × Product biz-a[\s\S]*Pay ₦1,0/);

  assert.deepEqual((await api('POST', `/pay/${token}`, {})).body, { success: true });
  const link = await doc('payLinks', token);
  const order = await doc('orders', link.orderId);
  assert.equal(order.status, 'paid');
  assert.equal(order.paymentId, `sim_${token}`);

  // The queued messages go out: the shop's own thank-you to the customer, "Paid" to the owner.
  await bot.drain();
  const receipt = bot.transport.sent.map(m => m.content as { type: string; caption?: string; link?: string; filename?: string }).find(c => c.type === 'document');
  assert.ok(receipt, 'the thank-you comes with the PDF receipt');
  assert.match(receipt.caption!, /^Thank you Kemi! We got ₦1,0[\d.,]* for RLY-[A-Z0-9]{5} 💛$/);
  assert.equal(receipt.filename, `Receipt-${order.ref}.pdf`);
  assert.ok(receipt.link!.endsWith(`/receipts/${order.receiptToken}`));
  const pdf = await createApp().request(`/receipts/${order.receiptToken}`, {}, env);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await api('GET', '/receipts/notarealtokenatall123', {})).status, 404);

  const ownerPaid = await doc('outbox', `${order.id}_owner_paid`);
  assert.equal(ownerPaid.document.filename, `Receipt-${order.ref}.pdf`, 'the owner alert carries the receipt too');
  assert.match(ownerPaid.text, /Relay fee, paid by the customer: ₦[\d.,]+\. You receive ₦1,0/, 'the fee is never a surprise');
  assert.deepEqual(ownerPaid.buttons.map((b: { id: string }) => b.id), [`act:order:${order.ref}`, `act:ready:${order.ref}`, 'act:menu'], 'View order · Mark ready · Menu');
  const alert = bot.transport.sent.find(m => m.to === fx.a.ownerPhone && (m.content as any).interactive?.header?.type === 'document');
  assert.ok(alert, 'the owner gets the receipt on top of the buttons');
  assert.equal((alert!.content as any).interactive.header.document.filename, `Receipt-${order.ref}.pdf`);
  assert.match((await doc('outbox', `${fx.a.id}_first_sale`)).text, /🎉 You just made your first sale on Relay: ₦1,0[\d.,]*! Your money is safe in your Relay wallet[\s\S]*Reply \*VERIFY\*/);
  assert.match((await bot.send('admin', { from: fx.a.ownerPhone.slice(1), text: 'verify' }))[0].text, /Let's verify your account so you can withdraw[\s\S]*1 of 4/);
  const again = await bot.send('admin', { from: fx.a.ownerPhone.slice(1), text: `receipt ${order.ref}` });
  assert.equal((again[0].content as { type: string }).type, 'document');
  assert.match(again[0].text, new RegExp(`Receipt for ${order.ref}`));

  assert.deepEqual((await api('POST', `/pay/${token}`, {})).body, { success: true, alreadyPaid: true }, 'paying twice is harmless');
  assert.match((await api('GET', `/pay/${token}`, {})).body, /Payment successful/);
  assert.equal((await api('GET', '/pay/notarealtoken', {})).status, 404);
});

test('payments: an expired order can\'t be paid; transfer mode shows bank details instead', async () => {
  const bot = new Bot();
  const me = '2348091119002';
  const { token } = await orderUpTo(bot, me);
  await db.update(db.doc('payLinks', token), { expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const res = await api('POST', `/pay/${token}`, {});
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /expired/);
  assert.match((await api('GET', `/pay/${token}`, {})).body, /This order has expired/);

  // With PAYMENTS_MODE=transfer the page doesn't exist.
  assert.equal((await api('GET', `/pay/${token}`, { env: testEnv({ PAYMENTS_MODE: 'transfer' }) })).status, 404);
});

test('payments: owner order updates reach the customer in the shop\'s words', async () => {
  const bot = new Bot();
  const me = '2348091119003';
  const { token } = await orderUpTo(bot, me);
  await api('POST', `/pay/${token}`, {});
  await bot.drain();
  const order = await doc('orders', (await doc('payLinks', token)).orderId);
  const owner = fx.a.ownerPhone.slice(1);
  const ready = await bot.send('admin', { from: owner, text: `${order.ref} ready` });
  assert.match(ready[0].text, /ready\. The customer has been told\./);
  const sent = bot.transport.sent.map(m => ({ to: m.to, text: (m.content as { text?: string }).text ?? '' }));
  assert.ok(sent.some(m => m.to === `+${me}` && new RegExp(`Good news Kemi! Your order ${order.ref} is ready for pickup at Business biz-a\\.`).test(m.text)), JSON.stringify(sent.slice(-3)));
});
