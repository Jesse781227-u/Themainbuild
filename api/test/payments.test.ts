import crypto from 'node:crypto';
import { api, clearFirestore, db, doc, env, FakeTransport, queueMessage, seed, seedCart } from './helpers';
import { checkout, type OrderPolicy } from '../src/services/orders';
import { bachsAdapter, type BachsAdapter, type BachsPaymentEvent } from '../src/services/bachs';
import { markOrderPaid } from '../src/services/on-paid';
import { handleQueueBatch } from '../src/services/queue';
import { lagosDate } from '../src/lib/time';
import { getConfig } from '../src/config';
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

// The real Bachs signing scheme and payload are TODO(jesse); this stand-in adapter lets the matching,
// idempotency and pipeline logic be tested end to end through the webhook route.
const SECRET = 'bachs-test-secret';
const testBachs: BachsAdapter = {
  verify: (raw, headers) => headers.get('x-test-signature') === crypto.createHmac('sha256', SECRET).update(raw).digest('hex'),
  parse: body => body as BachsPaymentEvent,
};
const postBachs = (event: BachsPaymentEvent, sign = true) => {
  const raw = JSON.stringify(event);
  return api('POST', '/api/v1/webhooks/bachs', { raw, bachs: testBachs, headers: sign ? { 'x-test-signature': crypto.createHmac('sha256', SECRET).update(raw).digest('hex') } : { 'x-test-signature': 'nope' } });
};

let fx: Awaited<ReturnType<typeof seed>>;
const policy: OrderPolicy = { bps: 100, capKobo: 200_000, holdMinutes: 30 };
let n = 0;
async function newOrder(qty = 1) {
  const cartId = `cart-p${n++}`;
  await seedCart(cartId, fx.a.id, fx.a.customer, [{ productId: fx.a.product, qty }]);
  return checkout(db, { cartId, businessId: fx.a.id, policy });
}

before(async () => { await clearFirestore(); fx = await seed(); await db.update(db.doc('products', fx.a.product), { stock: 100 }); });
beforeEach(() => { env.EVENTS.sent.length = 0; });

test('payments: the real Bachs adapter fails closed until implemented', async () => {
  const res = await api('POST', '/api/v1/webhooks/bachs', { body: { providerRef: 'x', accountId: fx.a.bachs, amountKobo: 1, paidAt: new Date().toISOString() } });
  assert.equal(res.status, 401);
  assert.equal(bachsAdapter.parse({}), null);
});

test('payments: webhook rejects bad signature', async () => {
  const o = await newOrder();
  const res = await postBachs({ providerRef: 'ref-bad', accountId: fx.a.bachs, amountKobo: o.payAmountKobo, paidAt: new Date().toISOString() }, false);
  assert.equal(res.status, 401);
  assert.equal((await doc('orders', o.id)).status, 'awaiting_payment');
  assert.equal(await doc('payments', 'bachs_ref-bad'), null);
});

test('payments: webhook matches by amount and marks order paid', async () => {
  const other = await newOrder();
  const o = await newOrder(2);
  const res = await postBachs({ providerRef: 'ref-1', accountId: fx.a.bachs, amountKobo: o.payAmountKobo, paidAt: new Date().toISOString() });
  assert.equal(res.status, 200);
  const stored = await doc('orders', o.id);
  assert.equal(stored.status, 'paid');
  assert.equal(stored.paymentId, 'bachs_ref-1');
  assert.equal((await doc('orders', other.id)).status, 'awaiting_payment');
  assert.equal((await doc('payments', 'bachs_ref-1')).status, 'matched');
  assert.equal(await doc('amountClaims', `${fx.a.id}_${o.payAmountKobo}`), null, 'claim freed');
  assert.deepEqual(env.EVENTS.sent.map(j => j.kind === 'outbox' && j.messageId).sort(), [`${fx.a.id}_first_sale`, `${o.id}_first_thanks`, `${o.id}_owner_paid`, `${o.id}_receipt`].sort(), 'receipt, owner alert, the first-sale message and the updates ask for a new customer');
});

test('payments: same amount at another business does not match', async () => {
  const o = await newOrder();
  await postBachs({ providerRef: 'ref-wrong-biz', accountId: fx.b.bachs, amountKobo: o.payAmountKobo, paidAt: new Date().toISOString() });
  assert.equal((await doc('orders', o.id)).status, 'awaiting_payment');
  assert.equal((await doc('payments', 'bachs_ref-wrong-biz')).status, 'unmatched');
  assert.ok(await doc('outbox', 'bachs_ref-wrong-biz_unmatched'), 'business B owner is told about the unmatched money');
});

test('payments: duplicate webhook is idempotent', async () => {
  const o = await newOrder();
  const event = { providerRef: 'ref-dup', accountId: fx.a.bachs, amountKobo: o.payAmountKobo, paidAt: new Date().toISOString() };
  const results = await Promise.all([postBachs(event), postBachs(event), postBachs(event)]);
  assert.ok(results.every(r => r.status === 200));
  assert.equal((await doc('orders', o.id)).status, 'paid');
  assert.equal((await doc('ledger', o.id)).grossKobo, o.payAmountKobo);
  const day = await doc('dailyStats', `${fx.a.id}_${lagosDate()}`);
  const before = day.ordersPaid;
  await postBachs(event);
  assert.equal((await doc('dailyStats', `${fx.a.id}_${lagosDate()}`)).ordersPaid, before);
});

