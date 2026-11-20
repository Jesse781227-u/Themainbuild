// Owner bot round 2: sold out by section, one money figure, no dead ends anywhere, broadcast
// audience after the preview, pause by opening hours, "no" only cancels non-yes/no questions,
// stale AI replies dropped, neutral tone for owners.
import { Bot, clearFirestore, db, doc, seed } from './helpers';
import { createCategories, createProduct } from '../src/services/catalog';
import { reopenAt } from '../src/bots/owner-home';
import type { ConverseStep, LLMProvider } from '../src/services/ai';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
let owner: string;
const rowsOf = (m: { content: unknown }) => ((m.content as { interactive?: { action?: { sections?: { rows: { id: string; title: string; description?: string }[] }[] } } }).interactive?.action?.sections ?? []).flatMap(s => s.rows);
before(async () => {
  await clearFirestore(); fx = await seed(); owner = fx.a.ownerPhone.slice(1);
  const [meals, drinks] = await createCategories(db, fx.a.id, ['Meals', 'Drinks']);
  for (let i = 1; i <= 12; i++) await createProduct(db, { businessId: fx.a.id, name: `Meal ${String(i).padStart(2, '0')}`, priceKobo: 100_000 * i, categoryId: meals.id, stock: 5 });
  await createProduct(db, { businessId: fx.a.id, name: 'Zobo', priceKobo: 50_000, categoryId: drinks.id, stock: 0 });
});

test('1 · Sold out / restock: sections first, 9 at a time with More…, and Sold out (n) to restock', async () => {
  const bot = new Bot();
  const pick = (await bot.send('admin', { from: owner, choice: 'act:soldout', text: 'Sold out / restock' }))[0];
  const rows = rowsOf(pick);
  assert.deepEqual(rows.map(r => r.title), ['Meals', 'Other products', 'Sold out (1)', '⬅ Back to menu']);
  const meals = rows[0].id;
  const page1 = rowsOf((await bot.send('admin', { from: owner, choice: meals, text: 'Meals' }))[0]);
  assert.equal(page1.length, 10);
  assert.equal(page1[9].title, 'More…', 'never cut at 10: the next page');
  const page2 = rowsOf((await bot.send('admin', { from: owner, choice: page1[9].id, text: 'More…' }))[0]);
  assert.deepEqual(page2.map(r => r.title), ['Meal 10', 'Meal 11', 'Meal 12', '⬅ Back to menu']);
  // Restock: the sold-out list, how many, done.
  const out = rowsOf((await bot.send('admin', { from: owner, choice: 'act:soldout:out', text: 'Sold out (1)' }))[0]);
  assert.equal(out[0].title, 'Zobo');
  const ask = await bot.send('admin', { from: owner, choice: out[0].id, text: 'Zobo' });
  assert.match(ask[0].text, /^How many \*Zobo\* are back in stock\?/);
  assert.deepEqual(ask[0].options, ['act:cancel', 'act:menu']);
  const done = await bot.send('admin', { from: owner, text: '8' });
  assert.match(done[0].text, /^✅ Zobo: \+8, now 8 in stock\./);
  // Nothing sold out: the picker says so and explains restocking.
  const none = (await bot.send('admin', { from: owner, choice: 'act:soldout', text: 'Sold out / restock' }))[0];
  assert.match(none.text, /Nothing is sold out right now\. When something is, it shows under \*Sold out\* here/);
});

test('2 · one money figure: "to you" in the header, the Money row, Orders and every Money period', async () => {
  const bot = new Bot();
  const menu = (await bot.send('admin', { from: owner, text: 'menu' }))[0];
  assert.match(menu.text, /today: \d+ to deliver · ₦[\d,]+ to you · \d+ unpaid/);
  assert.match(rowsOf(menu).find(r => r.id === 'act:money')!.description!, /^₦[\d,]+ to you today · /);
  const money = (await bot.send('admin', { from: owner, choice: 'act:money', text: 'Money' }))[0].text;
  for (const p of ['Today', 'Last 7 days', 'This month']) assert.match(money, new RegExp(`${p}: \\*₦[\\d,]+\\*( to you)`));
  assert.match((await bot.send('admin', { from: owner, choice: 'act:orders', text: 'Orders' }))[0].text, /\*₦[\d,]+ to you\*/);
});

