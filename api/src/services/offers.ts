// Personal offer codes (Smart Reach): one customer, one use, an expiry. Checked at checkout inside
// the order's transaction; reserved by that order, and freed again if it expires or is cancelled.
// offerCodes/{CODE}: { code, businessId, customerId, percentOff | amountOffKobo, expiresAt, usedAt, orderId }
import { z } from 'zod';
import { C } from '../db';
import type { Firestore, Transaction } from '../lib/firestore';
import { randomId } from '../lib/crypto';

export interface OfferCode {
  code: string; businessId: string; customerId: string;
  percentOff: number | null; amountOffKobo: number | null;
  expiresAt: string; usedAt: string | null; orderId: string | null; createdAt: string;
}

export const offerInput = z.object({
  businessId: z.string().min(1).max(64), customerId: z.string().min(1).max(128),
  percentOff: z.number().int().min(1).max(90).nullable().optional(),
  amountOffKobo: z.number().int().min(100).max(100_000_000).nullable().optional(),
  days: z.number().int().min(1).max(90).default(7),
  name: z.string().max(60).nullable().optional(),
}).refine(v => !!v.percentOff !== !!v.amountOffKobo, 'percent or amount, one of them');

const SAFE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const suffix = () => [...randomId(16)].map(ch => SAFE[ch.charCodeAt(0) % SAFE.length]).join('').slice(0, 4);
export const normaliseCode = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
export const looksLikeCode = (s: string) => /^[A-Z]{2,5}-[A-Z0-9]{4}$/.test(normaliseCode(s));

export async function createOfferCode(db: Firestore, raw: z.input<typeof offerInput>, now = new Date()): Promise<OfferCode> {
  const v = offerInput.parse(raw);
  const prefix = ((v.name ?? '').trim().split(/\s+/)[0].normalize('NFKD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4) || 'GIFT').padEnd(2, 'X');
  for (let i = 0; i < 5; i++) {
    const code = `${prefix}-${suffix()}`;
    const offer: OfferCode = { code, businessId: v.businessId, customerId: v.customerId, percentOff: v.percentOff ?? null, amountOffKobo: v.amountOffKobo ?? null, expiresAt: new Date(now.getTime() + v.days * 86_400_000).toISOString(), usedAt: null, orderId: null, createdAt: now.toISOString() };
    if (await db.create(db.doc(C.offerCodes, code), { ...offer })) return offer;
  }
  throw new Error('OFFER_CODE_COLLISION');
}

export type OfferCheck = { ok: true; offer: OfferCode; discountKobo: number } | { ok: false; reason: 'not_found' | 'not_yours' | 'expired' | 'used' };

export function checkOffer(offer: OfferCode | null, who: { businessId: string; customerId: string }, subtotalKobo: number, now = new Date()): OfferCheck {
  if (!offer || offer.businessId !== who.businessId) return { ok: false, reason: 'not_found' };
  if (offer.customerId !== who.customerId) return { ok: false, reason: 'not_yours' };
  if (offer.usedAt) return { ok: false, reason: 'used' };
  if (offer.expiresAt <= now.toISOString()) return { ok: false, reason: 'expired' };
  const off = offer.percentOff ? Math.floor((subtotalKobo * offer.percentOff) / 100) : Math.min(offer.amountOffKobo ?? 0, subtotalKobo);
  return { ok: true, offer, discountKobo: Math.max(0, Math.min(off, subtotalKobo)) };
}

export async function lookOffer(db: Firestore, code: string) {
  return (await db.get(db.doc(C.offerCodes, normaliseCode(code)))) as OfferCode | null;
}

// Inside checkout's transaction.
export async function redeemOffer(tx: Transaction, db: Firestore, code: string, who: { businessId: string; customerId: string; orderId: string }, subtotalKobo: number, now: Date) {
  const offer = (await tx.get(db.doc(C.offerCodes, normaliseCode(code)))) as OfferCode | null;
  const r = checkOffer(offer, who, subtotalKobo, now);
  if (!r.ok) throw new Error(`OFFER_${r.reason.toUpperCase()}`);
  tx.update(db.doc(C.offerCodes, r.offer.code), { usedAt: now.toISOString(), orderId: who.orderId });
  return r;
}

// The order didn't go through: the code can be used again (until it expires).
export function freeOffer(tx: Transaction, db: Firestore, order: { offerCode?: string | null; id: string }) {
  if (order.offerCode) tx.update(db.doc(C.offerCodes, order.offerCode), { usedAt: null, orderId: null });
}

export const offerReason = (r: Exclude<OfferCheck, { ok: true }>['reason']) =>
  ({ not_found: "That code doesn't exist.", not_yours: 'That code belongs to someone else.', expired: 'That code has expired.', used: 'That code has already been used.' })[r];
