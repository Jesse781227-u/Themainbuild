// The owner's navigation (brief "menu navigation fix"): one flat menu, nothing stale, a way back
// from everything, one vocabulary, test mode you can leave. Each acceptance check is a test.
import { Bot, clearFirestore, db, doc, env, seed, whatsAppLimitProblems } from './helpers';
import type { AgentTurn, ConverseStep, LLMProvider } from '../src/services/ai';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

void env;
let fx: Awaited<ReturnType<typeof seed>>;
let owner: string;
before(async () => { await clearFirestore(); fx = await seed(); owner = fx.a.ownerPhone.slice(1); });
const rowsOf = (m: { content: unknown }) => ((m.content as { interactive?: { action?: { sections?: { rows: { id: string; title: string; description?: string }[] }[] } } }).interactive?.action?.sections ?? []).flatMap(s => s.rows);

// A model that only counts: the navigation must never reach it.
function counting() {
  const seen: AgentTurn[][] = [];
  const llm: LLMProvider & { seen: typeof seen } = { seen, async chooseTool() { return null; }, async converse(i): Promise<ConverseStep> { seen.push(i.turns); return { calls: [], text: 'OK', usage: { inTokens: 0, outTokens: 0 } }; } };
  return llm;
}

test('1 · MENU: one list of 10 rows; orders, money, add, sold out, products, customers and pause are one tap away', async () => {
  const bot = new Bot();
  const [m] = await bot.send('admin', { from: owner, text: 'menu' });
  const rows = rowsOf(m);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map(r => r.title), ['Orders', 'Money', 'Add product', 'Sold out / restock', 'My products', 'Message customers', 'My customers', 'Pause shop', 'Settings', 'Help']);
  for (const id of ['act:orders', 'act:money', 'act:add', 'act:soldout', 'act:products', 'act:reachhub', 'act:customers', 'act:close']) {
    const out = await bot.send('admin', { from: owner, choice: id, text: id });
    assert.ok(out.length, `${id} answers straight away`);
  }
});

test('2 · a half-written broadcast never catches a later message after the owner moved on', async () => {
  const bot = new Bot();
  await bot.send('admin', { from: owner, choice: 'act:reachhub', text: 'Message customers' });
  const ask = await bot.send('admin', { from: owner, choice: 'act:campaign', text: 'Send a broadcast' });
  assert.deepEqual(ask[0].options, ['act:cancel', 'act:menu'], 'a way out while it waits');
  await bot.send('admin', { from: owner, choice: 'act:menu', text: 'Menu' });
  await bot.send('admin', { from: owner, choice: 'act:orders', text: 'Orders' });
  const before = (await db.query('campaigns', [['businessId', '==', fx.a.id]])).length;
  const out = await bot.send('admin', { from: owner, text: 'ok thanks' });
  assert.equal((await db.query('campaigns', [['businessId', '==', fx.a.id]])).length, before, 'no broadcast drafted');
  assert.ok(out.every(m => !/customers:\n|Cost:/.test(m.text)));
});

test('3 · Add product → "cancel": cancelled, nothing saved, the AI never asked', async () => {
  const llm = counting();
  const bot = new Bot(llm);
  const products = (await db.query('products', [['businessId', '==', fx.a.id]])).length;
  await bot.send('admin', { from: owner, choice: 'act:add', text: 'Add product' });
  const out = await bot.send('admin', { from: owner, text: 'cancel' });
  assert.equal(out[0].text.split('\n')[0], 'Cancelled. Nothing was sent or saved.');
  assert.equal((await db.query('products', [['businessId', '==', fx.a.id]])).length, products);
  assert.equal(llm.seen.length, 0);
  // Add product with no price: asked again, with Cancel and Menu.
  await bot.send('admin', { from: owner, choice: 'act:add', text: 'Add product' });
  const again = await bot.send('admin', { from: owner, text: 'beef suya' });
  assert.match(again[0].text, /^I need a name and a price/);
  assert.deepEqual(again[0].options, ['act:cancel', 'act:menu']);
  await bot.send('admin', { from: owner, text: 'back' });
});

