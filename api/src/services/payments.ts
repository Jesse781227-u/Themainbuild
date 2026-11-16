import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { formatKobo } from '../lib/money';
import type { Business } from '../domain/business';
import type { Payment } from '../domain/commerce';
import type { BachsPaymentEvent } from './bachs';
import { applyPaid } from './on-paid';
import { claimId } from './orders';
import { adminConversationId } from './conversations';

export type PaymentOutcome =
  | { status: 'duplicate' }
  | { status: 'matched' | 'late'; orderId: string; outboxIds: string[] }
  | { status: 'unmatched'; outboxIds: string[] };

// Records a Bachs payment exactly once (keyed by Bachs's reference) and, if the amount matches one of
// the receiving business's claimed amounts, runs the on-paid pipeline in the same transaction.
export async function recordBachsPayment(db: Firestore, p: BachsPaymentEvent): Promise<PaymentOutcome> {
  const paymentId = `bachs_${p.providerRef.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const [business] = (await db.query(C.businesses, [['bachsAccountId', '==', p.accountId]], { limit: 1 })) as unknown as (Business & { _id: string })[];
  const businessId = business?._id ?? null;

  return db.runTransaction(async tx => {
    if (await tx.get(db.doc(C.payments, paymentId))) return { status: 'duplicate' } as const;
    const claim = businessId ? await tx.get(db.doc(C.amountClaims, claimId(businessId, p.amountKobo))) : null;
    const paid = claim ? await applyPaid(tx, db, String(claim.orderId), { paymentId, paidAt: p.paidAt }) : null;
    const matched = paid?.applied ? paid : null;
    const status: Payment['status'] = matched ? (matched.late ? 'late' : 'matched') : 'unmatched';
    const payment: Payment = { id: paymentId, businessId, provider: 'bachs', providerRef: p.providerRef, amountKobo: p.amountKobo, orderId: matched?.order.id ?? null, status, receivedAt: new Date().toISOString() };
    tx.create(db.doc(C.payments, paymentId), { ...payment });

    if (matched) return { status, orderId: matched.order.id, outboxIds: matched.outboxIds } as PaymentOutcome;
    // Money arrived that doesn't match an open order: tell the owner so they can sort it out by chat.
    const outboxIds: string[] = [];
    if (business?.ownerPhone) {
      const id = `${paymentId}_unmatched`;
      tx.create(db.doc(C.outbox, id), {
        id, businessId, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone, conversationId: adminConversationId(business.ownerPhone),
        kind: 'owner_payment_unmatched', text: `You received ${formatKobo(p.amountKobo)} via Bachs that doesn't match any open order. Reply with the order number to link it.`,
        status: 'pending', attempts: 0, createdAt: payment.receivedAt,
      });
      outboxIds.push(id);
    }
    return { status: 'unmatched', outboxIds } as PaymentOutcome;
  });
}
