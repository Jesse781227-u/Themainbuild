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

export interface LLMProvider {
  // imageUrl: a public product photo (our R2 media URL) the model may look at, e.g. to pick a category.
  chooseTool(input: { system: string; message: string; tools: ToolSpec[]; imageUrl?: string }): Promise<ToolChoice | null>;
}

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

export function geminiProvider(cfg: Pick<Config, 'GEMINI_API_KEY' | 'GEMINI_MODEL'>, doFetch: typeof fetch = (...a) => fetch(...a)): LLMProvider | null {
  if (!cfg.GEMINI_API_KEY) return null;
  return {
    async chooseTool({ system, message, tools, imageUrl }) {
      const image = imageUrl ? await inlineImage(imageUrl, doFetch) : null;
      const functionDeclarations = tools.map(t => ({
        name: t.name, description: t.description,
        ...(Object.keys(t.params).length ? { parameters: { type: 'OBJECT', properties: Object.fromEntries(Object.entries(t.params).map(([k, p]) => [k, { type: geminiType[p.type], description: p.description, ...(p.enum ? { enum: p.enum } : {}) }])), required: t.required ?? [] } } : {}),
      }));
      const res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.GEMINI_MODEL}:generateContent`, {
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
