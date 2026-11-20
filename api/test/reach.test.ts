import { Bot, clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { abandonedCarts, backInStock, consented, executeCampaign, markOwnerSent, planCampaign, routeAll, type ReachCustomer } from '../src/services/reach';
import { markOrderPaid } from '../src/services/on-paid';
import type { Business } from '../src/domain/business';
import type { Product } from '../src/domain/commerce';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

// Tests that send "now" would otherwise depend on the time of day: quiet hours are off here, and on
// (21:00–08:00) in the test about them.
const cfgQuiet = getConfig({ ...env, REACH_QUIET_FROM: '21', REACH_QUIET_TO: '8' });
const cfg = Object.assign(getConfig(env), { REACH_QUIET_FROM: 0, REACH_QUIET_TO: 0 }); // the config is cached per env: set it there
const DAY = 86_400_000;
const noon = new Date('2026-11-25T11:00:00Z');      // 12:00 Lagos
const lateNight = new Date('2026-11-25T21:30:00Z'); // 22:30 Lagos: quiet hours
const ago = (ms: number, from = noon) => new Date(from.getTime() - ms).toISOString();
const cust = (id: string, extra: Partial<ReachCustomer> = {}): ReachCustomer => ({ id, businessId: 'b', phone: `+23480${id.padStart(8, '0')}`, name: `Name${id} Okafor`, marketingOptIn: true, marketingOptInAt: ago(30 * DAY), orderCount: 0, totalSpentKobo: 0, createdAt: ago(60 * DAY), updatedAt: ago(DAY), ...extra });
const regular = { orderCount: 4, lastOrderAt: ago(10 * DAY) };

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, cfg, { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
});
const biz = async () => (await doc('businesses', fx.a.id)) as unknown as Business;
const shop = (bot: Bot, from: string, text: string, choice?: string) => bot.send('shop', { from, to: fx.a.pnid, text, choice, name: 'Ada Obi' });
const cid = (phone: string) => `${fx.a.id}_wa_${phone}`;

test('router: open window is free and used first', () => {
  const [d] = routeAll([cust('1', regular)], new Map([['1', ago(3_600_000)]]), { cfg, usedService: 0, now: noon });
  assert.deepEqual([d.route, d.cost, d.queuedUntil], ['open', 0, null], 'their chat is open: free, even for a regular');
});

test('router: service allowance used up falls through', () => {
  const ds = routeAll([cust('1', regular), cust('2')], new Map([['1', ago(3_600_000)], ['2', ago(3_600_000)]]), { cfg, usedService: 1000, now: noon });
  assert.deepEqual(ds.map(d => d.route ?? d.skip), ['owner_sent', 'unreachable'], '1,000 free messages used: regulars go by the owner, the rest wait for paid templates');
  const one = routeAll([cust('1'), cust('2')], new Map([['1', ago(3_600_000)], ['2', ago(3_600_000)]]), { cfg, usedService: 999, now: noon });
  assert.deepEqual(one.map(d => d.route ?? d.skip), ['open', 'unreachable'], 'the last free message goes to the first');
});

test('router: opted out, capped and quiet hours are skipped or queued', () => {
  const open = new Map(['1', '2', '3', '4', '5'].map(id => [id, ago(3_600_000, lateNight)]));
  const ds = routeAll([
    cust('1', { marketingOptOutAt: ago(DAY) }),
    cust('2', { marketingTimes: [ago(2 * DAY, lateNight)] }),
    cust('3', { spamReportedAt: ago(DAY) }),
    cust('4'),
    cust('5', { marketingOptIn: false, marketingOptInAt: null, createdAt: '2026-12-01T00:00:00Z' }),
  ], open, { cfg: cfgQuiet, usedService: 0, now: lateNight });
  assert.deepEqual(ds.map(d => d.route ?? d.skip), ['no_consent', 'weekly_cap', 'reported', 'open', 'no_consent']);
  assert.equal(ds[3].queuedUntil, '2026-11-26T07:00:00.000Z', 'late at night: waits for 8am Lagos');
  assert.ok(consented(cust('6', { marketingOptIn: false, marketingOptInAt: null, createdAt: '2026-11-01T00:00:00Z' }), cfg), 'a customer from before Smart Reach is in unless they said stop');
});

