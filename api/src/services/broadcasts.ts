// Broadcasts: an owner sends one update to customers who opted in to marketing messages. The owner
// always sees the audience size and the Meta cost before anything is sent (the Admin Bot asks YES/NO).
// Each recipient becomes one outbox message: free-form if they messaged in the last 24 hours,
// otherwise the approved broadcast template (Y11). Customers opt out by sending STOP.
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import { randomId } from '../lib/crypto';
import { formatKobo } from '../lib/money';
import type { Business } from '../domain/business';
import type { Customer } from '../domain/commerce';
import { customerConversationId } from './conversations';

// only: limit to these customers (e.g. the ones a Status post was aimed at); still opted-in only.
export async function broadcastAudience(db: Firestore, businessId: string, only?: string[] | null) {
  const rows = (await db.query(C.customers, [['businessId', '==', businessId], ['marketingOptIn', '==', true]], { limit: 5000 })) as unknown as (Customer & { channel?: string })[];
  // WhatsApp only: Instagram has no marketing templates.
  const keep = only ? new Set(only) : null;
  return rows.filter(c => c.phone && (c.channel ?? 'whatsapp') === 'whatsapp' && (!keep || keep.has(c.id)));
}

export interface BroadcastQuote { audience: number; capped: boolean; costKobo: number; perMessageKobo: number }

export async function quoteBroadcast(db: Firestore, cfg: Config, businessId: string, only?: string[] | null): Promise<BroadcastQuote | null> {
  if (!cfg.MARKETING_MESSAGE_COST_KOBO) return null;
  const all = await broadcastAudience(db, businessId, only);
  const audience = Math.min(all.length, cfg.BROADCAST_MAX_RECIPIENTS);
  // Upper bound: customers inside their 24-hour window may cost nothing, but we quote the maximum.
  return { audience, capped: all.length > audience, costKobo: audience * cfg.MARKETING_MESSAGE_COST_KOBO, perMessageKobo: cfg.MARKETING_MESSAGE_COST_KOBO };
}

export const quoteText = (q: BroadcastQuote, message: string) =>
  `Send this to ${q.audience} customer${q.audience === 1 ? '' : 's'} who opted in${q.capped ? ' (the limit per broadcast)' : ''}?\n\n"${message}"\n\nEstimated Meta cost: up to ${formatKobo(q.costKobo)} (${formatKobo(q.perMessageKobo)} per message).`;

export async function createBroadcast(db: Firestore, cfg: Config, business: Pick<Business, 'id' | 'name'>, message: string, now = new Date(), only?: string[] | null) {
  const recipients = (await broadcastAudience(db, business.id, only)).slice(0, cfg.BROADCAST_MAX_RECIPIENTS);
  const id = randomId(9).replace(/[^A-Za-z0-9]/g, 'x');
  const at = now.toISOString();
  const text = `${message}\n\n${business.name}. Reply STOP to stop these messages.`;
  const outboxIds: string[] = [];
  // Firestore commits hold up to 500 writes.
  for (let i = 0; i < recipients.length; i += 400) {
    const batch = db.batch();
    for (const c of recipients.slice(i, i + 400)) {
      const mid = `${id}_${c.id}`;
      batch.create(db.doc(C.outbox, mid), {
        id: mid, businessId: business.id, audience: 'customer', channel: 'whatsapp', to: c.phone, conversationId: customerConversationId(business.id, 'whatsapp', c.phone),
        kind: 'broadcast', broadcastId: id, text, status: 'pending', attempts: 0, createdAt: at,
        // Template body (Y11): {{1}} business name, {{2}} the owner's message.
        template: { key: 'broadcast', params: [business.name, message] },
      });
      outboxIds.push(mid);
    }
    await batch.commit();
  }
  await db.create(db.doc(C.broadcasts, id), { id, businessId: business.id, message, recipients: outboxIds.length, estimatedCostKobo: outboxIds.length * (cfg.MARKETING_MESSAGE_COST_KOBO ?? 0), createdAt: at });
  return { id, outboxIds };
}

// A wa.me link with a prefilled message: free to share in WhatsApp Status, groups or on Instagram.
export function shopLink(displayNumber: string | null | undefined, text: string) {
  const digits = String(displayNumber ?? '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : null;
}
