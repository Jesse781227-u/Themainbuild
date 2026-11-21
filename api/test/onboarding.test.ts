import { Bot, clearFirestore, db, doc, seed, signUp } from './helpers';
import { normalise, profileName } from '../src/bots/onboarding';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProduct } from '../src/bots/products-flow';
import { ruleGuess } from '../src/bots/category-guess';
import { adjustInventory, createCategories, createProduct, deleteCategory, listCategories, moveProduct, parseCategoryList } from '../src/services/catalog';
import { hasStock } from '../src/domain/commerce';
import type { Category } from '../src/domain/commerce';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });

const OWNER = '2348035551111';
const opts = (m: { options: string[] }[]) => m.flatMap(x => x.options);
const body = (m: { text: string; content?: unknown }) => ((m.content as { interactive?: { body?: { text: string } } })?.interactive?.body?.text ?? m.text);
const conv = (phone: string) => doc('conversations', `admin_${phone}`);

test('parsing: prices, stock and size words in product lines', () => {
  assert.deepEqual(parseProduct('Black AF1 25k'), { name: 'Black AF1', priceKobo: 2_500_000, stock: null, options: null });
  assert.deepEqual(parseProduct('Black AF1 ₦25,000'), { name: 'Black AF1', priceKobo: 2_500_000, stock: null, options: null });
  assert.deepEqual(parseProduct('Black AF1 25000 4'), { name: 'Black AF1', priceKobo: 2_500_000, stock: 4, options: null });
  assert.deepEqual(parseProduct('Jollof rice, 2500, 10'), { name: 'Jollof rice', priceKobo: 250_000, stock: 10, options: null });
  assert.deepEqual(parseProduct('add Small chops 1,500'), { name: 'Small chops', priceKobo: 150_000, stock: null, options: null });
  // Sizes and colours become the product's options, wherever they are in the line.
  const sizes = [{ name: 'Size', values: ['40', '41', '42', '43', '44'] }];
  assert.deepEqual(parseProduct('Black AF1 25k sizes 40-44'), { name: 'Black AF1', priceKobo: 2_500_000, stock: null, options: sizes });
  assert.deepEqual(parseProduct('Black AF1 sizes 40-44 25k'), { name: 'Black AF1', priceKobo: 2_500_000, stock: null, options: sizes });
  assert.deepEqual(parseProduct('Hoodie 7500 sizes S M L colors red and light blue')!.options, [{ name: 'Size', values: ['S', 'M', 'L'] }, { name: 'Colour', values: ['Red', 'Light Blue'] }]);
  assert.deepEqual(parseProduct('Ankara gown 25000 colour: green/gold 10'), { name: 'Ankara gown', priceKobo: 2_500_000, stock: 10, options: [{ name: 'Colour', values: ['Green', 'Gold'] }] });
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

const MENU = `MEALS
Jollof rice & chicken 3500
Fried rice & turkey 4000
SNACKS
Puff puff 500
Meat pie 800
DRINKS
Zobo 700
Chapman 1500`;

test('onboarding v3: hey → name → menu → Looks good → address + hours → delivery list → fee → Connect, in 7 owner messages', async () => {
  const bot = new Bot();
  const say = (text: string, choice?: string) => bot.send('admin', { from: OWNER, text, choice, name: 'Ada Obi 🌸' });
  const all: { text: string }[] = [];
  let count = 0;
  const owner = async (text: string, choice?: string) => { count++; const r = await say(text, choice); all.push(...r); return r; };

  const hi = await owner('hey');
  assert.match(hi[0].text, /^Hi Ada 👋 I'll set up your WhatsApp shop so customers can order and pay without you answering every chat\. Takes about 3 minutes\.\n\nWhat's your shop called\?\n\nBy continuing you agree to our terms: https?:\/\/\S+\/terms$/);
  assert.doesNotMatch(hi[0].text, /CALL/, 'no "Reply CALL" in the welcome (HELP has it)');
  // (not counted: what an owner might also send)
  assert.match((await say('add Jollof rice, 2500, 10'))[0].text, /looks like a product/);
  assert.equal((await say('?'))[0].text, "Sorry, what's your shop called?");

  const menu = await owner("Mama Ada's Kitchen");
  assert.equal(menu[0].text, 'Love it. Send me your menu: a PDF, a photo, or just type it out.');
  const bizId = (await doc('ownerPhones', `+${OWNER}`)).activeBusinessId;
  let biz = await doc('businesses', bizId);
  assert.deepEqual([biz.name, biz.ownerName, biz.status, biz.feePayer], ["Mama Ada's Kitchen", 'Ada Obi', 'onboarding', 'customer'], 'owner name from the WhatsApp profile, not asked');

  const summary = await owner(MENU);
  assert.equal(body(summary[0]), 'Got it! 6 items in 3 sections: Meals, Snacks and Drinks.');
  assert.deepEqual(summary[0].options, ['imp:all', 'imp:list']);
  // [See full list] (optional): everything by section, then the choice again.
  const full = await say('See full list', 'imp:list');
  assert.match(full[0].text, /^\*Meals\* \(2\)\n• Jollof rice & chicken: ₦3,500\n• Fried rice & turkey: ₦4,000/);
  assert.deepEqual(full.at(-1)!.options, ['imp:all', 'imp:fix']);

  // Words for the button ("yeah, add them" = Looks good): saved, and straight on.
  const place = await owner('yeah, add them');
  assert.equal(place.length, 1);
  assert.equal(place[0].text, "Where's the shop, and when are you open?\ne.g. 16 Atunrase Estate, Gbagada · Mon–Fri 8–7, Sat 10–7");
  assert.equal((await db.query('products', [['businessId', '==', bizId]])).length, 6);
  biz = await doc('businesses', bizId);
  assert.equal(biz.category, 'food_beverage', 'the type from the menu, never asked');

  const delivery = await owner('16 Atunrase Estate, Gbagada · Mon–Fri 8–7, Sat 10–7');
  assert.equal(delivery.length, 1, 'both saved with ✅ lines, no Yes/Change');
  assert.equal(body(delivery[0]), "✅ 16 Atunrase Estate, Gbagada, Lagos\n✅ Mon–Fri 8am–7pm · Sat 10am–7pm · Sun closed\n\nDo you deliver? Send your area price list, or type one price if it's the same everywhere.");
  assert.deepEqual(delivery[0].options, ['dl:pickup']);

  const fee = await owner('Gbagada 1000\nYaba 3000\nIkeja 3000\nEbutte Metta 3000\nLekki Phase 1 4000');
  assert.equal(fee.length, 1, 'saved straight away: no Save/Cancel, no full list');
  assert.equal(body(fee[0]), 'Saved 5 areas, ₦1,000–₦4,000. I fixed 1 spelling (like Ebutte Metta → Ebute Metta). Send *DELIVERY* anytime to check or edit them.\n\nLast thing: Relay costs nothing upfront. We take 4.5% of each sale (max ₦4,000), only when you get paid. Who pays it?');
  assert.deepEqual(fee[0].options, ['fee:customer', 'fee:owner']);

  const ready = await owner("I'll pay", 'fee:owner');
  assert.equal(ready.length, 1, 'no separate fee confirmation');
  const cta = (ready[0].content as any).interactive;
  assert.equal(cta.type, 'cta_url');
  assert.equal(cta.body.text, "Done 🎉 Mama Ada's Kitchen is ready. Connect your WhatsApp number to go live. Meta will ask you to log into Facebook.\n\nWant to try it as a customer first? Reply *TEST*.");
  assert.equal(cta.action.parameters.display_text, 'Connect my number');
  assert.match(cta.action.parameters.url, /\/connect\/[A-Za-z0-9]+$/);

  assert.ok(count <= 7, `${count} owner messages from "hey" to the Connect button`);
  assert.ok(all.every(m => !/Step \d+ of/.test(m.text)), 'no step counter anywhere');
  assert.ok(all.every(m => m.text.split('\n').length <= 8), 'no long messages');

  // What isn't asked any more: defaults, each with its command.
  biz = await doc('businesses', bizId);
  assert.deepEqual([biz.city, biz.area, biz.address, biz.fulfilment, biz.shipsInterstate, biz.afterHours, biz.prepTime, biz.feePayer], ['Lagos', 'Gbagada', '16 Atunrase Estate', 'both', false, 'orders', '15–30 min', 'owner']);
  assert.deepEqual([biz.hours.mon, biz.hours.sat, biz.hours.sun], [{ open: '08:00', close: '19:00' }, { open: '10:00', close: '19:00' }, null]);
  assert.match(biz.policies.returns, /No returns on food/);
  const zones = await db.query('deliveryZones', [['businessId', '==', bizId]]);
  assert.deepEqual(zones.map(z => z.name).sort(), ['Ebute Metta', 'Gbagada', 'Ikeja', 'Lekki Phase 1', 'Yaba']);

  // TEST, then EXIT: back to the Connect button.
  await say('TEST');
  const back = await say('EXIT');
  assert.equal((back.at(-1)!.content as any).interactive?.type, 'cta_url');
  assert.match((await say('products'))[0].text, /\*Meals\*[\s\S]*Jollof rice & chicken/, 'commands work at "ready"');

  const events = await db.query('onboardingEvents', [['ownerPhone', '==', `+${OWNER}`]]);
  const seen = new Set(events.map(e => `${e.step}:${e.event}`));
  for (const s of ['basics:entered', 'shop_name:completed', 'products:entered', 'products:completed', 'location:entered', 'delivery:entered', 'connect:entered', 'connect_link:entered']) assert.ok(seen.has(s), `analytics: ${s}`);
});

test('onboarding v3: only one of address and hours → the other is asked; pickup only; one price for everywhere; a doubtful time is checked', async () => {
  const bot = new Bot();
  const from = '2348035551112';
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Bola' });
  await say('hi'); await say('Bola Bags'); await say('Leather tote 18000'); await say("That's all", 'prod:done');
  const hours = await say('12 Admiralty Way, Lekki');
  assert.equal(hours[0].text, '✅ 12 Admiralty Way, Lekki, Lagos\n\nAnd what time do you open and close?');
  const delivery = await say('9am to 6pm');
  assert.match(delivery[0].text, /^✅ Every day 9am–6pm\n\nDo you deliver\?/);
  const fee = await say('2000 everywhere');
  assert.match(fee[0].text, /^✅ Delivery is ₦2,000 everywhere\.\n\nLast thing:/);

  const other = '2348035551113';
  const say2 = (text: string, choice?: string) => bot.send('admin', { from: other, text, choice, name: 'Kemi' });
  await say2('hi'); await say2('Kemi Cakes'); await say2('Red velvet 15000'); await say2("That's all", 'prod:done');
  const address = await say2('Mon–Sat 10am to 6pm');
  assert.equal(address[0].text, "✅ Mon–Sat 10am–6pm · Sun closed\n\nAnd where's the shop? e.g. *16 Atunrase Estate, Gbagada*");
  const doubt = await say2('Yaba · 8am to 7am');
  assert.match(doubt[0].text, /8am to 7pm, or open overnight until 7am\?/, 'a doubtful time is checked, not saved');
  const pick = await say2('8am–7pm', doubt[0].options[0]);
  assert.match(pick.map(m => m.text).join('\n'), /Do you deliver\?/);
  const paid = await say2('Pickup only', 'dl:pickup');
  assert.match(paid[0].text, /^✅ Pickup only\.\n\nLast thing:/);
});

test('onboarding v2: a menu as the very first message is read straight away; the name is asked meanwhile', async () => {
  const bot = new Bot();
  const from = '2348035554444';
  const first = await bot.send('admin', { from, text: 'Suya 3000\nAsun 4500\nChapman 1500', name: '' });
  assert.match(body(first[0]), /^Got it! 3 items\./);
  assert.deepEqual(first[0].options, ['imp:all', 'imp:list']);
  assert.match(first[1].text, /^Hi 👋 I'll set up your WhatsApp shop[\s\S]*While you check that list: what's your shop called\?\n\nBy continuing you agree to our terms/);
  const added = await bot.send('admin', { from, choice: 'imp:all', text: 'Looks good', name: '' });
  assert.equal(added.length, 1);
  assert.equal(added[0].text, "Saved ✅ Now, what's your shop called?");
  assert.equal((await bot.send('admin', { from, text: 'Suya Spot', name: '' }))[0].text, 'And what should I call you?', 'no WhatsApp profile name: asked once');
  const place = await bot.send('admin', { from, text: 'My name is Musa', name: '' });
  assert.equal(place[0].text, "Nice to meet you, Musa! Where's the shop, and when are you open?\ne.g. 16 Atunrase Estate, Gbagada · Mon–Fri 8–7, Sat 10–7", 'the menu is in: straight to the address');
  const biz = await doc('businesses', (await doc('ownerPhones', `+${from}`)).activeBusinessId);
  assert.deepEqual([biz.name, biz.ownerName], ['Suya Spot', 'Musa']);
  assert.ok(biz.termsAcceptedAt, 'terms accepted when they replied');
});

test('onboarding v3: typed products work without a menu; the type and photos are never asked', async () => {
  const bot = new Bot();
  const from = '2348035556666';
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Bisi' });
  await say('hello');
  await say('Bisi Gifts');
  const card = await say('Mystery box 5000');
  assert.match(card[0].text, /\*Mystery box\*\n₦5,000 · Products/);
  assert.deepEqual(card[1].options, ['prod:done']);
  await say('Gift hamper 12k');
  const place = await say("That's all", 'prod:done');
  assert.equal(place.length, 1);
  assert.match(place[0].text, /^Where's the shop, and when are you open\?/);
  const biz = await doc('businesses', (await doc('ownerPhones', `+${from}`)).activeBusinessId);
  assert.equal(biz.category, 'other', 'unclear: left as "other", not asked');
});

test('onboarding v2: coming back after a break offers Continue or Start over; start over clears drafts', async () => {
  const bot = new Bot();
  const from = '2348035552222';
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Bola' });
  await say('hi');
  await say('Bola Bakes');
  await say('Cupcakes 500\nBirthday cake 15000');
  await say('Looks good', 'imp:all');
  const businessId = (await doc('ownerPhones', `+${from}`)).activeBusinessId;
  const stale = async () => db.set(db.doc('conversations', `admin_${from}`), { onboarding: { ...(await conv(from)).onboarding, lastSeenAt: new Date(Date.now() - 2 * 3600_000).toISOString() } }, { merge: true });

  await stale();
  const back = await say('hello');
  assert.match(back[0].text, /Welcome back, Bola\. You were on \*your address and hours\*\. Continue\?/);
  assert.deepEqual(back[0].options, ['ob:continue', 'ob:restart']);
  assert.match((await say('Yes', 'ob:continue'))[0].text, /^Where's the shop, and when are you open\?/);
  await say('Yaba, Lagos · 9am to 6pm');
  await stale();
  assert.match((await say('hi'))[0].text, /You were on \*delivery\*/);

  const restart = await say('Start over', 'ob:restart');
  assert.match(restart[0].text, /starting again[\s\S]*What's your shop called/);
  assert.equal(await doc('ownerPhones', `+${from}`), null, 'the half-made shop is gone');
  assert.equal(await doc('businesses', businessId), null);
  assert.equal((await db.query('products', [['businessId', '==', businessId]])).length, 0);
  assert.match((await say('Bola Bakes 2'))[0].text, /^Love it\. Send me your menu/);
});

test('onboarding v2: old conversations map onto the new steps', () => {
  assert.deepEqual(normalise({ step: 'owner_name' }), { stage: 'basics', step: 'shop_name', lastSeenAt: undefined });
  assert.equal(normalise({ stage: 'categories', step: 'categories' })!.step, 'products');
  assert.equal(normalise({ stage: 'branding', step: 'messages' })!.stage, 'products');
  assert.equal(normalise({ stage: 'connect', step: 'connect' })!.step, 'ready');
  assert.equal(normalise({ stage: 'hours', step: 'prep' })!.step, 'prep');
  assert.equal(profileName('🔥🔥'), null);
  assert.equal(profileName('Chioma 💕 Okafor'), 'Chioma Okafor');
});

test('shops: a second shop on the same number, SWITCH between them, data kept apart', async () => {
  const bot = new Bot();
  const from = '2348035557777';
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Kunle' });
  const { businessId: first } = await signUp(bot, from, { shop: 'Kunle Kicks', product: 'White sneakers 30k', name: 'Kunle', until: 'linked' });
  assert.match((await say('new shop'))[0].text, /Add another shop or branch\?/);
  assert.equal((await say('Yes, add one', 'newshop:yes'))[0].text, "What's the new shop or branch called?");
  assert.match((await say('Kunle Kicks Ikeja'))[0].text, /Send me your menu/);
  const owner = await doc('ownerPhones', `+${from}`);
  const second = owner.activeBusinessId;
  assert.notEqual(second, first);
  assert.deepEqual(owner.businessIds, [first, second]);
  await say('Black slides 8000');
  assert.deepEqual((await db.query('products', [['businessId', '==', second]])).map(p => p.name), ['Black slides']);
  assert.deepEqual((await db.query('products', [['businessId', '==', first]])).map(p => p.name), ['White sneakers'], 'the first shop is untouched');

  // Finish the second shop's signup, then switch.
  await signUpRest(bot, from);
  const sw = await say('switch');
  assert.match(sw[0].text, /You're managing \*Kunle Kicks Ikeja\*/);
  assert.deepEqual(sw[0].options, [`shop:${first}`, `shop:${second}`]);
  assert.match((await say('Kunle Kicks', `shop:${first}`))[0].text, /Now managing \*Kunle Kicks\*/);
  assert.match((await say('products'))[0].text, /White sneakers/);
  assert.doesNotMatch((await say('products'))[0].text, /Black slides/);
  assert.match((await say('x', 'shop:not-mine'))[0].text, /isn't on this number/);
});

// The rest of signup from the product step (for a shop whose name and first product are in).
async function signUpRest(bot: Bot, from: string) {
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Kunle' });
  await say("That's all", 'prod:done');
  await say('Ikeja, Lagos · Mon-Sat 9am-7pm, Sun closed');
  await say('Pickup only', 'dl:pickup');
  await say('Customers pay', 'fee:customer');
}

test('admin: an owner who is already set up gets a greeting, not "didn\'t understand"', async () => {
  const bot = new Bot();
  const o = fx.b.ownerPhone.slice(1);
  const hi = await bot.send('admin', { from: o, text: 'Hi' });
  assert.match(hi[0].text, /^Hi 👋 \*Business biz-b\* today: /);
  assert.deepEqual(opts(hi).slice(0, 2), ['act:orders', 'act:money'], 'hi opens the MENU');
  assert.match((await bot.send('admin', { from: o, choice: 'g:products', text: 'Products' }))[0].text, /Your products/);
  assert.match((await bot.send('admin', { from: o, text: 'good morning!' }))[0].text, /^Hi 👋 \*Business biz-b\* today: /);
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

const THRIFT = `CLOTHING
Pink Tie-Front Crop Top 4500
Plaid Flannel Shirt 6500
Denim Jacket 12000
SHOES
Black Ankle Boots 15000
White Sneakers 18000
BAGS
Leather Tote Bag 9000`;

test('file check: a kitchen that sends a clothing list is asked once; the examples follow the shop', async () => {
  const bot = new Bot();
  const from = '2348035558888';
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Teniola' });
  await say('hi');
  const step2 = await say("Mama Tee's Kitchen");
  assert.equal(step2[0].text, 'Love it. Send me your menu: a PDF, a photo, or just type it out.');
  const check = await say(THRIFT);
  assert.equal(check.length, 1);
  assert.match(check[0].text, /^Quick check 👀 Your shop is called \*Mama Tee's Kitchen\*, but this file looks like \*clothing, shoes and bags\*\. Did you send the right file\?/);
  assert.deepEqual(check[0].options, ['imp:mine', 'imp:other', 'imp:rename']);
  // Change the name: the products are kept and the summary follows.
  assert.match((await say('Change shop name', 'imp:rename'))[0].text, /What's your shop called\? I'll keep the products/);
  const renamed = await say("Tee's Thrift");
  assert.match(renamed[0].text, /Done ✅ Your shop is now \*Tee's Thrift\*/);
  assert.match(body(renamed[1]), /^Got it! 6 items/);
  const bizId = (await doc('ownerPhones', `+${from}`)).activeBusinessId;
  assert.equal((await doc('businesses', bizId)).name, "Tee's Thrift");
  // [Change something]: saved, then how to fix it, with an example from their own list.
  const fix = await say('Change something', 'imp:fix');
  assert.equal((await doc('businesses', bizId)).category, 'fashion_retail');
  assert.doesNotMatch(fix[0].text, /Jollof/);
  assert.match(fix[0].text, /e\.g\. \*[A-Z][^*]+ \d+\*/, 'an example from their own list');
  assert.deepEqual(fix[0].options, ['ok:yes']);
});

test('file check: "Yes, it\'s my stock" sets the type; "Send another file" drops the list; vague names never warn', async () => {
  const bot = new Bot();
  const from = '2348035559999';
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Tee' });
  await say('hi');
  await say("Mama Tee's Kitchen");
  await say(THRIFT);
  assert.match((await say('Send another file', 'imp:other'))[0].text, /Send the right file/);
  assert.equal((await conv(from)).importDraft, null);
  await say(THRIFT);
  const mine = await say("Yes, it's my stock", 'imp:mine');
  assert.match(body(mine[0]), /^Got it! 6 items/);
  assert.equal((await doc('businesses', (await doc('ownerPhones', `+${from}`)).activeBusinessId)).category, 'fashion_retail');

  const other = new Bot();
  const vague = '2348035550001';
  await other.send('admin', { from: vague, text: 'hi', name: 'Tee' });
  await other.send('admin', { from: vague, text: "Tee's Place", name: 'Tee' });
  assert.match(body((await other.send('admin', { from: vague, text: THRIFT, name: 'Tee' }))[0]), /^Got it! 6 items/);
});

test('location: a known area is saved straight away; an unknown one is read back, fixable in words', async () => {
  const bot = new Bot();
  const from = '2348035550002';
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Teniola' });
  await say('hi');
  await say("Tee's Thrift");
  await say('Plaid Flannel Shirt 6500');
  await say("That's all", 'prod:done');
  // An area Relay knows, with a landmark: saved, then only the hours are asked.
  const hours = await say("it's in Lagos, Yaba, near Tejuosho market");
  assert.equal(hours[0].text, '✅ Yaba, Lagos — near Tejuosho Market\n\nAnd what time do you open and close?');

  const other = '2348035550004';
  const say2 = (text: string, choice?: string) => bot.send('admin', { from: other, text, choice, name: 'Tunde' });
  await say2('hi'); await say2('Tunde Tools'); await say2('Hammer 4500'); await say2("That's all", 'prod:done');
  // An area it doesn't know: read back (the hours sent with it are saved, with a ✅ line).
  const back = await say2('5 Church Street, Ogudu Village, Lagos · 9am to 6pm');
  assert.equal(body(back[0]), '✅ Every day 9am–6pm\n\n📍 5 Church Street, Ogudu Village, Lagos. Is that right?');
  assert.deepEqual(back[0].options, ['loc:ok', 'loc:fix']);
  const fixed = await say2('7 Church Street');
  assert.match(body(fixed[0]), /📍 7 Church Street, Ogudu Village, Lagos\. Is that right\?/);
  const next = await say2('Yes', 'loc:ok');
  assert.match(body(next[0]), /^✅ 7 Church Street, Ogudu Village, Lagos\n\nDo you deliver\?/);
  // A known area in another city ("Sango" is in Ibadan): read back too.
  const third = '2348035550005';
  const say3 = (text: string, choice?: string) => bot.send('admin', { from: third, text, choice, name: 'Femi' });
  await say3('hi'); await say3('Femi Phones'); await say3('Charger 3000'); await say3("That's all", 'prod:done');
  assert.deepEqual((await say3('12 Idiroko Road, Sango Ota, Ogun · 9am to 6pm'))[0].options, ['loc:ok', 'loc:fix']);
});

test('hours at signup: the reported message is checked, not saved as "Every day 8am–7am"', async () => {
  const bot = new Bot();
  const from = '2348035550003';
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'May' });
  await say('hi');
  await say('Mayschills');
  await say('Plaid shirt 6500');
  await say("That's all", 'prod:done');
  const q1 = await say('8AM to 7AM on weekdays and 10am to 7am on saturdays');
  assert.match(body(q1[0]), /^Mon–Fri: 8am to 7pm, or open overnight until 7am\?/);
  const bizId = (await doc('ownerPhones', `+${from}`)).activeBusinessId;
  assert.equal((await doc('businesses', bizId)).hours ?? null, null, 'nothing saved while a time is doubtful');
  await say('8am–7pm', 'hrv:alt');
  const done = await say('10am–7pm', 'hrv:alt');
  // Both doubts settled: saved (Sunday wasn't named: closed), then the missing address.
  assert.equal(done[0].text, "✅ Mon–Fri 8am–7pm · Sat 10am–7pm · Sun closed\n\nAnd where's the shop? e.g. *16 Atunrase Estate, Gbagada*");
  assert.deepEqual((await doc('businesses', bizId)).hours.sun, null);
});