test('4 · "back" with nothing pending opens the menu', async () => {
  const [m] = await new Bot().send('admin', { from: owner, text: 'back' });
  assert.equal(rowsOf(m)[0].id, 'act:orders');
});

test('5 · Pause → Cancel: the shop stays open and the menu still says Pause shop', async () => {
  const bot = new Bot();
  const pause = await bot.send('admin', { from: owner, choice: 'act:close', text: 'Pause shop' });
  assert.deepEqual(pause[0].options, ['act:close:1', 'act:close:3', 'act:close:open', 'act:close:cancel']);
  const kept = await bot.send('admin', { from: owner, choice: 'act:close:cancel', text: 'Cancel' });
  assert.equal(kept[0].text.split('\n')[0], 'Your shop is still open.');
  assert.equal((await doc('businesses', fx.a.id)).pausedUntil ?? null, null);
  const [m] = await bot.send('admin', { from: owner, text: 'menu' });
  assert.equal(rowsOf(m).find(r => r.id === 'act:close')!.title, 'Pause shop');
});

test('6 · Money shows goods + delivery, and its total matches Orders', async () => {
  const now = new Date().toISOString();
  await db.set(db.doc('orders', 'nav-paid'), { id: 'nav-paid', ref: 'RLY-NAV01', businessId: fx.a.id, customerId: fx.a.customer, channel: 'whatsapp', items: [{ productId: fx.a.product, name: 'Akara', priceKobo: 160_000, qty: 1 }], subtotalKobo: 160_000, deliveryFeeKobo: 700_000, feeKobo: 1_600, feePaidBy: 'customer', uniqueKobo: 0, payAmountKobo: 861_600, status: 'paid', fulfilment: 'pending', delivery: { method: 'self_arranged', feeKobo: 700_000, address: 'Sangotedo' }, holdExpiresAt: now, paidAt: now, createdAt: now, updatedAt: now });
  const bot = new Bot();
  const money = (await bot.send('admin', { from: owner, choice: 'act:money', text: 'Money' }))[0].text;
  assert.match(money, /Today: \*₦8,600\* to you \(₦1,600 goods \+ ₦7,000 delivery\), 1 paid order/);
  const orders = (await bot.send('admin', { from: owner, choice: 'act:orders', text: 'Orders' }))[0];
  assert.match(orders.text, /Paid today: 1 order, \*₦8,600 to you\*\./);
  assert.match(orders.text, /^🚚 \*To deliver \(1\)\*\n• RLY-NAV01/);
  assert.deepEqual(orders.options, ['act:deliverpick', 'act:receipt', 'act:menu']);
  const pick = await bot.send('admin', { from: owner, choice: 'act:deliverpick', text: 'Mark delivered' });
  assert.equal(rowsOf(pick[0])[0].id, 'act:delivered:RLY-NAV01');
  await bot.send('admin', { from: owner, choice: 'act:delivered:RLY-NAV01', text: 'RLY-NAV01' });
  assert.equal((await doc('orders', 'nav-paid')).fulfilment, 'delivered');
});

