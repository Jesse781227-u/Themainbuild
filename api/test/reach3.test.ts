import { clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { createCategories, createProduct } from '../src/services/catalog';
import { triggerOn, type ReachCustomer } from '../src/services/reach';
import { afterDelivery, dueCustomers, priceDrop, regularsAndWinBack, suggestReach, weeklySummary } from '../src/services/reach-triggers';
import { prepareStatus, replyKeyword } from '../src/services/status-posts';
import { markOrderPaid } from '../src/services/on-paid';
import type { Business } from '../src/domain/business';
import type { Order } from '../src/domain/commerce';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

const cfg = Object.assign(getConfig(env), { REACH_QUIET_FROM: 0, REACH_QUIET_TO: 0 });
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const deps = { enqueue: async () => {} };

let fx: Awaited<ReturnType<typeof seed>>;
let product: { id: string; name: string };
let n = 0;
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, cfg, { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
  const [cat] = await createCategories(db, fx.a.id, ['Sneakers']);
  product = await createProduct(db, { businessId: fx.a.id, name: 'Air Jordans', priceKobo: 5_000_000, categoryId: cat.id });
});
const biz = async () => (await doc('businesses', fx.a.id)) as unknown as Business;
async function customer(extra: Record<string, unknown> = {}) {
  const phone = `23480700${String(++n).padStart(5, '0')}`;
  const id = `${fx.a.id}_wa_${phone}`;
  await db.set(db.doc('customers', id), { id, businessId: fx.a.id, channel: 'whatsapp', phone: `+${phone}`, name: 'Ada Obi', marketingOptIn: true, marketingOptInAt: ago(30), lastInboundAt: new Date(Date.now() - 3_600_000).toISOString(), orderCount: 0, totalSpentKobo: 0, createdAt: ago(100), updatedAt: ago(1), ...extra });
  return id;
}
const signal = (customerId: string, type: string, days = 1) => db.set(db.doc('customerSignals', `s${++n}`), { businessId: fx.a.id, customerId, type, productId: product.id, categoryId: null, variant: null, at: ago(days) });
async function paid(id: string, customerId: string, daysAgo = 0, fulfilment = 'pending') {
  const at = ago(daysAgo);
  await db.set(db.doc('orders', id), { id, ref: `RLY-${id.slice(-5).toUpperCase().padStart(5, 'X')}`, businessId: fx.a.id, customerId, channel: 'whatsapp', status: 'awaiting_payment', fulfilment, items: [{ productId: product.id, name: 'Air Jordans', priceKobo: 5_000_000, qty: 1 }], subtotalKobo: 5_000_000, deliveryFeeKobo: 0, feeKobo: 0, uniqueKobo: 0, payAmountKobo: 5_000_000, delivery: null, holdExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: at, updatedAt: at });
  await markOrderPaid(db, id, fx.a.id, `pay-${id}`, at);
}

