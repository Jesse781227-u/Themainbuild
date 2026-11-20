// AI providers, behind interfaces so they can be swapped or faked in tests.
//
// The LLM only ever *chooses* one of Relay's typed tools and proposes arguments. It never writes to
// Firestore and its free text is never sent to anyone: tool arguments are validated with zod, the
// business id comes from the caller's context (never the model), and destructive tools need a YES.
// Function calling is forced (mode ANY) and "offTopic" is one of the tools, which keeps the bots
// business-specific as Meta's WhatsApp Business policy requires.
import type { Config } from '../config';

export interface ToolParam { type: 'string' | 'number' | 'integer' | 'boolean'; description: string; enum?: string[] }
export interface ToolSpec { name: string; description: string; params: Record<string, ToolParam>; required?: string[] }
export interface ToolChoice { tool: string; args: Record<string, unknown> }

// One line read from a menu or price list. Prices are naira as written (validated by the caller).
export interface CatalogItem { name: string; price: number | null; category: string | null; stock?: number | null; description?: string | null; image?: number | null /* 1-based index into the photos passed in */ }

export interface PairItem { id: string; name: string; category: string; priceNaira: number }

// ── The conversation agent (bots/agent.ts) ──
// One step of a conversation: the model either calls tools or writes the reply. The agent runs the
// loop (tools, step limit, time limit, fact check); the provider only translates.
export type AgentTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  | { role: 'call'; name: string; args: Record<string, unknown>; raw?: unknown } // raw: the provider's own part (e.g. Gemini's thought signature), sent back as is
  | { role: 'result'; name: string; result: unknown };
export interface ConverseStep { calls: { name: string; args: Record<string, unknown>; raw?: unknown }[]; text: string; usage: { inTokens: number; outTokens: number } }

export interface LLMProvider {
  // imageUrl: a public product photo (our R2 media URL) the model may look at, e.g. to pick a category.
  chooseTool(input: { system: string; message: string; tools: ToolSpec[]; imageUrl?: string }): Promise<ToolChoice | null>;
  // Reads a whole menu / price list (a PDF, a photo of a printed menu, or text) into items. It only
  // extracts what is written; the owner confirms before anything is saved.
  // Drafts short texts (e.g. the shop's welcome message) as { key: text }. The owner approves them.
  writeTexts?(input: { prompt: string; keys: readonly string[] }): Promise<Record<string, string>>;
  // Picks items that go with what a customer just added (cross) and maybe one dearer version (upsell). Ids only.
  pickPairs?(input: { shop: string; shopType: string; anchor: PairItem; candidates: PairItem[] }): Promise<{ cross: string[]; upsell: string | null }>;
  // purpose "delivery": a list of delivery areas and fees (name = area, price = fee).
  readCatalog?(input: { file?: { mimeType: string; bytes: ArrayBuffer }; text?: string; businessType?: string; categories?: string[]; images?: { mimeType: string; bytes: Uint8Array }[]; purpose?: 'products' | 'delivery' }): Promise<CatalogItem[]>;
  // Which product each photo shows: returns, per photo (in order), a 1-based index into names, or null.
  matchPhotos?(input: { names: string[]; photos: { mimeType: string; bytes: Uint8Array }[] }): Promise<(number | null)[]>;
  // One conversation step (see AgentTurn). mode "text" forbids tool calls (the final reply).
  converse?(input: { system: string; turns: AgentTurn[]; tools: ToolSpec[]; mode: 'auto' | 'text'; timeoutMs: number }): Promise<ConverseStep>;
}

