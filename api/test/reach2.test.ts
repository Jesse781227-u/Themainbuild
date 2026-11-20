import { Bot, clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { createCategories, createProduct } from '../src/services/catalog';
import { evaluate, loadSegmentData, refreshSegments, ruleFromWords, ruleSchema, type SegmentData } from '../src/services/segments';
import { fillVariables, setTemplateState, templatePayloads } from '../src/services/templates';
import { executeCampaign, personal, planCampaign, routeAll, type ReachCustomer } from '../src/services/reach';
import { campaignResults, dueCampaignReports } from '../src/services/reach-results';
import { getWallet } from '../src/services/wallet';
import { markOrderPaid } from '../src/services/on-paid';
import type { Business } from '../src/domain/business';
import type { Order } from '../src/domain/commerce';
import type { LLMProvider } from '../src/services/ai';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

const cfg = Object.assign(getConfig(env), { REACH_QUIET_FROM: 0, REACH_QUIET_TO: 0 }); // no quiet hours in these tests
const DAY = 86_400_000;
const now = new Date('2026-11-25T11:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
const order = (id: string, customerId: string, productId: string, days: number, extra: Partial<Order> = {}): Order => ({ id, ref: id, businessId: 'b', customerId, channel: 'whatsapp', status: 'paid', fulfilment: 'delivered', items: [{ productId, name: productId, priceKobo: 100_000, qty: 1 }], subtotalKobo: 100_000, deliveryFeeKobo: 0, feeKobo: 0, uniqueKobo: 0, payAmountKobo: 100_000, delivery: null, holdExpiresAt: ago(days), paidAt: ago(days), paymentId: 'x', needsAttention: null, createdAt: ago(days), updatedAt: ago(days), ...extra } as Order);
const customer = (id: string, extra: Partial<ReachCustomer> = {}): ReachCustomer => ({ id, businessId: 'b', phone: `+234800000${id}`, name: 'Ada Okafor', marketingOptIn: true, orderCount: 0, totalSpentKobo: 0, createdAt: ago(200), updatedAt: ago(1), ...extra });

test('segments: each rule type selects the right customers', () => {
  const d: SegmentData = {
    products: [{ id: 'sneak', categoryId: 'shoes', name: 'Sneaker', variants: null }, { id: 'tee', categoryId: 'tops', name: 'Tee', variants: null }],
    customers: ['1', '2', '3', '4', '5'].map(id => customer(id, id === '5' ? { interestWords: ['only sneakers'] } : {})),
    orders: [
      order('o1', '1', 'sneak', 5, { items: [{ productId: 'sneak', name: 'Sneaker (42)', priceKobo: 900_000, qty: 1 }], subtotalKobo: 900_000, delivery: { method: 'self_arranged', feeKobo: 0, address: '12 Herbert Macaulay Way, Yaba' } }),
      order('o2', '1', 'tee', 6), order('o3', '1', 'tee', 13),
      order('o4', '2', 'tee', 60),
      order('o5', '3', 'tee', 200),
    ],
    signals: [{ customerId: '4', type: 'asked', productId: 'sneak', categoryId: null, variant: null, at: ago(2) }, { customerId: '2', type: 'viewed', productId: null, categoryId: 'shoes', variant: null, at: ago(40) }],
  };
  const who = (r: unknown) => evaluate(ruleSchema.parse(r), d, now).sort();
  assert.deepEqual(who({ all: [{ kind: 'signal', action: 'bought', categoryId: 'shoes' }] }), ['1']);
  assert.deepEqual(who({ all: [{ kind: 'signal', action: 'asked', productId: 'sneak', withinDays: 7 }] }), ['4']);
  assert.deepEqual(who({ all: [{ kind: 'signal', action: 'viewed', categoryId: 'shoes', withinDays: 30 }] }), [], 'too long ago');
  assert.deepEqual(who({ all: [{ kind: 'spend_percentile', min: 90 }] }), ['1']);
  assert.deepEqual(who({ all: [{ kind: 'order_count', min: 3 }] }), ['1']);
  assert.deepEqual(who({ all: [{ kind: 'order_count', min: 1, max: 1 }] }), ['2', '3']);
  assert.deepEqual([who({ all: [{ kind: 'recency', bucket: 'active' }] }), who({ all: [{ kind: 'recency', bucket: 'cooling' }] }), who({ all: [{ kind: 'recency', bucket: 'lapsed' }] })], [['1'], ['2'], ['3']]);
  assert.deepEqual(who({ all: [{ kind: 'last_order_older', days: 30 }] }), ['2', '3']);
  assert.deepEqual(who({ all: [{ kind: 'size', value: '42' }] }), ['1']);
  assert.deepEqual(who({ all: [{ kind: 'area', value: 'Yaba' }] }), ['1']);
  assert.deepEqual(who({ all: [{ kind: 'interest', value: 'sneaker' }] }), ['5']);
  assert.deepEqual(who({ all: [{ kind: 'usual_day', day: new Date(new Date(ago(5)).getTime() + 3_600_000).toUTCString().slice(0, 3).toLowerCase() }] }).length <= 1, true);
});

test('segments: plain language becomes a validated rule with a count', async () => {
  const cats = [{ id: 'shoes', name: 'Sneakers' }, { id: 'bags', name: 'Bags' }];
  const products = [{ id: 'j4', name: 'Jordan 4' }];
  assert.deepEqual(await ruleFromWords('my sneaker buyers', { categories: cats, products }), { all: [{ kind: 'signal', action: 'bought', categoryId: 'shoes' }] });
  assert.deepEqual(await ruleFromWords("people who haven't ordered in a month", { categories: cats, products }), { all: [{ kind: 'last_order_older', days: 30 }] });
  assert.deepEqual(await ruleFromWords('my top customers', { categories: cats, products }), { all: [{ kind: 'spend_percentile', min: 90 }] });
  // The AI is only asked when the patterns don't know, and its rule must use ids that exist.
  const ai = (rule: unknown) => ({ async chooseTool() { return null; }, async writeTexts() { return { rule: JSON.stringify(rule) }; } }) as LLMProvider;
  assert.deepEqual(await ruleFromWords('folks into Jordans', { categories: cats, products, llm: ai({ all: [{ kind: 'signal', action: 'viewed', productId: 'j4' }] }) }), { all: [{ kind: 'signal', action: 'viewed', productId: 'j4' }] });
  assert.equal(await ruleFromWords('folks into Jordans', { categories: cats, products, llm: ai({ all: [{ kind: 'signal', action: 'viewed', productId: 'not-mine' }] }) }), null, 'an id from another shop is refused');
  assert.equal(await ruleFromWords('folks into Jordans', { categories: cats, products, llm: ai({ all: [{ kind: 'drop_table' }] }) }), null, 'anything outside the rule format is refused');
});

let fx: Awaited<ReturnType<typeof seed>>;
let sneakers: string;
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, cfg, { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
  const [cat] = await createCategories(db, fx.a.id, ['Sneakers']);
  sneakers = (await createProduct(db, { businessId: fx.a.id, name: 'Jordan 4', priceKobo: 4_000_000, categoryId: cat.id })).id;
});
const biz = async () => (await doc('businesses', fx.a.id)) as unknown as Business;
const at = () => new Date().toISOString();
async function paidOrder(id: string, customerId: string, when = at()) {
  await db.set(db.doc('orders', id), { id, ref: `RLY-${id.slice(-5).toUpperCase().padStart(5, 'X')}`, businessId: fx.a.id, customerId, channel: 'whatsapp', status: 'awaiting_payment', fulfilment: 'pending', items: [{ productId: sneakers, name: 'Jordan 4', priceKobo: 4_000_000, qty: 1 }], subtotalKobo: 4_000_000, deliveryFeeKobo: 0, feeKobo: 0, uniqueKobo: 0, payAmountKobo: 4_000_000, delivery: null, holdExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: when, updatedAt: when });
  await markOrderPaid(db, id, fx.a.id, `pay-${id}`, when);
}
async function newCustomer(phone: string, extra: Record<string, unknown> = {}) {
  const id = `${fx.a.id}_wa_${phone}`;
  await db.set(db.doc('customers', id), { id, businessId: fx.a.id, channel: 'whatsapp', phone: `+${phone}`, name: 'Ada Obi', marketingOptIn: true, marketingOptInAt: at(), orderCount: 0, totalSpentKobo: 0, createdAt: at(), updatedAt: at(), ...extra });
  return id;
}

test('segments: refresh on a paid order', async () => {
  const id = await newCustomer('2348077000001');
  const loyal = { all: [{ kind: 'order_count' as const, min: 3 }] };
  assert.ok(!evaluate(loyal, await loadSegmentData(db, fx.a.id)).includes(id));
  for (const n of [1, 2, 3]) await paidOrder(`seg-o${n}`, id);
  assert.ok(evaluate(loyal, await loadSegmentData(db, fx.a.id)).includes(id), 'the third paid order puts them in 3+ orders at once');
  const sizes = await refreshSegments(db, fx.a.id);
  assert.ok(sizes.find(s => s.key === 'loyal')!.size >= 1);
  assert.ok(sizes.some(s => s.name === 'Bought Sneakers' && s.size >= 1));
  assert.equal((await doc('segments', `${fx.a.id}_loyal`)).system, true);
});

test('templates: library validates variables and submit script lists them', () => {
  const payloads = templatePayloads();
  assert.ok(payloads.length >= 5 && payloads.every(p => p.category === 'MARKETING'), 'marketing, never labelled utility');
  assert.deepEqual(fillVariables({ variables: ['name', 'item'] }, { name: 'Ada', item: '' }), { ok: false, missing: ['item'] });
  assert.deepEqual(fillVariables({ variables: ['name', 'item'] }, { name: 'Ada', item: 'Jordan 4' }), { ok: true, params: ['Ada', 'Jordan 4'] });
  const out = spawnSync(process.execPath, ['--import', 'tsx', path.join(__dirname, '../scripts/submit-templates.ts'), '--dry-run'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /OK: \d+ marketing templates[\s\S]*relay_back_in_stock/);
});

test('personal: a message with a missing variable is skipped, not sent broken', () => {
  const open = new Map([['1', new Date(Date.now() - 3_600_000).toISOString()], ['2', new Date(Date.now() - 3_600_000).toISOString()]]);
  const ds = routeAll([customer('1'), customer('2', { name: '🔥🔥' })], open, { cfg, usedService: 0, needs: ['name'] });
  assert.deepEqual(ds.map(d => d.route ?? d.skip), ['open', 'missing_variable']);
  assert.equal(personal('Hi {name}, new stock!', { name: 'Ada Obi' }), 'Hi Ada, new stock!');
});

test('route plan: paid sends need approval and enough wallet balance', async () => {
  // A customer whose chat closed long ago: only a paid template can reach them.
  const id = await newCustomer('2348077000002', { lastInboundAt: new Date(Date.now() - 10 * DAY).toISOString() });
  const plain = await planCampaign(db, cfg, await biz(), { name: 'x', text: 'Hi {name}, new Jordans!', source: 'owner', audience: [id] });
  assert.equal(plain.summary.unreachable, 1, 'no approved template: not reachable');
  await setTemplateState(db, fx.a.id, 'relay_update', 'approved');
  const paid = await planCampaign(db, cfg, await biz(), { name: 'x', text: 'Hi {name}, new Jordans!', source: 'owner', audience: [id] });
  assert.equal(paid.summary.paid_template, 1);
  assert.equal(paid.summary.cost, Math.round(0.0516 * cfg.NGN_PER_USD * 100), '$0.0516 at the configured rate');
  // The wallet is empty: nothing is sent or charged.
  await getWallet(db, fx.a.id); await db.update(db.doc('wallets', fx.a.id), { availableKobo: 0 });
  const blocked = await executeCampaign(db, cfg, { enqueue: async () => {} }, await biz(), paid.campaign.id);
  assert.ok(blocked && 'blocked' in blocked && blocked.blocked);
  assert.equal((await db.query('sends', [['campaignId', '==', paid.campaign.id]])).length, 0);
  // Money in the wallet: sent as the template, and charged once.
  await db.set(db.doc('ledger', 'sale-for-reach'), { id: 'sale-for-reach', businessId: fx.a.id, type: 'sale', merchantNetKobo: 1_000_000, at: at() });
  await db.delete(db.doc('wallets', fx.a.id));
  const before = (await getWallet(db, fx.a.id)).availableKobo;
  const r = await executeCampaign(db, cfg, { enqueue: async () => {} }, await biz(), paid.campaign.id);
  assert.equal(r!.sent, 1);
  assert.equal((await getWallet(db, fx.a.id)).availableKobo, before - paid.summary.cost);
  assert.equal((await doc('ledger', `msgcost_${paid.campaign.id}`)).type, 'message_cost');
  const out = await doc('outbox', `reach_${paid.campaign.id}_${id}`.replace(/[^A-Za-z0-9_-]/g, '_'));
  assert.deepEqual(out.paidTemplate, { name: 'relay_update', params: ['Ada', 'Business biz-a', 'Hi Ada, new Jordans!'] });
  await setTemplateState(db, fx.a.id, 'relay_update', 'pending');
});

test('attribution: reply or order within 48h links to the last send', async () => {
  const id = await newCustomer('2348077000003', { lastInboundAt: new Date(Date.now() - 11 * 3_600_000).toISOString(), marketingOptInAt: new Date(Date.now() - 12 * 3_600_000).toISOString() });
  const first = await planCampaign(db, cfg, await biz(), { name: 'First', text: 'One', source: 'owner', audience: [id] });
  await executeCampaign(db, cfg, { enqueue: async () => {} }, await biz(), first.campaign.id, {}, new Date(Date.now() - 10 * 3_600_000));
  await db.update(db.doc('customers', id), { marketingTimes: [] });
  const second = await planCampaign(db, cfg, await biz(), { name: 'Second', text: 'Two', source: 'owner', audience: [id] });
  await executeCampaign(db, cfg, { enqueue: async () => {} }, await biz(), second.campaign.id, {}, new Date(Date.now() - 2 * 3_600_000));
  await paidOrder('attr-o1', id, new Date(Date.now() - 3_600_000).toISOString());
  await db.set(db.doc('customerSignals', 'attr-r1'), { businessId: fx.a.id, customerId: id, type: 'replied', productId: null, categoryId: null, variant: null, at: new Date(Date.now() - 90 * 60_000).toISOString() });
  const [a, b] = [await campaignResults(db, first.campaign.id), await campaignResults(db, second.campaign.id)];
  assert.deepEqual([a.ordered, a.replied], [0, 0], 'the earlier send gets nothing');
  assert.deepEqual([b.ordered, b.replied, b.revenueKobo], [1, 1, 4_000_000], 'the last send before the order wins');
  // Too late: an order 49h after the only send counts for nothing.
  const late = await newCustomer('2348077000004', { lastInboundAt: new Date(Date.now() - 51 * 3_600_000).toISOString(), marketingOptInAt: new Date(Date.now() - 52 * 3_600_000).toISOString() });
  const third = await planCampaign(db, cfg, await biz(), { name: 'Third', text: 'Three', source: 'owner', audience: [late] });
  await executeCampaign(db, cfg, { enqueue: async () => {} }, await biz(), third.campaign.id, {}, new Date(Date.now() - 50 * 3_600_000));
  await paidOrder('attr-o2', late, new Date(Date.now() - 3_600_000).toISOString());
  assert.equal((await campaignResults(db, third.campaign.id)).ordered, 0);
});

test('report: campaign numbers match the sends log', async () => {
  const ids = [await newCustomer('2348077000005', { lastInboundAt: new Date(Date.now() - 50 * 3_600_000).toISOString(), marketingOptInAt: new Date(Date.now() - 52 * 3_600_000).toISOString() }), await newCustomer('2348077000006', { lastInboundAt: new Date(Date.now() - 50 * 3_600_000).toISOString(), marketingOptInAt: new Date(Date.now() - 52 * 3_600_000).toISOString() })];
  const p = await planCampaign(db, cfg, await biz(), { name: 'Weekend', text: 'Hi {name}!', source: 'owner', audience: ids });
  await executeCampaign(db, cfg, { enqueue: async () => {} }, await biz(), p.campaign.id, {}, new Date(Date.now() - 49 * 3_600_000));
  await paidOrder('rep-o1', ids[0], new Date(Date.now() - 48.5 * 3_600_000).toISOString());
  const sends = await db.query('sends', [['campaignId', '==', p.campaign.id]]);
  const r = await campaignResults(db, p.campaign.id);
  assert.equal(r.sent, sends.length);
  assert.equal(r.costKobo, sends.reduce((t, s) => t + Number(s.cost), 0));
  assert.equal(r.ordered, 1);
  const outbox = await dueCampaignReports(db);
  const mine = await doc('outbox', `${fx.a.id}_reach_${p.campaign.id}`);
  assert.ok(outbox.includes(`${fx.a.id}_reach_${p.campaign.id}`));
  assert.equal(mine.text, '📊 *Weekend*: sent 2 → 0 replied → 1 ordered → ₦40,000. Cost ₦0.');
  assert.equal((await doc('sends', `${p.campaign.id}_${ids[0]}`.replace(/[^A-Za-z0-9_-]/g, '_'))).attributedOrderId, 'rep-o1');
  assert.deepEqual(await dueCampaignReports(db), [], 'reported once');
});

test('owner: "tell my sneaker buyers about the new Jordans" → who, how many, three wordings, then the plan', async () => {
  const bot = new Bot();
  const o = fx.a.ownerPhone.slice(1);
  const who = await bot.send('admin', { from: o, text: 'tell my sneaker buyers about the new Jordans, 10% off this weekend' });
  assert.match(who[0].text, /^\*\d+ customers?\*: bought Sneakers\.[\s\S]*\*1\.\* Hi \{name\}/);
  assert.deepEqual(who[1].options, ['act:reachpick:1', 'act:reachpick:2', 'act:reachpick:3']);
  const plan = await bot.send('admin', { from: o, choice: 'act:reachpick:1', text: 'Option 1' });
  assert.match(plan[0].text, /customers?:\n/);
  assert.match(plan[0].text, /Cost: ₦/);
});
