import { Bot, clearFirestore, db, doc, seed, signUp } from './helpers';
import { normalise, profileName } from '../src/bots/onboarding';
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

const MENU = `MEALS
Jollof rice & chicken 3500
Fried rice & turkey 4000
SNACKS
Puff puff 500
Meat pie 800
DRINKS
Zobo 700
Chapman 1500`;

test('onboarding v2: hi → shop name → menu → preview → location → hours → delivery → policies → ready → connect link', async () => {
  const bot = new Bot();
  const say = (text: string, choice?: string) => bot.send('admin', { from: OWNER, text, choice, name: 'Ada Obi 🌸' });
  const hi = await say('Hi');
  assert.match(hi[0].text, /^Welcome to Relay, Ada 👋[\s\S]*about 5 minutes[\s\S]*agree to Relay's Terms: https?:\/\/\S+\/terms\nStuck\? Reply \*CALL\* anytime[\s\S]*\*Step 1 of 6\* · What's your shop called\?$/);
  assert.match((await say('add Jollof rice, 2500, 10'))[0].text, /looks like a product/);

  const products = await say("Mama Ada's Kitchen");
  assert.match(products[0].text, /^\*Step 2 of 6\* · Send your menu, price list or product photos/);
  const owner = await doc('ownerPhones', `+${OWNER}`);
  const bizId = owner.activeBusinessId;
  let biz = await doc('businesses', bizId);
  assert.deepEqual([biz.name, biz.ownerName, biz.status, biz.termsVersion, biz.feePayer], ["Mama Ada's Kitchen", 'Ada Obi', 'onboarding', '2026-11-19', 'customer'], 'owner name from the WhatsApp profile, not asked');
  assert.ok(biz.termsAcceptedAt);
  assert.deepEqual(owner.businessIds, [bizId]);

  const summary = await say(MENU);
  assert.match(summary[0].text, /I found \*6 products\* in 3 categories/);
  const added = await say('Add all 6', 'imp:all');
  assert.match(added[0].text, /^Done ✅ Added 6 products in 3 categories: Meals · Snacks · Drinks\.\n\nHere's what your customers will see 👇$/, 'one confirmation, not two');
  assert.equal((added[1].content as any).interactive.type, 'carousel', 'the real carousel');
  assert.match(added[1].text, /Hi, welcome to Mama Ada's Kitchen 👋/);
  assert.deepEqual(added[2].options, ['ok:yes', 'ok:fix', 'prod:more']);
  // The preview's buttons work: the owner can open a section.
  const meals = await say('See Meals', added[1].options[0]);
  assert.equal((meals[0].content as any).interactive.type, 'carousel');
  assert.match(meals[0].text, /Meals/);
  assert.deepEqual(meals[1].options, ['ok:yes', 'ok:fix', 'prod:more']);
  biz = await doc('businesses', bizId);
  assert.deepEqual([biz.category, biz.businessTypeInferred], ['food_beverage', true], 'the menu tells us it is food: no type question');

  assert.match((await say('Fix something', 'ok:fix'))[0].text, /send the product again with the new price/);
  assert.match((await say('Zobo 800'))[0].text, /^Updated \*Zobo\*: ₦700 → ₦800$/);
  // Part of the name is enough when it's clearly one product: updated, not added again.
  const fixed = await say('jollof rice 4000');
  assert.match(fixed[0].text, /^Updated \*Jollof rice & chicken\*: ₦3,500 → ₦4,000$/);
  assert.deepEqual(fixed[1].options, ['ok:yes', 'ok:fix', 'ok:see']);
  // Delete during signup: the Yes button deletes, then back to the question.
  const ask = await say('delete meat pie');
  assert.match(ask[0].text, /^Delete \*Meat pie\* \(₦800\)\? Customers won't see it any more\.\n/);
  assert.deepEqual(ask[0].options, ['yes', 'no']);
  assert.equal(ask.length, 1, 'the signup question waits until they answer');
  const gone = await say('Yes, delete it', 'yes');
  assert.match(gone[0].text, /^🗑️ Deleted \*Meat pie\*\. You now have 5 products\.$/);
  assert.deepEqual(gone[1].options, ['ok:yes', 'ok:fix', 'prod:more'], 'back to where they were');
  assert.equal((await db.query('products', [['businessId', '==', bizId]])).filter(p => !p.deletedAt).length, 5);
  // A new name says so.
  const fresh = await say('kunu 600');
  assert.match(JSON.stringify(fresh), /Added new product \*Kunu\* ₦600 in Drinks/);
  const photos = await say('Looks right', 'ok:yes');
  assert.match(photos[0].text, /6 products have no photo yet[\s\S]*up to 5/);
  // Commands work at every step, then the step's question comes back.
  const list = await say('PRODUCTS');
  assert.match(list[0].text, /\*Meals\*\n• Fried rice & turkey — ₦4,000/);
  assert.doesNotMatch(list[0].text, /no stock count/);
  assert.deepEqual(list[1].options, ['ph:skip']);
  assert.deepEqual(photos[0].options, ['ph:skip']);

  assert.match((await say('Skip for now', 'ph:skip'))[0].text, /^\*Step 3 of 6\* · Where is Mama Ada's Kitchen\?/);
  const street = await say("it's in Lagos, Yaba, near Tejuosho market");
  assert.match(street[0].text, /What's the street or building in Yaba\?/);
  const where = await say('12 Herbert Macaulay Way');
  assert.match(where[0].text, /^📍 12 Herbert Macaulay Way, Yaba, Lagos — near Tejuosho Market\. Is that right\?\n/);
  assert.deepEqual(where[0].options, ['loc:ok', 'loc:fix']);
  assert.match((await say('Yes', 'loc:ok'))[0].text, /^\*Step 4 of 6\* · What time do you open and close/);
  const same = await say('8am - 9pm');
  assert.match(same[0].text, /8am–9pm\. Same every day\?/);
  assert.deepEqual(same[0].options, ['hrs:same', 'hrs:perday', 'hrs:closed']);
  assert.match((await say('Closed some days', 'hrs:closed'))[0].text, /Which days are you closed/);
  const prep = await say('Sunday');
  assert.match(prep[0].text, /✅ Mon–Sat 8am–9pm · Sun closed\.\nWhen you're closed, customers can still order/);
  assert.match(prep[1].text, /How long does an order usually take to prepare/, 'food shops get the prep-time question');
  const delivery = await say('30–60 min', 'prep:1');
  assert.match(delivery[0].text, /^\*Step 5 of 6\* · How do customers get their orders\?/);
  assert.match((await say('Both', 'dl:both'))[0].text, /delivery within Yaba/);
  assert.match((await say('1,500'))[0].text, /elsewhere in Lagos/);
  assert.match((await say('3k'))[0].text, /other states/);
  assert.deepEqual((await say('Yes', 'is:yes'))[0].options, ['is:flat', 'is:quote']);
  const policies = await say('I quote per order', 'is:quote');
  assert.equal(policies[0].text, '✅ Delivery: ₦1,500 within Yaba · ₦3,000 elsewhere in Lagos · other states: you quote per order. Pickup is free.');
  assert.match(policies[1].text, /what most food shops use:\n\n• No returns on food\./);
  // Optional: how the shop talks to customers. Three samples each for the three that matter most.
  const offer = await say('Use these', 'pol:use');
  assert.deepEqual(offer[0].options, ['msgs:choose', 'msgs:default']);
  const welcome = await say('Choose messages', 'msgs:choose');
  assert.match(welcome[0].text, /^Message 1 of 3 · \*Welcome\* — sent the first reply to a new customer\.\n\nNow:\n[\s\S]*\*Option 1\* \(warm and chatty\)\n[\s\S]*\*Option 2\* \(short and professional\)\nWelcome to \*Mama Ada's Kitchen\*\. How can we help you today\?\n\n\*Option 3\* \(playful, with a light Naija touch\)/);
  assert.deepEqual(welcome[1].options, ['msgpick:welcome:1', 'msgpick:welcome:2', 'msgpick:welcome:3', 'msgedit:welcome', 'msgkeep:welcome']);
  const thanks = await say('Option 2', 'msgpick:welcome:2');
  assert.match(thanks[0].text, /^Saved ✅ Here's exactly how customers will see your \*welcome\* message:\n\nWelcome to \*Mama Ada's Kitchen\*\. How can we help you today\?$/);
  assert.match(thanks[1].text, /^Message 2 of 3 · \*Thank you after payment\*/);
  // Their own words: checked, shown, then saved.
  await say('Write my own', 'msgedit:paymentThanks');
  assert.match((await say('Thanks {custmer}! Got your {total}.'))[0].text, /I don't know \{custmer\}/);
  const mine = await say('Thanks {customer_name}! We got your {total} for {order_id} 🙏');
  assert.match(mine[0].text, /^Here's how customers will see it:\n\nThanks Ada! We got your ₦12,500 for RLY-7KQ2M 🙏/);
  assert.deepEqual(mine[0].options, ['msgsave:paymentThanks', 'msgedit:paymentThanks']);
  const third = await say('Save', 'msgsave:paymentThanks');
  assert.match(third[1].text, /^Message 3 of 3 · \*Showing what you sell\*/);
  const fee = await say('Keep the current one', 'msgkeep:menuIntro');
  assert.match(fee.map(m => m.text).join('\n'), /That's your messages done 👍/);
  biz = await doc('businesses', bizId);
  assert.equal(biz.messages.welcome, "Welcome to *Mama Ada's Kitchen*. How can we help you today?");
  assert.equal(biz.messages.paymentThanks, 'Thanks {customer_name}! We got your {total} for {order_id} 🙏');
  assert.equal(biz.messages.menuIntro, undefined, 'kept the default');
  // Who pays the fee comes before TEST, so the pretend order shows the right total.
  assert.match(fee.at(-1)!.text, /^\*Step 6 of 6\* · Relay's fee is \*1% of each paid order\*, at most ₦2,000/);
  fee[0] = fee.at(-1)!;
  assert.deepEqual(fee[0].options, ['fee:customer', 'fee:owner']);
  const ready = await say("I'll pay it", 'fee:owner');
  assert.equal(ready[0].text, "👍 You'll pay the fee — customers see your prices only.");
  assert.match(ready[1].text, /^\*Step 6 of 6\* · Mama Ada's Kitchen is ready 🎉[\s\S]*TEST/);
  assert.deepEqual(ready[1].options, ['test:start', 'ob:connect']);
  assert.equal((await doc('businesses', bizId)).feePayer, 'owner');
  // TEST: the welcome they picked (option 2) is the first thing a customer gets for "hi".
  const test = await say('Test my shop', 'test:start');
  assert.equal(test[1].text.split('\n')[0], "Welcome to *Mama Ada's Kitchen*. How can we help you today?");
  assert.deepEqual(test[1].options, ['menu', 'ask', 'track'], 'no carousel on a plain hi');
  await say('EXIT');

  biz = await doc('businesses', bizId);
  assert.deepEqual([biz.city, biz.area, biz.address, biz.landmark, biz.prepTime, biz.fulfilment, biz.shipsInterstate, biz.interstatePricing], ['Lagos', 'Yaba', '12 Herbert Macaulay Way', 'Tejuosho Market', '30–60 min', 'both', true, 'quote']);
  assert.deepEqual([biz.hours.mon, biz.hours.sun], [{ open: '08:00', close: '21:00' }, null]);
  assert.match(biz.policies.returns, /No returns on food/);
  const zones = await db.query('deliveryZones', [['businessId', '==', bizId]]);
  assert.deepEqual(zones.map(z => [z.match, z.feeKobo]).sort(), [['Lagos', 300_000], ['Yaba', 150_000]]);

  assert.match((await say('Connect now', 'ob:connect'))[0].text, /WhatsApp Business/);
  assert.match((await say('Not sure', 'wa:unsure'))[0].text, /Switching is free and keeps your chats/);
  assert.match((await say('Done', 'wa:done'))[0].text, /log into Facebook/);
  assert.match((await say('No', 'fb:no'))[0].text, /create a free account/);
  const link = await say('I have one now', 'fb:now');
  assert.match(link[0].text, /open this link[\s\S]*\/connect\/[A-Za-z0-9]+/);
  assert.equal((await conv(OWNER)).onboarding, null, 'the everyday Admin Bot from here');
  assert.equal((await doc('ownerPhones', `+${OWNER}`)).onboardingStage, 'connect');
  assert.match((await say('products'))[0].text, /\*Meals\*[\s\S]*Jollof rice & chicken/);

  const events = await db.query('onboardingEvents', [['ownerPhone', '==', `+${OWNER}`]]);
  const seen = new Set(events.map(e => `${e.step}:${e.event}`));
  for (const s of ['basics:entered', 'shop_name:completed', 'products:entered', 'preview:completed', 'location:entered', 'hours:entered', 'delivery:entered', 'connect:entered', 'connect_link:entered']) assert.ok(seen.has(s), `analytics: ${s}`);
});

test('onboarding v2: a menu as the very first message is read straight away; the name is asked meanwhile', async () => {
  const bot = new Bot();
  const from = '2348035554444';
  const first = await bot.send('admin', { from, text: 'Suya 3000\nAsun 4500\nChapman 1500', name: '' });
  assert.match(first[0].text, /I found \*3 products\*/);
  assert.deepEqual(first[0].options, ['imp:all', 'imp:cancel']);
  assert.match(first[1].text, /^Welcome to Relay 👋[\s\S]*While you check that list: what's your shop called\?$/);
  const added = await bot.send('admin', { from, choice: 'imp:all', text: 'Add all 3', name: '' });
  assert.match(added[0].text, /Added 3 products/);
  assert.match(added[1].text, /\*Step 1 of 6\* · Now, what's your shop called\?/);
  assert.match((await bot.send('admin', { from, text: 'Suya Spot', name: '' }))[0].text, /what's \*your\* name\?/, 'no WhatsApp profile name: asked once');
  const preview = await bot.send('admin', { from, text: 'Musa', name: '' });
  assert.match(preview[0].text, /✅ 3 products/);
  const biz = await doc('businesses', (await doc('ownerPhones', `+${from}`)).activeBusinessId);
  assert.deepEqual([biz.name, biz.ownerName], ['Suya Spot', 'Musa']);
  assert.ok(biz.termsAcceptedAt, 'terms accepted when they replied');
});

test('onboarding v2: unclear products ask the business type; typed products work without a menu', async () => {
  const bot = new Bot();
  const from = '2348035556666';
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Bisi' });
  await say('hello');
  await say('Bisi Gifts');
  const card = await say('Mystery box 5000');
  assert.match(card[0].text, /\*Mystery box\*\n₦5,000 · Products/);
  assert.deepEqual(card[1].options, ['prod:done']);
  await say('Gift hamper 12k');
  const preview = await say("That's all", 'prod:done');
  assert.match(preview[0].text, /✅ 2 products\./);
  const type = await say('Looks right', 'ok:yes');
  assert.match(type[0].text, /What kind of business is Bisi Gifts/);
  assert.ok(type[0].options.includes('btype:general_services'));
  assert.match((await say('Other', 'btype:other'))[0].text, /^📷 \*Gift hamper\* and \*Mystery box\* have no photo yet/);
});

test('onboarding v2: coming back after a break offers Continue or Start over; start over clears drafts', async () => {
  const bot = new Bot();
  const from = '2348035552222';
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Bola' });
  await say('hi');
  await say('Bola Bakes');
  await say('Cupcakes 500\nBirthday cake 15000');
  await say('Add all 2', 'imp:all');
  await say('Looks right', 'ok:yes');
  const businessId = (await doc('ownerPhones', `+${from}`)).activeBusinessId;
  const stale = async () => db.set(db.doc('conversations', `admin_${from}`), { onboarding: { ...(await conv(from)).onboarding, lastSeenAt: new Date(Date.now() - 2 * 3600_000).toISOString() } }, { merge: true });

  await stale();
  const back = await say('hello');
  assert.match(back[0].text, /Welcome back, Bola\. You were on \*your products\*\. Continue\?/);
  assert.deepEqual(back[0].options, ['ob:continue', 'ob:restart']);
  assert.match((await say('Yes', 'ob:continue'))[0].text, /no photo yet/);
  await say('Skip', 'ph:skip');
  await stale();
  assert.match((await say('hi'))[0].text, /You were on \*your location\*/);

  const restart = await say('Start over', 'ob:restart');
  assert.match(restart[0].text, /starting again[\s\S]*What's your shop called/);
  assert.equal(await doc('ownerPhones', `+${from}`), null, 'the half-made shop is gone');
  assert.equal(await doc('businesses', businessId), null);
  assert.equal((await db.query('products', [['businessId', '==', businessId]])).length, 0);
  assert.match((await say('Bola Bakes 2'))[0].text, /Step 2 of 6/);
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
  assert.match((await say('Yes, add one', 'newshop:yes'))[0].text, /Step 1 of 6\* · What's the new shop or branch called/);
  assert.match((await say('Kunle Kicks Ikeja'))[0].text, /Step 2 of 6/);
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
  let last = await say('Looks right', 'ok:yes');
  if (last.some(m => m.options.some(id => id.startsWith('btype:')))) last = await say('Fashion', 'btype:fashion_retail');
  if (last.some(m => m.options.includes('ph:skip'))) await say('Skip', 'ph:skip');
  await say('Lagos, Ikeja');
  await say('No pickup address', 'loc:nostreet');
  await say('Yes', 'loc:ok');
  await say('Mon-Sat 9am-7pm, Sun closed');
  await say('Pickup', 'dl:pickup');
  await say('Skip', 'pol:skip');
  await say('Use defaults', 'msgs:default');
  await say('My customers', 'fee:customer');
  await say('Connect now', 'ob:connect');
  await say('Yes', 'wa:yes');
  await say('Yes', 'fb:yes');
}

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
  assert.match(step2[0].text, /Send your menu[\s\S]*e\.g\. \*Jollof rice & chicken 3500\*/, 'a kitchen gets a food example');
  const check = await say(THRIFT);
  assert.equal(check.length, 1);
  assert.match(check[0].text, /^Quick check 👀 Your shop is called \*Mama Tee's Kitchen\*, but this file looks like \*clothing, shoes and bags\*\. Did you send the right file\?/);
  assert.deepEqual(check[0].options, ['imp:mine', 'imp:other', 'imp:rename']);
  // Change the name: the products are kept and the summary follows.
  assert.match((await say('Change shop name', 'imp:rename'))[0].text, /What's your shop called\? I'll keep the products/);
  const renamed = await say("Tee's Thrift");
  assert.match(renamed[0].text, /Done ✅ Your shop is now \*Tee's Thrift\*/);
  assert.match(renamed[1].text, /I found \*6 products\*/);
  const bizId = (await doc('ownerPhones', `+${from}`)).activeBusinessId;
  assert.equal((await doc('businesses', bizId)).name, "Tee's Thrift");
  await say('Add all 6', 'imp:all');
  assert.equal((await doc('businesses', bizId)).category, 'fashion_retail');
  const fix = await say('Change something', 'ok:fix');
  assert.doesNotMatch(fix[0].text, /Jollof/);
  assert.match(fix[0].text, /e\.g\. \*[A-Z][^*]+ \d+\*/, 'an example from their own list');
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
  assert.match(mine[0].text, /I found \*6 products\*/);
  assert.equal((await doc('businesses', (await doc('ownerPhones', `+${from}`)).activeBusinessId)).category, 'fashion_retail');

  const other = new Bot();
  const vague = '2348035550001';
  await other.send('admin', { from: vague, text: 'hi', name: 'Tee' });
  await other.send('admin', { from: vague, text: "Tee's Place", name: 'Tee' });
  assert.match((await other.send('admin', { from: vague, text: THRIFT, name: 'Tee' }))[0].text, /^I found \*6 products\*/);
});
