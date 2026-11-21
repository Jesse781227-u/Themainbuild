// AI providers that speak the OpenAI chat format (Groq, OpenRouter, Mistral…), and a chain that
// tries providers in order: Groq's free tier first, then Gemini (services/ai.ts).
//
// The OpenAI-format provider covers conversations, choosing a tool and short texts. It has no
// photos or PDFs: those calls (reading a menu, matching photos, a product photo) fall to the next
// provider in the chain. Models that say "rate limited" (429) are skipped for as long as the
// provider asks (retry-after), so each message doesn't wait on them again.
import type { Config } from '../config';
import type { AgentTurn, LLMProvider, ToolSpec } from './ai';

const CHAT_TIMEOUT_MS = 30_000;
const skipUntil = new Map<string, number>(); // `${provider}:${model}` → time it may be asked again
export function resetOpenAiSkips() { skipUntil.clear(); }

interface Opts { name: string; baseUrl: string; apiKey?: string; models: string[] }
type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; tool_call_id?: string };
interface ChatJson { choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments?: string } }[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }

const toolsFor = (tools: ToolSpec[]) => tools.map(t => ({
  type: 'function' as const,
  function: {
    name: t.name, description: t.description,
    parameters: { type: 'object', properties: Object.fromEntries(Object.entries(t.params).map(([k, p]) => [k, { type: p.type, description: p.description, ...(p.enum ? { enum: p.enum } : {}) }])), required: t.required ?? [] },
  },
}));
const parseArgs = (s: string | undefined) => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}; } catch { return {}; } };

// How long a 429 asks us to wait: retry-after (seconds), longer for a daily limit. 5s to 1 hour.
export function retryAfterMs(headers: Headers, body: string): number {
  const s = Number(headers.get('retry-after'));
  const daily = /per day|\bRPD\b|\bTPD\b|daily/i.test(body);
  const ms = Number.isFinite(s) && s > 0 ? s * 1000 : daily ? 3_600_000 : 60_000;
  return Math.min(Math.max(ms, 5_000), 3_600_000);
}

// The agent's turns in the OpenAI format: a step's tool calls are one assistant message, each result
// a "tool" message with the same id. Calls made by another provider (Gemini) get ids here.
export function toMessages(system: string, turns: AgentTurn[]): Msg[] {
  const out: Msg[] = [{ role: 'system', content: system }];
  const pending: { id: string; name: string }[] = [];
  let n = 0;
  turns.forEach((t, i) => {
    if (t.role === 'user' || t.role === 'assistant') { out.push({ role: t.role, content: t.text }); return; }
    if (t.role === 'call') {
      const id = (t.raw as { openaiId?: string } | undefined)?.openaiId ?? `call_${++n}`;
      const call = { id, type: 'function' as const, function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } };
      const last = out[out.length - 1];
      if (turns[i - 1]?.role === 'call' && last.role === 'assistant' && last.tool_calls) last.tool_calls.push(call);
      else out.push({ role: 'assistant', content: null, tool_calls: [call] });
      pending.push({ id, name: t.name });
      return;
    }
    const at = pending.findIndex(p => p.name === t.name);
    const [match] = at >= 0 ? pending.splice(at, 1) : [{ id: `call_${++n}` }];
    out.push({ role: 'tool', tool_call_id: match.id, content: JSON.stringify(t.result ?? null).slice(0, 8000) });
  });
  return out;
}

