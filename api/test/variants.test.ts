import { Bot, clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { createProduct } from '../src/services/catalog';
import { makeVariants, stockPatch } from '../src/domain/commerce';
import { recentOrders, releaseExpiredHolds } from '../src/services/orders';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, getConfig(env), { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
  await db.update(db.doc('products', fx.a.product), { available: false });
});
const owner = () => fx.a.ownerPhone.slice(1);
const rows = (m: { content: unknown }) => ((m.content as { interactive: { action: { sections: { rows: { id: string; title: string }[] }[] } } }).interactive.action.sections).flatMap(s => s.rows);

test('options: combinations, and stock changes per option', () => {
  const vs = makeVariants([{ name: 'Size', values: ['40', '41'] }, { name: 'Colour', values: ['Black', 'Brown'] }]);
  assert.deepEqual(vs.map(v => v.label), ['40 / Black', '40 / Brown', '41 / Black', '41 / Brown']);
  const p = { stock: null, variants: vs.map((v, i) => ({ ...v, stock: i === 0 ? 3 : null })) };
  assert.deepEqual(stockPatch(p, [{ variantId: 'v1', delta: -2 }])!.variants![0].stock, 1);
  assert.equal(stockPatch(p, [{ variantId: 'v2', delta: -2 }]), null, 'an option without a count is never reserved');
  assert.throws(() => stockPatch(p, [{ variantId: 'v1', delta: -4 }]), /INSUFFICIENT_STOCK/);
  const all = { stock: 5, variants: vs.map(v => ({ ...v, stock: 5 })) };
  assert.equal(stockPatch(all, [{ variantId: 'v1', delta: -1 }, { variantId: 'v3', delta: -2 }])!.stock, 17, 'the product total follows its options');
  assert.deepEqual(stockPatch({ stock: 4 }, [{ delta: -1 }, { delta: -1 }]), { stock: 2 });
});