test('router: owner-sent links are encoded, capped at 30, and mark-sent updates sends', async () => {
  const many = Array.from({ length: 35 }, (_, i) => cust(String(100 + i), regular));
  const ds = routeAll(many, new Map(), { cfg, usedService: 0, now: noon });
  assert.equal(ds.filter(d => d.route === 'owner_sent').length, 30);
  assert.equal(ds.filter(d => d.skip === 'owner_batch_full').length, 5);
  // Through a real campaign: the link opens their chat with the message typed.
  const at = new Date().toISOString();
  const id = `${fx.a.id}_wa_2348099000001`;
  await db.set(db.doc('customers', id), { id, businessId: fx.a.id, phone: '+2348099000001', name: 'Ada Obi', marketingOptIn: true, marketingOptInAt: at, orderCount: 5, lastOrderAt: at, totalSpentKobo: 0, createdAt: at, updatedAt: at });
  const p = await planCampaign(db, cfg, await biz(), { name: 'x', text: 'Hi {name}, 50% off & free delivery?', source: 'owner', audience: [id] });
  assert.equal(p.summary.owner_sent, 1);
  const r = await executeCampaign(db, cfg, { enqueue: async () => {} }, await biz(), p.campaign.id);
  assert.equal(r!.links[0].link, `https://wa.me/2348099000001?text=${encodeURIComponent('Hi Ada, 50% off & free delivery?')}`);
  assert.equal((await doc('sends', `${p.campaign.id}_${id}`)).status, 'owner_pending');
  assert.equal(await markOwnerSent(db, fx.a.id, p.campaign.id), 1);
  const s = await doc('sends', `${p.campaign.id}_${id}`);
  assert.equal(s.status, 'owner_marked_sent');
  assert.ok(s.sentAt);
  assert.equal((await doc('customers', id)).marketingTimes.length, 1, 'it counts toward the weekly limit');
});

test('reach: sends log is the source of truth for cost', async () => {
  const bot = new Bot();
  await shop(bot, '2348099100001', 'hi'); // an open chat
  await db.update(db.doc('customers', cid('2348099100001')), { marketingOptIn: true, marketingOptInAt: new Date().toISOString() });
  const p = await planCampaign(db, cfg, await biz(), { name: 'x', text: 'New stock {name}!', source: 'owner', audience: [cid('2348099100001')] });
  const r = await executeCampaign(db, cfg, { enqueue: async () => {} }, await biz(), p.campaign.id);
  assert.equal(r!.sent, 1);
  const sends = await db.query('sends', [['campaignId', '==', p.campaign.id]]);
  assert.deepEqual(sends.map(s => [s.route, s.cost, s.status]), [['open', 0, 'sent']]);
  assert.equal(sends.reduce((t, s) => t + Number(s.cost), 0), p.campaign.estCost, 'cost comes from the sends');
  const again = await executeCampaign(db, cfg, { enqueue: async () => {} }, await biz(), p.campaign.id);
  assert.equal(again!.sent, 0, 'sending twice sends nothing');
  assert.equal((await db.query('sends', [['campaignId', '==', p.campaign.id]])).length, 1);
  const out = await doc('outbox', `reach_${p.campaign.id}_${cid('2348099100001')}`.replace(/[^A-Za-z0-9_-]/g, '_'));
  assert.match(JSON.stringify(out.content), /"id":"stopupd","title":"Stop updates"/, 'every update has Stop updates');
});

