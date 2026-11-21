// The signup assistant with a scripted model: chatty answers are read by the AI and saved through the
// same fixed steps (every check and read-back kept); questions get an answer and the same question
// again; prices the owner didn't write are refused; the AI down → the fixed step, as before.
import { Bot, clearFirestore, db, env } from './helpers';
import { getConfig } from '../src/config';
import { feeTerms } from '../src/services/orders';
import { amountsIn, signupTools, type SignupHelpers } from '../src/bots/signup-agent';
import type { AgentTurn, ConverseStep, LLMProvider } from '../src/services/ai';
import type { Business } from '../src/domain/business';
import type { Product } from '../src/domain/commerce';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

const cfg = getConfig(env);
type Step = { call: [string, Record<string, unknown>][] } | { say: string } | { fail: true };
function scripted() {
  const steps: Step[] = [];
  const seen: { system: string; turns: AgentTurn[]; tools: string[] }[] = [];
  const llm: LLMProvider & { steps: Step[]; seen: typeof seen } = {
    steps, seen,
    async chooseTool() { return null; },
    async converse(input): Promise<ConverseStep> {
      seen.push({ system: input.system, turns: [...input.turns], tools: input.tools.map(t => t.name) });
      const s = steps.shift();
      if (!s) return { calls: [], text: '', usage: { inTokens: 1, outTokens: 1 } };
      if ('fail' in s) throw new Error('GEMINI_FAILED: 429 quota');
      if ('say' in s) return { calls: [], text: s.say, usage: { inTokens: 100, outTokens: 20 } };
      return { calls: s.call.map(([name, args]) => ({ name, args })), text: '', usage: { inTokens: 100, outTokens: 10 } };
    },
  };
  return llm;
}

const opts = (m: { options: string[] }[]) => m.flatMap(x => x.options);
const texts = (m: { text: string }[]) => m.map(x => x.text).join('\n---\n');
const shopOf = async (phone: string) => (await db.query('businesses', [['ownerPhone', '==', `+${phone}`]]))[0] as unknown as Business;

// Short plain answers (the fixed steps) up to "Where's the shop, and when are you open?".
async function toPlace(bot: Bot, from: string) {
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Tayo' });
  await say('hi');
  await say('Ada Store');
  const card = await say('Gift box 5000');
  const pick = opts(card).find(id => id.startsWith('pcat:') && id !== 'pcat:new');
  if (pick) await say('Category', pick);
  return say("That's all", 'prod:done');
}

before(async () => { await clearFirestore(); });