test('7 · Help → Try my shop: every customer message says how to leave; EXIT goes straight to the owner menu', async () => {
  const bot = new Bot();
  const help = await bot.send('admin', { from: owner, choice: 'menu:Help', text: 'Help' });
  assert.deepEqual(rowsOf(help[0]).map(r => r.id), ['act:test', 'act:help', 'act:call', 'act:menu']);
  const test = await bot.send('admin', { from: owner, choice: 'act:test', text: 'Try my shop' });
  for (const m of test.slice(1)) assert.match(m.text, /🧪 Test mode · type EXIT to go back/);
  const shop = await bot.send('admin', { from: owner, text: 'what do you have?' });
  for (const m of shop) assert.match(m.text, /🧪 Test mode · type EXIT to go back/);
  const back = await bot.send('admin', { from: owner, text: 'exit' });
  assert.equal(back[0].text, "You're back with Relay 👋");
  assert.equal(rowsOf(back[1])[0].id, 'act:orders');
  // Or the button (on the welcome of a fresh test chat, where there's room).
  await bot.send('admin', { from: owner, choice: 'act:test', text: 'Try my shop' });
  const again = await bot.send('admin', { from: owner, text: 'hi' });
  for (const m of again) assert.match(m.text, /🧪 Test mode · type EXIT to go back/);
  const viaButton = await bot.send('admin', { from: owner, choice: 'act:exittest', text: 'Back to my dashboard' });
  assert.equal(rowsOf(viaButton[1])[0].id, 'act:orders');
});

test('8 · old buttons still in the chat (menu:Shop, menu:Orders, menu:Money, menu:Customers, act:pending, act:sales, act:wallet) still work', async () => {
  const bot = new Bot();
  const first = async (choice: string) => (await bot.send('admin', { from: owner, choice, text: choice }))[0];
  assert.equal(rowsOf(await first('menu:Shop'))[0].id, 'act:orders');
  assert.match((await first('menu:Orders')).text, /To deliver|Nothing to deliver/);
  assert.match((await first('menu:Money')).text, /^💰 \*Money\*/);
  assert.deepEqual(rowsOf(await first('menu:Customers')).map(r => r.id), ['act:status', 'act:campaign', 'act:reach', 'act:menu']);
  assert.match((await first('act:pending')).text, /To deliver|Nothing to deliver/);
  assert.match((await first('act:sales')).text, /^💰 \*Money\*/);
  assert.match((await first('act:wallet')).text, /^💰 \*Money\*/);
});

test('9 · every owner list fits WhatsApp: ≤10 rows, titles ≤24, descriptions ≤72 and never cut short', async () => {
  const bot = new Bot();
  for (const choice of ['act:menu', 'menu:Settings', 'menu:Help', 'act:reachhub', 'act:close', 'act:reach', 'act:tone']) {
    for (const m of await bot.send('admin', { from: owner, choice, text: choice })) {
      assert.deepEqual(whatsAppLimitProblems(m.content), [], choice);
      for (const r of rowsOf(m)) assert.ok(!/…$/.test(r.description ?? ''), `${choice}: "${r.title}" description cut short`);
    }
  }
});

test('a question left unanswered for 10 minutes is dropped', async () => {
  const bot = new Bot();
  await bot.send('admin', { from: owner, choice: 'act:campaign', text: 'Send a broadcast' });
  await db.set(db.doc('conversations', `admin_${owner}`), { awaitingAt: new Date(Date.now() - 11 * 60_000).toISOString() }, { merge: true });
  const before = (await db.query('campaigns', [['businessId', '==', fx.a.id]])).length;
  await bot.send('admin', { from: owner, text: 'see you tomorrow then' });
  assert.equal((await db.query('campaigns', [['businessId', '==', fx.a.id]])).length, before);
  assert.equal((await doc('conversations', `admin_${owner}`)).awaiting, null);
});

test('one vocabulary: To deliver, Broadcast, Automatic updates (no "Pending orders", "Send an update", "Smart Reach")', async () => {
  const bot = new Bot();
  const seen: string[] = [];
  for (const choice of ['act:menu', 'act:reachhub', 'act:reach', 'act:orders', 'menu:Settings', 'menu:Help']) for (const m of await bot.send('admin', { from: owner, choice, text: choice })) seen.push(JSON.stringify(m.content));
  seen.push((await bot.send('admin', { from: owner, text: '/help' })).map(m => m.text).join('\n'));
  const all = seen.join('\n');
  assert.ok(!/Pending orders|Send an update|Smart Reach|Paid, still to deliver/.test(all), all.match(/Pending orders|Send an update|Smart Reach|Paid, still to deliver/)?.[0]);
});
