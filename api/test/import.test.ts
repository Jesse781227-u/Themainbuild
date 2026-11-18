import { Bot, clearFirestore, db, doc, env, fakeLLM, seed } from './helpers';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanItems, handleImport, parsePastedMenu } from '../src/bots/catalog-import';
import { DEV_MEDIA_PREFIX, devMediaKey, type Input } from '../src/bots/common';
import { getConfig } from '../src/config';
import { listCategories, listProducts } from '../src/services/catalog';
import type { FlowCtx } from '../src/bots/products-flow';
import type { CatalogItem } from '../src/services/ai';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });
const opts = (m: { options: string[] }[]) => m.flatMap(x => x.options);

const MENU = `RICE DISHES
Jollof rice - 2,500
Fried rice 2.5k
DRINKS:
Zobo (50cl) ₦500
Chapman 1500 12
Call 08012345678 to order`;

test('import: a pasted menu is read by rules, headings become categories', () => {
  const items = parsePastedMenu(MENU)!;
  assert.deepEqual(items.map(i => [i.category, i.name, i.priceKobo, i.stock]), [
    ['Rice Dishes', 'Jollof rice', 250_000, null],
    ['Rice Dishes', 'Fried rice', 250_000, null],
    ['Drinks', 'Zobo (50cl)', 50_000, null],
    ['Drinks', 'Chapman', 150_000, 12],
  ]);
  assert.equal(parsePastedMenu('Jollof rice 2500'), null, 'one line is just one product');
  assert.equal(parsePastedMenu('Sneakers\nBags'), null, 'a list without prices is not a menu');
});

test('import: CSV files keep quoted prices together and drop the header row', () => {
  const items = parsePastedMenu('name,price,stock\nGRILLS\nSuya,3000\nAsun,"4,500",10\nDRINKS\nZobo;500;30', { csv: true })!;
  assert.deepEqual(items.map(i => [i.category, i.name, i.priceKobo, i.stock]), [
    ['Grills', 'Suya', 300_000, null], ['Grills', 'Asun', 450_000, 10], ['Drinks', 'Zobo', 50_000, 30],
  ]);
});

test('import: AI output is validated (prices, duplicates, missing prices)', () => {
  const raw: CatalogItem[] = [
    { name: 'Suya', price: 3000, category: 'grills' }, { name: 'suya', price: 3000, category: 'Grills' },
    { name: 'Asun', price: null, category: 'Grills' }, { name: 'Pepper soup', price: -5, category: null }, { name: 'Malt', price: 700, category: '' },
  ];
  const { items, skippedNoPrice } = cleanItems(raw, 'Meals');
  assert.deepEqual(items.map(i => [i.name, i.priceKobo, i.category]), [['Suya', 300_000, 'Grills'], ['Malt', 70_000, 'Meals']]);
  assert.deepEqual(skippedNoPrice, ['Asun', 'Pepper soup']);
});

test('import: an owner pastes a menu, sees the summary, taps Add all', async () => {
  const bot = new Bot();
  const o = fx.a.ownerPhone.slice(1);
  const preview = await bot.send('admin', { from: o, text: MENU });
  assert.match(preview[0].text, /I found \*4 products\* in 2 categories\.\n\n\*Rice Dishes\* \(2\)\n• Jollof rice: ₦2,500[\s\S]*\*Drinks\* \(2\)[\s\S]*Chapman: ₦1,500 \(12 in stock\)/);
  assert.deepEqual(opts(preview), ['imp:all', 'imp:cancel']);
  assert.equal((await listProducts(db, fx.a.id)).length, 1, 'nothing saved before Add all');

  assert.match((await bot.send('admin', { from: o, choice: 'imp:all', text: 'Add all 4' }))[0].text, /Done ✅ Added 4 products in 2 categories/);
  const products = await listProducts(db, fx.a.id);
  assert.equal(products.length, 5);
  const cats = await listCategories(db, fx.a.id);
  const drinks = cats.find(c => c.name === 'Drinks')!;
  assert.equal(drinks.productCount, 2);
  assert.equal(products.find(p => p.name === 'Chapman')!.categoryId, drinks.id);
  assert.match((await bot.send('admin', { from: o, choice: 'imp:all', text: 'Add all 4' }))[0].text, /already added or cancelled/, 'tapping twice adds nothing');

  // Sending the menu again with new prices updates instead of duplicating; Cancel saves nothing.
  const again = await bot.send('admin', { from: o, text: 'Jollof rice 3000\nFried rice 3000' });
  assert.match(again[0].text, /All already in your shop: they get the new price\.[\s\S]*Jollof rice: ₦3,000\n/, 'notes first; no (update) on every line when all are updates');
  const mixed = await bot.send('admin', { from: o, text: 'Jollof rice 3000\nPuff puff 200' });
  assert.match(mixed[0].text, /1 already in your shop: it gets the new price[\s\S]*Jollof rice: ₦3,000 \(update\)[\s\S]*Puff puff: ₦200\n/);
  assert.match((await bot.send('admin', { from: o, choice: 'imp:cancel', text: 'Cancel' }))[0].text, /Nothing was added/);
  assert.equal(products.find(p => p.name === 'Jollof rice')!.priceKobo, 250_000);
});