test('signup assistant: "8 to 7 on weedays and 10 to 7 on saturday" plus the address → both saved, one message', async () => {
  const llm = scripted();
  const bot = new Bot(llm);
  const from = '2348035550101';
  assert.match(texts(await toPlace(bot, from)), /Where's the shop, and when are you open\?/);
  const week = { mon: '08:00-19:00', tue: '08:00-19:00', wed: '08:00-19:00', thu: '08:00-19:00', fri: '08:00-19:00', sat: '10:00-19:00', sun: 'unknown' };
  llm.steps.push({ call: [['setLocation', { street: '16 Atunrase Estate', area: 'Gbagada' }], ['setHours', week]] }, { say: '👍' });
  const r = await bot.send('admin', { from, text: 'we dey 16 atunrase estate gbagada, 8 to 7 on weedays and 10 to 7 on saturday' });
  assert.equal(r.length, 1, 'one message, not two');
  assert.match(r[0].text, /^✅ 16 Atunrase Estate, Gbagada, Lagos\n✅ Mon–Fri 8am–7pm · Sat 10am–7pm · Sun closed\n\nDo you deliver\?/);
  assert.doesNotMatch(r[0].text, /👍/, 'the AI\'s "👍" isn\'t sent on top of the next question');
  assert.ok(llm.seen[0].tools.includes('setHours') && llm.seen[0].tools.includes('setLocation') && !llm.seen[0].tools.includes('setShopName'), 'only the tools for this step');
  const shop = await shopOf(from);
  assert.deepEqual([shop.area, shop.hours?.sat, shop.hours?.sun], ['Gbagada', { open: '10:00', close: '19:00' }, null]);
});

test('signup assistant: a question mid-signup is answered, then the same question again', async () => {
  const llm = scripted();
  const bot = new Bot(llm);
  const from = '2348035550102';
  await bot.send('admin', { from, text: 'hi', name: 'Tayo' });
  const answer = `You only pay when you get paid: ${feeTerms(cfg)}.`;
  llm.steps.push({ say: answer });
  const r = await bot.send('admin', { from, text: 'how much does Relay charge?' });
  assert.equal(r.length, 1);
  assert.ok(r[0].text.startsWith(answer), r[0].text);
  assert.match(r[0].text, /What's your shop called\?/);
  assert.equal(await shopOf(from), undefined, 'no shop made from a question');
  // The AI out of quota: the question is still never taken as the shop's name.
  llm.steps.push({ fail: true });
  const down = await bot.send('admin', { from, text: 'how much una dey charge for this thing?' });
  assert.match(texts(down), /can't answer that right now[\s\S]*What's your shop called\?/);
  assert.equal(await shopOf(from), undefined);
});

test('signup assistant: Pidgin shop name; a price the owner never wrote is refused', async () => {
  const llm = scripted();
  const bot = new Bot(llm);
  const from = '2348035550103';
  await bot.send('admin', { from, text: 'hi', name: 'Tayo' });
  llm.steps.push({ call: [['setShopName', { name: 'Mama Tee Kitchen' }]] });
  const named = await bot.send('admin', { from, text: 'my shop name na Mama Tee Kitchen o' });
  assert.equal((await shopOf(from)).name, 'Mama Tee Kitchen');
  assert.match(texts(named), /menu|price list|product/i, 'on to products');

  llm.steps.push({ call: [['addProduct', { name: 'Jollof rice', price: 2500 }], ['addProduct', { name: 'Fried rice', price: 3000 }]] }, { say: 'How much is the fried rice?' });
  const r = await bot.send('admin', { from, text: 'I dey sell jollof rice and fried rice, jollof na 2.5k' });
  const products = (await db.query('products', [['businessId', '==', (await shopOf(from)).id]])) as unknown as Product[];
  assert.deepEqual(products.map(p => [p.name, p.priceKobo]), [['Jollof rice', 250_000]], 'only the price they wrote');
  const result = llm.seen[llm.seen.length - 1].turns.filter(t => t.role === 'result').map(t => JSON.stringify((t as { result: unknown }).result));
  assert.match(result.join(' '), /AMOUNT_NOT_IN_MESSAGE/, 'the model is told why');
  assert.match(texts(r), /Jollof rice/);
  assert.match(texts(r), /How much is the fried rice\?/, 'the AI\'s question about what it couldn\'t save is sent');
});

test('signup assistant: the AI down (quota) → the fixed step reads it, as before', async () => {
  const llm = scripted();
  const bot = new Bot(llm);
  const from = '2348035550104';
  await toPlace(bot, from);
  llm.steps.push({ fail: true });
  const r = await bot.send('admin', { from, text: 'we dey open 8am to 9pm every day of the week' });
  assert.equal(r[0].text, "✅ Every day 8am–9pm\n\nAnd where's the shop? e.g. *16 Atunrase Estate, Gbagada*");
});

test('signup assistant: short plain answers skip the AI; a button step offers the buttons as a choice', async () => {
  const llm = scripted();
  const bot = new Bot(llm);
  await toPlace(bot, '2348035550105');
  await bot.send('admin', { from: '2348035550105', text: 'Ikeja, Lagos · 8am-9pm', name: 'Tayo' });
  assert.equal(llm.seen.length, 0, 'plain answers like "Ada Store" and "Ikeja, Lagos · 8am-9pm" never called the model');
  const h = { step: 'fee_payer', message: 'make customers pay am', business: null, options: [{ id: 'fee:customer', title: 'My customers pay' }, { id: 'fee:owner', title: "I'll pay the fee" }] } as unknown as SignupHelpers;
  assert.deepEqual(signupTools(h).map(t => t.spec.name), ['pickOption', 'callMe']);
  assert.deepEqual(amountsIn('jollof na 2.5k, fried rice ₦3,000 and 1500 for small chops'), [2500, 3000, 1500]);
});

test('signup assistant: names, places and times must come from the owner, not from Relay\'s examples', async () => {
  const { fromOwner } = await import('../src/bots/signup-agent');
  const h = { heard: "I'll add photos later\nI'm in Lekki phase 1, Lagos. Admiralty way, opposite the Mega Chicken" };
  assert.throws(() => fromOwner(h, '12 Herbert Macaulay Way', 'PLACE'), /PLACE_NOT_FROM_OWNER/, 'the example address in the question');
  assert.throws(() => fromOwner(h, 'Yaba', 'PLACE'), /NOT_FROM_OWNER/);
  assert.equal(fromOwner(h, 'Admiralty Way', 'PLACE'), 'Admiralty Way');
  assert.equal(fromOwner(h, 'Lekki Phase 1', 'PLACE'), 'Lekki Phase 1');
  assert.equal(fromOwner({ heard: 'we dey for surulree' }, 'Surulere', 'PLACE'), 'Surulere', 'one letter off is fine');
  const { signupTools } = await import('../src/bots/signup-agent');
  const hours = signupTools({ step: 'hours', message: 'we open 9 to 5', heard: 'we open 9 to 5', business: null, setHours: async () => true } as unknown as SignupHelpers).find(t => t.spec.name === 'setHours')!;
  await assert.rejects(hours.run({ mon: '08:00-21:00' }, null), /TIMES_NOT_FROM_OWNER/);
  assert.ok(await hours.run({ mon: '09:00-17:00', sun: 'closed' }, null));
});

test('signup assistant: words at a question with buttons ("we close by 7 in the evening", "make my customers pay am") work like the tap', async () => {
  const llm = scripted();
  const bot = new Bot(llm);
  const from = '2348035550106';
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Tayo' });
  await toPlace(bot, from);
  const doubt = await say('Yaba · 8am to 7am');                                       // a doubtful time: [8am–7pm] [Overnight]
  assert.deepEqual(opts(doubt), ['hrv:alt', 'hrv:night']);
  // A sentence at the buttons goes to the AI, which taps the one meant.
  llm.steps.push({ call: [['pickOption', { option: '8am–7pm' }]] });
  const next = await say('no o, we close by 7 in the evening');
  assert.ok(llm.seen.at(-1)!.tools.includes('pickOption'));
  assert.match(llm.seen.at(-1)!.system, /Buttons on screen[^\n]*"8am–7pm"/);
  assert.match(texts(next), /✅ Every day 8am–7pm[\s\S]*Do you deliver\?/);
  // A button's own words stay instant (no AI).
  const before = llm.seen.length;
  const fee = await say('Pickup only');
  assert.equal(llm.seen.length, before);
  assert.match(texts(fee), /Last thing:/);
  // Who pays, in words.
  llm.steps.push({ call: [['pickOption', { option: 'Customers pay' }]] });
  const ready = await say('make my customers pay am abeg');
  assert.match(texts(ready), /is ready/);
  assert.equal((await shopOf(from)).feePayer, 'customer');
});
