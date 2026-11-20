// What Meta reports after a send: delivered / read / failed (the `statuses` in the webhook), and the
// review result of each marketing template (message_template_status_update).
//   • outbox.deliveryStatus moves forward only (sent → delivered → read; failed is final)
//   • a Smart Reach send follows it, so reports can show delivered/read and drop failures
//   • a failed paid send gives its cost back to the wallet (Meta doesn't charge failures), once
//   • error 131050 = the customer turned off marketing messages in WhatsApp → they're opted out
//   • a template approved/rejected for a shop's WhatsApp account updates templateStatus
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { log } from '../lib/logger';
import { optOut, type Send } from './reach';
import { setTemplateState, type TemplateState } from './templates';

type Obj = Record<string, any>;
export type Delivery = 'sent' | 'delivered' | 'read' | 'failed';
export interface StatusEvent { messageId: string; status: Delivery; at: string; code: number | null }
const RANK: Record<Delivery, number> = { sent: 1, delivered: 2, read: 3, failed: 9 };
export const MARKETING_TURNED_OFF = 131050;

const iso = (t: unknown) => { const n = Number(t); return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString(); };

export function parseStatuses(body: unknown): StatusEvent[] {
  const b = (body ?? {}) as Obj;
  if (b.object !== 'whatsapp_business_account') return [];
  const out: StatusEvent[] = [];
  for (const entry of Array.isArray(b.entry) ? b.entry : []) for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
    for (const s of Array.isArray(change?.value?.statuses) ? change.value.statuses : []) {
      if (!s?.id || !(s.status in RANK)) continue;
      const e = Array.isArray(s.errors) ? s.errors[0] : undefined;
      out.push({ messageId: String(s.id), status: s.status, at: iso(s.timestamp), code: typeof e?.code === 'number' ? e.code : null });
    }
  }
  return out;
}

export function parseTemplateUpdates(body: unknown): { wabaId: string; name: string; status: TemplateState; reason: string | null }[] {
  const b = (body ?? {}) as Obj;
  if (b.object !== 'whatsapp_business_account') return [];
  const map: Record<string, TemplateState> = { APPROVED: 'approved', REJECTED: 'rejected', PENDING: 'pending', DISABLED: 'rejected', PAUSED: 'pending' };
  const out: { wabaId: string; name: string; status: TemplateState; reason: string | null }[] = [];
  for (const entry of Array.isArray(b.entry) ? b.entry : []) for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
    if (change?.field !== 'message_template_status_update') continue;
    const v = change.value ?? {};
    const status = map[String(v.event ?? '').toUpperCase()];
    if (!status || !v.message_template_name || !entry?.id) continue;
    out.push({ wabaId: String(entry.id), name: String(v.message_template_name), status, reason: v.reason && v.reason !== 'NONE' ? String(v.reason).slice(0, 200) : null });
  }
  return out;
}

export async function applyStatuses(db: Firestore, events: StatusEvent[]) {
  let applied = 0;
  for (const ev of events) {
    const [m] = await db.query(C.outbox, [['providerMessageId', '==', ev.messageId]], { limit: 1 });
    if (!m) continue; // not ours, or the send isn't recorded yet (a later status will be)
    const before = (m.deliveryStatus as Delivery | undefined) ?? 'sent';
    if (RANK[ev.status] <= RANK[before] || before === 'failed') continue;
    await db.update(db.doc(C.outbox, m._id), { deliveryStatus: ev.status, deliveryAt: ev.at, ...(ev.code ? { deliveryError: ev.code } : {}) });
    applied++;
    if (m.kind !== 'reach' || !m._id.startsWith('reach_')) continue;
    const sendId = m._id.slice('reach_'.length);
    const send = (await db.get(db.doc(C.sends, sendId))) as Send | null;
    if (!send) continue;
    await db.update(db.doc(C.sends, sendId), { status: ev.status, ...(ev.status === 'failed' ? { failedCode: ev.code } : {}) });
    if (ev.status !== 'failed') continue;
    if (ev.code === MARKETING_TURNED_OFF) await optOut(db, send.customerId, ev.at);
    if (send.route === 'paid_template' && send.cost > 0) await refundSend(db, send, ev.at);
    log('info', 'reach_send_failed', { businessId: send.businessId, campaignId: send.campaignId, code: ev.code });
  }
  return applied;
}

// A failed paid message: its cost goes back to the shop's wallet, once.
async function refundSend(db: Firestore, send: Send, at: string) {
  await db.runTransaction(async tx => {
    const id = `msgrefund_${send.id}`;
    const [done, wallet] = await tx.getAll([db.doc(C.ledger, id), db.doc(C.wallets, send.businessId)]);
    if (done || !wallet) return;
    tx.create(db.doc(C.ledger, id), { id, businessId: send.businessId, type: 'message_refund', campaignId: send.campaignId, sendId: send.id, amountKobo: send.cost, at });
    tx.update(db.doc(C.wallets, send.businessId), { availableKobo: Number(wallet.availableKobo ?? 0) + send.cost, lifetimeOutKobo: Number(wallet.lifetimeOutKobo ?? 0) - send.cost, updatedAt: at });
  });
}

export async function applyTemplateUpdates(db: Firestore, updates: ReturnType<typeof parseTemplateUpdates>) {
  for (const u of updates) {
    const conns = await db.query(C.whatsappConnections, [['wabaId', '==', u.wabaId]], { limit: 5 });
    for (const c of conns) await setTemplateState(db, String(c.businessId ?? c._id), u.name, u.status, { reason: u.reason });
    log('info', 'template_status', { name: u.name, status: u.status, shops: conns.length });
  }
}
