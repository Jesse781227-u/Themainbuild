import { Bot, clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { createCategories, createProduct } from '../src/services/catalog';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
const ids: Record<string, string> = {};
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, getConfig(env), { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
  await db.update(db.doc('products', fx.a.product), { available: false });
  const [food, drinks, sides] = await createCategories(db, fx.a.id, ['Food', 'Drinks', 'Sides']);
  for (const [name, price, cat, stock] of [
    ['Jollof rice', 250_000, food.id, null], ['Jollof special', 320_000, food.id, null], ['Fried rice', 250_000, food.id, null],
    ['Zobo', 50_000, drinks.id, null], ['Chapman', 80_000, drinks.id, 0], ['Plantain', 70_000, sides.id, null],
  ] as const) ids[name] = (await createProduct(db, { businessId: fx.a.id, name, priceKobo: price, categoryId: cat, stock })).id;
});

const shop = (bot: Bot, from: string, choice: string) => bot.send('shop', { from, to: fx.a.pnid, choice, text: 'Add', name: 'Kemi' });
const ia = (m: { content: unknown }) => (m.content as { interactive: { type: string } }).interactive;

test('suggestions: with no signal, only the same-category upgrade is offered', async () => {
  const r = await shop(new Bot(), '2348091200001', `add:${ids['Jollof rice']}`);
  assert.match(r[0].text, /Added 1 × Jollof rice/);
  assert.equal(r.length, 2);
  assert.match(r[1].text, /^Want to upgrade your Jollof rice\?\n\n\*Jollof special\*\n₦3,200/);
});

test('suggestions: owner pairings come first, then the upgrade; sold out and in-cart items are skipped; once per item', async () => {
  const owner = fx.a.ownerPhone.slice(1);
  const bot = new Bot();
  assert.match((await bot.send('admin', { from: owner, text: 'pair Jollof rice with Zobo, Chapman and Plantain' }))[0].text, /suggest Zobo, Chapman, Plantain first/);
  const me = '2348091200002';
  await shop(bot, me, `add:${ids['Plantain']}`);
  const r = await shop(bot, me, `add:${ids['Jollof rice']}`);
  assert.equal(ia(r[1]).type, 'carousel');
  assert.match(r[1].text, /^Goes well with your Jollof rice 👇\n1\. Zobo · ₦500\n2\. ⬆️ Upgrade/, 'Chapman is sold out, Plantain is already in the cart');
  assert.deepEqual(r[1].options, [`buy:${ids['Zobo']}`, `buy:${ids['Jollof special']}`]);
  assert.equal((await shop(bot, me, `add:${ids['Jollof rice']}`)).length, 1, 'adding it again: no repeat suggestions');
  await bot.send('admin', { from: owner, text: 'unpair Jollof rice' });
  assert.deepEqual((await doc('products', ids['Jollof rice'])).pairsWith, []);
});

test('suggestions: what customers bought together, and the AI pick (cached)', async () => {
  await db.set(db.doc('orders', 'o-together'), { id: 'o-together', ref: 'RLY-TOGE1', businessId: fx.a.id, customerId: 'x', channel: 'whatsapp', status: 'paid', fulfilment: 'delivered', items: [{ productId: ids['Fried rice'], name: 'Fried rice', priceKobo: 250_000, qty: 1 }, { productId: ids['Plantain'], name: 'Plantain', priceKobo: 70_000, qty: 1 }], subtotalKobo: 320_000, deliveryFeeKobo: 0, feeKobo: 0, uniqueKobo: 0, payAmountKobo: 320_000, delivery: null, holdExpiresAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const asked: string[] = [];
  const bot = new Bot({ async chooseTool() { return null; }, async pickPairs({ anchor }) { asked.push(anchor.name); return { cross: [ids['Zobo'], 'not-a-real-id'], upsell: null }; } });
  const r = await shop(bot, '2348091200003', `add:${ids['Fried rice']}`);
  assert.match(r[1].text, /^Goes well with your Fried rice 👇\n1\. Plantain · ₦700\n2\. Zobo · ₦500/, 'bought together first, then the AI');
  assert.deepEqual(asked, ['Fried rice']);
  assert.deepEqual((await doc('products', ids['Fried rice'])).aiPairs.ids, [ids['Zobo']], 'unknown ids are dropped');
  await shop(bot, '2348091200004', `add:${ids['Fried rice']}`);
  assert.deepEqual(asked, ['Fried rice'], 'the AI pick is reused');
});

test('suggestions: the owner can turn them off', async () => {
  const bot = new Bot();
  assert.match((await bot.send('admin', { from: fx.a.ownerPhone.slice(1), text: 'suggestions off' }))[0].text, /Suggestions are off/);
  assert.equal((await shop(bot, '2348091200005', `add:${ids['Jollof rice']}`)).length, 1);
  await bot.send('admin', { from: fx.a.ownerPhone.slice(1), text: 'suggestions on' });
});
