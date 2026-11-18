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

export interface LLMProvider {
  // imageUrl: a public product photo (our R2 media URL) the model may look at, e.g. to pick a category.
  chooseTool(input: { system: string; message: string; tools: ToolSpec[]; imageUrl?: string }): Promise<ToolChoice | null>;
  // Reads a whole menu / price list (a PDF, a photo of a printed menu, or text) into items. It only
  // extracts what is written; the owner confirms before anything is saved.
  // Drafts short texts (e.g. the shop's welcome message) as { key: text }. The owner approves them.
  writeTexts?(input: { prompt: string; keys: readonly string[] }): Promise<Record<string, string>>;
  // Picks items that go with what a customer just added (cross) and maybe one dearer version (upsell). Ids only.
  pickPairs?(input: { shop: string; shopType: string; anchor: PairItem; candidates: PairItem[] }): Promise<{ cross: string[]; upsell: string | null }>;
  readCatalog?(input: { file?: { mimeType: string; bytes: ArrayBuffer }; text?: string; businessType?: string; categories?: string[]; images?: { mimeType: string; bytes: Uint8Array }[] }): Promise<CatalogItem[]>;
}

export const CATALOG_MIME = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif)|text\/(plain|csv))$/;
export const MAX_CATALOG_BYTES = 15_000_000;
// Quick replies (choosing what an owner meant) vs reading a whole catalogue with photos.
const CHAT_TIMEOUT_MS = 30_000;
const CATALOG_TIMEOUT_MS = 120_000;

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
    for (const [i, model] of models.entries()) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      for (let attempt = 0; attempt < (i === 0 ? 2 : 1); attempt++) {
        if (attempt) await new Promise(r => setTimeout(r, 800));
        try {
          last = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
          if (![429, 500, 503].includes(last.status)) return last;
        } catch (e) {
          if (!(e instanceof Error && /abort|timeout/i.test(`${e.name} ${e.message}`))) throw e; // timed out: try again / next model
        }
      }
    }
    if (last) return last;
    throw new Error('GEMINI_FAILED: timeout');
  };
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

    async readCatalog({ file, text, businessType, categories, images }) {
      if (file && (!CATALOG_MIME.test(file.mimeType) || file.bytes.byteLength > MAX_CATALOG_BYTES)) throw new Error('CATALOG_FILE_UNSUPPORTED');
      const parts: Record<string, unknown>[] = [{ text: [
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
      const res = await gemini({
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
      }, CATALOG_TIMEOUT_MS);
      if (!res.ok) throw new Error(`GEMINI_FAILED: ${res.status}`);
      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const raw = json.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
      try { return ((JSON.parse(raw) as { items?: CatalogItem[] }).items ?? []).slice(0, 300); } catch { return []; }
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
