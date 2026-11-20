// Smart Reach: the edges — consent for paid sends, money taken once, codes freed, switches that
// stay off, scheduling, and WhatsApp's limits on what's sent.
import { Bot, clearFirestore, db, doc, env, FakeTransport, seed, seedCart, whatsAppLimitProblems } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { createCategories, createProduct } from '../src/services/catalog';
import { addressOf, executeCampaign, planCampaign, planSummary, releaseQueuedSends, routeAll, type ReachCustomer } from '../src/services/reach';
import { describeRule, ruleFromWords } from '../src/services/segments';
import { setTemplateState, TEMPLATES, templatePayloads } from '../src/services/templates';
import { campaignResults } from '../src/services/reach-results';
import { afterDelivery, priceDrop, suggestReach, weeklySummaries, weeklySummary } from '../src/services/reach-triggers';
import { chargeMessages, getWallet } from '../src/services/wallet';
import { processOutbox } from '../src/services/outbox';
import { checkOffer, createOfferCode } from '../src/services/offers';
import { checkout, releaseHold } from '../src/services/orders';
import { picksMessage } from '../src/services/picks';
import { replyKeyword } from '../src/services/status-posts';
import { markOrderPaid } from '../src/services/on-paid';
import type { LLMProvider } from '../src/services/ai';
import type { Business } from '../src/domain/business';
import type { Product } from '../src/domain/commerce';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

const cfg = Object.assign(getConfig(env), { REACH_QUIET_FROM: 0, REACH_QUIET_TO: 0 });
const H = 3_600_000, DAY = 24 * H;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const deps = { enqueue: async () => {} };
const policy = { bps: 100, capKobo: 200_000, holdMinutes: 30, feePayer: 'customer' as const };
const rc = (id: string, extra: Partial<ReachCustomer> = {}): ReachCustomer => ({ id, businessId: 'b', phone: `+23480${id.padStart(8, '0')}`, name: 'Ada Obi', marketingOptIn: true, orderCount: 0, totalSpentKobo: 0, createdAt: ago(100 * DAY), updatedAt: ago(DAY), ...extra });

let fx: Awaited<ReturnType<typeof seed>>;
let product: Product;
let n = 0;
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, cfg, { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
  const [cat] = await createCategories(db, fx.a.id, ['Bags', 'Hats']);
  product = await createProduct(db, { businessId: fx.a.id, name: 'Leather Tote', priceKobo: 2_000_000, categoryId: cat.id, images: ['https://img.test/tote.jpg'] });
});
const biz = async () => (await doc('businesses', fx.a.id)) as unknown as Business;
async function customer(extra: Record<string, unknown> = {}) {
  const phone = `2348090${String(++n).padStart(6, '0')}`;
  const id = `${fx.a.id}_wa_${phone}`;
  await db.set(db.doc('customers', id), { id, businessId: fx.a.id, channel: 'whatsapp', phone: `+${phone}`, name: 'Ada Obi', marketingOptIn: true, marketingOptInAt: ago(30 * DAY), lastInboundAt: ago(H), orderCount: 0, totalSpentKobo: 0, createdAt: ago(100 * DAY), updatedAt: ago(DAY), ...extra });
  return id;
}
const withTriggers = (t: Record<string, boolean>) => db.update(db.doc('businesses', fx.a.id), { reachTriggers: t });

// ── Consent and the paid route ──
test('route plan: paid sends skip customers who never clearly said yes', () => {
  const closed = ago(10 * DAY);
  const ds = routeAll([
    rc('1', { lastInboundAt: closed, marketingOptInAt: ago(DAY) }),                                    // said yes
    rc('2', { lastInboundAt: closed, marketingOptIn: undefined, marketingOptInAt: null, createdAt: '2026-01-01T00:00:00.000Z' }), // customer from before Smart Reach
    rc('3', { lastInboundAt: closed, marketingOptInAt: ago(5 * DAY), marketingOptOutAt: ago(DAY) }),   // said stop after
  ], new Map(), { cfg, usedService: 0, ownerSentOk: false, paidOk: true });
  assert.deepEqual(ds.map(d => d.route ?? d.skip), ['paid_template', 'unreachable', 'no_consent']);
});