export const CATALOG_MIME = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif)|text\/(plain|csv))$/;
export const MAX_CATALOG_BYTES = 15_000_000;
// Quick replies (choosing what an owner meant) vs reading a whole catalogue.
const CHAT_TIMEOUT_MS = 30_000;
// Models that said "quota exceeded" are skipped (per worker) for as long as Gemini says to wait
// (RetryInfo: "37s" for a per-minute limit, ~24h for a daily one; at most an hour, then asked
// again), so each message doesn't lose time asking them again.
const quotaUntil = new Map<string, number>();
// When every model keeps failing (out of quota, down, timing out), stop calling for a minute so
// customers get the instant answers straight away instead of waiting out each timeout.
const breaker = { fails: 0, restUntil: 0 };
export const REST_MS = 60_000;
export const modelsResting = (now = Date.now()) => breaker.restUntil > now;
export function resetBreaker() { breaker.fails = 0; breaker.restUntil = 0; quotaUntil.clear(); }
const noteResult = (ok: boolean) => {
  if (ok) { breaker.fails = 0; return; }
  if (++breaker.fails >= 2) { breaker.restUntil = Date.now() + REST_MS; breaker.fails = 0; }
};
export function quotaWait(body: string): number | null {
  if (!/quota|RESOURCE_EXHAUSTED/i.test(body)) return null;
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  const ms = m ? Number(m[1]) * 1000 : 60_000;
  return Math.min(Math.max(ms, 5_000), 3_600_000);
}
// Catalogues: models race. The main model starts; if it hasn't answered after HEDGE_MS (or fails),
// the next one starts too, and the first good answer wins. Nothing waits longer than the total.
const CATALOG_HEDGE_MS = 8_000;
const CATALOG_TOTAL_MS = 75_000;
const PHOTO_MATCH_TOTAL_MS = 150_000; // in the background, so it can take longer

const MAX_IMAGE_BYTES = 4_000_000;

// Fetches a photo for the model as inline data. Any failure just means "no photo".
async function inlineImage(url: string, doFetch: typeof fetch) {
  try {
    const res = await doFetch(url);
    if (!res.ok) return null;
    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0];
    if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) return null;
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_IMAGE_BYTES) return null;
    return { inlineData: { mimeType, data: Buffer.from(bytes).toString('base64') } };
  } catch { return null; }
}

export interface Transcriber {
  transcribe(audio: ArrayBuffer, mimeType: string): Promise<string>;
}

