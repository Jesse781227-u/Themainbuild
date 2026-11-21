// The Groq connector (OpenAI chat format) and the provider chain, with a pretend server: tool calls
// and their results keep matching ids, a rate-limited model is skipped, and when Groq can't answer
// (rate limited, or a photo) the next provider does.
import { chainProviders, groqProvider, resetOpenAiSkips, retryAfterMs, toMessages } from '../src/services/ai-openai';
import type { LLMProvider } from '../src/services/ai';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const cfg = { GROQ_API_KEY: 'gsk_test', GROQ_MODEL: 'openai/gpt-oss-120b', GROQ_FALLBACK_MODEL: 'llama-3.3-70b-versatile' };
type Req = { model: string; body: Record<string, unknown> };
function server(answers: (Response | ((r: Req) => Response))[]) {
  const seen: Req[] = [];
  const doFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const r = { model: String(body.model), body };
    seen.push(r);
    const a = answers.shift();
    if (!a) throw new Error('no more answers');
    return typeof a === 'function' ? a(r) : a;
  }) as unknown as typeof fetch;
  return { seen, doFetch };
}
const ok = (message: Record<string, unknown>) => new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 120, completion_tokens: 15 } }), { status: 200 });
const limited = (retry = '20') => new Response(JSON.stringify({ error: { message: 'Rate limit reached for model on tokens per minute (TPM)' } }), { status: 429, headers: { 'retry-after': retry } });
const tools = [{ name: 'setHours', description: 'Saves hours', params: { mon: { type: 'string' as const, description: 'Monday' } }, required: ['mon'] }];

beforeEach(() => resetOpenAiSkips());

test('groq: a conversation step with tool calls; results go back with the same ids', async () => {
  const { seen, doFetch } = server([ok({ content: null, tool_calls: [{ id: 'call_a', function: { name: 'setHours', arguments: '{"mon":"08:00-19:00"}' } }] })]);
  const groq = groqProvider(cfg, doFetch)!;
  const step = await groq.converse!({ system: 'sys', turns: [{ role: 'user', text: '8 to 7 on weedays' }], tools, mode: 'auto', timeoutMs: 5000 });
  assert.deepEqual(step.calls, [{ name: 'setHours', args: { mon: '08:00-19:00' }, raw: { openaiId: 'call_a' } }]);
  assert.deepEqual(step.usage, { inTokens: 120, outTokens: 15 });
  assert.equal(seen[0].model, 'openai/gpt-oss-120b');
  assert.equal(seen[0].body.reasoning_effort, 'low');
  assert.equal(seen[0].body.tool_choice, 'auto');
  const msgs = toMessages('sys', [
    { role: 'user', text: 'hi' },
    { role: 'call', name: 'setHours', args: { mon: 'closed' }, raw: { openaiId: 'call_a' } },
    { role: 'call', name: 'callMe', args: {}, raw: [{ functionCall: {} }] }, // made by Gemini: gets an id here
    { role: 'result', name: 'setHours', result: { saved: true } },
    { role: 'result', name: 'callMe', result: { done: true } },
    { role: 'assistant', text: '👍' },
  ]);
  assert.deepEqual(msgs.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'tool', 'assistant']);
  assert.deepEqual(msgs[2].tool_calls!.map(c => c.id), ['call_a', 'call_1'], 'one assistant message for the step');
  assert.deepEqual([msgs[3].tool_call_id, msgs[4].tool_call_id], ['call_a', 'call_1']);
});

test('groq: a rate-limited model is skipped for as long as Groq asks; then the backup model', async () => {
  const { seen, doFetch } = server([limited('20'), ok({ content: 'Hello 👋' }), ok({ content: 'Again' })]);
  const groq = groqProvider(cfg, doFetch)!;
  const turn = () => groq.converse!({ system: 's', turns: [{ role: 'user', text: 'hi' }], tools: [], mode: 'text', timeoutMs: 5000 });
  assert.equal((await turn()).text, 'Hello 👋');
  assert.equal((await turn()).text, 'Again');
  assert.deepEqual(seen.map(r => r.model), ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'llama-3.3-70b-versatile'], 'the limited one is not asked again');
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '20' }), ''), 20_000);
  assert.equal(retryAfterMs(new Headers(), 'Rate limit reached on requests per day (RPD)'), 3_600_000);
  assert.equal(groqProvider({ ...cfg, GROQ_API_KEY: undefined }), null, 'no key, no Groq');
});

test('chain: Groq first; rate limited or a photo → Gemini; menus only Gemini has', async () => {
  const { doFetch } = server([limited(), limited(), ok({ content: null, tool_calls: [{ id: 'x', function: { name: 'setHours', arguments: '{}' } }] })]);
  const gemini: LLMProvider & { asked: string[] } = {
    asked: [],
    async chooseTool(i) { gemini.asked.push(`chooseTool:${i.imageUrl ?? ''}`); return { tool: 'fromGemini', args: {} }; },
    async converse() { gemini.asked.push('converse'); return { calls: [], text: 'from Gemini', usage: { inTokens: 1, outTokens: 1 } }; },
    async readCatalog() { gemini.asked.push('readCatalog'); return []; },
  };
  const llm = chainProviders([groqProvider(cfg, doFetch), gemini])!;
  // Both Groq models rate limited → Gemini answers.
  assert.equal((await llm.converse!({ system: 's', turns: [{ role: 'user', text: 'hi' }], tools: [], mode: 'text', timeoutMs: 5000 })).text, 'from Gemini');
  // A photo: Groq passes, Gemini looks.
  assert.deepEqual(await llm.chooseTool({ system: 's', message: 'm', tools, imageUrl: 'https://img/x.jpg' }), { tool: 'fromGemini', args: {} });
  assert.ok(typeof llm.readCatalog === 'function');
  await llm.readCatalog!({ text: 'jollof 2500' });
  assert.deepEqual(gemini.asked, ['converse', 'chooseTool:https://img/x.jpg', 'readCatalog']);
  assert.equal(chainProviders([null, gemini]), gemini, 'one provider: itself');
});
