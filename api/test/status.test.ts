import { Bot, clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { createCategories, createProduct } from '../src/services/catalog';
import { dueStatusReports, scoreAudience, type StatusCustomer } from '../src/services/status-posts';
import { statusImage } from '../src/services/status-image';
import { suggestStatus } from '../src/services/status-tips';
import type { Business } from '../src/domain/business';
import type { Order } from '../src/domain/commerce';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

const DAY = 86_400_000;
const now = new Date('2026-11-19T12:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
const customer = (id: string, extra: Partial<StatusCustomer> = {}): StatusCustomer => ({ id, businessId: 'b', phone: `+23480${id.padStart(8, '0')}`, name: `Name ${id}`, marketingOptIn: true, orderCount: 0, totalSpentKobo: 0, createdAt: ago(100), updatedAt: ago(100), ...extra });
const order = (customerId: string, productId: string, daysAgo: number): Order => ({ id: `o-${customerId}-${productId}`, customerId, businessId: 'b', status: 'paid', paidAt: ago(daysAgo), createdAt: ago(daysAgo), items: [{ productId, name: productId, priceKobo: 100_000, qty: 1 }] } as unknown as Order);
const products = [{ id: 'boots1', categoryId: 'shoes' }, { id: 'boots2', categoryId: 'shoes' }, { id: 'dress', categoryId: 'clothing' }];

test('audience: bought it > bought the section > asked about it; recent beats old; no link, opted out or spam: out', () => {
  const ranked = scoreAudience({
    now, products, target: { productIds: ['boots1'], categoryId: null },
    customers: [
      customer('1'), customer('2'), customer('3', { interests: { p_boots1: ago(2) } }), customer('4'), customer('5'),
      customer('6', { marketingOptIn: false, marketingOptOutAt: ago(3) }), customer('7', { spamReportedAt: ago(10) }), customer('8'), customer('9'),
    ],
    orders: [order('1', 'boots1', 5), order('2', 'boots2', 5), order('4', 'boots1', 200), order('5', 'dress', 1), order('6', 'boots1', 1), order('7', 'boots1', 1), order('9', 'boots2', 90)],
  });
  // 9 bought other boots 3 months ago; 4 bought these boots 7 months ago: recent wins.
  assert.deepEqual(ranked.map(r => r.customerId), ['1', '2', '3', '9', '4'], 'dress buyer 5 and 8 have no link; 6 opted out; 7 reported spam');
});

test('audience: mentioned in the last 7 days → not suggested again yet; often mentioned → lower, so others get a turn', () => {
  const base = { now, products, target: { productIds: ['boots1'], categoryId: null }, orders: [order('1', 'boots1', 5), order('2', 'boots1', 6)] };
  const fresh = scoreAudience({ ...base, customers: [customer('1'), customer('2')] });
  assert.deepEqual(fresh.map(r => [r.customerId, r.cooling]), [['1', false], ['2', false]]);
  const cooling = scoreAudience({ ...base, customers: [customer('1', { lastStatusMentionAt: ago(3), statusMentionCount: 1 }), customer('2')] });
  assert.deepEqual(cooling.find(r => r.customerId === '1')!.cooling, true);
  const rotated = scoreAudience({ ...base, customers: [customer('1', { lastStatusMentionAt: ago(30), statusMentionCount: 4 }), customer('2')] });
  assert.deepEqual(rotated.map(r => r.customerId), ['2', '1'], 'tagged 4 times before: drops below someone similar');
});

test('image: a 1080×1920 JPEG, with or without a photo', () => {
  const jpeg = statusImage({ hex: '0f766e', shopName: "Tee's Thrift", title: 'Black Leather Chukka Boots', price: '₦19,000' });
  assert.deepEqual([...jpeg.slice(0, 2)], [0xff, 0xd8]);
  assert.ok(jpeg.byteLength > 10_000);
});

let fx: Awaited<ReturnType<typeof seed>>;
const stored = new Map<string, { bytes: Uint8Array; type: string }>();
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, getConfig(env), { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
  (env as unknown as { PRODUCT_IMAGES: unknown }).PRODUCT_IMAGES = {
    async put(k: string, v: ArrayBuffer, o?: { httpMetadata?: { contentType?: string } }) { stored.set(k, { bytes: new Uint8Array(v), type: o?.httpMetadata?.contentType ?? '' }); return null; },
    async get(k: string) { const v = stored.get(k); return v ? { body: new Response(v.bytes).body!, httpMetadata: { contentType: v.type } } : null; },
  };
});

test('status: /status → picture + caption + 5 to mention → change people → posted → a day later, who ordered', async () => {
  const [shoes] = await createCategories(db, fx.a.id, ['Shoes']);
  const boots = await createProduct(db, { businessId: fx.a.id, name: 'Black Ankle Boots', priceKobo: 1_500_000, categoryId: shoes.id });
  const at = new Date().toISOString();
  // Seven customers who bought boots (more than 5, so "Change people" has someone else to offer).
  for (let i = 1; i <= 7; i++) {
    const id = `${fx.a.id}_wa_23480990000${i}`;
    await db.set(db.doc('customers', id), { id, businessId: fx.a.id, phone: `+23480990000${i}`, name: `Buyer${i} Okafor`, marketingOptIn: true, orderCount: 1, totalSpentKobo: 1_500_000, createdAt: at, updatedAt: at });
    await db.set(db.doc('orders', `o-boot-${i}`), { id: `o-boot-${i}`, ref: `RLY-BOOT${i}`, businessId: fx.a.id, customerId: id, channel: 'whatsapp', status: 'paid', fulfilment: 'delivered', items: [{ productId: boots.id, name: 'Black Ankle Boots', priceKobo: 1_500_000, qty: 1 }], subtotalKobo: 1_500_000, deliveryFeeKobo: 0, feeKobo: 0, uniqueKobo: 0, payAmountKobo: 1_500_000, delivery: null, holdExpiresAt: at, paidAt: new Date(Date.now() - i * DAY).toISOString(), createdAt: new Date(Date.now() - i * DAY).toISOString(), updatedAt: at });
  }
  const bot = new Bot();
  const o = fx.a.ownerPhone.slice(1);
  const pick = await bot.send('admin', { from: o, text: '/status' });
  assert.ok(pick[0].options.includes(`act:status:p:${boots.id}`));
  const made = await bot.send('admin', { from: o, choice: `act:status:p:${boots.id}`, text: 'Black Ankle Boots' });
  const img = made[0].content as { type: string; link: string; caption: string };
  assert.equal(img.type, 'image');
  assert.match(img.caption, /^✨ Black Ankle Boots\n₦15,000[\s\S]*Reply \*BOOTS\* to order/);
  const key = img.link.split('/media/')[1];
  assert.equal(stored.get(key)!.type, 'image/jpeg', 'the picture is saved for WhatsApp to fetch');
  assert.match(made[1].text, /tap \*@\* and add these 5:\n1\. Buyer1 Okafor \(…0001\)\n2\. Buyer2 Okafor/, 'the most recent buyers first');
  const postId = made[1].options[0].split(':')[2];
  assert.deepEqual(made[1].options, [`act:stposted:${postId}`, `act:stpeople:${postId}`, `act:stskip:${postId}`]);
  assert.match(made[2].text, /2 more customers might like this\. Send them a personal message instead\?/);

  const other = await bot.send('admin', { from: o, choice: `act:stpeople:${postId}`, text: 'Change people' });
  assert.match(other[0].text, /add these 2:\n1\. Buyer6 Okafor/);
  await bot.send('admin', { from: o, choice: `act:stpeople:${postId}`, text: 'Change people' }); // back to the first 5
  const posted = await bot.send('admin', { from: o, choice: `act:stposted:${postId}`, text: "I've posted it" });
  assert.match(posted[0].text, /I'll tell you tomorrow/);
  const tagged = await doc('customers', `${fx.a.id}_wa_234809900001`);
  assert.ok(tagged.lastStatusMentionAt);
  assert.equal(tagged.statusMentionCount, 1);
  // The same people aren't suggested again for a week.
  const again = await bot.send('admin', { from: o, choice: `act:status:p:${boots.id}`, text: 'Black Ankle Boots' });
  assert.match(again[1].text, /add these 2:\n1\. Buyer6 Okafor[\s\S]*2\. Buyer7 Okafor/);

  // Buyer1 orders again within a day of the post; Buyer2 just messages.
  const post = await doc('statusPosts', postId);
  const soon = new Date(new Date(post.confirmedPostedAt).getTime() + 3_600_000).toISOString();
  await db.set(db.doc('orders', 'o-after'), { id: 'o-after', ref: 'RLY-AFTER', businessId: fx.a.id, customerId: `${fx.a.id}_wa_234809900001`, channel: 'whatsapp', status: 'paid', fulfilment: 'pending', items: [], subtotalKobo: 3_700_000, deliveryFeeKobo: 0, feeKobo: 0, uniqueKobo: 0, payAmountKobo: 3_700_000, delivery: null, holdExpiresAt: soon, paidAt: soon, createdAt: soon, updatedAt: soon });
  await db.set(db.doc('conversations', `${fx.a.id}_wa_234809900002`), { lastInboundAt: soon }, { merge: true });
  assert.deepEqual(await dueStatusReports(db, new Date(Date.now() + 2 * 3_600_000)), [], 'not before the day is up');
  const ids = await dueStatusReports(db, new Date(Date.now() + 25 * 3_600_000));
  assert.equal(ids.length, 1);
  const report = await doc('outbox', ids[0]);
  assert.equal(report.text, '📊 Your Status for *Black Ankle Boots*: 1 of the 5 you mentioned ordered 🎉 (₦37,000), and 1 more messaged you.');
  assert.deepEqual(report.buttons.map((b: { id: string }) => b.id), ['act:status', 'act:menu']);
  assert.deepEqual(await dueStatusReports(db, new Date(Date.now() + 26 * 3_600_000)), [], 'reported once');

  // The rest get a personal message instead: only them, opted-in only, cost first.
  await bot.send('admin', { from: o, choice: `act:stothers:${postId}`, text: 'Yes, write it' });
  const quote = await bot.send('admin', { from: o, text: 'Black Ankle Boots are back! Reply to order.' });
  assert.match(quote[0].text, /^Send this to 2 customers who opted in\?/);
});

test('status tips: on by default for live shops, once a day, never during signup, and can be turned off', async () => {
  const bot = new Bot();
  const b = (await doc('businesses', fx.a.id)) as unknown as Business;
  const deps = { enqueue: async () => {} } as never;
  assert.equal(await suggestStatus(db, deps, { ...b, status: 'onboarding' }, { kind: 'new', name: 'X' }, { productId: 'p' }), false, 'not during signup');
  assert.equal(await suggestStatus(db, deps, { ...b, status: 'active' }, { kind: 'restock', name: 'Black Ankle Boots' }, { productId: 'p' }), true);
  const tip = (await db.query('outbox', [['businessId', '==', fx.a.id], ['kind', '==', 'status_tip']]))[0];
  assert.match(String(tip.text), /Black Ankle Boots\* is back in stock\. Make a Status\?/);
  assert.equal(await suggestStatus(db, deps, (await doc('businesses', fx.a.id)) as unknown as Business, { kind: 'new', name: 'Y' }, { productId: 'p' }), false, 'once a day');
  assert.match((await bot.send('admin', { from: fx.a.ownerPhone.slice(1), text: 'status tips off' }))[0].text, /no more Status tips/);
  assert.equal((await doc('businesses', fx.a.id)).statusTips, false);
});