test('paid: pipeline is idempotent', async () => {
  const o = await newOrder();
  const customerBefore = await doc('customers', fx.a.customer);
  const results = await Promise.all([1, 2, 3].map(i => markOrderPaid(db, o.id, fx.a.id, `manual_${i}`)));
  assert.equal(results.filter(r => r.applied).length, 1);
  assert.equal((await markOrderPaid(db, o.id, fx.a.id, 'manual_again')).applied, false);
  const customer = await doc('customers', fx.a.customer);
  assert.equal(customer.orderCount, customerBefore.orderCount + 1);
  assert.equal(customer.totalSpentKobo, customerBefore.totalSpentKobo + o.subtotalKobo);
});

test('paid: updates customer stats, ledger and daily stats', async () => {
  const o = await newOrder(3);
  const key = `${fx.a.id}_${lagosDate()}`;
  const dayBefore = (await doc('dailyStats', key)) ?? { ordersPaid: 0, salesKobo: 0, relayFeeKobo: 0 };
  const custBefore = await doc('customers', fx.a.customer);
  const r = await markOrderPaid(db, o.id, fx.a.id, 'manual_stats');
  assert.equal(r.applied, true);

  const ledger = await doc('ledger', o.id);
  assert.equal(ledger.businessId, fx.a.id);
  assert.equal(ledger.goodsKobo, 300_000);
  assert.equal(ledger.relayFeeKobo, 3_000);
  assert.equal(ledger.merchantNetKobo, o.payAmountKobo - 3_000);

  const day = await doc('dailyStats', key);
  assert.equal(day.ordersPaid, dayBefore.ordersPaid + 1);
  assert.equal(day.salesKobo, dayBefore.salesKobo + 300_000);
  assert.equal(day.relayFeeKobo, dayBefore.relayFeeKobo + 3_000);

  const cust = await doc('customers', fx.a.customer);
  assert.equal(cust.orderCount, custBefore.orderCount + 1);
  assert.equal(cust.totalSpentKobo, custBefore.totalSpentKobo + 300_000);
  assert.ok(cust.lastOrderAt);
  assert.equal(cust.phone, fx.a.customerPhone, 'merge keeps existing customer fields');
});

test('paid: late payment after the hold expired is still recorded', async () => {
  const o = await newOrder();
  const { releaseHold } = await import('../src/services/orders');
  await releaseHold(db, o.id, new Date(Date.now() + 31 * 60_000));
  const stockAfterRelease = (await doc('products', fx.a.product)).stock;
  await postBachs({ providerRef: 'ref-late', accountId: fx.a.bachs, amountKobo: o.payAmountKobo, paidAt: new Date().toISOString() });
  const stored = await doc('orders', o.id);
  assert.equal(stored.status, 'paid');
  assert.equal(stored.needsAttention, null);
  assert.equal((await doc('payments', 'bachs_ref-late')).status, 'late');
  assert.equal((await doc('products', fx.a.product)).stock, stockAfterRelease - 1, 'stock taken again');
});

test('outbox: receipt goes to the customer from the merchant number, alert to the owner from the admin bot', async () => {
  const { saveWhatsAppConnection } = await import('../src/services/whatsapp');
  const cfg = getConfig(env);
  await saveWhatsAppConnection(db, cfg, { businessId: fx.a.id, wabaId: 'w', phoneNumberId: fx.a.pnid, accessToken: 't' });
  const at = new Date().toISOString();
  await db.set(db.doc('conversations', fx.a.customer), { id: fx.a.customer, businessId: fx.a.id, lastInboundAt: at });
  await db.set(db.doc('conversations', `admin_${fx.a.ownerPhone.slice(1)}`), { id: `admin_${fx.a.ownerPhone.slice(1)}`, businessId: fx.a.id, lastInboundAt: at });
  const o = await newOrder();
  await markOrderPaid(db, o.id, fx.a.id, 'manual_outbox');
  const transport = new FakeTransport();
  const msgs = [queueMessage({ kind: 'outbox', messageId: `${o.id}_receipt` }), queueMessage({ kind: 'outbox', messageId: `${o.id}_owner_paid` }), queueMessage({ kind: 'outbox', messageId: `${o.id}_receipt` })];
  await handleQueueBatch({ queue: 't', messages: msgs }, env, { transport });
  assert.equal(transport.sent.length, 2, 'the duplicate job does not send twice');
  assert.deepEqual(transport.sent.map(s => [s.phoneNumberId, s.to]).sort(), [[fx.a.pnid, fx.a.customerPhone], ['pn-admin', fx.a.ownerPhone]].sort());
  assert.equal((await doc('outbox', `${o.id}_receipt`)).status, 'sent');
});
