// Live check of the signup assistant: whole signups written the way real owners write (Pidgin, typos,
// questions, several things at once), with the real Gemini model, against the test database. Prints
// every exchange and whether the AI or the fixed step answered. Run with the 8181 test emulator up:
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 TEST_PROJECT_ID=demo-relay-eval npx tsx scripts/eval-signup.ts [--only food] [--pace 4000]
// The key comes from api/.dev.vars and is never printed.
import fs from 'node:fs';
import path from 'node:path';
import { geminiProvider } from '../src/services/ai';
import { Bot, clearFirestore, env } from '../test/helpers';
import { getConfig } from '../src/config';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const file = path.join(__dirname, '..', '.dev.vars');
const vars: Record<string, string> = Object.fromEntries((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split(/\r?\n/).map(l => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map(m => [m![1], m![2].replace(/^"|"$/g, '')]));

// [what the owner writes, the button they tap instead (optional)].
type Say = [string, string?];
const SIGNUPS: Record<string, Say[]> = {
  food: [
    ['hi'],
    ['how much una dey charge for this thing?'],
    ['my shop name na Mama Tee Kitchen, we dey sell food for Surulere'],
    ['jollof rice 2500, fried rice na 3k, peppered chicken 1500 and zobo 500'],
    ['na everything be that for now'],
    ['e correct, everything good'],
    ['we dey for 15 Adeniran Ogunsanya street Surulere Lagos, near the shoprite'],
    ['yes na there'],
    ['8 to 7 on weedays and 10 to 7 on saturday'],
    ['sunday we no dey open'],
    ['e correct'],
    ['e dey take like 40 minutes'],
    ['we dey deliver and people fit come pick up too'],
    ['delivery for surulere na 1500'],
    ['for other parts of lagos na 3500'],
    ['no we no dey send outside lagos'],
    ['use the one wey you write'],
  ],
  fashion: [
    ['hi'],
    ["Hello! I'm Chioma and my store is called Chi Luxe Closet, I sell ladies bags and shoes"],
    ['Can I add my products later? I have like 200 items'],
    ['ok let me add two now. Leather tote bag 18,000 and block heel sandals 12.5k'],
    ["that's all for now thanks"],
    ['looks good!'],
    ["I'm in Lekki phase 1, Lagos. Admiralty way, opposite the Mega Chicken"],
    ['correct'],
    ['monday to saturday 10am till 8pm, closed on sundays'],
    ['yes thats right'],
    ['only delivery, no pickup'],
    ['3000 within lekki'],
    ['5000 for the rest of lagos'],
    ['yes, I send to other states. I quote per order because it depends on the place'],
    ['no returns after 3 days, exchanges only, no refunds'],
  ],
};

async function main() {
  if (!vars.GEMINI_API_KEY) throw new Error('Set GEMINI_API_KEY in api/.dev.vars.');
  const llm = geminiProvider({ GEMINI_API_KEY: vars.GEMINI_API_KEY, GEMINI_MODEL: arg('model') ?? vars.GEMINI_MODEL ?? 'gemini-3.7-flash', GEMINI_FALLBACK_MODEL: vars.GEMINI_FALLBACK_MODEL ?? 'gemini-flash-latest,gemini-3.1-flash-lite' });
  Object.assign(getConfig(env), { SIGNUP_AGENT_TIMEOUT_MS: 20_000 }); // the free tier is slow at times
  const pace = Number(arg('pace') ?? 4000);
  const only = arg('only')?.split(',');
  await clearFirestore();
  let n = 0;
  for (const [name, turns] of Object.entries(SIGNUPS).filter(([k]) => !only || only.includes(k))) {
    console.log(`\n════════ ${name} ════════`);
    const bot = new Bot(llm);
    const from = `234803777${String(++n).padStart(4, '0')}`;
    for (const [text, choice] of turns) {
      if (pace) await new Promise(r => setTimeout(r, pace)); // the free tier allows only a few requests a minute
      const t0 = Date.now();
      const replies = await bot.send('admin', { from, text, choice, name: name === 'food' ? 'Tola' : 'Chioma' });
      console.log(`\n👤 ${text}${choice ? `  [tap ${choice}]` : ''}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      for (const m of replies) console.log(`🤖 ${m.text.replace(/\n/g, '\n   ')}${m.options.length ? `\n   [${m.options.join(' | ')}]` : ''}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
