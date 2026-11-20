// The owner's conversation agent with a scripted model: answers from the database, changes with
// Confirm or Undo per the owner's rules, exact commands staying instant.
import { Bot, clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { createCategories, createProduct } from '../src/services/catalog';
import { periodDays } from '../src/bots/admin-agent';
import type { AgentTurn, ConverseStep, LLMProvider, ToolSpec } from '../src/services/ai';
import type { Product } from '../src/domain/commerce';
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const cfg = getConfig(env);
type Step = { call: [string, Record<string, unknown>][] } | { say: string } | { fail: true };
function scripted(steps: Step[]) {
  const seen: { system: string; turns: AgentTurn[]; tools: ToolSpec[] }[] = [];
  const llm: LLMProvider & { seen: typeof seen } = {
    seen,
    async chooseTool() { return null; },
    async converse(input): Promise<ConverseStep> {
      seen.push({ system: input.system, turns: [...input.turns], tools: input.tools });
      const s = steps.shift();
      if (!s) return { calls: [], text: 'OK', usage: { inTokens: 1, outTokens: 1 } };
      if ('fail' in s) throw new Error('GEMINI_FAILED: 503');
      if ('say' in s) return { calls: [], text: s.say, usage: { inTokens: 100, outTokens: 20 } };
      return { calls: s.call.map(([name, args]) => ({ name, args })), text: '', usage: { inTokens: 100, outTokens: 10 } };
    },
  };
  return llm;
}
const results = (llm: ReturnType<typeof scripted>, step = 1) => (llm.seen[step].turns.filter(t => t.role === 'result') as { name: string; result: any }[]);

let fx: Awaited<ReturnType<typeof seed>>;
let jollof: Product, zobo: Product;
let owner: string;
before(async () => {
  await clearFirestore();
  fx = await seed();
  owner = fx.a.ownerPhone.slice(1);
  const [rice] = await createCategories(db, fx.a.id, ['Rice']);
  jollof = await createProduct(db, { businessId: fx.a.id, name: 'Jollof Rice', priceKobo: 350_000, categoryId: rice.id, stock: 12 });
  zobo = await createProduct(db, { businessId: fx.a.id, name: 'Zobo', priceKobo: 100_000, categoryId: rice.id, stock: 30 });
});
beforeEach(() => { Object.assign(cfg, { AGENT_TIMEOUT_MS: 8000, AGENT_ENABLED: undefined }); });

test('periods: this week starts Monday; last week is the 7 days before (Lagos)', () => {
  const wed = new Date('2026-11-18T10:00:00Z');
  assert.deepEqual(periodDays('this_week', wed), ['2026-11-16', '2026-11-17', '2026-11-18']);
  assert.deepEqual(periodDays('last_week', wed), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
  assert.equal(periodDays('last_month', wed).length, 31);
  assert.equal(periodDays('last_month', wed)[0], '2026-10-01');
  assert.deepEqual(periodDays('yesterday', new Date('2026-11-20T23:30:00Z')), ['2026-11-20'], 'already the 21st in Lagos');
});

test('owner agent: "how far with sales this week vs last week?" → two summaries, a plain comparison', async () => {
  for (const d of periodDays('this_week')) await db.set(db.doc('dailyStats', `${fx.a.id}_${d}`), { businessId: fx.a.id, date: d, ordersPaid: 2, salesKobo: 500_000 });
  for (const d of periodDays('last_week')) await db.set(db.doc('dailyStats', `${fx.a.id}_${d}`), { businessId: fx.a.id, date: d, ordersPaid: 1, salesKobo: 200_000 });
  const days = periodDays('this_week').length;
  const llm = scripted([{ call: [['salesSummary', { period: 'this_week' }], ['salesSummary', { period: 'last_week' }]] }, { say: `This week: ₦${(days * 5000).toLocaleString('en-NG')} from ${days * 2} orders, vs ₦14,000 last week 📈` }]);
  const bot = new Bot(llm);
  const out = await bot.send('admin', { from: owner, text: 'how far with sales this week vs last week?' });
  const [tw, lw] = results(llm);
  assert.equal(tw.result.sales, `₦${(days * 5000).toLocaleString('en-NG')}`);
  assert.equal(lw.result.sales, '₦14,000');
  assert.equal(lw.result.paidOrders, 7);
  assert.match(out[0].text, /vs ₦14,000 last week/);
});

test('owner agent: "remove jollof, e don finish" → sold out (not deleted), with Undo that puts it back', async () => {
  const llm = scripted([{ call: [['markSoldOut', { product: 'jollof' }]] }, { say: 'Done, *Jollof Rice* is now sold out.' }]);
  const bot = new Bot(llm);
  const out = await bot.send('admin', { from: owner, text: 'remove jollof from the menu, e don finish' });
  assert.match(out[0].text, /^Done, \*Jollof Rice\* is now sold out\.\n/);
  assert.deepEqual(out[0].options, ['undo', 'act:products']);
  const p = await doc('products', jollof.id);
  assert.equal(p.stock, 0);
  assert.equal(p.deletedAt, null, 'not deleted');
  const undo = await bot.send('admin', { from: owner, choice: 'undo', text: 'Undo' });
  assert.match(undo[0].text, /^↩️ Undone: Jollof Rice back in stock\./);
  assert.equal((await doc('products', jollof.id)).stock, 12);
  assert.match((await bot.send('admin', { from: owner, choice: 'undo', text: 'Undo' }))[0].text, /^Nothing to undo now\./, 'once');
});

test('owner agent: a price change waits for Confirm; Yes runs exactly the stored change', async () => {
  const llm = scripted([{ call: [['setPrice', { product: 'Zobo', price: '1200' }]] }, { say: 'I can change *Zobo* to ₦1,200 for you.' }]);
  const bot = new Bot(llm);
  const out = await bot.send('admin', { from: owner, text: 'abeg make zobo 1200 from today' });
  assert.match(out[0].text, /^I can change \*Zobo\* to ₦1,200 for you\.\n\nChange the price of \*Zobo\* to ₦1,200\?\n/);
  assert.deepEqual(out[0].options, ['yes', 'no']);
  assert.equal((await doc('products', zobo.id)).priceKobo, 100_000, 'nothing changed yet');
  const done = await bot.send('admin', { from: owner, choice: 'yes', text: 'Yes, change it' });
  assert.match(done[0].text, /Zobo is now ₦1,200 \(was ₦1,000\)/);
  assert.equal((await doc('products', zobo.id)).priceKobo, 120_000);
});

test('owner agent: deleting asks first; No leaves it', async () => {
  const llm = scripted([{ call: [['deleteProduct', { product: 'Zobo' }]] }, { say: 'Sure.' }]);
  const bot = new Bot(llm);
  const out = await bot.send('admin', { from: owner, text: 'delete zobo completely from my shop please' });
  assert.match(out[0].text, /Delete \*Zobo\*/);
  await bot.send('admin', { from: owner, choice: 'no', text: 'No, keep it' });
  assert.equal((await doc('products', zobo.id)).deletedAt, null);
});

test('owner agent: a restock happens straight away, with Undo', async () => {
  const llm = scripted([{ call: [['restock', { product: 'Zobo', quantity: 10 }]] }, { say: 'Added 10 *Zobo* 👍' }]);
  const bot = new Bot(llm);
  const before = (await doc('products', zobo.id)).stock;
  const out = await bot.send('admin', { from: owner, text: 'i just got 10 more zobo, add am' });
  assert.equal((await doc('products', zobo.id)).stock, before + 10);
  assert.deepEqual(out[0].options, ['undo', 'act:menu']);
  await bot.send('admin', { from: owner, choice: 'undo', text: 'Undo' });
  assert.equal((await doc('products', zobo.id)).stock, before);
});

test('owner agent: "who never come back since last month?" → a group with a count', async () => {
  const llm = scripted([{ call: [['customerGroup', { description: "people who haven't ordered in a month" }]] }, { say: 'No customers in that group yet.' }]);
  const bot = new Bot(llm);
  await bot.send('admin', { from: owner, text: 'who never come back since last month?' });
  const [g] = results(llm);
  assert.equal(g.result.group, 'no order for 30+ days');
  assert.equal(typeof g.result.count, 'number');
});

test('owner agent: exact commands stay instant (no AI call)', async () => {
  const llm = scripted([]);
  const bot = new Bot(llm);
  await bot.send('admin', { from: owner, text: 'orders' });
  await bot.send('admin', { from: owner, text: 'restock Zobo 5' });
  assert.equal(llm.seen.length, 0);
});

test('owner agent: the AI down → the old routing answers, never an error', async () => {
  const bot = new Bot(scripted([{ fail: true }]));
  const out = await bot.send('admin', { from: owner, text: 'how my business dey go this period sef' });
  assert.ok(out.length && out.every(m => !/error/i.test(m.text)));
});

test('owner agent: the context gives today\'s numbers and the products', async () => {
  const llm = scripted([{ say: 'All good 👍' }]);
  const bot = new Bot(llm);
  await bot.send('admin', { from: owner, text: 'how far, how body today?' });
  assert.match(llm.seen[0].system, /Jollof Rice \| ₦3,500 \| \d+ (left|in stock)/);
  assert.match(llm.seen[0].system, /orders waiting for payment/);
  assert.match(llm.seen[0].system, /mark it sold out \(markSoldOut\), not delete/);
});

test('owner agent: "I\'ve changed it" with no change made is never sent', async () => {
  const llm = scripted([{ say: "I've set *Zobo* to ₦1,000 for you 👍" }, { say: "I've changed *Zobo* to ₦1,000 now." }]);
  const bot = new Bot(llm);
  const out = await bot.send('admin', { from: owner, text: 'abeg make zobo cheaper small, use the normal price' });
  assert.ok(out.every(m => !/I've (set|changed)/.test(m.text)));
  assert.match((llm.seen[1].turns.at(-1) as { text: string }).text, /no action tool was called/);
});

test('owner: an exact price command also waits for Confirm (the owner\'s rule)', async () => {
  const bot = new Bot(null);
  const before = (await doc('products', zobo.id)).priceKobo;
  const out = await bot.send('admin', { from: owner, text: 'price zobo 1500' });
  assert.match(out[0].text, /^Change the price of \*zobo\* to ₦1,500\?/i);
  assert.equal((await doc('products', zobo.id)).priceKobo, before);
  await bot.send('admin', { from: owner, choice: 'yes', text: 'Yes, change it' });
  assert.equal((await doc('products', zobo.id)).priceKobo, 150_000);
});