test('owner: one line with sizes and colours → one product with options; restock one size; sold out per size', async () => {
  const bot = new Bot();
  const say = (text: string, choice?: string) => bot.send('admin', { from: owner(), text, choice });
  let card = await say('add Black boots 15000 sizes 40-42 colours black, brown');
  const pick = card[0].options.find(id => id.startsWith('pcat:') && id !== 'pcat:new');
  if (pick) card = await say('General', pick);
  assert.match(card[0].text, /Sizes: 40, 41, 42 · Colours: Black, Brown/);
  const [p] = (await db.query('products', [['businessId', '==', fx.a.id]])).filter(x => x.name === 'Black boots' || x.name === 'Black Boots');
  assert.equal((p.variants as unknown[]).length, 6);
  assert.equal(p.stock, null);

  assert.match((await say('restock Black boots 5'))[0].text, /Which one\? \*Black (b|B)oots\* comes in 40 \/ Black, 40 \/ Brown/);
  assert.match((await say('restock Black boots 41 black 3'))[0].text, /Black (b|B)oots \(41 \/ Black\): \+3, now 3 in stock/);
  assert.equal((await doc('products', p._id)).variants.find((v: { label: string }) => v.label === '41 / Black').stock, 3);
  assert.match((await say('products'))[0].text, /Black (b|B)oots — ₦15,000 · Sizes 40–42 · Colours Black, Brown \(.*41 \/ Black \(3\)/);

  const which = await say('/soldout Black boots');
  assert.ok(rows(which[0]).some(r => r.id === `act:soldout:${p._id}:v1`));
  assert.match((await say('40 / Black', `act:soldout:${p._id}:v1`))[0].text, /\(40 \/ Black\)\* is marked sold out/);
  assert.equal((await doc('products', p._id)).variants[0].stock, 0);
});

test('customer: Add to cart asks which size; the cart, the order and the stock hold go by size', async () => {
  const product = await createProduct(db, { businessId: fx.a.id, name: 'Chelsea Boots', priceKobo: 2_000_000, categoryId: `cat-${fx.a.id}`, optionNames: ['Size'], variants: [
    { id: 'v1', label: '41', options: { Size: '41' }, priceKobo: null, stock: 2 },
    { id: 'v2', label: '42', options: { Size: '42' }, priceKobo: 2_200_000, stock: 0 },
    { id: 'v3', label: '43', options: { Size: '43' }, priceKobo: null, stock: null },
  ] });
  assert.equal(product.stock, null, 'one option has no count, so the product has none either');
  const bot = new Bot();
  const me = '2348091400001';
  const shop = (text: string, choice?: string) => bot.send('shop', { from: me, to: fx.a.pnid, text, choice });
  const ask = await shop('Add to cart', `buy:${product.id}`);
  assert.match(ask[0].text, /\*Chelsea Boots\* · ₦20,000\nWhich size\?\nSold out: 42/);
  assert.deepEqual(rows(ask[0]).map(r => r.id), [`addv:${product.id}:v1`, `addv:${product.id}:v3`], 'sold-out sizes are left out of the list');
  const added = await shop('41', `addv:${product.id}:v1`);
  assert.match(added.at(-1)!.text, /Added 1 × Chelsea Boots \(41\)[\s\S]*• 1 × Chelsea Boots \(41\): ₦20,000/);
  await shop('41', `addv:${product.id}:v1`);
  assert.match((await shop('41', `addv:${product.id}:v1`))[0].text, /Sorry, only 2 Chelsea Boots \(41\) left\./);
  await shop('43', `addv:${product.id}:v3`);

  const confirm = await shop('Checkout', 'checkout');
  assert.match(confirm[0].text, /• 2 × Chelsea Boots \(41\): ₦40,000\n• 1 × Chelsea Boots \(43\): ₦20,000\nSubtotal: ₦60,000/);
  await shop('Confirm order', 'confirm');
  const [order] = await recentOrders(db, [['customerId', '==', `${fx.a.id}_wa_${me}`]], 1);
  assert.deepEqual(order.items.map(l => [l.name, l.variantId, l.qty]), [['Chelsea Boots (41)', 'v1', 2], ['Chelsea Boots (43)', 'v3', 1]]);
  assert.deepEqual((await doc('products', product.id)).variants.map((v: { stock: number | null }) => v.stock), [0, 0, null], 'size 41 is held');
  await releaseExpiredHolds(db, new Date(Date.now() + 2 * 3_600_000));
  assert.deepEqual((await doc('products', product.id)).variants.map((v: { stock: number | null }) => v.stock), [2, 0, null], 'and given back when the hold runs out');
});

test('customer: too many options for one list → the size first, then the colour', async () => {
  const sizes = Array.from({ length: 10 }, (_, i) => String(36 + i));
  const p = await createProduct(db, { businessId: fx.a.id, name: 'Canvas Sneakers', priceKobo: 1_000_000, categoryId: `cat-${fx.a.id}`, optionNames: ['Size', 'Colour'], variants: makeVariants([{ name: 'Size', values: sizes }, { name: 'Colour', values: ['White', 'Black'] }]) });
  const bot = new Bot();
  const shop = (text: string, choice?: string) => bot.send('shop', { from: '2348091400002', to: fx.a.pnid, text, choice });
  const first = await shop('Add to cart', `buy:${p.id}`);
  assert.equal(rows(first[0]).length, 10);
  assert.equal(rows(first[0])[0].id, `opt1:${p.id}:36`);
  const second = await shop('42', `opt1:${p.id}:42`);
  assert.match(second[0].text, /size 42\. Which colour\?/);
  assert.deepEqual(rows(second[0]).map(r => r.title), ['42 / White', '42 / Black']);
  assert.match((await shop('42 / Black', rows(second[0])[1].id)).at(-1)!.text, /Added 1 × Canvas Sneakers \(42 \/ Black\)/);
});