test('route plan: a paid send in quiet hours waits for the morning', () => {
  const quiet = Object.assign({}, cfg, { REACH_QUIET_FROM: 21, REACH_QUIET_TO: 8 });
  const night = new Date('2026-11-20T22:30:00Z'); // 23:30 in Lagos
  const [d] = routeAll([rc('1', { lastInboundAt: ago(10 * DAY), marketingOptInAt: ago(DAY) })], new Map(), { cfg: quiet, usedService: 0, ownerSentOk: false, paidOk: true, now: night });
  assert.equal(d.route, 'paid_template');
  assert.equal(d.queuedUntil, '2026-11-21T07:00:00.000Z', '8am Lagos');
});

test('wallet: message costs are charged once per campaign, never below zero', async () => {
  await db.set(db.doc('ledger', 'w-sale'), { id: 'w-sale', businessId: fx.a.id, type: 'sale', merchantNetKobo: 100_000, at: ago(H) });
  await db.delete(db.doc('wallets', fx.a.id));
  const start = (await getWallet(db, fx.a.id)).availableKobo;
  assert.equal(await chargeMessages(db, fx.a.id, 'camp-x', 30_000, 3), true);
  assert.equal(await chargeMessages(db, fx.a.id, 'camp-x', 30_000, 3), true, 'already charged: true, nothing taken');
  assert.equal((await getWallet(db, fx.a.id)).availableKobo, start - 30_000);
  assert.equal(await chargeMessages(db, fx.a.id, 'camp-y', start, 1), false, 'more than the balance');
  assert.equal((await getWallet(db, fx.a.id)).availableKobo, start - 30_000);
  assert.equal(await chargeMessages(db, fx.a.id, 'camp-z', 0, 0), true, 'free: nothing to charge');
});

test('outbox: a paid send goes out as the approved template with its values', async () => {
  const id = 'paid-out-1';
  await db.set(db.doc('outbox', id), { id, businessId: fx.a.id, audience: 'customer', channel: 'whatsapp', to: '+2348090999001', conversationId: `${fx.a.id}_wa_2348090999001`, kind: 'reach', text: 'x', paidTemplate: { name: 'relay_back_in_stock', params: ['Ada', 'Leather Tote', 'Shop'], headerImage: 'https://img.test/tote.jpg' }, status: 'pending', attempts: 0, createdAt: ago(0) });
  const t = new FakeTransport();
  assert.equal(await processOutbox(db, cfg, t, id), 'sent');
  const sent = t.sent[0].content as { type: string; name: string; components: { type: string; parameters: { type: string; text?: string }[] }[] };
  assert.equal(sent.type, 'template');
  assert.equal(sent.name, 'relay_back_in_stock');
  assert.deepEqual(sent.components.map(c => c.type), ['header', 'body']);
  assert.deepEqual(sent.components[1].parameters.map(p => p.text), ['Ada', 'Leather Tote', 'Shop']);
  assert.equal((await doc('outbox', id)).viaTemplate, true);
});

test('queued paid sends go out in the morning without needing an open chat', async () => {
  const id = await customer({ lastInboundAt: ago(10 * DAY), marketingOptInAt: ago(DAY) });
  await db.set(db.doc('sends', 'q-paid'), { id: 'q-paid', businessId: fx.a.id, campaignId: 'cq', customerId: id, route: 'paid_template', cost: 8_000, status: 'queued', text: 'Hi', sendAfter: ago(H), createdAt: ago(2 * H), paidTemplate: { name: 'relay_update', params: ['Ada', 'Shop', 'Hi'] } });
  const ids = await releaseQueuedSends(db, cfg);
  assert.ok(ids.includes('reach_q-paid'));
  assert.equal((await doc('outbox', 'reach_q-paid')).paidTemplate.name, 'relay_update');
});

test('queued free-window sends fail once the 72 hours are over', async () => {
  const id = await customer({ lastInboundAt: ago(80 * H), adReferralAt: ago(80 * H) });
  await db.set(db.doc('sends', 'q-ad'), { id: 'q-ad', businessId: fx.a.id, campaignId: 'cq2', customerId: id, route: 'free_window', cost: 0, status: 'queued', text: 'Hi', sendAfter: ago(H), createdAt: ago(9 * H) });
  await releaseQueuedSends(db, cfg);
  assert.equal((await doc('sends', 'q-ad')).status, 'failed');
});

