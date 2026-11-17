import { Bot, clearFirestore, db, doc, seed } from './helpers';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProduct, stripVariantWords } from '../src/bots/products-flow';
import { ruleGuess } from '../src/bots/category-guess';
import { adjustInventory, createCategories, createProduct, deleteCategory, listCategories, moveProduct, parseCategoryList } from '../src/services/catalog';
import { hasStock } from '../src/domain/commerce';
import type { Category } from '../src/domain/commerce';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });

const OWNER = '2348035551111';
const opts = (m: { options: string[] }[]) => m.flatMap(x => x.options);
const conv = (phone: string) => doc('conversations', `admin_${phone}`);

test('parsing: prices, stock and size words in product lines', () => {
  assert.deepEqual(parseProduct('Black AF1 25k'), { name: 'Black AF1', priceKobo: 2_500_000, stock: null });
  assert.deepEqual(parseProduct('Black AF1 ₦25,000'), { name: 'Black AF1', priceKobo: 2_500_000, stock: null });
  assert.deepEqual(parseProduct('Black AF1 25000 4'), { name: 'Black AF1', priceKobo: 2_500_000, stock: 4 });
  assert.deepEqual(parseProduct('Jollof rice, 2500, 10'), { name: 'Jollof rice', priceKobo: 250_000, stock: 10 });
  assert.deepEqual(parseProduct('add Small chops 1,500'), { name: 'Small chops', priceKobo: 150_000, stock: null });
  assert.equal(stripVariantWords('Black AF1 25k sizes 40-44'), 'Black AF1 25k');
  assert.equal(stripVariantWords('Black AF1 sizes 40-44 25k'), 'Black AF1 25k');
  assert.equal(parseProduct('hello there'), null);
  assert.deepEqual(parseCategoryList('sneakers, slides and bags\nSneakers'), ['Sneakers', 'Slides', 'Bags']);
  assert.deepEqual(parseCategoryList('1. Men\'s wear\n2. iPhone cases'), ["Men's wear", 'iPhone cases']);
});

test('category guess: own name first, related words second, ambiguity asks', () => {
  const cat = (name: string) => ({ id: name, name }) as Category;
  const cats = ['Sneakers', 'Slides', 'Bags'].map(cat);
  assert.equal(ruleGuess('Leather bag', cats)?.name, 'Bags');
  assert.equal(ruleGuess('Gucci slides', cats)?.name, 'Slides');
  assert.equal(ruleGuess('Black AF1', cats), null, 'AF1 could be sneakers or slides: ask');
  assert.equal(ruleGuess('Black AF1', ['Shoes', 'Bags'].map(cat))?.name, 'Shoes');
  assert.equal(ruleGuess('Zobo 50cl', ['Meals', 'Drinks'].map(cat))?.name, 'Drinks');
  assert.equal(ruleGuess('Mystery box', cats), null);
});

