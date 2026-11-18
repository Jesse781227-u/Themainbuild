import { api, Bot, clearFirestore, db, doc, env, seed, testEnv } from './helpers';
import { getConfig, parseConfig } from '../src/config';
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
  const sent = bot.transport.sent.map(m => (m.content as { text?: string }).text ?? '');
  assert.ok(sent.some(t => /^Thank you Kemi! We got ₦1,0[\d.,]* for RLY-[A-Z0-9]{5} 💛$/.test(t)), sent.join(' | '));
  assert.ok(await doc('outbox', `${order.id}_owner_paid`), 'the owner alert is queued (sent when their 24-hour window is open)');

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