test('suggest: Relay suggests at most once a day per shop', async () => {
  const b = await biz();
  assert.equal(await suggestReach(db, b), null, 'nothing worth suggesting yet');
  for (let i = 0; i < 3; i++) await signal(await customer(), 'viewed');
  const id = await suggestReach(db, b);
  assert.ok(id);
  const msg = await doc('outbox', id!);
  assert.match(msg.text, /^💡 3 people looked at \*Air Jordans\* this week but didn't buy\. Send them an update\?$/);
  assert.equal(msg.buttons[0].id, `act:reachask:${product.id}`);
  for (let i = 0; i < 3; i++) await signal(await customer(), 'asked');
  assert.equal(await suggestReach(db, await biz()), null, 'already suggested today');
  assert.ok(await suggestReach(db, await biz(), new Date(Date.now() + DAY)), 'tomorrow is fine');
});

test('trigger: price drop, after delivery and first order thanks', async () => {
  // Price drop: the person who looked hears about it, once per new price; a buyer doesn't.
  const looker = await customer(), buyer = await customer();
  await signal(looker, 'viewed'); await signal(buyer, 'viewed'); await signal(buyer, 'bought');
  const r = await priceDrop(db, cfg, deps, await biz(), product, 5_000_000, 4_500_000);
  assert.ok(r!.sent >= 1);
  assert.equal(await doc('outbox', `reach_pd_${product.id}_4500000_${buyer}`), null, 'a buyer is left out');
  assert.match((await doc('outbox', `reach_pd_${product.id}_4500000_${looker}`)).text, /^Hi Ada, Air Jordans at .+ is now ₦45,000 \(was ₦50,000\) 🎉$/);
  assert.equal(await priceDrop(db, cfg, deps, await biz(), product, 5_000_000, 4_500_000), null, 'same drop: once');
  assert.equal(await priceDrop(db, cfg, deps, await biz(), product, 4_500_000, 4_800_000), null, 'a rise is not a drop');

  // First order thanks: with the updates ask when they haven't clearly said yes; only the first order.
  const fresh = await customer({ marketingOptIn: null, marketingOptInAt: null });
  await paid('ft-o1', fresh);
  const thanks = await doc('outbox', 'ft-o1_first_thanks');
  assert.match(thanks.text, /^Thanks for your first order with .+! 🙏 Want news when new things arrive\? \(At most once a week\.\)$/);
  assert.equal(thanks.buttons[0].id, 'optin');
  await paid('ft-o2', fresh);
  assert.equal(await doc('outbox', 'ft-o2_first_thanks'), null, 'second order: no thanks message');
  const optedIn = await customer();
  await paid('ft-o3', optedIn);
  assert.equal(await doc('outbox', 'ft-o3_first_thanks'), null, 'already said yes: the receipt\'s thanks is enough');

  // After delivery: a day after, once.
  const got = await customer();
  await paid('ad-o1', got, 0, 'delivered');
  await db.update(db.doc('orders', 'ad-o1'), { deliveredAt: ago(1.1) });
  assert.equal(await afterDelivery(db, cfg, deps), 1);
  assert.match((await doc('outbox', `reach_ad_ad-o1_${got}`)).text, /^Hi Ada, hope you're enjoying your Air Jordans! Anything else you need from .+\?$/);
  assert.equal(await afterDelivery(db, cfg, deps), 0, 'once');
});

test('trigger: usual order due and win back stay off until turned on', async () => {
  for (const category of ['food_beverage', 'fashion_retail', 'other'] as const) {
    assert.equal(triggerOn({ category }, 'usual_order_due'), false);
    assert.equal(triggerOn({ category }, 'win_back'), false);
  }
  const regular = await customer(), gone = await customer();
  for (const d of [31, 21, 11]) await paid(`reg-${d}`, regular, d);
  await paid('gone-1', gone, 70);
  const due = dueCustomers([{ id: regular } as ReachCustomer, { id: gone } as ReachCustomer], (await db.query('orders', [['businessId', '==', fx.a.id], ['status', '==', 'paid']])) as unknown as Order[]);
  assert.deepEqual([due.usual.map(x => x.id), due.lapsed.map(x => x.id)], [[regular], [gone]]);
  assert.deepEqual(await regularsAndWinBack(db, cfg, deps, await biz()), { usual: 0, winBack: 0 }, 'off by default');
  await db.update(db.doc('businesses', fx.a.id), { reachTriggers: { usual_order_due: true, win_back: true } });
  assert.deepEqual(await regularsAndWinBack(db, cfg, deps, await biz()), { usual: 1, winBack: 1 });
  assert.deepEqual(await regularsAndWinBack(db, cfg, deps, await biz()), { usual: 0, winBack: 0 }, 'once per cycle');
  await db.update(db.doc('businesses', fx.a.id), { reachTriggers: {} });
});

test('status: reach segments pick the mentions and captions use a reply keyword', async () => {
  assert.equal(replyKeyword('Black Ankle Boots'), 'BOOTS');
  assert.equal(replyKeyword('Jollof Rice (Large) 2'), 'LARGE');
  const viewer = await customer({ name: 'Zara Bello' });
  const stopped = await customer({ name: 'Yemi Stop', marketingOptOutAt: ago(1) });
  await signal(viewer, 'carted', 0); await signal(stopped, 'asked', 0);
  const images = { async put() { return null; }, async get() { return null; } } as never;
  const post = await prepareStatus(db, cfg, images, await biz(), { productIds: [product.id], categoryId: null });
  assert.match(post!.caption, /Reply \*JORDANS\* to order 💬$/);
  assert.equal(post!.suggestedMentions[0].customerId, viewer, 'the person who carted it comes first');
  assert.ok(!post!.suggestedMentions.some(m => m.customerId === stopped), 'someone who said stop is left out');
});

test('report: weekly summary names the best trigger', async () => {
  // Price drop got an order within 48h (from the earlier test's looker); nothing else did.
  const looker = (await db.query('sends', [['campaignId', '==', `pd_${product.id}_4500000`]]))[0].customerId as string;
  await paid('wk-o1', looker);
  const s = await weeklySummary(db, fx.a.id);
  assert.equal(s.best, 'Price drop');
  assert.ok(s.sent >= 3 && s.ordered >= 1);
  assert.match(s.text!, /^📈 Smart Reach this week: \d+ sent → \d+ ordered → ₦[\d,]+\.\nBest: \*Price drop\* \(1 order, ₦50,000\)\.\nMessage costs this month: ₦0\.$/);
});