export function openAiCompatProvider(o: Opts, doFetch: typeof fetch = (...a) => fetch(...a)): LLMProvider | null {
  if (!o.apiKey) return null;
  const models = [...new Set(o.models.map(m => m.trim()).filter(Boolean))];
  if (!models.length) return null;
  const chat = async (body: Record<string, unknown>, timeoutMs = CHAT_TIMEOUT_MS): Promise<ChatJson> => {
    const usable = models.filter(m => !((skipUntil.get(`${o.name}:${m}`) ?? 0) > Date.now()));
    if (!usable.length) throw new Error(`${o.name.toUpperCase()}_FAILED: every model is rate limited`);
    let last = '';
    for (const model of usable) {
      let res: Response;
      try {
        res = await doFetch(`${o.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
          // gpt-oss models think before answering: "low" keeps replies fast.
          body: JSON.stringify({ model, ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}), ...body }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
        continue; // timed out or unreachable: the next model
      }
      if (res.ok) return (await res.json()) as ChatJson;
      const text = await res.text().catch(() => '');
      last = `${res.status} ${text.match(/"message":\s*"([^"]{0,160})/)?.[1] ?? ''}`.trim();
      if (res.status === 429) skipUntil.set(`${o.name}:${model}`, Date.now() + retryAfterMs(res.headers, text));
      else if (res.status < 500 && res.status !== 408) break; // a bad request won't get better on another model
    }
    throw new Error(`${o.name.toUpperCase()}_FAILED: ${last || 'no answer'}`);
  };
  const json = async (prompt: string, temperature: number) => {
    const r = await chat({ messages: [{ role: 'user', content: `${prompt}\nAnswer with JSON only.` }], temperature, response_format: { type: 'json_object' } });
    try { return JSON.parse(r.choices?.[0]?.message?.content ?? '{}') as Record<string, unknown>; } catch { return {}; }
  };
  return {
    async chooseTool({ system, message, tools, imageUrl }) {
      if (imageUrl) throw new Error(`${o.name.toUpperCase()}_FAILED: no photos`); // the next provider looks at it
      const r = await chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: message }], tools: toolsFor(tools), tool_choice: 'required', temperature: 0 });
      const call = r.choices?.[0]?.message?.tool_calls?.[0];
      return call ? { tool: call.function.name, args: parseArgs(call.function.arguments) } : null;
    },
    async converse({ system, turns, tools, mode, timeoutMs }) {
      const r = await chat({
        messages: toMessages(system, turns),
        ...(tools.length ? { tools: toolsFor(tools), tool_choice: mode === 'text' ? 'none' : 'auto' } : {}),
        temperature: 0.5, max_completion_tokens: 1500,
      }, timeoutMs);
      const m = r.choices?.[0]?.message;
      return {
        calls: (m?.tool_calls ?? []).map(c => ({ name: c.function.name, args: parseArgs(c.function.arguments), raw: { openaiId: c.id } })),
        text: (m?.content ?? '').trim(),
        usage: { inTokens: r.usage?.prompt_tokens ?? 0, outTokens: r.usage?.completion_tokens ?? 0 },
      };
    },
    async writeTexts({ prompt, keys }) {
      const out = await json(`${prompt}\nReturn a JSON object with exactly these keys, each a string: ${keys.join(', ')}.`, 0.9);
      return Object.fromEntries(keys.filter(k => typeof out[k] === 'string' && (out[k] as string).trim()).map(k => [k, (out[k] as string).trim()]));
    },
    async pickPairs({ shop, shopType, anchor, candidates }) {
      const out = await json([
        `A customer at "${shop}" (a small ${shopType.replace(/_/g, ' ')} business in Nigeria) just added this to their cart: ${JSON.stringify(anchor)}.`,
        'From the shop items below, pick up to 4 that genuinely go WITH it (things people buy together), best first; not near-identical alternatives. If nothing really goes with it, an empty list.',
        'Separately, at most one upsell: a better or bigger version of the same kind of item, a bit dearer. Or null.',
        'Use only ids from the list. Return {"cross": [ids], "upsell": id or null}.',
        'Shop items: ' + JSON.stringify(candidates),
      ].join('\n'), 0.2);
      return { cross: Array.isArray(out.cross) ? out.cross.filter((x): x is string => typeof x === 'string') : [], upsell: typeof out.upsell === 'string' && out.upsell ? out.upsell : null };
    },
  };
}

export function groqProvider(cfg: Pick<Config, 'GROQ_API_KEY' | 'GROQ_MODEL' | 'GROQ_FALLBACK_MODEL'>, doFetch?: typeof fetch) {
  return openAiCompatProvider({ name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: cfg.GROQ_API_KEY, models: [cfg.GROQ_MODEL, ...String(cfg.GROQ_FALLBACK_MODEL ?? '').split(',')] }, doFetch);
}

// Tries each provider in turn; a provider without a feature (photos, menus) is passed over. In a
// conversation the first one gets most of the time, so the next can still answer before the limit.
export function chainProviders(list: (LLMProvider | null | undefined)[]): LLMProvider | null {
  const ps = list.filter((p): p is LLMProvider => !!p);
  if (ps.length <= 1) return ps[0] ?? null;
  type Key = keyof LLMProvider;
  const run = async <K extends Key>(key: K, args: unknown, adjust?: (a: unknown, i: number, of: number) => unknown): Promise<unknown> => {
    const able = ps.filter(p => typeof p[key] === 'function');
    let err: unknown = new Error('LLM_FAILED: no provider');
    for (const [i, p] of able.entries()) {
      try { return await (p[key] as (a: unknown) => Promise<unknown>).call(p, adjust ? adjust(args, i, able.length) : args); } catch (e) { err = e; }
    }
    throw err;
  };
  const has = (key: Key) => ps.some(p => typeof p[key] === 'function');
  const chain: LLMProvider = { chooseTool: a => run('chooseTool', a) as ReturnType<LLMProvider['chooseTool']> };
  if (has('converse')) chain.converse = a => run('converse', a, (x, i, of) => {
    const input = x as Parameters<NonNullable<LLMProvider['converse']>>[0];
    return i < of - 1 ? { ...input, timeoutMs: Math.max(1000, Math.round(input.timeoutMs * 0.6)) } : input;
  }) as ReturnType<NonNullable<LLMProvider['converse']>>;
  for (const key of ['writeTexts', 'pickPairs', 'readCatalog', 'matchPhotos'] as const) if (has(key)) (chain as unknown as Record<string, unknown>)[key] = (a: unknown) => run(key, a);
  return chain;
}