// ── Results ──
test('report: sends that never went out are not counted', async () => {
  const a = await customer(), b = await customer();
  await db.set(db.doc('sends', 'r-ok'), { id: 'r-ok', businessId: fx.a.id, campaignId: 'rc1', customerId: a, route: 'open', cost: 0, status: 'sent', text: 'x', sentAt: ago(H), createdAt: ago(H) });
  await db.set(db.doc('sends', 'r-fail'), { id: 'r-fail', businessId: fx.a.id, campaignId: 'rc1', customerId: b, route: 'open', cost: 0, status: 'failed', text: 'x', sentAt: null, createdAt: ago(H) });
  await db.set(db.doc('sends', 'r-owner'), { id: 'r-owner', businessId: fx.a.id, campaignId: 'rc1', customerId: b, route: 'owner_sent', cost: 0, status: 'owner_pending', text: 'x', sentAt: null, createdAt: ago(H) });
  assert.equal((await campaignResults(db, 'rc1')).sent, 1);
});

test('report: no updates this week means no weekly message', async () => {
  const s = await weeklySummary(db, 'biz-nobody');
  assert.equal(s.text, null);
});

test('report: weekly summaries only go out on Mondays (Lagos)', async () => {
  assert.deepEqual(await weeklySummaries(db, new Date('2026-11-24T09:00:00Z')), [], 'Tuesday');
});

// ── Switches ──
test('trigger: price drop and after delivery stay quiet when switched off', async () => {
  const looker = await customer();
  await db.set(db.doc('customerSignals', 'off-1'), { businessId: fx.a.id, customerId: looker, type: 'viewed', productId: product.id, categoryId: null, variant: null, at: ago(H) });
  await withTriggers({ price_drop: false, after_delivery: false });
  assert.equal(await priceDrop(db, cfg, deps, await biz(), product, 2_000_000, 1_500_000), null);
  await db.set(db.doc('orders', 'off-o1'), { id: 'off-o1', ref: 'RLY-OFF01', businessId: fx.a.id, customerId: looker, channel: 'whatsapp', status: 'paid', fulfilment: 'delivered', items: [{ productId: product.id, name: 'Leather Tote', priceKobo: 1, qty: 1 }], subtotalKobo: 1, deliveryFeeKobo: 0, feeKobo: 0, uniqueKobo: 0, payAmountKobo: 1, delivery: null, holdExpiresAt: ago(2 * DAY), deliveredAt: ago(30 * H), createdAt: ago(2 * DAY), updatedAt: ago(30 * H) });
  assert.equal(await afterDelivery(db, cfg, deps), 0);
  assert.equal(await doc('outbox', `reach_ad_off-o1_${looker}`), null);
  await withTriggers({});
});

test('trigger: first-order thanks stays quiet when switched off', async () => {
  await withTriggers({ first_order_thanks: false });
  const fresh = await customer({ marketingOptIn: null, marketingOptInAt: null });
  await db.set(db.doc('orders', 'fo-off'), { id: 'fo-off', ref: 'RLY-FOOFF', businessId: fx.a.id, customerId: fresh, channel: 'whatsapp', status: 'awaiting_payment', fulfilment: 'pending', items: [{ productId: product.id, name: 'Leather Tote', priceKobo: 2_000_000, qty: 1 }], subtotalKobo: 2_000_000, deliveryFeeKobo: 0, feeKobo: 0, uniqueKobo: 0, payAmountKobo: 2_000_000, delivery: null, holdExpiresAt: new Date(Date.now() + H).toISOString(), createdAt: ago(0), updatedAt: ago(0) });
  await markOrderPaid(db, 'fo-off', fx.a.id, 'pay-fo-off');
  assert.equal(await doc('outbox', 'fo-off_first_thanks'), null);
  await withTriggers({});
});

test('suggest: fewer than three interested people is not worth a message', async () => {
  const b = { ...(await biz()), lastReachSuggestDate: null };
  await db.update(db.doc('businesses', fx.a.id), { lastReachSuggestDate: null });
  // The shop's only signals so far: one viewer.
  assert.equal(await suggestReach(db, b), null);
});

test('suggest: a paused or unfinished shop gets no suggestions', async () => {
  assert.equal(await suggestReach(db, { ...(await biz()), status: 'onboarding' } as Business), null);
});

// ── Segments ──
test('segments: a rule reads back in plain words', () => {
  const names = { categories: [{ id: 'c1', name: 'Bags' }], products: [{ id: 'p1', name: 'Tote' }] };
  assert.equal(describeRule({ all: [{ kind: 'signal', action: 'bought', categoryId: 'c1', withinDays: 30 }, { kind: 'order_count', min: 3 }] }, names), 'bought Bags in the last 30 days · 3+ orders');
  assert.equal(describeRule({ all: [{ kind: 'spend_percentile', min: 90 }, { kind: 'area', value: 'Yaba' }] }, names), 'top 10% by spend · in Yaba');
});

