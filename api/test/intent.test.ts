import { Bot, clearFirestore, db, doc, fakeLLM, seed } from './helpers';
import { listProducts } from '../src/services/catalog';
import { parseAdminCommand, parseProductLine } from '../src/bots/intent';
import { adminTools } from '../src/bots/admin-tools';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });
const owner = () => fx.a.ownerPhone.slice(1);

test('intent: add product maps to addProduct', async () => {
  for (const [input, name, price, stock] of [
    ['add Jollof rice, 2500, 10', 'Jollof rice', '2500', 10],
    ['add Jollof rice, ₦2,500, 10 in stock', 'Jollof rice', '2,500', 10],
    ['Add Agbada 2 piece 15000 3', 'Agbada 2 piece', '15000', 3],
    ['add Ankara 5k x4', 'Ankara', '5000', 4],
    ['add Rice 50kg 45,000', 'Rice 50kg', '45,000', undefined],
  ] as const) {
    const c = parseAdminCommand(input);
    assert.equal(c?.tool, 'addProduct', input);
    assert.deepEqual(c?.args, { name, price, ...(stock === undefined ? {} : { stock }) }, input);
  }
  assert.equal(parseProductLine('just words'), null);
  // The zod schema turns naira text into exact kobo.
  assert.deepEqual(adminTools.addProduct.schema.parse({ name: 'Jollof rice', price: '₦2,500', stock: 10 }), { name: 'Jollof rice', price: 250_000, stock: 10 });

  // Free text the rules don't know goes to the LLM, which can only pick a tool; the result runs
  // through the same validation and lands in the owner's business.
  const llm = fakeLLM(m => (m.includes('puff') ? { tool: 'addProduct', args: { name: 'Puff puff', price: '200', stock: 50 } } : null));
  const bot = new Bot(llm);
  const replies = await bot.send('admin', { from: owner(), text: 'abeg put puff puff for 200 naira, I get 50' });
  assert.deepEqual(llm.calls, ['abeg put puff puff for 200 naira, I get 50']);
  assert.match(replies[0].text, /\*Puff puff\*\n₦200 · General\nStock: 50 in stock/);
  assert.ok((await listProducts(db, fx.a.id)).some(p => p.name === 'Puff puff' && p.priceKobo === 20_000 && p.stock === 50));
});

test('intent: tools are scoped to the caller business', async () => {
  // The model tries to act on business B (by name and by a smuggled businessId).
  const llm = fakeLLM(m => m.startsWith('nuke') ? { tool: 'deleteProduct', args: { product: `Product ${fx.b.id}`, businessId: fx.b.id } }
    : m.startsWith('sneak') ? { tool: 'addProduct', args: { name: 'Sneaky', price: '100', businessId: fx.b.id } } : null);
  const bot = new Bot(llm);
  const r1 = await bot.send('admin', { from: owner(), text: 'nuke the other shop product' });
  assert.match(r1[0].text, /couldn't find|Did you mean \*Product biz-a\*/, 'only its own products are ever offered');
  assert.equal((await doc('products', fx.b.product)).deletedAt, null);
  await bot.send('admin', { from: owner(), text: 'sneak one in' });
  const sneaky = (await listProducts(db, fx.b.id)).find(p => p.name === 'Sneaky');
  assert.equal(sneaky, undefined, 'nothing was created in business B');
  // Orders too: B's order reference is invisible to A.
  await db.update(db.doc('orders', fx.b.order), { ref: 'RLY-BBBBB' });
  const r2 = await bot.send('admin', { from: owner(), text: 'RLY-BBBBB paid' });
  assert.match(r2[0].text, /couldn't find order RLY-BBBBB/);
});

test('intent: destructive actions need confirmation', async () => {
  const bot = new Bot();
  const ask = await bot.send('admin', { from: owner(), text: `delete Product ${fx.a.id}` });
  assert.match(ask[0].text, /Delete \*Product biz-a\* \(₦1,000\)\?/);
  assert.deepEqual(ask[0].options, ['yes', 'no']);
  assert.equal((await doc('products', fx.a.product)).deletedAt, null, 'nothing happens before YES');
  assert.match((await bot.send('admin', { from: owner(), text: 'no' }))[0].text, /cancelled/i);
  assert.equal((await doc('products', fx.a.product)).deletedAt, null);
  // A YES with nothing pending does nothing destructive.
  await bot.send('admin', { from: owner(), text: 'yes' });
  assert.equal((await doc('products', fx.a.product)).deletedAt, null);
  // Ask again and confirm with the button.
  await bot.send('admin', { from: owner(), text: `delete Product ${fx.a.id}` });
  const done = await bot.send('admin', { from: owner(), choice: 'yes', text: 'Yes' });
  assert.match(done[0].text, /🗑️ Deleted \*Product biz-a\*\. You now have \d+ products?\./);
  assert.ok((await doc('products', fx.a.product)).deletedAt);
});

test('intent: off-topic requests are redirected', async () => {
  const llm = fakeLLM(() => ({ tool: 'offTopic', args: {} }));
  const bot = new Bot(llm);
  const r = await bot.send('admin', { from: owner(), text: 'write me a poem about the sea' });
  assert.equal(r.length, 1);
  assert.match(r[0].text, /I can only help you run your shop/);
  // A tool name the model invents is never run.
  const rogue = new Bot(fakeLLM(() => ({ tool: 'sendEmail', args: { to: 'x' } })));
  assert.match((await rogue.send('admin', { from: owner(), text: 'email my accountant' }))[0].text, /I can only help you run your shop/);
  // Without an LLM, unknown text gets help, not a guess.
  assert.match((await new Bot().send('admin', { from: owner(), text: 'what is the capital of France' }))[0].text, /didn't get that/);
});
