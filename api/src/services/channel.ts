// The one way Relay sends messages. It enforces Meta's 24-hour customer service window: free-form
// messages (text, media, interactive) are only allowed within 24 hours of the person's last inbound
// message; outside it only an approved template may be sent.
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import { decrypt } from '../lib/crypto';
import { log } from '../lib/logger';
import { maskPhone, toWaId } from '../lib/phone';
import type { CarouselShape } from './carousel';

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export type OutboundContent =
  | { type: 'text'; text: string }
  | { type: 'image'; link: string; caption?: string }
  | { type: 'document'; link: string; filename: string; caption?: string }
  | { type: 'interactive'; interactive: Record<string, unknown> }
  | { type: 'template'; name: string; language: string; components?: unknown[] }
  | { type: 'reaction'; messageId: string; emoji: string }; // an emoji on the person's message ('' removes it)

export function windowOpen(lastInboundAt: string | null | undefined, now = new Date()) {
  if (!lastInboundAt) return false;
  const age = now.getTime() - new Date(lastInboundAt).getTime();
  return age >= 0 && age < WINDOW_MS;
}

export class WindowClosedError extends Error {
  constructor() { super('WINDOW_CLOSED: more than 24 hours since the last inbound message; only a template can be sent.'); }
}

export interface Sender { phoneNumberId: string; accessToken: string }
export interface InstagramSender { igAccountId: string; accessToken: string }
export interface Transport {
  sendWhatsApp(sender: Sender, toE164: string, content: OutboundContent): Promise<{ messageId: string }>;
  sendInstagram(sender: InstagramSender, recipientId: string, text: string): Promise<{ messageId: string }>;
  // Marks their message read and shows "typing…" until we reply (up to 25 seconds).
  markTyping(sender: Sender, messageId: string): Promise<void>;
}

// Interactive messages as plain text, for Instagram (and logs). Options are numbered in the same
// order as optionIds(), so a reply of "2" picks the second option on any channel.
export function optionIds(content: OutboundContent): string[] {
  if (content.type !== 'interactive') return [];
  const i = content.interactive as { type?: string; action?: { buttons?: { reply: { id: string } }[]; sections?: { rows: { id: string }[] }[] } };
  if (i.type === 'button') return (i.action?.buttons ?? []).map(b => b.reply.id);
  if (i.type === 'list') return (i.action?.sections ?? []).flatMap(sec => sec.rows.map(r => r.id));
  // Carousels: a typed number picks that card's first button (Buy), e.g. on Instagram.
  if (i.type === 'carousel') return ((content.interactive as CarouselShape).action?.cards ?? []).map(c => c.action?.buttons?.[0]?.quick_reply?.id ?? '').filter(Boolean);
  return [];
}

export function toText(content: OutboundContent): string {
  if (content.type === 'text') return content.text;
  if (content.type === 'image') return [content.caption, content.link].filter(Boolean).join(NEWLINE);
  if (content.type === 'document') return [content.caption, `${content.filename}: ${content.link}`].filter(Boolean).join(NEWLINE);
  if (content.type === 'template') return `[template ${content.name}]`;
  if (content.type === 'reaction') return content.emoji ? `[reacted ${content.emoji}]` : '[reaction removed]';
  // A link button (e.g. "Pay ₦3,030"): text plus the link, for Instagram and logs.
  if (content.type === 'interactive' && (content.interactive as { type?: string }).type === 'cta_url') {
    const i = content.interactive as { body?: { text?: string }; action?: { parameters?: { display_text?: string; url?: string } } };
    return [i.body?.text ?? '', `${i.action?.parameters?.display_text ?? 'Open'}: ${i.action?.parameters?.url ?? ''}`].filter(Boolean).join(NEWLINE);
  }
  if (content.type === 'interactive' && (content.interactive as { type?: string }).type === 'carousel') {
    const c = content.interactive as CarouselShape;
    const cards = (c.action?.cards ?? []).map((card, n) => `${n + 1}. ${String(card.body?.text ?? '').replace(/\*/g, '').split(NEWLINE).filter(Boolean).join(' · ')}`);
    return [c.body?.text ?? '', ...cards, cards.length ? (c.action?.cards?.[0]?.action?.buttons?.[0]?.quick_reply?.id?.startsWith('buy:') ? 'Reply with a number to buy.' : 'Reply with a number to choose.') : ''].filter(Boolean).join(NEWLINE);
  }
  const i = content.interactive as { body?: { text?: string }; action?: { buttons?: { reply: { title: string } }[]; sections?: { title?: string; rows: { title: string; description?: string }[] }[] } };
  const titles = i.action?.buttons ? i.action.buttons.map(b => b.reply.title) : (i.action?.sections ?? []).flatMap(sec => sec.rows.map(r => (r.description ? `${r.title} (${r.description})` : r.title)));
  return [i.body?.text ?? '', ...titles.map((t, n) => `${n + 1}. ${t}`), titles.length ? 'Reply with a number.' : ''].filter(Boolean).join(NEWLINE);
}
const NEWLINE = String.fromCharCode(10);