test('3 · no dead ends: fee (✓ + Menu), verify step 1, tone (✓ + Back), receipt (Back), Change hours', async () => {
  const bot = new Bot();
  const fee = (await bot.send('admin', { from: owner, choice: 'act:fee', text: "Relay's fee" }))[0];
  assert.deepEqual(fee.options, ['fee:customer', 'fee:owner', 'act:menu']);
  assert.match(JSON.stringify(fee.content), /My customers pay ✓/);
  assert.deepEqual((await bot.send('admin', { from: owner, choice: 'act:verify', text: 'Verify now' }))[0].options, ['act:cancel', 'act:menu']);
  await bot.send('admin', { from: owner, text: 'cancel' });
  const tone = rowsOf((await bot.send('admin', { from: owner, choice: 'act:tone', text: 'Assistant tone' }))[0]);
  assert.equal(tone[0].title, 'Like my messages ✓');
  assert.equal(tone.at(-1)!.id, 'act:menu');
  const hours = await bot.send('admin', { from: owner, choice: 'act:hours', text: 'Opening hours' });
  assert.deepEqual(hours[0].options, ['act:hourschange', 'act:menu']);
  const ask = await bot.send('admin', { from: owner, choice: 'act:hourschange', text: 'Change hours' });
  assert.deepEqual(ask[0].options, ['act:cancel', 'act:menu']);
  const read = await bot.send('admin', { from: owner, text: 'Mon–Sat 8am–9pm, Sun closed' });
  assert.match(read.map(m => m.text).join('\n'), /Mon|Monday/, 'read back for checking');
});

test('3 · every owner screen offers Menu or Cancel (unless it is a full 10-row list)', async () => {
  const bot = new Bot();
  const screens = ['act:menu', 'act:orders', 'act:money', 'act:add', 'act:soldout', 'act:products', 'act:reachhub', 'act:customers', 'act:close', 'menu:Settings', 'menu:Help',
    'act:hours', 'act:delivery', 'act:messages', 'act:policies', 'act:tone', 'act:fee', 'act:status', 'act:campaign', 'act:reach', 'act:segments', 'act:receipt',
    'act:verify', 'act:help', 'act:owing', 'act:zonesupload', 'act:policyedit', 'act:hourschange', 'act:call'];
  const bad: string[] = [];
  for (const choice of screens) {
    const out = await bot.send('admin', { from: owner, choice, text: choice });
    const last = out.at(-1);
    if (!last) { bad.push(`${choice}: nothing sent`); continue; }
    const ok = last.options.includes('act:menu') || last.options.some(o => o === 'act:cancel' || o.endsWith(':cancel')) || rowsOf(last).length === 10;
    if (!ok) bad.push(`${choice}: ${JSON.stringify(last.options)} "${last.text.slice(0, 60)}"`);
  }
  assert.deepEqual(bad, []);
});

