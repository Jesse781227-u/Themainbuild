import { C } from '../db';
import type { Config } from '../config';
import type { QueueJob, R2BucketLike } from '../env';
import type { Firestore } from '../lib/firestore';
import { randomId } from '../lib/crypto';
import { log } from '../lib/logger';
import type { Business } from '../domain/business';
import type { Product } from '../domain/commerce';
import type { LLMProvider, Transcriber } from '../services/ai';
import { downloadMedia, type Transport } from '../services/channel';
import type { InboundEvent } from '../services/inbound';
import { adminConversationId } from '../services/conversations';

export interface BotDeps {
  transport: Transport;
  llm: LLMProvider | null;
  transcriber: Transcriber | null;
  fetch: typeof fetch;
  images?: R2BucketLike;
  enqueue: (jobs: QueueJob[]) => Promise<void>;
  now?: () => Date;
}

export interface Input { text: string; choiceId: string | null; imageId: string | null; audioId: string | null }

type Obj = Record<string, any>;

// What the person sent, reduced to text plus the id of a tapped option, photo or voice note.
export function readInput(event: InboundEvent): Input {
  const m = (event.message ?? {}) as Obj;
  const reply = m.interactive?.list_reply ?? m.interactive?.button_reply ?? null;
  const caption = typeof m.image?.caption === 'string' ? m.image.caption : '';
  return {
    text: String(event.text ?? reply?.title ?? m.button?.text ?? caption ?? '').trim(),
    choiceId: reply?.id ? String(reply.id) : null,
    imageId: m.image?.id ? String(m.image.id) : null,
    audioId: m.audio?.id ? String(m.audio.id) : null,
  };
}

// Voice notes become text. Returns null when transcription isn't available or fails.
export async function transcribeVoice(cfg: Config, deps: BotDeps, accessToken: string, audioId: string) {
  if (!deps.transcriber) return null;
  try {
    const { bytes, mimeType } = await downloadMedia(cfg, accessToken, audioId, deps.fetch);
    return (await deps.transcriber.transcribe(bytes, mimeType)) || null;
  } catch (e) {
    log('warn', 'transcription_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) });
    return null;
  }
}

// Downloads a WhatsApp photo and stores it in R2 as a product image. Returns its public URL.
export async function storeProductImage(cfg: Config, deps: BotDeps, accessToken: string, mediaId: string, businessId: string, productId: string) {
  if (!deps.images) return null;
  const { bytes, mimeType } = await downloadMedia(cfg, accessToken, mediaId, deps.fetch);
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const key = `businesses/${businessId}/products/${productId}-${randomId(4).replace(/[^A-Za-z0-9]/g, 'x')}.${ext}`;
  await deps.images.put(key, bytes, { httpMetadata: { contentType: mimeType } });
  return `${cfg.API_BASE_URL}/media/${key}`;
}

export const YES = /^(yes|y|yeah|yep|confirm|ok|okay|sure|do it)\b/i;
export const NO = /^(no|n|nope|cancel|stop|don'?t)\b/i;

// Finds a product by name within one business: exact, then prefix, then substring.
export async function findProducts(db: Firestore, businessId: string, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const all = ((await db.query(C.products, [['businessId', '==', businessId]])) as unknown as Product[]).filter(p => !p.deletedAt);
  const exact = all.filter(p => p.name.toLowerCase() === q);
  if (exact.length) return exact;
  const prefix = all.filter(p => p.name.toLowerCase().startsWith(q));
  if (prefix.length) return prefix;
  return all.filter(p => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
}

// Messages to the owner go through the outbox, so a closed 24-hour window or a Meta hiccup can't
// lose them or break the customer's flow.
export async function notifyOwner(db: Firestore, deps: BotDeps, business: Pick<Business, 'id' | 'ownerPhone'>, kind: string, text: string, dedupeKey?: string) {
  if (!business.ownerPhone) return;
  const id = `${business.id}_${kind}_${dedupeKey ?? randomId(8)}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const created = await db.create(db.doc(C.outbox, id), {
    id, businessId: business.id, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone,
    conversationId: adminConversationId(business.ownerPhone), kind, text, status: 'pending', attempts: 0, createdAt: new Date().toISOString(),
  });
  if (created) await deps.enqueue([{ kind: 'outbox', messageId: id }]);
}

export const buttons = (body: string, items: [id: string, title: string][]) => ({
  type: 'interactive' as const,
  interactive: { type: 'button', body: { text: body }, action: { buttons: items.slice(0, 3).map(([id, title]) => ({ type: 'reply', reply: { id, title: title.slice(0, 20) } })) } },
});

export const list = (body: string, button: string, rows: { id: string; title: string; description?: string }[], sectionTitle = 'Options') => ({
  type: 'interactive' as const,
  interactive: { type: 'list', body: { text: body }, action: { button: button.slice(0, 20), sections: [{ title: sectionTitle.slice(0, 24), rows: rows.slice(0, 10).map(r => ({ id: r.id, title: r.title.slice(0, 24), ...(r.description ? { description: r.description.slice(0, 72) } : {}) })) }] } },
});
