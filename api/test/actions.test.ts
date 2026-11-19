import { Bot, clearFirestore, db, doc, env, fakeLLM, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { ACTIONS, commandsPayload, followUps, matchAction } from '../src/bots/actions';
import { addShop, switchShop } from '../src/services/owners';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, getConfig(env), { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
});
const owner = () => fx.a.ownerPhone.slice(1);
const rows = (m: { content: unknown }) => ((m.content as { interactive: { action: { sections: { rows: { id: string }[] }[] } } }).interactive.action.sections).flatMap(s => s.rows.map(r => r.id));

test('commands: the registry makes a valid WhatsApp command list, and a bad entry stops the sync', () => {
  const p = commandsPayload();
  assert.deepEqual(p.commands.map(c => c.command_name), ['menu', 'add', 'products', 'soldout', 'orders', 'receipt', 'sales', 'wallet', 'withdraw', 'owing', 'customers', 'status', 'campaign', 'hours', 'delivery', 'messages', 'close', 'switch', 'test', 'call']);
  assert.ok(p.commands.length <= 30);
  for (const c of p.commands) { assert.match(c.command_name, /^[a-z0-9_]{1,32}$/); assert.ok(c.command_description.length <= 256); assert.doesNotMatch(c.command_description, /\p{Extended_Pictographic}/u); }
  assert.ok(p.prompts.length <= 4 && p.prompts.every(x => x.length <= 80));
    // Breaking a limit fails loudly.
  for (const bad of [{ command: 'Sales-Report', hint: 'x' }, { command: 'promo', hint: 'Big sale 🎉' }, { command: 'long', hint: 'x'.repeat(257) }]) {
    ACTIONS.push({ id: 'bad', ...bad, run: async () => null });
    assert.throws(() => commandsPayload(), /COMMANDS_INVALID/);
    ACTIONS.pop();
  }
  for (let i = 0; i < 11; i++) ACTIONS.push({ id: `x${i}`, command: `x${i}`, hint: 'x', run: async () => null });
  assert.throws(() => commandsPayload(), /31 commands \(WhatsApp allows 30\)/);
  ACTIONS.splice(ACTIONS.length - 11, 11);
});

test('commands: /sales, sales, "how much did I make today?", the menu row and the AI all give the same report', async () => {
  for (const t of ['/sales', 'Sales', 'How much did I make today?', '/SALES']) assert.equal(matchAction(t)?.action.id, 'sales', t);
  assert.equal(matchAction('/soldout pink crop top')?.arg, 'pink crop top');
  assert.equal(matchAction('receipt rly-abcde')?.arg, 'RLY-ABCDE');
  const ai = new Bot(fakeLLM(m => (m.includes('takings') ? { tool: 'salesToday', args: {} } : null)));
  const replies = [
    await ai.send('admin', { from: owner(), text: '/sales' }),
    await ai.send('admin', { from: owner(), text: 'sales' }),
    await ai.send('admin', { from: owner(), text: 'how much did I make today' }),
    await ai.send('admin', { from: owner(), choice: 'act:sales', text: 'Sales report' }),
    await ai.send('admin', { from: owner(), text: 'what are my takings looking like' }),
  ];
  for (const r of replies) {
    assert.match(r[0].text, /^📊 Sales for Business biz-a\nToday: /);
    assert.deepEqual(r[0].options, ['act:owing', 'act:orders', 'act:menu']);
  }
});

