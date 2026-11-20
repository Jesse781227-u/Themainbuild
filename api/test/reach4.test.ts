import { Bot, clearFirestore, db, doc, env, FakeTransport, postMeta, queueMessage, seed, seedCart, waMessage } from './helpers';
import { handleQueueBatch } from '../src/services/queue';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { createCategories, createProduct } from '../src/services/catalog';
import { executeCampaign, planCampaign, routeAll, type ReachCustomer } from '../src/services/reach';
import { pickedForYou } from '../src/services/picks';
import { checkOffer, createOfferCode } from '../src/services/offers';
import { checkout, cancelOrder } from '../src/services/orders';
import { fromAd } from '../src/services/router';
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
let shoes: string, bags: string;
const products: Product[] = [];
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, cfg, { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
  const [s, b] = await createCategories(db, fx.a.id, ['Shoes', 'Bags']);
  shoes = s.id; bags = b.id;
  for (const [name, cat, price] of [['Black Boots', shoes, 1_500_000], ['White Sneakers', shoes, 2_000_000], ['Brown Loafers', shoes, 1_800_000], ['Leather Tote', bags, 2_500_000], ['Mini Bag', bags, 1_200_000]] as const) {
    products.push(await createProduct(db, { businessId: fx.a.id, name, priceKobo: price, categoryId: cat, images: [`https://img.test/${name.replace(/ /g, '-')}.jpg`] }));
  }
});
const biz = async () => (await doc('businesses', fx.a.id)) as unknown as Business;
const byName = (n: string) => products.find(p => p.name === n)!;

test('carousel: picked-for-you products per customer', async () => {
  const now = new Date();
  const sig = (type: string, p: string) => ({ type, productId: byName(p).id, categoryId: null, at: ago(DAY) });
  // A shoe person (bought boots) and a bag person (carted the tote): different picks, nothing they own.
  const shoePerson = pickedForYou(products, [sig('bought', 'Black Boots'), sig('viewed', 'White Sneakers')], [byName('Black Boots').id], 5, now);
  const bagPerson = pickedForYou(products, [sig('carted', 'Leather Tote')], [], 5, now);
  assert.equal(shoePerson[0].name, 'White Sneakers');
  assert.ok(shoePerson.every(p => p.categoryId === shoes) && !shoePerson.some(p => p.name === 'Black Boots'));
  assert.deepEqual(bagPerson.map(p => p.name), ['Leather Tote', 'Mini Bag']);
  assert.deepEqual(pickedForYou(products, [], [], 5, now), [], 'no history: no picks');

  // Sent: each customer's own carousel (in their open chat), cards with "Add to cart".
  const mk = async (phone: string) => { const id = `${fx.a.id}_wa_${phone}`; await db.set(db.doc('customers', id), { ...rc(phone), id, businessId: fx.a.id, channel: 'whatsapp', phone: `+${phone}`, lastInboundAt: ago(H) }); return id; };
  const a = await mk('2348070100001'), b = await mk('2348070100002');
  await db.set(db.doc('customerSignals', 'pk1'), { businessId: fx.a.id, customerId: a, type: 'viewed', productId: byName('White Sneakers').id, categoryId: null, variant: null, at: ago(DAY) });
  await db.set(db.doc('customerSignals', 'pk2'), { businessId: fx.a.id, customerId: b, type: 'carted', productId: byName('Mini Bag').id, categoryId: null, variant: null, at: ago(DAY) });
  const p = await planCampaign(db, cfg, await biz(), { name: 'Picked for you', text: 'Hi {name}, we picked these for you 👇', source: 'owner', audience: [a, b], picks: true });
  await executeCampaign(db, cfg, deps, await biz(), p.campaign.id);
  const cards = async (cid: string) => ((await doc('outbox', `reach_${p.campaign.id}_${cid}`)).content as { type: string; interactive: { type: string; action: { cards: { action: { buttons: { quick_reply: { id: string } }[] } }[] } } });
  const [ca, cb] = [await cards(a), await cards(b)];
  assert.equal(ca.interactive.type, 'carousel');
  const ids = (c: typeof ca) => c.interactive.action.cards.map(x => x.action.buttons[0].quick_reply.id);
  assert.ok(ids(ca).includes(`buy:${byName('White Sneakers').id}`) && !ids(ca).some(x => x.includes(byName('Mini Bag').id)));
  assert.ok(ids(cb).includes(`buy:${byName('Mini Bag').id}`) && !ids(cb).some(x => x.includes(byName('White Sneakers').id)));
});

test('router: free entry window from ad referral is detected and used', async () => {
  assert.equal(fromAd({ referral: { source_type: 'ad', source_id: '1', ctwa_clid: 'abc' } }), true);
  assert.equal(fromAd({ text: { body: 'hi' } }), false);
  // A message from an ad sets adReferralAt on the customer.
  const phone = '2348070200001';
  await postMeta({ object: 'whatsapp_business_account', entry: [{ id: 'waba-a', changes: [{ field: 'messages', value: { metadata: { phone_number_id: fx.a.pnid }, contacts: [{ wa_id: phone, profile: { name: 'Bimpe' } }], messages: [{ ...waMessage({ phoneNumberId: fx.a.pnid, from: phone, id: 'wamid.ad1', text: 'Is this available?' }).entry[0].changes[0].value.messages[0], referral: { source_type: 'ad', source_id: '123', ctwa_clid: 'clid' } }] } }] }] });
  await handleQueueBatch({ queue: 'test', messages: env.EVENTS.sent.splice(0).map(job => queueMessage(job)) }, env, { transport: new FakeTransport(), llm: null, transcriber: null });
  assert.ok((await doc('customers', `${fx.a.id}_wa_${phone}`)).adReferralAt, 'the ad message is detected');
  // Routing: 30 hours after the ad message the 24h chat is closed, but the 72h window still lets it through, free.
  const opts = { cfg, usedService: cfg.SERVICE_FREE_PER_MONTH }; // monthly free chats all used: proves it doesn't need them
  const [viaAd] = routeAll([rc('1', { adReferralAt: ago(30 * H), lastInboundAt: ago(30 * H) })], new Map(), { ...opts, ownerSentOk: false });
  assert.deepEqual([viaAd.route, viaAd.cost], ['free_window', 0]);
  const [tooLate] = routeAll([rc('2', { adReferralAt: ago(73 * H), lastInboundAt: ago(73 * H) })], new Map(), { ...opts, ownerSentOk: false });
  assert.equal(tooLate.skip, 'unreachable');
});

