// Inbound webhook events: parsed from Meta's payload, saved as "pending" (idempotently, keyed by the
// message id), acknowledged, then processed from the queue. Processing claims the event with a short
// lease so a redelivered or re-swept event can't be handled twice at the same time.
import crypto from 'node:crypto';
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { increment } from '../lib/firestore';
import { normalisePhone } from '../lib/phone';

export const EVENT_TTL_DAYS = 30;     // Firestore TTL policy on inboundEvents.expireAt deletes them
export const MAX_ATTEMPTS = 5;
const LEASE_MS = 2 * 60_000;

export interface InboundItem {
  source: 'whatsapp' | 'instagram';
  kind: 'message' | 'echo';
  accountId: string;          // WhatsApp phone_number_id that received it, or the Instagram account id
  messageId: string;
  from: string;               // E.164 for WhatsApp, Instagram-scoped id for Instagram
  contactName: string | null;
  type: string;               // text, image, audio, interactive, …
  text: string | null;
  sentAt: string;
  message: Record<string, unknown>; // the single raw message (media ids, interactive replies, …)
}

export interface InboundEvent extends InboundItem {
  id: string; status: 'pending' | 'processing' | 'processed' | 'failed'; attempts: number;
  receivedAt: string; leaseUntil: string | null; route?: string | null; lastError?: string | null;
}

type Obj = Record<string, any>;
const tsToIso = (t: unknown) => { const n = Number(t); return Number.isFinite(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n).toISOString() : new Date().toISOString(); };

// Extracts customer/owner messages. Status updates (sent/delivered/read) are ignored for now.
export function parseMetaWebhook(body: unknown): InboundItem[] {
  const b = (body ?? {}) as Obj;
  const items: InboundItem[] = [];
  if (b.object === 'whatsapp_business_account') {
    for (const entry of Array.isArray(b.entry) ? b.entry : []) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        const value = change?.value ?? {};
        const accountId = String(value?.metadata?.phone_number_id ?? '');
        if (!accountId) continue;
        if (change.field === 'messages') {
          const names = new Map<string, string>((Array.isArray(value.contacts) ? value.contacts : []).map((c: Obj) => [String(c.wa_id), String(c.profile?.name ?? '')]));
          for (const m of Array.isArray(value.messages) ? value.messages : []) {
            const from = normalisePhone(String(m?.from ?? ''));
            if (!m?.id || !from) continue;
            items.push({ source: 'whatsapp', kind: 'message', accountId, messageId: String(m.id), from, contactName: names.get(String(m.from)) || null, type: String(m.type ?? 'unknown'), text: typeof m.text?.body === 'string' ? m.text.body : null, sentAt: tsToIso(m.timestamp), message: m });
          }
        } else if (change.field === 'smb_message_echoes') {
          // Coexistence: the owner replied from the WhatsApp Business app. This is the owner-takeover
          // signal (Phase 3).
          // TODO(jesse): confirm the smb_message_echoes payload shape against a real test webhook;
          // the field names below are unverified and only used to build an idempotency key.
          for (const m of Array.isArray(value.message_echoes) ? value.message_echoes : []) {
            const to = normalisePhone(String(m?.to ?? ''));
            if (!m?.id || !to) continue;
            items.push({ source: 'whatsapp', kind: 'echo', accountId, messageId: String(m.id), from: to, contactName: null, type: String(m.type ?? 'unknown'), text: typeof m.text?.body === 'string' ? m.text.body : null, sentAt: tsToIso(m.timestamp), message: m });
          }
        }
      }
    }
  } else if (b.object === 'instagram') {
    for (const entry of Array.isArray(b.entry) ? b.entry : []) {
      const accountId = String(entry?.id ?? '');
      for (const ev of Array.isArray(entry?.messaging) ? entry.messaging : []) {
        const m = ev?.message;
        if (!accountId || !m?.mid || m.is_echo || !ev.sender?.id) continue;
        items.push({ source: 'instagram', kind: 'message', accountId, messageId: String(m.mid), from: String(ev.sender.id), contactName: null, type: m.attachments ? String(m.attachments[0]?.type ?? 'attachment') : 'text', text: typeof m.text === 'string' ? m.text : null, sentAt: tsToIso(ev.timestamp), message: m });
      }
    }
  }
  return items;
}

// Message ids can contain characters Firestore ids don't allow; hash them.
export const eventId = (source: string, messageId: string) => crypto.createHash('sha256').update(`${source}:${messageId}`).digest('hex').slice(0, 40);

// Returns the event id if this message is new, or null if it was already saved (a Meta retry).
export async function saveInbound(db: Firestore, item: InboundItem, now = new Date()) {
  const id = eventId(item.source, item.messageId);
  const created = await db.create(db.doc(C.inboundEvents, id), {
    ...item, id, status: 'pending', attempts: 0, receivedAt: now.toISOString(), leaseUntil: null,
    expireAt: new Date(now.getTime() + EVENT_TTL_DAYS * 86_400_000), // Date → Firestore timestamp for the TTL policy
  });
  return created ? id : null;
}

export type Claim = { state: 'claimed'; event: InboundEvent } | { state: 'done' } | { state: 'busy' } | { state: 'missing' };

export async function claimEvent(db: Firestore, id: string, now = new Date()): Promise<Claim> {
  return db.runTransaction(async tx => {
    const ev = (await tx.get(db.doc(C.inboundEvents, id))) as InboundEvent | null;
    if (!ev) return { state: 'missing' } as const;
    if (ev.status === 'processed' || ev.status === 'failed') return { state: 'done' } as const;
    if (ev.status === 'processing' && ev.leaseUntil && ev.leaseUntil > now.toISOString()) return { state: 'busy' } as const;
    tx.update(db.doc(C.inboundEvents, id), { status: 'processing', leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(), attempts: increment(1) });
    return { state: 'claimed', event: { ...ev, attempts: ev.attempts + 1 } } as const;
  });
}

// Message content is kept only while the event still needs processing (audit decision 21). Once it
// is done (or has finally failed), only the metadata stays, until the TTL deletes it.
const scrubbed = { text: null, message: null, contactName: null };

export const markProcessed = (db: Firestore, id: string, route: string) => db.update(db.doc(C.inboundEvents, id), { status: 'processed', route, leaseUntil: null, processedAt: new Date().toISOString(), ...scrubbed });

export async function markFailed(db: Firestore, ev: InboundEvent, error: unknown) {
  const final = ev.attempts >= MAX_ATTEMPTS;
  // Only the error's first line, never payload data.
  const message = String(error instanceof Error ? error.message : error).split('\n')[0].slice(0, 200);
  await db.update(db.doc(C.inboundEvents, ev.id), { status: final ? 'failed' : 'pending', leaseUntil: null, lastError: message, ...(final ? scrubbed : {}) });
  return final;
}

// Events whose queue message was lost (enqueue failed, or a worker died mid-lease).
export async function findStuckEvents(db: Firestore, now = new Date(), limit = 50) {
  const cutoff = new Date(now.getTime() - LEASE_MS).toISOString();
  const pending = await db.query(C.inboundEvents, [['status', '==', 'pending'], ['receivedAt', '<=', cutoff]], { limit });
  const expired = await db.query(C.inboundEvents, [['status', '==', 'processing'], ['leaseUntil', '<=', now.toISOString()]], { limit });
  return [...pending, ...expired].map(e => e._id);
}