test('route plan: counts and cost per route before sending', async () => {
  const bot = new Bot();
  const o = fx.a.ownerPhone.slice(1);
  // A new week: earlier tests' updates don't count against these customers.
  for (const c of await db.query('customers', [['businessId', '==', fx.a.id]])) await db.update(db.doc('customers', c._id as string), { marketingTimes: [] });
  const home = await bot.send('admin', { from: o, text: '/reach' });
  assert.ok(home[0].options.includes('act:reachall'));
  await bot.send('admin', { from: o, choice: 'act:reachall', text: 'Send an update' });
  const plan = await bot.send('admin', { from: o, text: 'Hi {name}, new Ankara gowns just landed!' });
  assert.match(plan[0].text, /customers:\n• \d+ free, in their chat\n• 1 regulars: you send from your phone[\s\S]*Cost: ₦0/);
  const [send, free, edit] = plan[0].options;
  assert.match(send, /^act:reachsend:c_/);
  assert.match(free, /^act:reachfree:c_/);
  assert.equal(edit, 'act:reachall');
  assert.equal((await db.query('sends', [['campaignId', '==', send.split(':')[2]]])).length, 0, 'nothing sent before Send all');
  const done = await bot.send('admin', { from: o, choice: send, text: 'Send all' });
  assert.match(done[0].text, /^✅ Sent to \d+\./);
  assert.match(done[1].text, /Your regulars: tap each link[\s\S]*1\. Ada Obi: https:\/\/wa\.me\/2348099000001\?text=/);
  assert.deepEqual(done[2].options[0], `act:reachmark:${send.split(':')[2]}`);
});

