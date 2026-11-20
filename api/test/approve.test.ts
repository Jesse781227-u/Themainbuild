// Day 4 (MVP tracker M5): a waiting change is approved by a tap, the owner's own words, or a voice note.
import { ADMIN_PNID, Bot, clearFirestore, db, doc, env, postMeta, queueMessage, seed } from './helpers';
import { handleQueueBatch } from '../src/services/queue';
import { NO, YES } from '../src/bots/common';
import type { ConverseStep, LLMProvider } from '../src/services/ai';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
let owner: string;
const ZOBO = 'prod-zobo';
before(async () => {
  await clearFirestore();
  fx = await seed();
  owner = fx.a.ownerPhone.slice(1);
  const now = new Date().toISOString();
  await db.set(db.doc('products', ZOBO), { id: ZOBO, businessId: fx.a.id, name: 'Zobo', description: '', priceKobo: 100_000, images: [], categoryId: null, available: true, stock: 20, lowStockThreshold: 2, createdAt: now, updatedAt: now, deletedAt: null });
});

// The owner's assistant asks to change Zobo's price each time it's asked.
function priceAsker(prices: string[]) {
  const steps: ConverseStep[] = prices.flatMap(p => [
    { calls: [{ name: 'setPrice', args: { product: 'Zobo', price: p } }], text: '', usage: { inTokens: 10, outTokens: 5 } },
    { calls: [], text: `I can change *Zobo* to ₦${Number(p).toLocaleString('en-NG')}.`, usage: { inTokens: 10, outTokens: 5 } },
  ]);
  const llm: LLMProvider = { async chooseTool() { return null; }, async converse() { return steps.shift() ?? { calls: [], text: 'OK', usage: { inTokens: 1, outTokens: 1 } }; } };
  return llm;
}
const price = async () => (await doc('products', ZOBO)).priceKobo;

test('approve: "yes go ahead", "oya do am" or a voice note confirm a waiting change; "leave it" cancels', async () => {
  const bot = new Bot(priceAsker(['1200', '1500', '1800', '2000', '2500']));
  const ask = async (text: string) => { const out = await bot.send('admin', { from: owner, text }); assert.deepEqual(out[0].options, ['yes', 'no'], `"${text}" waits for a yes`); };

  await ask('abeg make zobo 1200 from today');
  assert.equal(await price(), 100_000, 'nothing changes before the yes');
  const yes = await bot.send('admin', { from: owner, text: 'Yes go ahead' });
  assert.match(yes[0].text, /Zobo is now ₦1,200/);
  assert.equal(await price(), 120_000);

  await ask('make zobo 1500 abeg, prices don go up');
  await bot.send('admin', { from: owner, text: 'oya do am' });
  assert.equal(await price(), 150_000);

  // A voice note: "Uh, okay, go on." written out by the transcriber.
  await ask('change the zobo price to 1800 for me please');
  await postMeta({ object: 'whatsapp_business_account', entry: [{ id: 'waba-admin', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '000', phone_number_id: ADMIN_PNID }, contacts: [{ wa_id: owner, profile: { name: 'Owner' } }], messages: [{ from: owner, id: 'wamid.voice-yes', timestamp: String(Math.floor(Date.now() / 1000)), type: 'audio', audio: { id: 'media-voice-yes', mime_type: 'audio/ogg; codecs=opus', voice: true } }] } }] }] });
  const media = (async (url: string) => (String(url).includes('media-voice-yes') ? Response.json({ url: 'https://media.test/v.ogg', mime_type: 'audio/ogg' }) : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/ogg' } }))) as typeof fetch;
  await handleQueueBatch({ queue: 'test', messages: env.EVENTS.sent.splice(0).map(j => queueMessage(j)) }, env, { transport: bot.transport, llm: null, transcriber: { async transcribe() { return 'Uh, okay, go on.'; } }, fetch: media });
  assert.equal(await price(), 180_000, 'the voice note approved it');

  await ask('set zobo to 2000 naira from tomorrow');
  const no = await bot.send('admin', { from: owner, text: 'leave it' });
  assert.match(no[0].text, /cancel/i);
  assert.equal(await price(), 180_000, '"leave it" changed nothing');

  await ask('abeg zobo price make e be 2500 now');
  await bot.send('admin', { from: owner, text: 'no wahala' });
  assert.equal(await price(), 250_000, '"no wahala" is a yes');

  // Words that only look like an answer are neither.
  for (const t of ['yesterday', 'okra', 'nothing', 'north side']) assert.ok(!YES.test(t) && !NO.test(t), t);
  for (const t of ['👍', 'Yes, change it.', 'abeg no', 'make e be', 'forget it']) assert.ok(YES.test(t) !== NO.test(t), t);
});