const geminiType = { string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN' } as const;

export function geminiProvider(cfg: Pick<Config, 'GEMINI_API_KEY' | 'GEMINI_MODEL' | 'GEMINI_FALLBACK_MODEL'>, doFetch: typeof fetch = (...a) => fetch(...a)): LLMProvider | null {
  if (!cfg.GEMINI_API_KEY) return null;
  // Gemini sometimes answers 429/500/503 ("high demand") or hangs. Each call gets a time limit; a busy
  // or slow main model gets one quick retry, then the fallback model.
  const gemini = async (init: RequestInit, timeoutMs = CHAT_TIMEOUT_MS) => {
    const models = [...new Set([cfg.GEMINI_MODEL, ...String(cfg.GEMINI_FALLBACK_MODEL ?? '').split(',')].map(m => m.trim()).filter(Boolean))];
    let last: Response | null = null;
    if (modelsResting()) throw new Error('GEMINI_FAILED: resting after repeated failures');
    const usable = models.filter(m => !((quotaUntil.get(m) ?? 0) > Date.now()));
    if (!usable.length) { noteResult(false); throw new Error('GEMINI_FAILED: every model is out of quota'); }
    for (const [i, model] of usable.entries()) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      for (let attempt = 0; attempt < (i === 0 ? 2 : 1); attempt++) {
        if (attempt) await new Promise(r => setTimeout(r, 800));
        try {
          last = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
          if (![429, 500, 503].includes(last.status)) { noteResult(true); return last; }
          // Out of quota (not just busy): skip this model for a while instead of retrying it.
          if (last.status === 429) {
            const wait = quotaWait(await last.clone().text().catch(() => ''));
            if (wait) { quotaUntil.set(model, Date.now() + wait); break; }
          }
        } catch (e) {
          if (!(e instanceof Error && /abort|timeout/i.test(`${e.name} ${e.message}`))) throw e; // timed out: try again / next model
        }
      }
    }
    noteResult(false);
    if (last) return last;
    throw new Error('GEMINI_FAILED: timeout');
  };
  // The racing version, for slow calls (catalogues, photos).
  const geminiRace = (init: RequestInit, hedgeMs: number, totalMs: number) => new Promise<Response>((resolve, reject) => {
    const models = [...new Set([cfg.GEMINI_MODEL, ...String(cfg.GEMINI_FALLBACK_MODEL ?? '').split(',')].map(m => m.trim()).filter(Boolean))];
    const attempts: AbortController[] = [];
    let started = 0, finished = 0, done = false, last: Response | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const total = setTimeout(() => finish(null, new Error('GEMINI_FAILED: timeout')), totalMs);
    function finish(res: Response | null, err?: Error, winner?: AbortController) {
      if (done) return;
      done = true;
      clearTimeout(total);
      if (timer) clearTimeout(timer);
      for (const a of attempts) if (a !== winner) a.abort(); // stop the others, keep the winner's body
      if (res) resolve(res); else reject(err ?? new Error('GEMINI_FAILED: timeout'));
    }
    function next() {
      if (done || started >= models.length) return;
      const model = models[started++];
      if (timer) clearTimeout(timer);
      if (started < models.length) timer = setTimeout(next, hedgeMs);
      const attempt = new AbortController();
      attempts.push(attempt);
      doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { ...init, signal: attempt.signal })
        .then(res => { if (res.ok) return finish(res, undefined, attempt); last = res; })
        .catch(() => undefined)
        .finally(() => {
          finished++;
          if (done) return;
          if (started < models.length) next(); // this one failed: don't wait for the timer
          else if (finished >= started) finish(last, new Error('GEMINI_FAILED: timeout'));
        });
    }
    next();
  });
  return {
    async chooseTool({ system, message, tools, imageUrl }) {
      const image = imageUrl ? await inlineImage(imageUrl, doFetch) : null;
      const functionDeclarations = tools.map(t => ({
        name: t.name, description: t.description,
        ...(Object.keys(t.params).length ? { parameters: { type: 'OBJECT', properties: Object.fromEntries(Object.entries(t.params).map(([k, p]) => [k, { type: geminiType[p.type], description: p.description, ...(p.enum ? { enum: p.enum } : {}) }])), required: t.required ?? [] } } : {}),
      }));
      const res = await gemini({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.GEMINI_API_KEY! },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: message }, ...(image ? [image] : [])] }],
          tools: [{ functionDeclarations }],
          toolConfig: { functionCallingConfig: { mode: 'ANY' } },
          generationConfig: { temperature: 0 },
        }),
      });
      if (!res.ok) throw new Error(`GEMINI_FAILED: ${res.status}`);
      const json = (await res.json()) as { candidates?: { content?: { parts?: { functionCall?: { name: string; args?: Record<string, unknown> } }[] } }[] };
      const call = json.candidates?.[0]?.content?.parts?.find(p => p.functionCall)?.functionCall;
      return call ? { tool: call.name, args: call.args ?? {} } : null;
    },

    async converse({ system, turns, tools, mode, timeoutMs }) {
      const functionDeclarations = tools.map(t => ({
        name: t.name, description: t.description,
        ...(Object.keys(t.params).length ? { parameters: { type: 'OBJECT', properties: Object.fromEntries(Object.entries(t.params).map(([k, p]) => [k, { type: geminiType[p.type], description: p.description, ...(p.enum ? { enum: p.enum } : {}) }])), required: t.required ?? [] } } : {}),
      }));
      // Gemini's roles: user / model; tool results go back as a user part.
      const contents: { role: 'user' | 'model'; parts: unknown[] }[] = [];
      const push = (role: 'user' | 'model', part: unknown) => {
        const last = contents[contents.length - 1];
        if (last && last.role === role) last.parts.push(part); else contents.push({ role, parts: [part] });
      };
      for (const t of turns) {
        if (t.role === 'user') push('user', { text: t.text });
        else if (t.role === 'assistant') push('model', { text: t.text });
        // Gemini's own reply goes back exactly as it came (thought signatures included): the first
        // call of a step carries all its parts, the others are already in it.
        else if (t.role === 'call') {
          if (Array.isArray(t.raw)) for (const part of t.raw) push('model', part);
          else if (!(t.raw && (t.raw as { sameStep?: boolean }).sameStep)) push('model', t.raw ?? { functionCall: { name: t.name, args: t.args } });
        }
        else push('user', { functionResponse: { name: t.name, response: { result: t.result } } });
      }
      const res = await gemini({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.GEMINI_API_KEY! },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          ...(functionDeclarations.length ? { tools: [{ functionDeclarations }], toolConfig: { functionCallingConfig: { mode: mode === 'text' ? 'NONE' : 'AUTO' } } } : {}),
          generationConfig: { temperature: 0.5, maxOutputTokens: 800 },
        }),
      }, timeoutMs);
      if (!res.ok) throw new Error(`GEMINI_FAILED: ${res.status} ${((await res.text().catch(() => "")).match(/"message":\s*"([^"]{0,160})/)?.[1] ?? "")}`.trim());
      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean; functionCall?: { name: string; args?: Record<string, unknown> } }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } };
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      return {
        calls: parts.filter(p => p.functionCall).map((p, i) => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {}, raw: i === 0 ? parts.filter(x => !x.thought || x.functionCall) : { sameStep: true } })),
        text: parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim(),
        usage: { inTokens: json.usageMetadata?.promptTokenCount ?? 0, outTokens: (json.usageMetadata?.candidatesTokenCount ?? 0) + (json.usageMetadata?.thoughtsTokenCount ?? 0) },
      };
    },

    async writeTexts({ prompt, keys }) {
      const res = await gemini({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.GEMINI_API_KEY! },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.9,
            responseMimeType: 'application/json',
            responseSchema: { type: 'OBJECT', properties: Object.fromEntries(keys.map(k => [k, { type: 'STRING' }])), required: [...keys] },
          },
        }),
      });
      if (!res.ok) throw new Error(`GEMINI_FAILED: ${res.status}`);
      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const raw = json.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
      try {
        const out = JSON.parse(raw) as Record<string, unknown>;
        return Object.fromEntries(keys.filter(k => typeof out[k] === 'string' && (out[k] as string).trim()).map(k => [k, (out[k] as string).trim()]));
      } catch { return {}; }
    },

    async pickPairs({ shop, shopType, anchor, candidates }) {
      const prompt = [
        `A customer at "${shop}" (a small ${shopType.replace(/_/g, ' ')} business in Nigeria) just added this to their cart: ${JSON.stringify(anchor)}.`,
        'From the shop items below, pick up to 4 that genuinely go WITH it: things people buy together (a drink or side with food, socks or a cleaner with sneakers, a bag that matches a dress). Best first.',
        'Do not pick near-identical alternatives to it (another shoe instead of this shoe). If nothing really goes with it, return an empty list.',
        'Separately, pick at most one upsell: a better, bigger or premium version of the same kind of item, a bit more expensive. Or null.',
        'Use only ids from the list.',
        'Shop items: ' + JSON.stringify(candidates),
      ].join('\n');
      const res = await gemini({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.GEMINI_API_KEY! },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            responseSchema: { type: 'OBJECT', properties: { cross: { type: 'ARRAY', items: { type: 'STRING' } }, upsell: { type: 'STRING', nullable: true } }, required: ['cross'] },
          },
        }),
      });
      if (!res.ok) throw new Error(`GEMINI_FAILED: ${res.status}`);
      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const raw = json.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
      try {
        const out = JSON.parse(raw) as { cross?: unknown; upsell?: unknown };
        return { cross: Array.isArray(out.cross) ? out.cross.filter((x): x is string => typeof x === 'string') : [], upsell: typeof out.upsell === 'string' && out.upsell ? out.upsell : null };
      } catch { return { cross: [], upsell: null }; }
    },

    async readCatalog({ file, text, businessType, categories, images, purpose }) {
      if (file && (!CATALOG_MIME.test(file.mimeType) || file.bytes.byteLength > MAX_CATALOG_BYTES)) throw new Error('CATALOG_FILE_UNSUPPORTED');
      const parts: Record<string, unknown>[] = [{ text: purpose === 'delivery' ? [
        'This is a list of delivery areas and delivery fees of a small business in Nigeria (a table, a list, a price sheet or a photo of one).',
        'Extract every area / place name with its delivery fee: name = the area exactly as written, price = the fee in naira ("3k" is 3000, "₦3,000" is 3000, "free" is 0), category = null.',
        'Only include what is written. Do not invent areas or fees. Ignore titles, notes, phone numbers and totals.',
      ].join(' ') : [
        'Extract every product or service with its price from this menu / price list of a small business in Nigeria.',
        'Use the section headings as categories (e.g. "Rice dishes", "Drinks"); keep them short and title case. If there are no headings, group items into a few sensible categories.',
        businessType ? `The business type is ${businessType}.` : '',
        categories?.length ? `The shop already has these categories; reuse them when they fit: ${categories.join(', ')}.` : '',
        'Prices are in naira: "2.5k" is 2500, "₦2,500" is 2500. If an item lists several sizes with prices, add one item per size, e.g. "Zobo (50cl)". If an item has no price, set price to null.',
        'Only include what is written. Do not invent items, prices or stock. Ignore addresses, phone numbers, opening hours and promotions.',
        images?.length ? `After the document come ${images.length} product photos taken from it, in order, labelled Photo 1 to Photo ${images.length}. For each item set image to the number of the photo that shows that item (look at the photo and where it sits next to the item), or null if none does. Use each photo for at most one item.` : '',
      ].filter(Boolean).join(' ') }];
      if (file) parts.push({ inlineData: { mimeType: file.mimeType, data: Buffer.from(file.bytes).toString('base64') } });
      (images ?? []).forEach((img, i) => parts.push({ text: `Photo ${i + 1}:` }, { inlineData: { mimeType: img.mimeType, data: Buffer.from(img.bytes).toString('base64') } }));
      if (text) parts.push({ text: text.slice(0, 30_000) });
      const res = await geminiRace({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.GEMINI_API_KEY! },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: { type: 'OBJECT', properties: { items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, price: { type: 'NUMBER', nullable: true }, category: { type: 'STRING', nullable: true }, stock: { type: 'INTEGER', nullable: true }, description: { type: 'STRING', nullable: true }, image: { type: 'INTEGER', nullable: true } }, required: ['name', 'price', 'category'] } } }, required: ['items'] },
          },
        }),
      }, CATALOG_HEDGE_MS, CATALOG_TOTAL_MS);
      if (!res.ok) throw new Error(`GEMINI_FAILED: ${res.status}`);
      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const raw = json.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
      try { return ((JSON.parse(raw) as { items?: CatalogItem[] }).items ?? []).slice(0, 300); } catch { return []; }
    },

    async matchPhotos({ names, photos }) {
      const parts: Record<string, unknown>[] = [{ text: [
        'These are product photos taken from a small shop\'s catalogue in Nigeria, followed by the shop\'s product list.',
        'For each photo, say which product it shows, by its number in the list, or null if it shows none of them or you are not sure. Use each product at most once.',
        'Products:', ...names.map((n, i) => `${i + 1}. ${n}`),
      ].join('\n') }];
      photos.forEach((p, i) => parts.push({ text: `Photo ${i + 1}:` }, { inlineData: { mimeType: p.mimeType, data: Buffer.from(p.bytes).toString('base64') } }));
      const res = await geminiRace({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.GEMINI_API_KEY! },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { photos: { type: 'ARRAY', items: { type: 'OBJECT', properties: { photo: { type: 'INTEGER' }, product: { type: 'INTEGER', nullable: true } }, required: ['photo', 'product'] } } }, required: ['photos'] } },
        }),
      }, CATALOG_HEDGE_MS, PHOTO_MATCH_TOTAL_MS);
      if (!res.ok) throw new Error(`GEMINI_FAILED: ${res.status}`);
      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const raw = json.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
      const out: (number | null)[] = photos.map(() => null);
      try {
        for (const r of (JSON.parse(raw) as { photos?: { photo: number; product: number | null }[] }).photos ?? []) {
          if (Number.isInteger(r.photo) && r.photo >= 1 && r.photo <= photos.length && Number.isInteger(r.product) && r.product! >= 1 && r.product! <= names.length) out[r.photo - 1] = r.product!;
        }
      } catch { /* no matches */ }
      return out;
    },
  };
}

export function openAiTranscriber(cfg: Pick<Config, 'OPENAI_API_KEY' | 'OPENAI_TRANSCRIBE_MODEL'>, doFetch: typeof fetch = (...a) => fetch(...a)): Transcriber | null {
  if (!cfg.OPENAI_API_KEY) return null;
  return {
    async transcribe(audio, mimeType) {
      const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('mp4') ? 'm4a' : 'audio';
      const form = new FormData();
      form.append('file', new Blob([audio], { type: mimeType }), `voice.${ext}`);
      form.append('model', cfg.OPENAI_TRANSCRIBE_MODEL);
      const res = await doFetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${cfg.OPENAI_API_KEY}` }, body: form });
      if (!res.ok) throw new Error(`TRANSCRIBE_FAILED: ${res.status}`);
      return String(((await res.json()) as { text?: string }).text ?? '').trim();
    },
  };
}
