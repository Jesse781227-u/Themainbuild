// The one way Relay sends messages. It enforces Meta's 24-hour customer service window: free-form
// messages (text, media, interactive) are only allowed within 24 hours of the person's last inbound
// message; outside it only an approved template may be sent.
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import { decrypt } from '../lib/crypto';
import { log } from '../lib/logger';
import { maskPhone, toWaId } from '../lib/phone';

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export type OutboundContent =
  | { type: 'text'; text: string }
  | { type: 'image'; link: string; caption?: string }
  | { type: 'interactive'; interactive: Record<string, unknown> }
  | { type: 'template'; name: string; language: string; components?: unknown[] };

export function windowOpen(lastInboundAt: string | null | undefined, now = new Date()) {
  if (!lastInboundAt) return false;
  const age = now.getTime() - new Date(lastInboundAt).getTime();
  return age >= 0 && age < WINDOW_MS;
}

export class WindowClosedError extends Error {
  constructor() { super('WINDOW_CLOSED: more than 24 hours since the last inbound message; only a template can be sent.'); }
}

export interface Sender { phoneNumberId: string; accessToken: string }
export interface Transport { sendWhatsApp(sender: Sender, toE164: string, content: OutboundContent): Promise<{ messageId: string }> }

// WhatsApp Cloud API: POST /{phone-number-id}/messages.
export function graphTransport(cfg: Pick<Config, 'META_GRAPH_VERSION'>, doFetch: typeof fetch = (...a) => fetch(...a)): Transport {
  return {
    async sendWhatsApp(sender, to, content) {
      const { type, ...rest } = content;
      const payload = type === 'template'
        ? { name: (rest as { name: string }).name, language: { code: (rest as { language: string }).language }, ...((rest as { components?: unknown[] }).components ? { components: (rest as { components?: unknown[] }).components } : {}) }
        : type === 'text' ? { body: (rest as { text: string }).text, preview_url: false }
        : type === 'image' ? rest
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
  };
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

export async function send(db: Firestore, cfg: Config, transport: Transport, args: {
  from: { adminBot: true } | { businessId: string }; conversationId: string; to: string; content: OutboundContent; now?: Date;
}) {
  const conversation = await db.get(db.doc(C.conversations, args.conversationId));
  if (args.content.type !== 'template' && !windowOpen(conversation?.lastInboundAt as string | null, args.now)) throw new WindowClosedError();
  const sender = await resolveSender(db, cfg, args.from);
  const result = await transport.sendWhatsApp(sender, args.to, args.content);
  log('info', 'message_sent', { conversationId: args.conversationId, to: maskPhone(args.to), type: args.content.type });
  return result;
}