test('reach: stop updates opts out at once and every send respects it', async () => {
  const bot = new Bot();
  const me = '2348099200001';
  await shop(bot, me, 'hi');
  await db.update(db.doc('customers', cid(me)), { marketingOptIn: true, marketingOptInAt: new Date(Date.now() - 1000).toISOString() });
  const stop = await shop(bot, me, 'Stop updates', 'stopupd');
  assert.match(stop[0].text, /^Done\. No more updates from Business biz-a/);
  const c = await doc('customers', cid(me)) as ReachCustomer;
  assert.equal(consented(c, cfg), false);
  const p = await planCampaign(db, cfg, await biz(), { name: 'x', text: 'Sale!', source: 'owner', audience: [cid(me)] });
  assert.equal(p.summary.no_consent, 1);
  assert.match((await shop(bot, me, 'start updates'))[0].text, /You'll now get occasional updates/);
  assert.equal(consented(await doc('customers', cid(me)) as ReachCustomer, cfg), true);
});

test('reach: checkout opt-in is unticked by default', async () => {
  const bot = new Bot();
  const me = '2348099300001';
  await shop(bot, me, 'Add to cart', `buy:${fx.a.product}`);
  await db.update(db.doc('customers', cid(me)), { createdAt: '2026-12-01T00:00:00.000Z' }); // a new customer
  const confirm = await shop(bot, me, 'Checkout', 'checkout');
  assert.ok(confirm[0].options.includes('optin'), 'a "Send me updates" button, not ticked');
  assert.equal(consented(await doc('customers', cid(me)) as ReachCustomer, cfg), false, 'no updates unless they tap it');
  const yes = await shop(bot, me, 'Send me updates', 'optin');
  assert.match(yes[0].text, /You'll get updates from Business biz-a/);
  assert.deepEqual(yes[0].options, ['confirm', 'menu']);
  assert.equal(consented(await doc('customers', cid(me)) as ReachCustomer, cfg), true);
  assert.ok(!(await shop(bot, me, 'Checkout', 'checkout'))[0].options.includes('optin'), 'not asked again');
});

test('reach: signals are recorded for views, questions, carts, orders and replies', async () => {
  const bot = new Bot();
  const me = '2348099400001';
  await shop(bot, me, 'do you have product biz-a?');                 // asked
  await shop(bot, me, 'See details', `det:${fx.a.product}`);         // viewed
  await shop(bot, me, 'Add to cart', `add:${fx.a.product}`);         // carted
  await shop(bot, me, 'Checkout', 'checkout');
  await shop(bot, me, 'Confirm order', 'confirm');
  const [order] = await db.query('orders', [['customerId', '==', cid(me)]]);
  await markOrderPaid(db, order._id as string, fx.a.id, 'cash');      // bought
  await db.update(db.doc('customers', cid(me)), { lastMarketingAt: new Date().toISOString() });
  await shop(bot, me, 'thanks!');                                   // replied
  const types = new Set((await db.query('customerSignals', [['customerId', '==', cid(me)]])).map(s => s.type));
  assert.deepEqual([...types].sort(), ['asked', 'bought', 'carted', 'replied', 'viewed']);
});

test('trigger: back in stock fires once per restock for people who wanted it', async () => {
  const at = new Date().toISOString();
  await db.update(db.doc('businesses', fx.a.id), { reachTriggers: { back_in_stock: true } });
  await db.update(db.doc('products', fx.a.product), { stock: 0 });
  const bot = new Bot();
  const wanted = '2348099500001', bought = '2348099500002', other = '2348099500003';
  for (const me of [wanted, bought, other]) await shop(bot, me, 'hi');
  for (const me of [wanted, bought, other]) await db.update(db.doc('customers', cid(me)), { marketingOptIn: true, marketingOptInAt: at });
  await db.set(db.doc('customerSignals', 'w1'), { businessId: fx.a.id, customerId: cid(wanted), type: 'viewed', productId: fx.a.product, at });
  await db.set(db.doc('customerSignals', 'b1'), { businessId: fx.a.id, customerId: cid(bought), type: 'carted', productId: fx.a.product, at });
  await db.set(db.doc('customerSignals', 'b2'), { businessId: fx.a.id, customerId: cid(bought), type: 'bought', productId: fx.a.product, at });
  const restock = await bot.send('admin', { from: fx.a.ownerPhone.slice(1), text: `restock Product ${fx.a.id} 5` });
  assert.match(restock[0].text, /\+5, now 5 in stock/);
  const reach = (await db.query('outbox', [['kind', '==', 'reach']])).filter(m => String(m.text).includes('back in stock'));
  const to = reach.map(m => m.to);
  assert.ok(to.includes(`+${wanted}`), 'the one who looked at it');
  assert.ok(!to.includes(`+${bought}`), 'not the one who bought it since');
  assert.ok(!to.includes(`+${other}`), 'not someone who never showed interest');
  const p = (await doc('products', fx.a.product)) as unknown as Product;
  await backInStock(db, cfg, { enqueue: async () => {} }, await biz(), p, null, 'same-restock');
  assert.equal(await backInStock(db, cfg, { enqueue: async () => {} }, await biz(), p, null, 'same-restock'), null, 'the same restock fires once');
});

test('trigger: abandoned cart after an hour, once', async () => {
  const bot = new Bot();
  const me = '2348099600001';
  await shop(bot, me, 'Add to cart', `add:${fx.a.product}`);
  await db.update(db.doc('customers', cid(me)), { marketingOptIn: true, marketingOptInAt: new Date().toISOString() });
  assert.equal(await abandonedCarts(db, cfg, { enqueue: async () => {} }), 0, 'not before an hour');
  const later = new Date(Date.now() + 61 * 60_000);
  assert.equal(await abandonedCarts(db, cfg, { enqueue: async () => {} }, later), 1);
  const msg = (await db.query('outbox', [['kind', '==', 'reach'], ['to', '==', `+${me}`]]))[0];
  assert.match(String(msg.text), /your cart at Business biz-a is saved: Product biz-a\. Ready to check out\?/);
  assert.match(JSON.stringify(msg.content), /"id":"checkout"/);
  assert.equal(await abandonedCarts(db, cfg, { enqueue: async () => {} }, new Date(Date.now() + 3 * 3_600_000)), 0, 'once per cart');
});