test('4 · Automatic updates has no send rows; a broadcast asks who after the preview', async () => {
  for (const c of await db.query('customers', [['businessId', '==', fx.a.id]])) await db.update(db.doc('customers', c._id as string), { marketingOptIn: true, lastInboundAt: new Date().toISOString(), orderCount: 3, lastOrderAt: new Date().toISOString() });
  const bot = new Bot();
  const auto = rowsOf((await bot.send('admin', { from: owner, choice: 'act:reach', text: 'Automatic updates' }))[0]).map(r => r.id);
  assert.ok(!auto.includes('act:reachgroup') && !auto.includes('act:reachall'));
  await bot.send('admin', { from: owner, choice: 'act:campaign', text: 'Send a broadcast' });
  const preview = (await bot.send('admin', { from: owner, text: 'New Zobo is in, ice cold!' }))[0];
  assert.match(preview.text, /Cost: ₦[\d,]+\n\nWho should get it\?/);
  assert.deepEqual(preview.options.map(o => o.split(':').slice(0, 2).join(':')), ['act:reachsend', 'act:bcgroup', 'act:cancel']);
  const groups = rowsOf((await bot.send('admin', { from: owner, choice: preview.options[1], text: 'Choose a group' }))[0]);
  assert.ok(groups.length >= 2 && groups.at(-1)!.id === 'act:menu');
  assert.ok(groups.every(r => r.id === 'act:menu' || /^act:bcpick:c_\w+:\w+/.test(r.id)));
  const forGroup = (await bot.send('admin', { from: owner, choice: groups[0].id, text: groups[0].title }))[0];
  assert.match(forGroup.text, /^1 customer:/);
  assert.match(forGroup.options[0], /^act:reachsend:c_/);
  assert.equal(forGroup.options.at(-1), 'act:cancel');
});

test('5 · pause times follow the opening hours', () => {
  // Thursday 20 Nov 2026, 3pm Lagos. Closed Fridays; Saturdays open at 10am.
  const now = new Date('2026-11-20T14:00:00Z');
  const hours = { mon: { open: '08:00', close: '20:00' }, tue: { open: '08:00', close: '20:00' }, wed: { open: '08:00', close: '20:00' }, thu: { open: '08:00', close: '20:00' }, fri: null, sat: { open: '10:00', close: '16:00' }, sun: null };
  assert.equal(reopenAt(hours, 1, now).toISOString(), '2026-11-21T09:00:00.000Z', 'Friday is closed: Saturday at 10am');
  assert.equal(reopenAt(hours, 3, now).toISOString(), '2026-11-23T07:00:00.000Z', 'Sunday closed → Monday 8am');
  assert.equal(reopenAt(null, 1, now).toISOString(), '2026-11-21T07:00:00.000Z', 'no hours: 8am');
});

test('8 · "no" answers a yes/no question; elsewhere it cancels', async () => {
  const bot = new Bot();
  await bot.send('admin', { from: owner, text: 'delete Zobo' });
  const answered = await bot.send('admin', { from: owner, text: 'no' });
  assert.equal(answered[0].text.split('\n')[0], 'OK, cancelled.', 'the confirmation question gets its answer');
  assert.ok(await doc('products', (await db.query('products', [['name', '==', 'Zobo']]))[0]._id as string));
  await bot.send('admin', { from: owner, choice: 'act:zonesupload', text: 'Send my price list' });
  assert.equal((await bot.send('admin', { from: owner, text: 'no' }))[0].text.split('\n')[0], 'Cancelled. Nothing was sent or saved.');
});

test('7 · an AI reply for an older message is dropped once the owner sent something newer; owners get a neutral tone', async () => {
  await db.update(db.doc('businesses', fx.a.id), { tone: 'street' });
  const systems: string[] = [];
  const llm: LLMProvider = {
    async chooseTool() { return null; },
    async converse(i): Promise<ConverseStep> {
      systems.push(i.system);
      // While this reply is being written, a newer owner message arrives.
      await db.set(db.doc('conversations', `admin_${owner}`), { lastOwnerMsgAt: new Date(Date.now() + 60_000).toISOString() }, { merge: true });
      return { calls: [], text: 'Here is the late answer.', usage: { inTokens: 1, outTokens: 1 } };
    },
  };
  const bot = new Bot(llm);
  const out = await bot.send('admin', { from: owner, text: 'how far with my business this week sef?' });
  assert.ok(!out.some(m => m.text.includes('late answer')), 'not sent');
  assert.match(systems[0], /Tone: neutral and professional/);
  assert.ok(!/Street|Tone \(the owner chose it\)/.test(systems[0]), 'never the customer tone');
  await db.update(db.doc('businesses', fx.a.id), { tone: null });
});