// WhatsApp Cloud API: POST /{phone-number-id}/messages.
export function graphTransport(cfg: Pick<Config, 'META_GRAPH_VERSION' | 'INSTAGRAM_GRAPH_HOST'>, doFetch: typeof fetch = (...a) => fetch(...a)): Transport {
  return {
    async sendWhatsApp(sender, to, content) {
      const { type, ...rest } = content;
      const payload = type === 'template'
        ? { name: (rest as { name: string }).name, language: { code: (rest as { language: string }).language }, ...((rest as { components?: unknown[] }).components ? { components: (rest as { components?: unknown[] }).components } : {}) }
        : type === 'text' ? { body: (rest as { text: string }).text, preview_url: false }
        : type === 'image' || type === 'document' ? rest
        : type === 'reaction' ? { message_id: (rest as { messageId: string }).messageId, emoji: (rest as { emoji: string }).emoji }
        : (rest as { interactive: unknown }).interactive;
      const res = await doFetch(`https://graph.facebook.com/${cfg.META_GRAPH_VERSION}/${sender.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sender.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: toWaId(to), type, [type]: payload }),
      });
      const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { code?: number; message?: string } };
      if (!res.ok || !json.messages?.[0]?.id) throw new Error(`META_SEND_FAILED: ${res.status} ${json.error?.code ?? ''}`.trim());
      return { messageId: json.messages[0].id };
    },
    async markTyping(sender, messageId) {
      const res = await doFetch(`https://graph.facebook.com/${cfg.META_GRAPH_VERSION}/${sender.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sender.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } }),
      });
      if (!res.ok) throw new Error(`META_TYPING_FAILED: ${res.status}`);
    },
    // TODO(jesse): verify against the approved Instagram messaging setup (see INSTAGRAM_GRAPH_HOST).
    async sendInstagram(sender, recipientId, text) {
      const res = await doFetch(`https://${cfg.INSTAGRAM_GRAPH_HOST}/${cfg.META_GRAPH_VERSION}/${sender.igAccountId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sender.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
      });
      const json = (await res.json().catch(() => ({}))) as { message_id?: string; error?: { code?: number } };
      if (!res.ok || !json.message_id) throw new Error(`INSTAGRAM_SEND_FAILED: ${res.status} ${json.error?.code ?? ''}`.trim());
      return { messageId: json.message_id };
    },
  };
}

// Development only (config refuses it elsewhere): prints messages instead of sending them.
export function logTransport(): Transport {
  let n = 0;
  return {
    async sendWhatsApp(sender, to, content) { console.log(`[send:log] whatsapp ${sender.phoneNumberId} → ${maskPhone(to)}\n${toText(content)}`); return { messageId: `log.${++n}` }; },
    async sendInstagram(sender, to, text) { console.log(`[send:log] instagram ${sender.igAccountId} → ${to}\n${text}`); return { messageId: `log.${++n}` }; },
    async markTyping() { /* shown in the /dev chat via devMessages */ },
  };
}

export const transportFor = (cfg: Config, doFetch?: typeof fetch) => (cfg.META_SEND_MODE === 'log' ? logTransport() : graphTransport(cfg, doFetch));

// Meta media (voice notes, photos): GET /{media-id} gives a short-lived URL that also needs the token.
export async function downloadMedia(cfg: Pick<Config, 'META_GRAPH_VERSION'>, accessToken: string, mediaId: string, doFetch: typeof fetch = (...a) => fetch(...a)) {
  const meta = await doFetch(`https://graph.facebook.com/${cfg.META_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!meta.ok) throw new Error(`MEDIA_LOOKUP_FAILED: ${meta.status}`);
  const { url, mime_type } = (await meta.json()) as { url: string; mime_type?: string };
  const file = await doFetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!file.ok) throw new Error(`MEDIA_DOWNLOAD_FAILED: ${file.status}`);
  return { bytes: await file.arrayBuffer(), mimeType: mime_type ?? file.headers.get('content-type') ?? 'application/octet-stream' };
}

// Which number a message goes out from: the Relay Admin Bot, or the merchant's own number.
export async function resolveSender(db: Firestore, cfg: Config, from: { adminBot: true } | { businessId: string }): Promise<Sender> {
  if ('adminBot' in from) {
    if (!cfg.ADMIN_BOT_PHONE_NUMBER_ID || !cfg.ADMIN_BOT_ACCESS_TOKEN) throw new Error('ADMIN_BOT_NOT_CONFIGURED');
    return { phoneNumberId: cfg.ADMIN_BOT_PHONE_NUMBER_ID, accessToken: cfg.ADMIN_BOT_ACCESS_TOKEN };
  }
  const conn = await db.get(db.doc(C.whatsappConnections, from.businessId));
  if (!conn || conn.status !== 'connected' || !conn.accessTokenEncrypted) throw new Error('WHATSAPP_NOT_CONNECTED');
  return { phoneNumberId: String(conn.phoneNumberId), accessToken: decrypt(String(conn.accessTokenEncrypted), cfg) };
}

export async function resolveInstagramSender(db: Firestore, cfg: Config, businessId: string): Promise<InstagramSender> {
  const conn = await db.get(db.doc(C.instagramConnections, businessId));
  if (!conn || conn.status !== 'connected' || !conn.accessTokenEncrypted) throw new Error('INSTAGRAM_NOT_CONNECTED');
  return { igAccountId: String(conn.igAccountId), accessToken: decrypt(String(conn.accessTokenEncrypted), cfg) };
}

export async function send(db: Firestore, cfg: Config, transport: Transport, args: {
  from: { adminBot: true } | { businessId: string }; conversationId: string; to: string; content: OutboundContent; now?: Date;
}) {
  const conversation = await db.get(db.doc(C.conversations, args.conversationId));
  if (args.content.type !== 'template' && !windowOpen(conversation?.lastInboundAt as string | null, args.now)) throw new WindowClosedError();
  if (conversation?.channel === 'instagram' && 'businessId' in args.from) {
    const sender = await resolveInstagramSender(db, cfg, args.from.businessId);
    const result = await transport.sendInstagram(sender, args.to, toText(args.content));
    log('info', 'message_sent', { conversationId: args.conversationId, channel: 'instagram', type: args.content.type });
    return result;
  }
  const sender = await resolveSender(db, cfg, args.from);
  const result = await transport.sendWhatsApp(sender, args.to, args.content);
  log('info', 'message_sent', { conversationId: args.conversationId, to: maskPhone(args.to), type: args.content.type });
  // Local testing: keep what would have been sent, so the /dev chat page can show it.
  if (cfg.RELAY_ENV === 'development' && cfg.META_SEND_MODE === 'log') {
    const at = (args.now ?? new Date()).toISOString();
    await db.set(db.doc(C.devMessages, `${at}_${crypto.randomUUID()}`), { phone: args.to, botNumber: sender.phoneNumberId, direction: 'out', content: args.content, at });
  }
  return result;
}