test('segments: the AI failing or answering nonsense gives no rule, never a guess', async () => {
  const ctx = { categories: [{ id: 'c1', name: 'Bags' }], products: [] };
  const broken = { async chooseTool() { return null; }, async writeTexts() { throw new Error('quota'); } } as LLMProvider;
  const babble = { async chooseTool() { return null; }, async writeTexts() { return { rule: 'sure! here are your customers' }; } } as LLMProvider;
  assert.equal(await ruleFromWords('the cool kids', { ...ctx, llm: broken }), null);
  assert.equal(await ruleFromWords('the cool kids', { ...ctx, llm: babble }), null);
  assert.equal(await ruleFromWords('the cool kids', ctx), null, 'no AI: no rule');
});

test('owner: a group nobody matches says so instead of planning an empty send', async () => {
  const bot = new Bot();
  const out = await bot.send('admin', { from: fx.a.ownerPhone.slice(1), text: 'tell my hat buyers about the new caps' });
  assert.match(out[0].text, /^Nobody matches \*bought Hats\* yet\./);
});

test('owner: an old wording button after the draft is gone starts again', async () => {
  const bot = new Bot();
  const out = await bot.send('admin', { from: fx.a.ownerPhone.slice(1), choice: 'act:reachpick:2', text: 'Option 2' });
  assert.match(out[0].text, /^Who should get it, and what's the news\?/);
});

// ── Templates ──
test('templates: every body variable has an example and a known value', () => {
  for (const t of TEMPLATES) {
    assert.equal([...t.body.matchAll(/\{\{\d+\}\}/g)].length, t.variables.length, t.name);
    assert.equal(t.example.length, t.variables.length, t.name);
    assert.equal(t.category, 'MARKETING');
  }
  assert.ok(TEMPLATES.some(t => t.carousel) && TEMPLATES.some(t => t.header === 'image'));
});

test('templates: a broken library entry is caught before anything is submitted', () => {
  TEMPLATES.push({ name: 'Bad Name', category: 'MARKETING', language: 'en', body: 'Hi {{2}}', variables: ['name'], example: [] });
  try { assert.throws(() => templatePayloads(), /TEMPLATE_INVALID Bad Name/); } finally { TEMPLATES.pop(); }
});

test('route plan: no approved template means the paid route is not offered', async () => {
  await setTemplateState(db, fx.a.id, 'relay_update', 'rejected');
  const id = await customer({ lastInboundAt: ago(10 * DAY) });
  const p = await planCampaign(db, cfg, await biz(), { name: 'x', text: 'Hi', source: 'owner', audience: [id] });
  assert.equal(p.summary.paid_template, 0);
  assert.equal(p.campaign.template, null);
});

// ── Offer codes ──
test('offer codes: an amount off never goes below zero', () => {
  const offer = { code: 'A-1', businessId: 'b', customerId: 'c', percentOff: null, amountOffKobo: 500_000, expiresAt: new Date(Date.now() + DAY).toISOString(), usedAt: null, orderId: null, createdAt: ago(0) };
  const r = checkOffer(offer, { businessId: 'b', customerId: 'c' }, 300_000);
  assert.ok(r.ok && r.discountKobo === 300_000);
  assert.deepEqual(checkOffer(offer, { businessId: 'other', customerId: 'c' }, 300_000), { ok: false, reason: 'not_found' }, "another shop's code doesn't exist here");
});

test('offer codes: an order that expires unpaid frees its code', async () => {
  const who = await customer();
  const offer = await createOfferCode(db, { businessId: fx.a.id, customerId: who, name: 'Ada', percentOff: 20 });
  await seedCart('cart-exp', fx.a.id, who, [{ productId: product.id, qty: 1 }]);
  const o = await checkout(db, { cartId: 'cart-exp', businessId: fx.a.id, policy, offerCode: offer.code });
  assert.ok((await doc('offerCodes', offer.code)).usedAt);
  assert.equal(await releaseHold(db, o.id, new Date(Date.now() + 2 * H)), true);
  assert.equal((await doc('offerCodes', offer.code)).usedAt, null);
});

test('offer codes: a paid order counts sales after the discount', async () => {
  const who = await customer();
  const offer = await createOfferCode(db, { businessId: fx.a.id, customerId: who, name: 'Ada', amountOffKobo: 500_000 });
  await seedCart('cart-disc', fx.a.id, who, [{ productId: product.id, qty: 1 }]);
  const o = await checkout(db, { cartId: 'cart-disc', businessId: fx.a.id, policy, offerCode: offer.code });
  await markOrderPaid(db, o.id, fx.a.id, `pay-${o.id}`);
  const ledger = await doc('ledger', o.id);
  assert.equal(ledger.goodsKobo, 1_500_000);
  assert.equal(ledger.discountKobo, 500_000);
  assert.equal((await doc('customers', who)).totalSpentKobo, 1_500_000);
});

test('offer codes: "{code}" in an update gives each customer their own code', async () => {
  const a = await customer(), b = await customer();
  const p = await planCampaign(db, cfg, await biz(), { name: 'Codes', text: 'Hi {name}, 10% off with code {code}', source: 'owner', audience: [a, b], offer: { percentOff: 10, days: 5 } });
  await executeCampaign(db, cfg, deps, await biz(), p.campaign.id);
  const texts = await Promise.all([a, b].map(async c => String((await doc('sends', `${p.campaign.id}_${c}`.replace(/[^A-Za-z0-9_-]/g, '_'))).text)));
  const codes = texts.map(t => /code (ADA-[A-Z2-9]{4})$/.exec(t)?.[1]);
  assert.ok(codes[0] && codes[1] && codes[0] !== codes[1]);
  assert.equal((await doc('offerCodes', codes[0]!)).customerId, a);
});

test('owner: "10% off ... code" in the news adds a personal code to each message', async () => {
  const bot = new Bot();
  const o = fx.a.ownerPhone.slice(1);
  await bot.send('admin', { from: o, text: '/reach' });
  await bot.send('admin', { from: o, choice: 'act:reachall', text: 'Send to everyone' });
  const plan = await bot.send('admin', { from: o, text: 'Weekend sale: 10% off everything with your code' });
  const id = (await db.query('campaigns', [['businessId', '==', fx.a.id], ['status', '==', 'planned']])).map(c => c as unknown as { text: string; offer: { percentOff: number } | null }).find(c => /code/.test(c.text));
  assert.ok(plan.length);
  assert.equal(id?.offer?.percentOff, 10);
  assert.match(id!.text, /\{code\}/);
});

// ── Carousels, Instagram ──
test('carousel: fewer than two picks sends nothing; every carousel fits WhatsApp limits', () => {
  assert.equal(picksMessage('Hi', [product]), null);
  const many = Array.from({ length: 12 }, (_, i) => ({ ...product, id: `p${i}`, name: `Product number ${i} with a long name to clip`.repeat(3) }));
  const msg = picksMessage('Hi Ada, picked for you 👇', many.slice(0, 10))!;
  assert.deepEqual(whatsAppLimitProblems(msg), []);
});

test('router: an Instagram customer in quiet hours waits for the morning if the chat is still open then', () => {
  const quiet = Object.assign({}, cfg, { REACH_QUIET_FROM: 21, REACH_QUIET_TO: 8 });
  const night = new Date('2026-11-20T22:00:00Z'); // 23:00 Lagos; morning is 07:00Z
  const ig = (id: string, lastAt: string) => rc(id, { channel: 'instagram', phone: '', id: `x_ig_${id}`, lastInboundAt: lastAt } as Partial<ReachCustomer>);
  const [ok, closes] = routeAll([ig('1', '2026-11-20T21:30:00Z'), ig('2', '2026-11-20T02:00:00Z')], new Map(), { cfg: quiet, usedService: 0, now: night });
  assert.deepEqual([ok.route, ok.queuedUntil], ['instagram', '2026-11-21T07:00:00.000Z']);
  assert.equal(closes.skip, 'unreachable', 'the chat closes before 8am');
  assert.equal(planSummary([ok, closes]).open, 1);
});

test('router: messages to Instagram customers go to their Instagram id', () => {
  assert.equal(addressOf({ id: 'biz-a_ig_17841400000', phone: '', channel: 'instagram' }), '17841400000');
  assert.equal(addressOf({ id: 'biz-a_wa_2348000000001', phone: '+2348000000001', channel: 'whatsapp' }), '+2348000000001');
});

test('status: the reply keyword for a section post comes from the section name', () => {
  assert.equal(replyKeyword('Ankara Gowns'), 'GOWNS');
  assert.equal(replyKeyword('42'), 'ORDER', 'no usable word: a safe default');
});