test('menu: "hi" opens it; too many rows for one list → sections, each its own list; things that don\'t apply are hidden', async () => {
  const bot = new Bot();
  const hi = await bot.send('admin', { from: owner(), text: 'hi' });
  assert.deepEqual(hi[0].options, ['menu:Shop', 'menu:Orders', 'menu:Money', 'menu:Customers', 'menu:Settings', 'menu:Help']);
  const settings = await bot.send('admin', { from: owner(), choice: 'menu:Settings', text: 'Settings' });
  assert.deepEqual(rows(settings[0]), ['act:hours', 'act:delivery', 'act:messages', 'act:policies', 'act:fee', 'act:close'], 'one shop: no Switch shop; not paused: no Reopen');
  assert.deepEqual(rows((await bot.send('admin', { from: owner(), choice: 'menu:Shop', text: 'Shop' }))[0]), ['act:add', 'act:products', 'act:soldout']);
  // A second shop brings Switch shop; pausing swaps Pause for Reopen.
  await addShop(db, fx.a.ownerPhone, fx.b.id, {});
  await switchShop(db, fx.a.ownerPhone, fx.a.id); // adding makes the new one active
  await db.update(db.doc('businesses', fx.a.id), { pausedUntil: 'open' });
  assert.deepEqual(rows((await bot.send('admin', { from: owner(), choice: 'menu:Settings', text: 'Settings' }))[0]), ['act:hours', 'act:delivery', 'act:messages', 'act:policies', 'act:fee', 'act:reopen', 'act:switch']);
  await db.update(db.doc('businesses', fx.a.id), { pausedUntil: null });
  // Unknown words: a short answer and the Menu, not a wall of help.
  const huh = await bot.send('admin', { from: owner(), text: 'blorp zzz' });
  assert.match(huh[0].text, /^Sorry, I didn't get that\./);
  assert.deepEqual(huh[0].options, ['act:menu', 'act:help']);
  const help = await bot.send('admin', { from: owner(), text: '/help' });
  assert.match(help[0].text, /^Tap \*Menu\* to see everything, or type \/ for the commands\./);
  assert.ok(help[0].text.length < 250, 'HELP is short: the MENU has the rest');
  assert.match(help[0].text, /restock Product biz-a 5/);
});

test('follow-ups: at most 3 buttons, and with three the last is Menu', () => {
  assert.deepEqual(followUps(undefined), [['act:menu', 'Menu']]);
  assert.deepEqual(followUps([['a', 'A']]), [['act:a', 'A'], ['act:menu', 'Menu']]);
  assert.deepEqual(followUps([['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D']]), [['act:a', 'A'], ['act:b', 'B'], ['act:menu', 'Menu']]);
  for (const a of ACTIONS) assert.ok(followUps(a.next).length <= 3 && followUps(a.next).every(([, t]) => t.length <= 20), a.id);
});

test('actions: sold out, receipt, add product with its follow-ups, pause stops checkout', async () => {
  const bot = new Bot();
  const pick = await bot.send('admin', { from: owner(), text: '/soldout' });
  assert.deepEqual(rows(pick[0]), [`act:soldout:${fx.a.product}`]);
  const done = await bot.send('admin', { from: owner(), choice: `act:soldout:${fx.a.product}`, text: 'Product biz-a' });
  assert.match(done[0].text, /✅ \*Product biz-a\* is marked sold out/);
  assert.deepEqual(done[0].options, ['act:soldout', 'act:products', 'act:menu']);
  assert.equal((await doc('products', fx.a.product)).stock, 0);
  await db.update(db.doc('products', fx.a.product), { stock: 10 });

  assert.match((await bot.send('admin', { from: owner(), text: '/receipt' }))[0].text, /No paid orders yet/);

  assert.match((await bot.send('admin', { from: owner(), text: '/add' }))[0].text, /Send the product's name and price/);
  const card = await bot.send('admin', { from: owner(), text: 'Zobo 500' });
  const id = card[0].options[0].slice(4);
  const saved = await bot.send('admin', { from: owner(), choice: `pok:${id}`, text: 'Looks right' });
  assert.deepEqual(saved[0].options, ['act:add', `act:photo:${id}`, 'act:menu'], 'Add another · Add photo · Menu');
  assert.match((await bot.send('admin', { from: owner(), choice: `act:photo:${id}`, text: 'Add photo' }))[0].text, /Send the photo of \*Zobo\*/);

  const ask = await bot.send('admin', { from: owner(), text: '/close' });
  assert.deepEqual(ask[0].options, ['act:close:1', 'act:close:3', 'act:close:open']);
  assert.match((await bot.send('admin', { from: owner(), choice: 'act:close:open', text: 'Until I reopen' }))[0].text, /Paused/);
  const shop = new Bot();
  await shop.send('shop', { from: '2348091300001', to: fx.a.pnid, choice: `buy:${fx.a.product}`, text: 'Add to cart' });
  assert.match((await shop.send('shop', { from: '2348091300001', to: fx.a.pnid, choice: 'checkout', text: 'Checkout' }))[0].text, /taking a short break[\s\S]*Your cart is saved/);
  assert.match((await bot.send('admin', { from: owner(), text: 'reopen' }))[0].text, /open for orders again/);
  assert.equal((await doc('businesses', fx.a.id)).pausedUntil, null);
});

test('ice breakers: "See how Relay works" explains before signup; "Talk to a person" reaches a person; "Open my menu" opens it', async () => {
  const bot = new Bot();
  const fresh = '2348035551212';
  const how = await bot.send('admin', { from: fresh, text: 'See how Relay works', name: 'Bayo' });
  assert.match(how[0].text, /^Relay runs your shop on your own WhatsApp number/);
  assert.deepEqual(how[0].options, ['ob:begin', 'ob:call']);
  assert.match((await bot.send('admin', { from: fresh, choice: 'ob:begin', text: 'Set up my shop', name: 'Bayo' }))[0].text, /^Welcome to Relay, Bayo[\s\S]*Step 1 of 6/);
  assert.match((await bot.send('admin', { from: '2348035551313', text: 'Talk to a person' }))[0].text, /A real person from Relay/);
  assert.deepEqual((await bot.send('admin', { from: owner(), text: 'Open my menu' }))[0].options[0], 'menu:Shop');
});

test('sync: the command list goes to the Admin Bot number; Meta errors are reported without the token', async () => {
  const { syncCommands } = await import('../src/services/automation');
  const calls: { url: string; body: any; auth: string }[] = [];
  const ok = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) }); return Response.json({ success: true }); }) as unknown as typeof fetch;
  assert.deepEqual(await syncCommands({ graphVersion: 'v21.0', phoneNumberId: '123', accessToken: 'secret-token' }, ok), { commands: 20, prompts: 4 });
  assert.equal(calls[0].url, 'https://graph.facebook.com/v21.0/123/conversational_automation');
  assert.equal(calls[0].body.commands[0].command_name, 'menu');
  assert.deepEqual(calls[0].body.prompts, ['Set up my shop', 'See how Relay works', 'Talk to a person', 'Open my menu']);
  const bad = (async () => Response.json({ error: { code: 100, message: 'Invalid parameter' } }, { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(syncCommands({ graphVersion: 'v21.0', phoneNumberId: '123', accessToken: 'secret-token' }, bad), (e: Error) => /META_SYNC_FAILED: 400 100 Invalid parameter/.test(e.message) && !e.message.includes('secret-token'));
});

test('test chat: the owner page carries the / commands and the ice breakers, and its script runs', async () => {
  const { api, testEnv } = await import('./helpers');
  const page = (await api('GET', '/dev/owner', { env: testEnv({ META_SEND_MODE: 'log' }) })).body as string;
  assert.match(page, /"commands":\[\{"name":"menu","hint":"Everything Relay can do for your shop, to tap"\}/);
  assert.match(page, /"iceBreakers":\["Set up my shop","See how Relay works","Talk to a person","Open my menu"\]/);
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)![1];
  assert.doesNotThrow(() => new Function(script));
});
