// npm run eval:conversation [-- --only <id,id> --model <name> --pace <ms between messages, default 4000>]
// Runs the Shop Bot agent over the conversation fixtures (scripts/eval/fixtures.ts) against the real
// Gemini model, on an in-memory pretend shop (nothing is saved anywhere). Reports the pass rate, the
// time per message and the estimated cost. The key comes from api/.dev.vars; it's never printed.
import fs from 'node:fs';
import path from 'node:path';
import { geminiProvider } from '../src/services/ai';
import { isFail, runAgent } from '../src/bots/agent';
import { remember, type AgentMemory } from '../src/bots/agent-memory';
import { costKobo } from '../src/bots/agent-stats';
import { shopContext, shopSystem, shopTools } from '../src/bots/shop-agent';
import { FIXTURES } from './eval/fixtures';
import { fakeHelpers } from './eval/fake-shop';
import { judge } from './eval/judge';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const vars: Record<string, string> = { ...Object.fromEntries((fs.existsSync(path.join(__dirname, '..', '.dev.vars')) ? fs.readFileSync(path.join(__dirname, '..', '.dev.vars'), 'utf8') : '').split(/\r?\n/).map(l => /^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map(m => [m[1], m[2]])), ...process.env as Record<string, string> };

async function main() {
  if (!vars.GEMINI_API_KEY) throw new Error('Set GEMINI_API_KEY (environment or api/.dev.vars).');
  const model = arg('model');
  const llm = geminiProvider({ GEMINI_API_KEY: vars.GEMINI_API_KEY, GEMINI_MODEL: model ?? vars.GEMINI_MODEL ?? 'gemini-3.7-flash', GEMINI_FALLBACK_MODEL: model ? '' : vars.GEMINI_FALLBACK_MODEL ?? 'gemini-flash-latest,gemini-3.1-flash-lite' });
  const only = arg('only')?.split(',');
  const fixtures = FIXTURES.filter(f => !only || only.includes(f.id));
  const pace = Number(arg('pace') ?? 4000);
  const times: number[] = [];
  let turns = 0, passed = 0, inTok = 0, outTok = 0, fallbacks = 0;
  const failures: string[] = [];
  for (const fx of fixtures) {
    const { h, rec, sent } = fakeHelpers(fx.shop, { first: fx.first, pastOrder: fx.pastOrder, savedAddress: fx.savedAddress });
    let memory: AgentMemory = { turns: [], summary: null };
    for (const [i, t] of fx.turns.entries()) {
      turns++;
      if (turns > 1 && pace) await new Promise(res => setTimeout(res, pace)); // the free tier allows ~15 requests a minute
      const before = sent.length;
      const r = await runAgent({ llm, system: shopSystem(h), context: shopContext(h, await h.cart()), memory, message: t.say, tools: shopTools(h), c: null, maxSteps: 4, timeoutMs: 15_000 });
      times.push(r.usage.ms); inTok += r.usage.inTokens; outTok += r.usage.outTokens;
      let reply = '';
      if (isFail(r)) fallbacks++;
      else { if (r.finish) await r.finish(r.text); else sent.push(r.text); reply = sent.slice(before).join('\n'); memory = remember(memory, t.say, r.text, r.calls.map(c => c.name)); }
      const called = r.calls.filter(c => c.ok).map(c => c.name);
      if (process.argv.includes('--verbose')) console.log(`
[${fx.id}#${i + 1}] ${t.say}
  calls: ${r.calls.map(c => `${c.name}${JSON.stringify(c.args)}`).join(' → ') || 'none'}
  cart: ${JSON.stringify(Object.fromEntries(rec.cart))}
  reply: ${isFail(r) ? `(fell back: ${r.failed})` : r.text}`);
      const problems = judge(t, { called, reply, rec, failed: isFail(r) ? `${r.failed}${r.detail ? `: ${r.detail.slice(0, 200)}` : ''}` : null });
      if (problems.length) failures.push(`✗ ${fx.id}#${i + 1} "${t.say.slice(0, 50)}" → ${problems.join('; ')} | tools: ${called.join(',') || 'none'} | reply: ${reply.replace(/\s+/g, ' ').slice(0, 140)}`);
      else passed++;
      process.stdout.write(problems.length ? '✗' : '·');
    }
  }
  times.sort((a, b) => a - b);
  const cost = costKobo({ GEMINI_IN_USD_PER_M: 0.3, GEMINI_OUT_USD_PER_M: 2.5, NGN_PER_USD: 1600 }, { inTokens: inTok, outTokens: outTok });
  console.log(`\n\n${failures.join('\n')}\n`);
  console.log(`Passed ${passed}/${turns} messages (${Math.round((passed / Math.max(1, turns)) * 100)}%) across ${fixtures.length} conversations; ${fallbacks} fell back.`);
  console.log(`Time per message: median ${times[Math.floor(times.length / 2)] ?? 0} ms, 90th percentile ${times[Math.floor(times.length * 0.9)] ?? 0} ms.`);
  console.log(`Cost: about ₦${(cost / 100 / Math.max(1, turns)).toFixed(2)} per message (${inTok} + ${outTok} tokens in all).`);
}


main().catch(e => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); });