test('import: a PDF menu is read by the AI and set up during signup', async () => {
  // A fake R2 bucket holding the uploaded PDF, and a fake model that reads it.
  const files = new Map<string, { bytes: ArrayBuffer; type: string }>();
  const bucket = {
    async get(key: string) { const f = files.get(key); return f ? { body: new Response(f.bytes).body!, httpEtag: 'x', httpMetadata: { contentType: f.type } } : null; },
    async put(key: string, value: ArrayBuffer) { files.set(key, { bytes: value, type: 'application/pdf' }); },
  };
  const mediaId = `${DEV_MEDIA_PREFIX}abc123`;
  await bucket.put(devMediaKey(mediaId), new TextEncoder().encode('%PDF-1.4 menu').buffer as ArrayBuffer);
  const seen: { mimeType?: string; categories?: string[] }[] = [];
  const llm = { ...fakeLLM(() => null), async readCatalog(i: { file?: { mimeType: string }; categories?: string[] }) { seen.push({ mimeType: i.file?.mimeType, categories: i.categories }); return [{ name: 'Ofada rice', price: 4000, category: 'Rice' }, { name: 'Ofada sauce', price: 1500, category: 'Sauces' }, { name: 'Market price fish', price: null, category: 'Sauces' }] as CatalogItem[]; } };

  const business = (await doc('businesses', fx.b.id)) as never;
  const state = {};
  const f: FlowCtx = { db, cfg: getConfig(env), deps: { transport: null as never, llm, transcriber: null, fetch, images: bucket, enqueue: async () => {} }, business, convRef: db.doc('conversations', 'admin_import_test'), state };
  const input: Input = { text: '', choiceId: null, imageId: null, audioId: null, document: { id: mediaId, mimeType: 'application/pdf', filename: 'menu.pdf' } };
  const notes: unknown[] = [];
  const read = await handleImport(f, input, '', 'token', async o => { notes.push(o); });
  assert.match(String(notes[0]), /Reading menu\.pdf/);
  assert.equal(seen[0].mimeType, 'application/pdf');
  assert.deepEqual(seen[0].categories, ['General'], 'the model is told the existing categories');
  const text = JSON.stringify(read!.out[0]);
  assert.match(text, /I found \*2 products\* in 2 categories/);
  assert.match(text, /No price found for: Market price fish/);

  const added = await handleImport(f, { ...input, document: null, choiceId: 'imp:all' }, '', 'token', async () => {});
  assert.equal(added!.created, 2);
  assert.deepEqual((await listCategories(db, fx.b.id)).map(c => c.name), ['General', 'Rice', 'Sauces']);

  // Without the AI, files can't be read: the owner is told to paste the list instead.
  const noAi = await handleImport({ ...f, deps: { ...f.deps, llm: null } }, input, '', 'token', async () => {});
  assert.match(String(noAi!.out[0]), /Paste your list as a message instead/);
  // A product photo with a name and price is one product, not a menu.
  assert.equal(await handleImport(f, { ...input, document: null, imageId: 'img1' }, 'Black AF1 25k', 'token', async () => {}), null);
});

test('import: pasting a menu at the categories step of signup sets everything up', async () => {
  const bot = new Bot();
  const from = '2348035553333';
  for (const text of ['hi', 'Kemi', 'Kemi Kitchen']) await bot.send('admin', { from, text });
  await bot.send('admin', { from, choice: 'btype:food_beverage', text: 'Food' });
  const cat = await bot.send('admin', { from, text: 'Lagos, Ikeja' });
  assert.match(cat[0].text, /Have a menu or price list\? Send it now/);
  assert.match((await bot.send('admin', { from, text: MENU }))[0].text, /I found \*4 products\*/);
  const done = await bot.send('admin', { from, choice: 'imp:all', text: 'Add all 4' });
  assert.match(done[0].text, /Added 4 products in 2 categories/);
  assert.match(done[1].text, /Your menu is in 🎉/);
  assert.deepEqual(opts([done[1]]), ['prod:more', 'prod:done']);
  const owner = await doc('ownerPhones', `+${from}`);
  assert.equal(owner.onboardingStage, 'products');
  assert.match((await bot.send('admin', { from, choice: 'prod:done', text: "I'm done" }))[0].text, /Your shop is set up/);
});