test('offer codes: single use, per customer, expiry checked at checkout', async () => {
  const ada = `${fx.a.id}_wa_2348070300001`, bayo = `${fx.a.id}_wa_2348070300002`;
  const offer = await createOfferCode(db, { businessId: fx.a.id, customerId: ada, name: 'Ada', percentOff: 10, days: 7 });
  assert.match(offer.code, /^ADA-[A-Z2-9]{4}$/);
  const boots = byName('Black Boots');
  // Someone else's code is refused at checkout (and nothing is reserved).
  await seedCart('cart-bayo', fx.a.id, bayo, [{ productId: boots.id, qty: 1 }]);
  await assert.rejects(checkout(db, { cartId: 'cart-bayo', businessId: fx.a.id, policy, offerCode: offer.code }), /OFFER_NOT_YOURS/);
  // Ada's checkout: 10% off the goods, the code reserved.
  await seedCart('cart-ada', fx.a.id, ada, [{ productId: boots.id, qty: 1 }]);
  const o = await checkout(db, { cartId: 'cart-ada', businessId: fx.a.id, policy, offerCode: offer.code.toLowerCase() });
  assert.equal(o.discountKobo, 150_000);
  assert.equal(o.payAmountKobo - o.uniqueKobo, 1_350_000 + o.feeKobo);
  assert.equal((await doc('offerCodes', offer.code)).orderId, o.id);
  // Single use: a second order can't use it…
  await seedCart('cart-ada2', fx.a.id, ada, [{ productId: boots.id, qty: 1 }]);
  await assert.rejects(checkout(db, { cartId: 'cart-ada2', businessId: fx.a.id, policy, offerCode: offer.code }), /OFFER_USED/);
  // …unless that order is cancelled, which frees it.
  await cancelOrder(db, o.id, fx.a.id);
  assert.equal((await doc('offerCodes', offer.code)).usedAt, null);
  // Expiry: checked at the moment of checkout.
  assert.deepEqual(checkOffer(await doc('offerCodes', offer.code), { businessId: fx.a.id, customerId: ada }, 100_000, new Date(Date.now() + 8 * DAY)), { ok: false, reason: 'expired' });
  await assert.rejects(checkout(db, { cartId: 'cart-ada2', businessId: fx.a.id, policy, offerCode: offer.code, now: new Date(Date.now() + 8 * DAY) }), /OFFER_EXPIRED|CART_EXPIRED/);
  const again = await checkout(db, { cartId: 'cart-ada2', businessId: fx.a.id, policy, offerCode: offer.code });
  assert.equal(again.offerCode, offer.code);
});

test('router: instagram route inside the 24h window', () => {
  const ig = (id: string, hoursAgo: number) => rc(id, { channel: 'instagram', phone: '', id: `${fx.a.id}_ig_${id}`, lastInboundAt: ago(hoursAgo * H) } as Partial<ReachCustomer>);
  const ds = routeAll([ig('1784001', 3), ig('1784002', 30)], new Map(), { cfg, usedService: cfg.SERVICE_FREE_PER_MONTH, ownerSentOk: true, paidOk: true });
  assert.deepEqual(ds.map(d => [d.route ?? d.skip, d.cost]), [['instagram', 0], ['unreachable', 0]], 'free inside 24h, no paid or owner route on Instagram');
});

test('offer codes: the customer types their code in the chat and sees it at checkout', async () => {
  const bot = new Bot();
  const phone = '2348070400001', c = { from: phone, to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'hi' });
  const offer = await createOfferCode(db, { businessId: fx.a.id, customerId: `${fx.a.id}_wa_${phone}`, name: 'Kemi', amountOffKobo: 200_000, days: 3 });
  await bot.send('shop', { ...c, choice: `buy:${byName('Mini Bag').id}`, text: 'Add to cart' });
  const saved = await bot.send('shop', { ...c, text: offer.code.toLowerCase() });
  assert.match(saved[0].text, /^✅ Code KEMI-[A-Z2-9]{4} saved: ₦2,000 off at checkout\./);
  const wrong = await bot.send('shop', { ...c, text: 'ZZZ-AB12' });
  assert.match(wrong[0].text, /^That code doesn't exist\./);
  const out = [...await bot.send('shop', { ...c, choice: 'checkout', text: 'Checkout' }), ...await bot.send('shop', { ...c, choice: 'pickup', text: "I'll pick it up" })].map(m => m.text).join('\n');
  assert.match(out, /Subtotal: ₦12,000\nCode KEMI-[A-Z2-9]{4}: -₦2,000/);
  assert.match(out, /Total: ₦10,\d{3}/);
});
