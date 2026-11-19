import { Bot, clearFirestore, db, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { carousel, CAROUSEL, clip, type CarouselShape } from '../src/services/carousel';
import { optionIds, toText } from '../src/services/channel';
import { cardFor, categoryCarousel, productCarousel } from '../src/bots/product-cards';
import { createCategories, createProduct } from '../src/services/catalog';
import type { Category, Product } from '../src/domain/commerce';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });
const cfg = { API_BASE_URL: 'https://relay.test' };
const product = (i: number, extra: Partial<Product> = {}): Product => ({ id: `p${i}`, businessId: 'b', name: `Item ${String(i).padStart(2, '0')}`, description: '', priceKobo: 100_000 + i, images: [], categoryId: 'c', available: true, stock: null, lowStockThreshold: 2, createdAt: '', updatedAt: '', ...extra });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ia = (c: unknown) => (c as { interactive: any }).interactive;
const cards = (c: unknown) => (ia(c) as { action: { cards: { body: { text: string }; header: { image: { link: string } }; action: { buttons: { quick_reply: { id: string; title: string } }[] } }[] } }).action.cards;

test('carousel: Meta limits are enforced in code', () => {
  const card = { imageUrl: 'https://x/1.jpg', body: 'x'.repeat(300), buttons: [['a', 'A very long button title here'], ['b', 'B']] as [string, string][] };
  assert.throws(() => carousel('Hi', [card]), /CAROUSEL_CARDS: 1/, 'at least 2 cards');
  assert.throws(() => carousel('Hi', Array(11).fill(card)), /CAROUSEL_CARDS: 11/, 'at most 10 cards');
  assert.throws(() => carousel('Hi', [card, { ...card, buttons: [['a', 'A']] }]), /CAROUSEL_BUTTONS_MISMATCH/, 'same buttons on every card');
  assert.throws(() => carousel(' ', [card, card]), /CAROUSEL_BODY_REQUIRED/);
  const c = carousel('Body', [card, card]);
  assert.equal(cards(c)[0].body.text.length, CAROUSEL.cardBodyMax, 'card text cut to 160');
  assert.ok(cards(c)[0].action.buttons[0].quick_reply.title.length <= 20, 'button titles cut to 20, at a word');
  assert.equal(clip('one two three four', 12), 'one two…');
});

test('carousel: cards show photo or stand-in, price, sold out, Buy and Details', () => {
  const withPhoto = cardFor(cfg, product(1, { images: ['https://cdn/af1.jpg'], description: 'Clean pair, size 42' }));
  assert.equal(withPhoto.imageUrl, 'https://cdn/af1.jpg');
  assert.equal(withPhoto.body, '*Item 01*\n₦1,000.01\nClean pair, size 42');
  assert.deepEqual(withPhoto.buttons, [['buy:p1', 'Add to cart'], ['det:p1', 'See details']]);
  const soldOut = cardFor(cfg, product(2, { stock: 0 }));
  assert.match(soldOut.imageUrl, /^https:\/\/relay\.test\/ph\/[0-9a-f]{6}\/I\.png$/, 'no photo: the shop colour and the first letter');
  assert.match(soldOut.body, /· Sold out$/);
  assert.deepEqual(soldOut.buttons, [['buy:p2', 'Sold out'], ['det:p2', 'See details']], 'same two buttons, so every card matches');
});

test('carousel: pages of 9 with a See more card; sold out last; one product is a detail card', () => {
  const ps = Array.from({ length: 23 }, (_, i) => product(i + 1, i === 0 ? { stock: 0 } : {}));
  const [p0] = productCarousel(cfg, { name: 'Ada Kicks' }, ps, { title: 'Sneakers', key: 'cat1' });
  const c0 = cards(p0);
  assert.equal(c0.length, 10);
  assert.equal(c0[0].body.text.split('\n')[0], '*Item 02*', 'in stock first');
  assert.match(c0[9].body.text, /\*See more\*\n14 more in Sneakers/);
  assert.deepEqual(c0[9].action.buttons.map(b => b.quick_reply.id), ['more:cat1:1', 'menu']);
  assert.match((ia(p0) as { body: { text: string } }).body.text, /Sneakers at Ada Kicks 👇 Swipe/);
  const c1 = cards(productCarousel(cfg, { name: 'Ada Kicks' }, ps, { title: 'Sneakers', key: 'cat1', page: 1 })[0]);
  assert.equal(c1.length, 10);
  const c2 = cards(productCarousel(cfg, { name: 'Ada Kicks' }, ps, { title: 'Sneakers', key: 'cat1', page: 2 })[0]);
  assert.equal(c2.length, 5, 'the last page has no See more card');
  assert.match(c2[4].body.text, /\*Item 01\*[\s\S]*Sold out/, 'sold out at the very end');
  const single = productCarousel(cfg, { name: 'Ada Kicks' }, [product(5)], { title: 'Bags', key: 'c' });
  assert.equal((ia(single[0]) as { type: string }).type, 'button', 'one product: a detail message, not a carousel');
  // Instagram / typed numbers: each card's first button, numbered in the text.
  assert.deepEqual(optionIds(p0).slice(0, 2), ['buy:p2', 'buy:p3']);
  assert.match(toText(p0), /1\. Item 02 · ₦1,000\.02[\s\S]*Reply with a number to buy/);
});

