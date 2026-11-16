// Messages produced by pipelines (receipts, owner alerts) are written to the outbox in the same
// transaction as the change that caused them, then sent from the queue. A message is sent at most
// once: it is claimed with a lease before sending and marked sent afterwards.
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import { increment } from '../lib/firestore';
import { log } from '../lib/logger';
import type { OutboxMessage } from './on-paid';
import { send, WindowClosedError, type Transport } from './channel';

const LEASE_MS = 2 * 60_000;
export const MAX_SEND_ATTEMPTS = 5;

export type OutboxResult = 'sent' | 'already_done' | 'busy' | 'blocked_window' | 'retry' | 'failed';

export async function processOutbox(db: Firestore, cfg: Config, transport: Transport, id: string, now = new Date()): Promise<OutboxResult> {
  const claimed = await db.runTransaction(async tx => {
    const m = (await tx.get(db.doc(C.outbox, id))) as OutboxMessage | null;
    if (!m || ['sent', 'blocked_window', 'failed'].includes(m.status)) return 'already_done' as const;
    if (m.status === 'sending' && m.leaseUntil && m.leaseUntil > now.toISOString()) return 'busy' as const;
    tx.update(db.doc(C.outbox, id), { status: 'sending', leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(), attempts: increment(1) });
    return { ...m, attempts: m.attempts + 1 };
  });
  if (typeof claimed === 'string') return claimed;

  if (claimed.channel === 'instagram') {
    // TODO(jesse): Instagram sending (Phase 3, C17) needs the IG messaging permission (Y9).
    await db.update(db.doc(C.outbox, id), { status: 'failed', leaseUntil: null, lastError: 'INSTAGRAM_SEND_NOT_IMPLEMENTED' });
    return 'failed';
  }
  try {
    const from = claimed.audience === 'owner' ? { adminBot: true as const } : { businessId: claimed.businessId };
    const { messageId } = await send(db, cfg, transport, { from, conversationId: claimed.conversationId, to: claimed.to, content: { type: 'text', text: claimed.text }, now });
    await db.update(db.doc(C.outbox, id), { status: 'sent', leaseUntil: null, sentAt: new Date().toISOString(), providerMessageId: messageId });
    return 'sent';
  } catch (e) {
    if (e instanceof WindowClosedError) {
      // TODO(jesse): send the approved template instead once Meta approves it (Y11).
      await db.update(db.doc(C.outbox, id), { status: 'blocked_window', leaseUntil: null });
      log('warn', 'outbox_window_closed', { outboxId: id, kind: claimed.kind });
      return 'blocked_window';
    }
    const final = claimed.attempts >= MAX_SEND_ATTEMPTS;
    await db.update(db.doc(C.outbox, id), { status: final ? 'failed' : 'pending', leaseUntil: null, lastError: String(e instanceof Error ? e.message : e).slice(0, 200) });
    log('error', 'outbox_send_failed', { outboxId: id, kind: claimed.kind, attempt: claimed.attempts, error: String(e instanceof Error ? e.message : e).slice(0, 200) });
    return final ? 'failed' : 'retry';
  }
}

export async function findStuckOutbox(db: Firestore, now = new Date(), limit = 50) {
  const cutoff = new Date(now.getTime() - LEASE_MS).toISOString();
  const pending = await db.query(C.outbox, [['status', '==', 'pending'], ['createdAt', '<=', cutoff]], { limit });
  const expired = await db.query(C.outbox, [['status', '==', 'sending'], ['leaseUntil', '<=', now.toISOString()]], { limit });
  return [...pending, ...expired].map(m => m._id);
}
