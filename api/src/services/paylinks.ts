// Simulated payments (PAYMENTS_MODE=simulated): until Bachs is wired in, checkout sends the customer
// a "Pay ₦X" link to a test payment page. Paying there runs the real on-paid pipeline (order paid,
// stock kept, the shop's thank-you to the customer, the owner's "Paid" alert); only the money is
// pretend. Never available in production (config refuses it).
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import { randomId } from '../lib/crypto';
import { formatKobo } from '../lib/money';
import type { Order } from '../domain/commerce';
import type { OutboundContent } from './channel';
import { markOrderPaid, type PaidResult } from './on-paid';

export interface PayLink { token: string; orderId: string; businessId: string; expiresAt: string; createdAt: string; paidAt?: string | null }

export async function createPayLink(db: Firestore, order: Pick<Order, 'id' | 'businessId' | 'holdExpiresAt'>) {
  const token = randomId(18).replace(/[^A-Za-z0-9]/g, 'x');
  const link: PayLink = { token, orderId: order.id, businessId: order.businessId, expiresAt: order.holdExpiresAt, createdAt: new Date().toISOString(), paidAt: null };
  await db.create(db.doc(C.payLinks, token), { ...link });
  return link;
}

export const payUrl = (cfg: Pick<Config, 'API_BASE_URL'>, token: string) => `${cfg.API_BASE_URL}/pay/${token}`;

// The checkout message: order summary and a button that opens the payment page.
export function payMessage(cfg: Pick<Config, 'API_BASE_URL'>, order: Pick<Order, 'ref' | 'items' | 'payAmountKobo' | 'holdExpiresAt'>, token: string, minutes: number, intro?: string): OutboundContent {
  const items = order.items.map(l => `${l.qty} × ${l.name}`).join('\n');
  return {
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: `${intro ? `${intro}\n\n` : ''}Order ${order.ref}\n${items}\n\nTotal: *${formatKobo(order.payAmountKobo)}*\n\nTap below to pay securely. We're holding your items for ${minutes} minutes.` },
      footer: { text: 'Test payment: no real money moves' },
      action: { name: 'cta_url', parameters: { display_text: `Pay ${formatKobo(order.payAmountKobo)}`.slice(0, 20), url: payUrl(cfg, token) } },
    },
  };
}

export type PayOutcome = { ok: true; result: PaidResult & { applied: true } } | { ok: false; reason: 'not_found' | 'expired' | 'already_paid' | 'cancelled' };

// "Pay" on the test page. Idempotent: paying twice, or after it was paid another way, changes nothing.
export async function paySimulated(db: Firestore, token: string, now = new Date()): Promise<PayOutcome> {
  const link = (await db.get(db.doc(C.payLinks, token))) as PayLink | null;
  if (!link) return { ok: false, reason: 'not_found' };
  const order = (await db.get(db.doc(C.orders, link.orderId))) as Order | null;
  if (!order) return { ok: false, reason: 'not_found' };
  if (order.status === 'paid') return { ok: false, reason: 'already_paid' };
  if (order.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (order.status === 'expired' || link.expiresAt <= now.toISOString()) return { ok: false, reason: 'expired' };
  const result = await markOrderPaid(db, order.id, order.businessId, `sim_${token}`, now.toISOString());
  if (!result.applied) return { ok: false, reason: result.reason === 'already_paid' ? 'already_paid' : result.reason === 'cancelled' ? 'cancelled' : 'not_found' };
  await db.update(db.doc(C.payLinks, token), { paidAt: now.toISOString() });
  return { ok: true, result };
}