test('shop: customers browse categories as carousels, Buy adds to the cart, search finds products', async () => {
  const [kicks, bags] = await createCategories(db, fx.b.id, ['Sneakers', 'Bags']);
  for (const [name, price, cat, stock] of [['Black AF1', 2_500_000, kicks.id, null], ['White AF1', 2_600_000, kicks.id, 0], ['Jordan 4', 4_000_000, kicks.id, 3], ['Tote bag', 900_000, bags.id, null]] as const) {
    await createProduct(db, { businessId: fx.b.id, name, priceKobo: price, categoryId: cat, stock });
  }
  await saveWhatsAppConnection(db, getConfig(env), { businessId: fx.b.id, wabaId: 'waba-b', phoneNumberId: fx.b.pnid, accessToken: 'merchant-b' });
  const bot = new Bot();
  const c = { from: '2348090000002', to: fx.b.pnid };
  const hello = await bot.send('shop', { ...c, text: 'hi' });
  assert.deepEqual(hello[0].options, ['menu', 'ask', 'track'], 'a plain hi gets the welcome, no carousel');
  const hi = await bot.send('shop', { ...c, text: 'send me your menu' });
  assert.match(hi[0].text, /^Here's what we have 👇/);
  assert.ok(hi[0].options.includes(`cat:${kicks.id}`) && hi[0].options.includes(`cat:${bags.id}`));
  assert.equal(ia(hi[0].content).type, 'carousel', 'categories are swipeable cards too');
  assert.match(hi[0].text, /Sneakers · 3 items · from ₦25,000\n2\. Bags · 1 item · from ₦9,000\nReply with a number to choose\./);
  const back = await bot.send('shop', { ...c, choice: 'menu', text: 'Menu' });
  assert.match(back[0].text, /^Here's what we have 👇\n1\./, 'no second welcome');

  const list = await bot.send('shop', { ...c, choice: `cat:${kicks.id}`, text: 'Sneakers' });
  assert.equal(ia(list[0].content).type, 'carousel');
  assert.match(list[0].text, /Sneakers at Business biz-b[\s\S]*Black AF1[\s\S]*Jordan 4[\s\S]*White AF1 · ₦26,000 · Sold out/);

  const white = (await db.query('products', [['businessId', '==', fx.b.id]])).find(p => p.name === 'White AF1')!;
  assert.match((await bot.send('shop', { ...c, choice: `buy:${white._id}`, text: 'Sold out' }))[0].text, /White AF1 is sold out right now/);
  const black = (await db.query('products', [['businessId', '==', fx.b.id]])).find(p => p.name === 'Black AF1')!;
  assert.match((await bot.send('shop', { ...c, choice: `buy:${black._id}`, text: 'Buy' })).at(-1)!.text, /Added 1 × Black AF1/);
  assert.match((await bot.send('shop', { ...c, choice: `det:${black._id}`, text: 'Details' }))[0].text, /\*Black AF1\*\n₦25,000/);

  const found = await bot.send('shop', { ...c, text: 'af1 sneakers' });
  assert.match(found[0].text, /Results for "af1 sneakers"[\s\S]*Black AF1[\s\S]*White AF1/);
});

test('carousel: categories page at 10 cards, with cover photos from their products', () => {
  const cats = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `Section ${i}`, coverImage: i === 1 ? 'https://img/cover.jpg' : null }) as unknown as Category);
  const prods = [{ ...product(1), categoryId: 'c0', images: ['https://img/p1.jpg'] }, { ...product(2), categoryId: 'c0', stock: 0 }] as Product[];
  const p0 = categoryCarousel(cfg, cats, prods, { intro: 'Hi!' });
  const cards = (ia(p0) as CarouselShape).action!.cards!;
  assert.equal(cards.length, 10);
  assert.equal(cards[0].header!.image!.link, 'https://img/p1.jpg', 'first product photo as cover');
  assert.equal(cards[1].header!.image!.link, 'https://img/cover.jpg', 'own cover wins');
  assert.match(cards[2].header!.image!.link!, /product-placeholder\.png$/);
  assert.match(cards[0].body!.text!, /^\*Section 0\*\n2 items · from ₦1,000\.01$/);
  assert.match(cards[2].body!.text!, /0 items · sold out/);
  assert.equal(cards[9].action!.buttons![0].quick_reply!.id, 'cats:1');
  const p1 = (ia(categoryCarousel(cfg, cats, prods, { intro: 'Hi!', page: 1 })) as CarouselShape).action!.cards!;
  assert.deepEqual(p1.map(c => c.action!.buttons![0].quick_reply!.id), ['cat:c9', 'cat:c10', 'cat:c11']);
});

test('placeholder: products without a photo get a PNG in the shop colour', async () => {
  const { api } = await import('./helpers');
  const { placeholderPath, shopColour } = await import('../src/services/placeholder');
  assert.equal(placeholderPath('biz-a', 'jollof rice'), `/ph/${shopColour('biz-a')}/J.png`);
  assert.equal(placeholderPath('biz-a', '🔥 Ëgusi'), `/ph/${shopColour('biz-a')}/E.png`);
  const { createApp } = await import('../src/app');
  const { env } = await import('./helpers');
  const res = await createApp().request(placeholderPath('biz-a', 'Zobo'), {}, env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer()).subarray(0, 4)], [137, 80, 78, 71]);
  assert.equal((await api('GET', '/ph/ffffff/A.png')).status, 404, 'only our colours');
});
