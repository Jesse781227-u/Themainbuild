import { C } from '../db';
import { fitTitle } from '../services/carousel';
export { fitTitle };
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

export interface Input {
  text: string; choiceId: string | null; imageId: string | null; audioId: string | null;
  document: { id: string; mimeType: string; filename: string } | null; // a file, e.g. a PDF menu
  flow?: unknown;                                                       // a submitted WhatsApp Flow form (nfm_reply)
}

type Obj = Record<string, any>;

// What the person sent, reduced to text plus the id of a tapped option, photo, voice note or file.
export function readInput(event: InboundEvent): Input {
  const m = (event.message ?? {}) as Obj;
  const reply = m.interactive?.list_reply ?? m.interactive?.button_reply ?? null;
  const caption = typeof m.image?.caption === 'string' ? m.image.caption : typeof m.document?.caption === 'string' ? m.document.caption : '';
  return {
    text: String(event.text ?? reply?.title ?? m.button?.text ?? caption ?? '').trim(),
    // A tapped button: interactive replies, or a quick reply that arrives as type "button".
    choiceId: reply?.id ? String(reply.id) : typeof m.button?.payload === 'string' ? m.button.payload : null,
    imageId: m.image?.id ? String(m.image.id) : null,
    audioId: m.audio?.id ? String(m.audio.id) : null,
    flow: m.interactive?.nfm_reply ?? null,
    document: m.document?.id ? { id: String(m.document.id), mimeType: String(m.document.mime_type ?? 'application/octet-stream'), filename: String(m.document.filename ?? 'file').slice(0, 120) } : null,
  };
}

// Files uploaded in the local test chat are kept in R2 under dev-uploads/ instead of Meta.
export const DEV_MEDIA_PREFIX = 'devmedia_';
export const devMediaKey = (id: string) => `dev-uploads/${id}`;

// Downloads a photo, voice note or file the person sent.
export async function fetchMedia(cfg: Config, deps: BotDeps, accessToken: string, mediaId: string): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  if (mediaId.startsWith(DEV_MEDIA_PREFIX) && cfg.RELAY_ENV === 'development' && deps.images) {
    const obj = await deps.images.get(devMediaKey(mediaId));
    if (!obj) throw new Error('MEDIA_LOOKUP_FAILED: 404');
    return { bytes: await new Response(obj.body).arrayBuffer(), mimeType: obj.httpMetadata?.contentType ?? 'application/octet-stream' };
  }
  return downloadMedia(cfg, accessToken, mediaId, deps.fetch);
}

// Voice notes become text. Returns null when transcription isn't available or fails.
export async function transcribeVoice(cfg: Config, deps: BotDeps, accessToken: string, audioId: string) {
  if (!deps.transcriber) return null;
  try {
    const { bytes, mimeType } = await fetchMedia(cfg, deps, accessToken, audioId);
    return (await deps.transcriber.transcribe(bytes, mimeType)) || null;
  } catch (e) {
    log('warn', 'transcription_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) });
    return null;
  }
}

// Downloads the photo the owner sent for their shop's profile picture and stores it in R2.
// TODO(jesse): once the number is connected, push it to the WhatsApp Business profile (Resumable
// Upload API for a handle, then POST /{phone-number-id}/whatsapp_business_profile with
// profile_picture_handle); verify that coexistence numbers allow this.
export async function storeProfilePhoto(cfg: Config, deps: BotDeps, accessToken: string, mediaId: string, businessId: string) {
  if (!deps.images) return null;
  const { bytes, mimeType } = await fetchMedia(cfg, deps, accessToken, mediaId);
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const key = `businesses/${businessId}/profile/photo-${randomId(4).replace(/[^A-Za-z0-9]/g, 'x')}.${ext}`;
  await deps.images.put(key, bytes, { httpMetadata: { contentType: mimeType } });
  return `${cfg.API_BASE_URL}/media/${key}`;
}

// Downloads a WhatsApp photo and stores it in R2 as a product image. Returns its public URL.
export async function storeProductImage(cfg: Config, deps: BotDeps, accessToken: string, mediaId: string, businessId: string, productId: string) {
  if (!deps.images) return null;
  const { bytes, mimeType } = await fetchMedia(cfg, deps, accessToken, mediaId);
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
export async function notifyOwner(db: Firestore, deps: BotDeps, business: Pick<Business, 'id' | 'ownerPhone'>, kind: string, text: string, dedupeKey?: string, content?: import('../services/channel').OutboundContent) {
  if (!business.ownerPhone) return;
  const id = `${business.id}_${kind}_${dedupeKey ?? randomId(8)}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const created = await db.create(db.doc(C.outbox, id), {
    id, businessId: business.id, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone,
    conversationId: adminConversationId(business.ownerPhone), kind, text, ...(content ? { content } : {}), status: 'pending', attempts: 0, createdAt: new Date().toISOString(),
  });
  if (created) await deps.enqueue([{ kind: 'outbox', messageId: id }]);
}

export const buttons = (body: string, items: [id: string, title: string][]) => ({
  type: 'interactive' as const,
  interactive: { type: 'button', body: { text: body }, action: { buttons: items.slice(0, 3).map(([id, title]) => ({ type: 'reply', reply: { id, title: fitTitle(title, 20) } })) } },
});

// A list with several titled sections (WhatsApp: 10 rows in total, titles 24, descriptions 72).
export function sectionList(body: string, button: string, sections: { title: string; rows: { id: string; title: string; description?: string }[] }[]) {
  let left = 10;
  const cut = sections.map(sec => { const rows = sec.rows.slice(0, Math.max(0, left)); left -= rows.length; return { title: fitTitle(sec.title, 24), rows: rows.map(r => ({ id: r.id, title: fitTitle(r.title, 24), ...(r.description ? { description: fitTitle(r.description, 72) } : {}) })) }; }).filter(sec => sec.rows.length);
  return { type: 'interactive' as const, interactive: { type: 'list', body: { text: body }, action: { button: fitTitle(button, 20), sections: cut } } };
}

export const list = (body: string, button: string, rows: { id: string; title: string; description?: string }[], sectionTitle = 'Options') => ({
  type: 'interactive' as const,
  interactive: { type: 'list', body: { text: body }, action: { button: fitTitle(button, 20), sections: [{ title: sectionTitle.slice(0, 24), rows: rows.slice(0, 10).map(r => ({ id: r.id, title: fitTitle(r.title, 24), ...(r.description ? { description: fitTitle(r.description, 72) } : {}) })) }] } },
});
