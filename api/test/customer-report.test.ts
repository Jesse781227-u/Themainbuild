// Fixes from a customer test run (20 Nov): the shop must still work well when the AI is down.
import { Bot, clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { geminiProvider, modelsResting, resetBreaker, type ConverseStep, type LLMProvider } from '../src/services/ai';
import { resolveDelivery } from '../src/services/delivery';
import { createApp } from '../src/app';
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
let n = 0;
const phone = () => `2348077500${String(++n).padStart(3, '0')}`;
const iso = () => new Date().toISOString();
const product = (id: string, name: string, kobo: number, extra: Record<string, unknown> = {}) =>
  db.set(db.doc('products', id), { id, businessId: fx.a.id, name, description: '', priceKobo: kobo, images: [], categoryId: null, available: true, stock: 20, lowStockThreshold: 2, createdAt: iso(), updatedAt: iso(), deletedAt: null, ...extra });
const zone = (id: string, name: string, match: string, kobo: number) =>
  db.set(db.doc('deliveryZones', `${fx.a.id}_${id}`), { id: `${fx.a.id}_${id}`, businessId: fx.a.id, name, match, feeKobo: kobo, timeframe: 'Same day', active: true });

before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, getConfig(env), { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
  await db.update(db.doc('businesses', fx.a.id), { category: 'food_beverage', fulfilment: 'delivery', suggestions: false, feePayer: 'customer' });
  await product('fried-rice', 'Fried Rice', 350_000);
  await product('fried-plantain', 'Fried Plantain', 150_000);
  await product('jollof', 'Jollof Rice', 300_000);
  await product('ofada', 'Ofada Rice & Ayamase', 450_000);
  await product('zobo', 'Zobo', 80_000);
  await zone('gb2', 'Gbagada Phase 2', 'gbagada phase 2', 150_000);
  await zone('gb1', 'Gbagada Phase 1', 'gbagada phase 1', 120_000);
  await zone('ikeja', 'Ikeja GRA', 'ikeja', 250_000);
  await zone('any', 'Elsewhere in Lagos', '', 500_000);
});
beforeEach(() => resetBreaker());

test('report: when every model keeps failing, calls stop for a minute instead of waiting out each timeout', async () => {
  let calls = 0;
  const llm = geminiProvider({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'm1', GEMINI_FALLBACK_MODEL: 'm2' }, (async () => { calls++; return new Response('busy', { status: 503 }); }) as typeof fetch)!;
  const turn = () => llm.converse!({ system: 's', turns: [{ role: 'user', text: 'hi' }], tools: [], mode: 'text', timeoutMs: 5000 });
  await assert.rejects(turn());
  await assert.rejects(turn());
  assert.ok(modelsResting(), 'resting after two full failures');
  const before = calls;
  const t0 = Date.now();
  await assert.rejects(turn(), /resting/);
  assert.equal(calls, before, 'no call while resting');
  assert.ok(Date.now() - t0 < 100, 'fails at once');
  // Out of quota on every model (Google's RetryInfo): no call at all.
  resetBreaker();
  let q = 0;
  const quota = geminiProvider({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'q1', GEMINI_FALLBACK_MODEL: 'q2' }, (async () => { q++; return new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3600s' }] } }), { status: 429 }); }) as typeof fetch)!;
  await assert.rejects(quota.converse!({ system: 's', turns: [{ role: 'user', text: 'hi' }], tools: [], mode: 'text', timeoutMs: 5000 }));
  const used = q;
  await assert.rejects(quota.converse!({ system: 's', turns: [{ role: 'user', text: 'hi' }], tools: [], mode: 'text', timeoutMs: 5000 }), /out of quota|resting/);
  assert.equal(q, used, 'known out of quota: not called again');
  resetBreaker();
});

test('report: checkout the assistant started is not lost when the model fails on the next step', async () => {
  const steps: (ConverseStep | Error)[] = [{ calls: [{ name: 'goToCheckout', args: { deliverTo: '12 Olawale Street, Gbagada Phase 2' } }], text: '', usage: { inTokens: 1, outTokens: 1 } }, new Error('GEMINI_FAILED: 429')];
  const llm: LLMProvider = { async chooseTool() { return null; }, async converse() { const s = steps.shift(); if (!s || s instanceof Error) throw s ?? new Error('done'); return s; } };
  const bot = new Bot(llm);
  const c = { from: phone(), to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'hi' });
  await bot.send('shop', { ...c, choice: 'add:jollof', text: 'Add to cart' });
  const out = await bot.send('shop', { ...c, text: 'deliver am to 12 Olawale Street, Gbagada Phase 2 abeg' });
  const all = out.map(m => m.text).join('\n');
  assert.match(all, /Please confirm your order/);
  assert.match(all, /Gbagada Phase 2/);
  assert.match(all, /₦1,500/, "Gbagada Phase 2's price, not the 'elsewhere' one");
});

test('report: without the AI, "how much be the fried rice?" gets the price, not an echo of the question', async () => {
  const bot = new Bot();
  const c = { from: phone(), to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'hi' });
  for (const t of ['abeg how much be the fried rice?', 'how much is fried rice', 'price of fried rice pls']) {
    const [m] = await bot.send('shop', { ...c, text: t });
    assert.match(m.text, /^\*Fried Rice\* (is|na) ₦3,500\./, t);
    assert.deepEqual(m.options, ['add:fried-rice', 'menu'], t);
  }
  const [many] = await bot.send('shop', { ...c, text: 'how much is your rice' });
  assert.ok(!JSON.stringify(many.content).includes('Results for'), 'never echoes the question as a title');
});

test('report: asking to add to, cancel or re-address an order goes to the owner, with the request', async () => {
  const bot = new Bot();
  for (const t of ['pls add one zobo to my order', 'cancel my order', 'change address to Ifako']) {
    const c = { from: phone(), to: fx.a.pnid };
    await bot.send('shop', { ...c, text: 'hi' });
    const [m] = await bot.send('shop', { ...c, text: t });
    assert.match(m.text, /I can't change an order here, so I've passed this to Business biz-a/, t);
    const told = (await db.query('outbox', [['businessId', '==', fx.a.id], ['kind', '==', 'handover']])).map(x => String(x.text));
    assert.ok(told.some(x => x.includes(`wants to change their order: "${t}"`)), `owner told: ${t}`);
  }
  const c = { from: phone(), to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'hi' });
  assert.match((await bot.send('shop', { ...c, text: 'where is my order?' }))[0].text, /don't have any orders/, 'tracking still works');
});

test('report: "gbagada" offers its areas; one clear area is used; "anywhere else" never beats a named area', async () => {
  const r = await resolveDelivery(db, fx.a.id, 'gbagada');
  assert.ok(r && 'choices' in r);
  assert.deepEqual(r.choices.map(z => z.name), ['Gbagada Phase 1', 'Gbagada Phase 2']);
  const one = await resolveDelivery(db, fx.a.id, '5 Isaac John Street, Ikeja');
  assert.ok(one && 'quote' in one && one.quote.feeKobo === 250_000);
  const other = await resolveDelivery(db, fx.a.id, 'Ajah');
  assert.ok(other && 'quote' in other && other.quote.feeKobo === 500_000, 'elsewhere: the catch-all');

  const bot = new Bot();
  const c = { from: phone(), to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'hi' });
  await bot.send('shop', { ...c, choice: 'add:jollof', text: 'Add to cart' });
  await bot.send('shop', { ...c, choice: 'checkout', text: 'Checkout' });
  const [pick] = await bot.send('shop', { ...c, text: 'Gbagada' });
  assert.deepEqual(pick.options, [`zone:${fx.a.id}_gb1`, `zone:${fx.a.id}_gb2`]);
  const [confirm] = await bot.send('shop', { ...c, choice: `zone:${fx.a.id}_gb2`, text: 'Gbagada Phase 2' });
  assert.match(confirm.text, /Please confirm your order/);
  assert.match(confirm.text, /Gbagada \(Gbagada Phase 2\)/);
});

