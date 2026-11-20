// Day 3 (MVP tracker M4): Relay learns from how the owner answers when they take over a chat.
import { Bot, clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import type { ConverseStep, LLMProvider } from '../src/services/ai';
import { scrub } from '../src/services/owner-examples';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, getConfig(env), { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
});

function listening() {
  const seen: string[] = [];
  const llm: LLMProvider & { seen: string[] } = {
    seen,
    async chooseTool() { return null; },
    async converse(input): Promise<ConverseStep> { seen.push(input.system); return { calls: [], text: 'We dey open till 9pm today 👍', usage: { inTokens: 10, outTokens: 5 } }; },
  };
  return llm;
}

test("learning: the owner's replies in a taken-over chat become examples", async () => {
  const bot = new Bot();
  const me = '2348077300001';
  const c = { from: me, to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'Do you deliver to Ikorodu? Call me on 0803 123 4567 or tolu@example.com' });
  // The owner answers from their own WhatsApp Business app, in two messages.
  await bot.send('echo', { ...c, text: 'Yes o! Ikorodu na ₦3,000, same day.' });
  await bot.send('echo', { ...c, text: 'Send your address 🙏' });
  assert.equal((await doc('conversations', `${fx.a.id}_wa_${me}`)).mode, 'owner', 'the owner took over');
  // A new question while the owner is handling the chat: the bot stays quiet, the owner answers.
  assert.equal((await bot.send('shop', { ...c, text: 'Ok. Una get small chops?' })).length, 0);
  await bot.send('echo', { ...c, text: 'Small chops dey, 10 pieces' });
  // An echo with no question before it in the last day teaches nothing.
  await db.set(db.doc('conversations', `${fx.a.id}_wa_2348077300009`), { id: `${fx.a.id}_wa_2348077300009`, businessId: fx.a.id, mode: 'bot' }, { merge: true });
  await bot.send('echo', { from: '2348077300009', to: fx.a.pnid, text: 'Hello, how can I help?' });

  const examples = (await doc('businesses', fx.a.id)).ownerExamples as { q: string; a: string; at: string }[];
  assert.deepEqual(examples.map(e => [e.q, e.a]), [
    ['Ok. Una get small chops?', 'Small chops dey, 10 pieces'],
    ['Do you deliver to Ikorodu? Call me on [number] or [email]', 'Yes o! Ikorodu na ₦3,000, same day. Send your address 🙏'],
  ]);
  assert.ok(!JSON.stringify(examples).includes(me), 'no customer number or id is stored with an example');
  assert.equal(scrub('acct 0123456789, +234 803 123 4567'), 'acct [number], [number]');
});

test("learning: the shop assistant is given the owner's examples, newest first, and never their customers' details", async () => {
  const llm = listening();
  const bot = new Bot(llm);
  const c = { from: '2348077300002', to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'hi' });
  await bot.send('shop', { ...c, text: 'my sister dey celebrate birthday, wetin you go advise make I buy for am?' });
  assert.ok(llm.seen.length >= 1, 'the assistant answered');
  const system = llm.seen[llm.seen.length - 1];
  assert.match(system, /How the owner answers customers \(newest first\)\. Follow their wording, tone and way of answering; prices, stock, delivery fees and payment details come only from the catalogue and tools/);
  const newer = system.indexOf('Q: Ok. Una get small chops?\nA: Small chops dey, 10 pieces');
  const older = system.indexOf('Q: Do you deliver to Ikorodu? Call me on [number] or [email]\nA: Yes o! Ikorodu na ₦3,000, same day. Send your address 🙏');
  assert.ok(newer > 0 && older > newer, 'newest first');
  for (const secret of ['0803 123 4567', 'tolu@example.com', '2348077300001']) assert.ok(!system.includes(secret), `never shows ${secret}`);
  // At most 8 examples are shown, the newest ones.
  const many = Array.from({ length: 12 }, (_, i) => ({ q: `question ${i}`, a: `answer ${i}`, at: new Date(Date.now() - i * 60_000).toISOString() }));
  await db.update(db.doc('businesses', fx.a.id), { ownerExamples: many });
  await bot.send('shop', { ...c, text: 'abeg e get anything wey fit small budget for party?' });
  const latest = llm.seen[llm.seen.length - 1];
  assert.ok(latest.includes('Q: question 0') && latest.includes('Q: question 7') && !latest.includes('Q: question 8'));
});