test('onboarding: basics → categories → products → connect, by chat', async () => {
  const bot = new Bot();
  assert.match((await bot.send('admin', { from: OWNER, text: 'Hi' }))[0].text, /about 10 minutes[\s\S]*what's your name/);
  assert.match((await bot.send('admin', { from: OWNER, text: 'Ada Obi' }))[0].text, /Nice to meet you, Ada! What's your business called/);
  assert.match((await bot.send('admin', { from: OWNER, text: 'add Jollof rice, 2500, 10' }))[0].text, /looks like a product or a command/);
  const type = await bot.send('admin', { from: OWNER, text: 'Ada Kicks' });
  assert.match(type[0].text, /What kind of business is Ada Kicks/);
  assert.ok(opts(type).includes('btype:fashion_retail') && opts(type).includes('btype:electronics') && opts(type).includes('btype:photography_events'));
  assert.match((await bot.send('admin', { from: OWNER, choice: 'btype:fashion_retail', text: 'Fashion' }))[0].text, /Which city and area/);
  assert.match((await bot.send('admin', { from: OWNER, text: 'Lagos' }))[0].text, /which area in Lagos/i);
  const cats = await bot.send('admin', { from: OWNER, text: 'Yaba' });
  assert.match(cats[0].text, /Clothing · Shoes · Bags · Accessories/);
  assert.deepEqual(opts(cats), ['cat:use', 'cat:own']);

  const owner = await doc('ownerPhones', `+${OWNER}`);
  const biz = await doc('businesses', owner.businessId);
  assert.deepEqual([biz.name, biz.category, biz.ownerName, biz.city, biz.area, biz.status], ['Ada Kicks', 'fashion_retail', 'Ada Obi', 'Lagos', 'Yaba', 'onboarding']);
  assert.equal(owner.onboardingStage, 'categories');

  assert.match((await bot.send('admin', { from: OWNER, choice: 'cat:use', text: 'Use these' }))[0].text, /Created ✅ Clothing · Shoes · Bags · Accessories/);
  assert.match((await bot.send('admin', { from: OWNER, choice: 'cat:edit', text: 'Edit' }))[0].text, /separated by commas/);
  const typed = await bot.send('admin', { from: OWNER, text: 'sneakers, slides and bags' });
  assert.match(typed[0].text, /Created ✅ Sneakers · Slides · Bags/);
  assert.deepEqual((await listCategories(db, biz.id)).map(c => c.name), ['Sneakers', 'Slides', 'Bags'], 'the starter list was replaced');
  assert.match((await bot.send('admin', { from: OWNER, choice: 'cat:ok', text: 'Looks good' }))[0].text, /send a \*photo\*/i);
  assert.equal((await doc('ownerPhones', `+${OWNER}`)).onboardingStage, 'products');

  // 1: clear category, stock counted.
  const bag = await bot.send('admin', { from: OWNER, text: 'Leather bag 15k 4' });
  assert.match(bag[0].text, /\*Leather bag\*\n₦15,000 · Bags\nStock: 4 in stock/);
  assert.ok(opts(bag)[0].startsWith('pok:') && opts(bag)[1].startsWith('pedit:'));
  // 2: ambiguous, so the owner picks; no stock given, so it isn't tracked.
  const ask = await bot.send('admin', { from: OWNER, text: 'Black AF1 25k sizes 40-44' });
  assert.match(ask[0].text, /Which category is \*Black AF1\* in\?/);
  assert.ok(opts(ask).includes('pcat:new'));
  const sneakers = (await listCategories(db, biz.id)).find(c => c.name === 'Sneakers')!;
  assert.match((await bot.send('admin', { from: OWNER, choice: `pcat:${sneakers.id}`, text: 'Sneakers' }))[0].text, /\*Black AF1\*\n₦25,000 · Sneakers\nStock: not tracked/);
  // 3: a brand-new category, then the preview of what customers see.
  await bot.send('admin', { from: OWNER, text: 'Silver watch 40k' });
  assert.match((await bot.send('admin', { from: OWNER, choice: 'pcat:new', text: 'New category' }))[0].text, /new category be called/);
  const third = await bot.send('admin', { from: OWNER, text: 'watches' });
  assert.match(third[0].text, /\*Silver watch\*\n₦40,000 · Watches/);
  assert.match(third[1].text, /what your customers will see/);
  assert.match(third[2].text, /Sneakers at Ada Kicks[\s\S]*Black AF1/);
  assert.deepEqual(opts([third[3]]), ['prod:more', 'prod:done']);

  // Edit: a corrected price replaces the old one.
  const af1 = (await db.query('products', [['businessId', '==', biz.id]])).find(p => p.name === 'Black AF1')!;
  assert.equal(af1.stock, null);
  assert.match((await bot.send('admin', { from: OWNER, choice: `pedit:${af1._id}`, text: 'Edit' }))[0].text, /Editing \*Black AF1\*/);
  assert.match((await bot.send('admin', { from: OWNER, text: 'Black AF1 27k' }))[0].text, /₦27,000 · Sneakers/);
  assert.equal((await listCategories(db, biz.id)).find(c => c.name === 'Sneakers')!.productCount, 1);

  const end = await bot.send('admin', { from: OWNER, choice: 'prod:done', text: "I'm done" });
  assert.match(end[0].text, /Your shop is set up[\s\S]*\/connect\/[A-Za-z0-9]+/);
  assert.equal((await doc('ownerPhones', `+${OWNER}`)).onboardingStage, 'connect');
  assert.equal((await conv(OWNER)).onboarding, null);
  assert.match((await bot.send('admin', { from: OWNER, text: 'products' }))[0].text, /\*Sneakers\*\n• Black AF1: ₦27,000, no stock count[\s\S]*\*Bags\*\n• Leather bag: ₦15,000, 4 in stock[\s\S]*\*Watches\*\n• Silver watch/);
});

test('onboarding: coming back after a break offers Continue or Start over', async () => {
  const bot = new Bot();
  const from = '2348035552222';
  for (const text of ['hi', 'Bola', 'Bola Bakes']) await bot.send('admin', { from, text });
  await bot.send('admin', { from, choice: 'btype:food_beverage', text: 'Food' });
  await bot.send('admin', { from, text: 'Ibadan, Bodija' });
  const businessId = (await doc('ownerPhones', `+${from}`)).businessId;
  const c = await conv(from);
  await db.set(db.doc('conversations', `admin_${from}`), { onboarding: { ...c.onboarding, lastSeenAt: new Date(Date.now() - 2 * 3600_000).toISOString() } }, { merge: true });

  const back = await bot.send('admin', { from, text: 'hello' });
  assert.match(back[0].text, /Welcome back, Bola\. You were on \*your categories\*\. Continue\?/);
  assert.deepEqual(opts(back), ['ob:continue', 'ob:restart']);
  assert.match((await bot.send('admin', { from, choice: 'ob:continue', text: 'Yes' }))[0].text, /Many Food shops start with/);

  await db.set(db.doc('conversations', `admin_${from}`), { onboarding: { ...(await conv(from)).onboarding, lastSeenAt: new Date(Date.now() - 2 * 3600_000).toISOString() } }, { merge: true });
  await bot.send('admin', { from, text: 'hello' });
  assert.match((await bot.send('admin', { from, choice: 'ob:restart', text: 'Start over' }))[0].text, /what's your name/);
  assert.equal(await doc('ownerPhones', `+${from}`), null, 'the half-made shop is gone');
  assert.equal(await doc('businesses', businessId), null);
});

test('admin: an owner who is already set up gets a greeting, not "didn\'t understand"', async () => {
  const bot = new Bot();
  const o = fx.b.ownerPhone.slice(1);
  const hi = await bot.send('admin', { from: o, text: 'Hi' });
  assert.match(hi[0].text, /^Hi 👋 What would you like to do for Business biz-b\?/);
  assert.deepEqual(opts(hi), ['g:products', 'g:orders', 'g:help']);
  assert.match((await bot.send('admin', { from: o, choice: 'g:products', text: 'Products' }))[0].text, /Your products/);
  assert.match((await bot.send('admin', { from: o, text: 'good morning!' }))[0].text, /What would you like to do/);
});

test('categories: owner commands, counts, and the delete-with-products guard', async () => {
  const bot = new Bot();
  const o = fx.a.ownerPhone.slice(1);
  assert.match((await bot.send('admin', { from: o, text: 'add category Sneakers, Bags' }))[0].text, /Created ✅ Sneakers · Bags/);
  assert.match((await bot.send('admin', { from: o, text: 'rename category Bags to Handbags' }))[0].text, /Renamed Bags to Handbags/);
  assert.match((await bot.send('admin', { from: o, text: 'move Handbags to the top' }))[0].text, /New order: Handbags · General · Sneakers/);
  assert.match((await bot.send('admin', { from: o, text: 'add White sneakers 30k' }))[0].text, /₦30,000 · Sneakers/);
  assert.match((await bot.send('admin', { from: o, text: 'move White sneakers to Handbags' }))[0].text, /Moved White sneakers to Handbags/);
  const list = await bot.send('admin', { from: o, text: 'categories' });
  assert.match(list[0].text, /1\. Handbags \(1 product\)[\s\S]*3\. Sneakers \(0 products\)/);

  const del = await bot.send('admin', { from: o, text: 'delete category Handbags' });
  assert.match(del[0].text, /Handbags has 1 product\. Move them to/);
  const sneakers = (await listCategories(db, fx.a.id)).find(c => c.name === 'Sneakers')!;
  const handbags = (await listCategories(db, fx.a.id)).find(c => c.name === 'Handbags')!;
  assert.ok(opts(del).includes(`movecat:${handbags.id}:${sneakers.id}`));
  assert.match((await bot.send('admin', { from: o, choice: `movecat:${handbags.id}:${sneakers.id}`, text: 'Sneakers' }))[0].text, /Moved 1 product to Sneakers and deleted Handbags/);
  assert.equal((await listCategories(db, fx.a.id)).find(c => c.name === 'Sneakers')!.productCount, 1);

  const empty = await bot.send('admin', { from: o, text: 'delete category General' });
  assert.match(empty[0].text, /Delete the category General\?/);
  assert.match((await bot.send('admin', { from: o, choice: 'yes', text: 'Yes' }))[0].text, /Deleted the category General/);
});

test('catalog: category integrity and products without a stock count', async () => {
  const [c1, c2] = await createCategories(db, fx.b.id, ['Shoes', 'Bags']);
  await assert.rejects(createProduct(db, { businessId: fx.b.id, name: 'X', priceKobo: 100, categoryId: `cat-${fx.a.id}` }), /CATEGORY_NOT_FOUND/, 'another business\'s category');
  const p = await createProduct(db, { businessId: fx.b.id, name: 'Tote', priceKobo: 100_00, categoryId: c2.id });
  assert.equal(p.stock, null);
  assert.ok(hasStock(p, 1_000), 'no stock count: never sold out');
  assert.equal((await doc('categories', c2.id)).productCount, 1);
  await assert.rejects(deleteCategory(db, fx.b.id, c2.id), /CATEGORY_NOT_EMPTY/);
  await moveProduct(db, fx.b.id, p.id, c1.id);
  assert.deepEqual([(await doc('categories', c1.id)).productCount, (await doc('categories', c2.id)).productCount], [1, 0]);
  await assert.rejects(adjustInventory(db, p.id, fx.b.id, -1, 'adjustment', 'owner'), /STOCK_NOT_TRACKED/);
  assert.equal(await adjustInventory(db, p.id, fx.b.id, 5, 'restock', 'owner'), 5, 'restocking starts counting');
  assert.equal((await doc('products', p.id)).stock, 5);
});