test('report: "where do you deliver?" with many areas asks theirs; the answer gets its price', async () => {
  for (let i = 0; i < 12; i++) await zone(`x${i}`, `Area ${String.fromCharCode(65 + i)}`, `area${String.fromCharCode(97 + i)}`, 200_000 + i * 10_000);
  const bot = new Bot();
  const c = { from: phone(), to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'hi' });
  const [ask] = await bot.send('shop', { ...c, text: 'do you deliver?' });
  assert.match(ask.text, /^We deliver to 16 areas, from ₦1,200 to ₦5,000\. Which area are you in\?/);
  const [price] = await bot.send('shop', { ...c, text: 'Ikeja' });
  assert.match(price.text, /^Delivery to \*Ikeja GRA\* is ₦2,500\./);
});

test('report: the service fee shows in the cart; the pay page shows the address and a way back to WhatsApp', async () => {
  const bot = new Bot();
  const c = { from: phone(), to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'hi' });
  const added = await bot.send('shop', { ...c, choice: 'add:fried-rice', text: 'Add to cart' });
  assert.match(added.at(-1)!.text, /Subtotal: ₦3,500\nService fee: ₦35/);
  await bot.send('shop', { ...c, choice: 'checkout', text: 'Checkout' });
  await bot.send('shop', { ...c, text: 'Ikeja GRA, 5 Isaac John' });
  const placed = await bot.send('shop', { ...c, choice: 'confirm', text: 'Confirm order' });
  const all = placed.map(m => JSON.stringify(m.content)).join(' ');
  assert.ok(!/order is confirmed/i.test(all), 'not "confirmed" before payment');
  assert.match(all, /placed/);
  const token = /\/pay\/([A-Za-z0-9_-]+)/.exec(all)![1];
  const page = await (await createApp().request(`/pay/${token}`, {}, env)).text();
  assert.match(page, /Deliver to<\/span><span[^>]*>Ikeja GRA, 5 Isaac John/);
  await createApp().request(`/pay/${token}`, { method: 'POST' }, env);
  assert.match(await (await createApp().request(`/pay/${token}`, {}, env)).text(), /href="https:\/\/wa\.me\/[0-9]*">Back to WhatsApp/);
});

test('report: "Upgrade to this" swaps the item in the cart instead of adding a second one', async () => {
  const bot = new Bot();
  const c = { from: phone(), to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'hi' });
  await bot.send('shop', { ...c, choice: 'add:jollof', text: 'Add to cart' });
  await bot.send('shop', { ...c, choice: 'add:jollof', text: 'Add to cart' });
  const out = await bot.send('shop', { ...c, choice: 'swap:jollof:ofada', text: 'Upgrade to this' });
  assert.match(out[0].text, /Upgraded to 2 × Ofada Rice & Ayamase/);
  const cart = await doc('carts', `${fx.a.id}_wa_${c.from}`);
  assert.deepEqual(cart.items.map((i: { productId: string; qty: number }) => [i.productId, i.qty]), [['ofada', 2]]);
});
