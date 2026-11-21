// Live check of the signup assistant: whole signups written the way real owners write (Pidgin, typos,
// questions, several things at once), with the real AI (Groq first, then Gemini, like the app),
// against the test database. The owner answers whatever question signup is on, from a list per step,
// and every exchange is printed. Run with the 8181 test emulator up:
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 TEST_PROJECT_ID=demo-relay-eval npx tsx scripts/eval-signup.ts [--only food] [--pace 6000] [--only-gemini]
// The keys come from api/.dev.vars and are never printed.
import fs from 'node:fs';
import path from 'node:path';
import { geminiProvider } from '../src/services/ai';
import { chainProviders, groqProvider } from '../src/services/ai-openai';
import { Bot, clearFirestore, doc, env } from '../test/helpers';
import { getConfig } from '../src/config';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const file = path.join(__dirname, '..', '.dev.vars');
const vars: Record<string, string> = Object.fromEntries((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split(/\r?\n/).map(l => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map(m => [m![1], m![2].replace(/^"|"$/g, '')]));

// What the owner says at each signup step, in order (a step asked again takes the next one).
// "tap:<id>" taps a button. Signup is done at the messages offer / fee payer.
type Script = { name: string; answers: Record<string, string[]> };
const SIGNUPS: Record<string, Script> = {
  food: { name: 'Tola', answers: {
    shop_name: ['how much una dey charge for this thing?', 'my shop name na Mama Tee Kitchen, we dey sell food for Surulere'],
    products: ['jollof rice 2500, fried rice na 3k, peppered chicken 1500 and zobo 500', 'na everything be that for now'],
    preview: ['e correct, everything good'],
    type: ['na food we dey sell'],
    photos: ['I go add pictures later, we dey for 15 Adeniran Ogunsanya street Surulere Lagos, near the shoprite'],
    city: ['15 Adeniran Ogunsanya street, Surulere, Lagos'], area: ['Surulere'], street: ['15 Adeniran Ogunsanya street'],
    location_confirm: ['yes na there'],
    hours: ['8 to 7 on weedays and 10 to 7 on saturday'],
    hours_review: ['sunday we no dey open', 'e correct', 'yes'],
    hours_same: ['no, saturday na 10 to 7 and sunday we close'],
    prep: ['e dey take like 40 minutes'], prep_custom: ['40 minutes'],
    delivery: ['we dey deliver and people fit come pick up too'],
    fee_local: ['delivery for surulere na 1500'],
    fee_city: ['for other parts of lagos na 3500'],
    interstate: ['no we no dey send outside lagos'],
    policies: ['use the one wey you write'],
  } },
  fashion: { name: 'Chioma', answers: {
    shop_name: ["Hello! I'm Chioma and my store is called Chi Luxe Closet, I sell ladies bags and shoes"],
    products: ['Can I add my products later? I have like 200 items', 'ok let me add two now. Leather tote bag 18,000 and block heel sandals 12.5k', "that's all for now thanks"],
    preview: ['looks good!'],
    type: ['fashion, bags and shoes'],
    photos: ["I'll add photos later"],
    city: ["I'm in Lekki phase 1, Lagos. Admiralty way, opposite the Mega Chicken"], area: ['Lekki Phase 1'], street: ['Admiralty Way'],
    location_confirm: ['correct'],
    hours: ['monday to saturday 10am till 8pm, closed on sundays'],
    hours_review: ['yes thats right'], hours_same: ['no, closed on sundays'],
    delivery: ['only delivery, no pickup'],
    fee_local: ['3000 within lekki'],
    fee_city: ['5000 for the rest of lagos'],
    interstate: ['yes, I send to other states. I quote per order because it depends on the place'],
    interstate_pricing: ['I quote per order'],
    policies: ['no returns after 3 days, exchanges only, no refunds'],
    policies_edit: ['no returns after 3 days, exchanges only, no refunds'],
  } },
};
const DONE_STEPS = ['msg_offer', 'fee_payer', 'ready'];

async function main() {
  if (!vars.GEMINI_API_KEY && !vars.GROQ_API_KEY) throw new Error('Set GROQ_API_KEY or GEMINI_API_KEY in api/.dev.vars.');
  const gemini = geminiProvider({ GEMINI_API_KEY: vars.GEMINI_API_KEY, GEMINI_MODEL: arg('model') ?? vars.GEMINI_MODEL ?? 'gemini-3.7-flash', GEMINI_FALLBACK_MODEL: vars.GEMINI_FALLBACK_MODEL ?? 'gemini-flash-latest,gemini-3.1-flash-lite' });
  const groq = process.argv.includes('--only-gemini') ? null : groqProvider({ GROQ_API_KEY: vars.GROQ_API_KEY, GROQ_MODEL: vars.GROQ_MODEL ?? 'openai/gpt-oss-120b', GROQ_FALLBACK_MODEL: vars.GROQ_FALLBACK_MODEL ?? 'openai/gpt-oss-20b' });
  const llm = chainProviders([groq, gemini]);
  console.log(groq ? 'AI: Groq first, then Gemini' : 'AI: Gemini only');
  Object.assign(getConfig(env), { SIGNUP_AGENT_TIMEOUT_MS: 20_000 }); // free tiers are slow at times
  const pace = Number(arg('pace') ?? 6000);
  const only = arg('only')?.split(',');
  await clearFirestore();
  let n = 0;
  for (const [key, script] of Object.entries(SIGNUPS).filter(([k]) => !only || only.includes(k))) {
    console.log(`\n════════ ${key} ════════`);
    const bot = new Bot(llm);
    const from = `234803777${String(++n).padStart(4, '0')}`;
    const left = Object.fromEntries(Object.entries(script.answers).map(([s, a]) => [s, [...a]]));
    const say = async (text: string, step: string) => {
      const tap = text.startsWith('tap:') ? text.slice(4) : undefined;
      const t0 = Date.now();
      const replies = await bot.send('admin', { from, text: tap ? '' : text, choice: tap, name: script.name });
      console.log(`\n[${step}] 👤 ${text}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      for (const m of replies) console.log(`🤖 ${m.text.replace(/\n/g, '\n   ')}${m.options.length ? `\n   [${m.options.join(' | ')}]` : ''}`);
    };
    await say('hi', 'start');
    for (let turn = 0; turn < 40; turn++) {
      const conv = await doc('conversations', `admin_${from}`);
      const step = String((conv?.onboarding as { step?: string } | undefined)?.step ?? 'shop_name');
      if (DONE_STEPS.includes(step)) { console.log(`\n✅ ${key}: signup reached "${step}" in ${turn + 1} messages`); break; }
      const next = left[step]?.shift();
      if (!next) { console.log(`\n⛔ ${key}: stuck on "${step}" (no more answers for it)`); break; }
      if (pace) await new Promise(r => setTimeout(r, pace)); // free tiers allow only so many requests a minute
      await say(next, step);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
