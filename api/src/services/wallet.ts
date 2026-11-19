// The shop's Relay wallet: Relay holds the money customers pay until the owner withdraws it.
//   sale (on-paid.ts)  → available += what the shop receives (order total − Relay's fee if the owner pays it)
//   withdraw           → available −= amount, a payout to the owner's verified bank account
//   payout failed      → the amount goes back
// Money is available as soon as it's paid. Payouts: no fee, ₦1,000 minimum, ₦500,000 a day by
// default (per-shop override), and only after the owner is verified (KYC, once).
// Moving real money: TODO(jesse) the Bachs payouts API. Until then nothing is sent automatically
// (fail closed): each request is sent to Relay's support number and someone marks it paid or failed
// (routes/internal.ts). With simulated payments (test mode) a payout is "paid" at once, pretend money.
import { C } from '../db';
import type { Config } from '../config';
import type { Business } from '../domain/business';
import type { Firestore } from '../lib/firestore';
import { decrypt, encrypt, randomId } from '../lib/crypto';
import { formatKobo } from '../lib/money';
import { lagosDate } from '../lib/time';

export const MIN_PAYOUT_KOBO = 100_000;            // ₦1,000
export const DEFAULT_DAILY_LIMIT_KOBO = 50_000_000; // ₦500,000

export interface Wallet { businessId: string; availableKobo: number; lifetimeInKobo: number; lifetimeOutKobo: number; payoutDay: string | null; payoutDayKobo: number; initialised: boolean; updatedAt: string }
export interface Payout {
  id: string; businessId: string; amountKobo: number;
  bank: { name: string; last4: string; accountName: string };
  status: 'processing' | 'paid' | 'failed'; reference: string | null; reason: string | null;
  createdAt: string; settledAt: string | null;
}
// What the owner gave once to be paid out. BVN and account number are encrypted; only the last 4
// digits are kept readable (for "GTBank ••6789").
export interface Kyc {
  businessId: string; status: 'pending_review' | 'verified' | 'rejected';
  legalName: string; bankName: string; accountLast4: string; accountName: string;
  bvnEnc: string; accountEnc: string; bvnLast4: string;
  reason: string | null; submittedAt: string; reviewedAt: string | null;
}

const iso = () => new Date().toISOString();
export const dailyLimit = (b: Pick<Business, 'payoutDailyLimitKobo'>) => b.payoutDailyLimitKobo ?? DEFAULT_DAILY_LIMIT_KOBO;
export const bankLine = (k: Pick<Kyc, 'bankName' | 'accountLast4' | 'accountName'>) => `${k.bankName} ••${k.accountLast4} (${k.accountName})`;

// The wallet, worked out from the ledger the first time (shops that sold before wallets existed).
export async function getWallet(db: Firestore, businessId: string): Promise<Wallet> {
  const ref = db.doc(C.wallets, businessId);
  const w = (await db.get(ref)) as Wallet | null;
  if (w?.initialised) return w;
  const entries = await db.query(C.ledger, [['businessId', '==', businessId]], { limit: 10_000 });
  let inKobo = 0, outKobo = 0;
  for (const e of entries) {
    if (e.type === 'sale') inKobo += Number(e.merchantNetKobo ?? 0);
    if (e.type === 'payout') outKobo += Number(e.amountKobo ?? 0);
    if (e.type === 'payout_reversal') outKobo -= Number(e.amountKobo ?? 0);
  }
  const fresh: Wallet = { businessId, availableKobo: inKobo - outKobo, lifetimeInKobo: inKobo, lifetimeOutKobo: outKobo, payoutDay: w?.payoutDay ?? null, payoutDayKobo: w?.payoutDayKobo ?? 0, initialised: true, updatedAt: iso() };
  await db.set(ref, { ...fresh });
  return fresh;
}

// How much can go out today, after the daily limit.
export function withdrawable(w: Wallet, business: Pick<Business, 'payoutDailyLimitKobo'>, now = new Date()) {
  const used = w.payoutDay === lagosDate(now) ? w.payoutDayKobo : 0;
  return Math.max(0, Math.min(w.availableKobo, dailyLimit(business) - used));
}

export async function getKyc(db: Firestore, businessId: string) {
  return (await db.get(db.doc(C.kyc, businessId))) as Kyc | null;
}

export async function saveKyc(db: Firestore, cfg: Pick<Config, 'RELAY_ENV' | 'TOKEN_ENCRYPTION_KEY' | 'PAYMENTS_MODE'>, businessId: string, d: { legalName: string; bvn: string; bankName: string; account: string; accountName: string }) {
  // TODO(jesse): confirm the account name with the bank (Bachs name enquiry) and the BVN with a
  // KYC provider. Until then a person at Relay checks it (pending_review); test mode verifies at once.
  const auto = cfg.PAYMENTS_MODE === 'simulated';
  const k: Kyc = {
    businessId, status: auto ? 'verified' : 'pending_review', legalName: d.legalName, bankName: d.bankName,
    accountLast4: d.account.slice(-4), accountName: d.accountName, bvnLast4: d.bvn.slice(-4),
    bvnEnc: encrypt(d.bvn, cfg), accountEnc: encrypt(d.account, cfg), reason: null, submittedAt: iso(), reviewedAt: auto ? iso() : null,
  };
  await db.set(db.doc(C.kyc, businessId), { ...k });
  return k;
}

// For the person at Relay who pays out by hand: the full account number (never in a message or log).
export function kycDetails(cfg: Pick<Config, 'RELAY_ENV' | 'TOKEN_ENCRYPTION_KEY'>, k: Kyc) {
  return { legalName: k.legalName, bankName: k.bankName, accountName: k.accountName, accountNumber: decrypt(k.accountEnc, cfg), bvnLast4: k.bvnLast4, status: k.status };
}

export type PayoutRefusal = 'not_verified' | 'below_minimum' | 'over_balance' | 'over_daily_limit';

// Takes the amount out of the wallet and records the payout, all at once. Returns the payout or why not.
export async function requestPayout(db: Firestore, business: Business, amountKobo: number, now = new Date()): Promise<{ ok: true; payout: Payout } | { ok: false; reason: PayoutRefusal; maxKobo?: number }> {
  const kyc = await getKyc(db, business.id);
  if (kyc?.status !== 'verified') return { ok: false, reason: 'not_verified' };
  if (!Number.isInteger(amountKobo) || amountKobo < MIN_PAYOUT_KOBO) return { ok: false, reason: 'below_minimum' };
  await getWallet(db, business.id); // make sure it's set up before the transaction
  const day = lagosDate(now), at = now.toISOString();
  return db.runTransaction(async tx => {
    const w = (await tx.get(db.doc(C.wallets, business.id))) as unknown as Wallet;
    if (amountKobo > w.availableKobo) return { ok: false as const, reason: 'over_balance' as const, maxKobo: w.availableKobo };
    const max = withdrawable(w, business, now);
    if (amountKobo > max) return { ok: false as const, reason: 'over_daily_limit' as const, maxKobo: max };
    const id = `P-${randomId(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
    const payout: Payout = { id, businessId: business.id, amountKobo, bank: { name: kyc.bankName, last4: kyc.accountLast4, accountName: kyc.accountName }, status: 'processing', reference: null, reason: null, createdAt: at, settledAt: null };
    tx.create(db.doc(C.payouts, id), { ...payout });
    tx.update(db.doc(C.wallets, business.id), { availableKobo: w.availableKobo - amountKobo, lifetimeOutKobo: w.lifetimeOutKobo + amountKobo, payoutDay: day, payoutDayKobo: (w.payoutDay === day ? w.payoutDayKobo : 0) + amountKobo, updatedAt: at });
    tx.create(db.doc(C.ledger, `payout_${id}`), { id: `payout_${id}`, businessId: business.id, type: 'payout', payoutId: id, amountKobo, at });
    return { ok: true as const, payout };
  });
}

// The bank confirmed it (or a person at Relay marked it): paid, or failed and given back.
export async function settlePayout(db: Firestore, businessId: string, id: string, outcome: { status: 'paid'; reference?: string | null } | { status: 'failed'; reason?: string | null }, now = new Date()) {
  const at = now.toISOString();
  return db.runTransaction(async tx => {
    const p = (await tx.get(db.doc(C.payouts, id))) as Payout | null;
    if (!p || p.businessId !== businessId) return { ok: false as const, reason: 'not_found' as const };
    if (p.status !== 'processing') return { ok: false as const, reason: 'already_settled' as const, payout: p };
    if (outcome.status === 'paid') {
      tx.update(db.doc(C.payouts, id), { status: 'paid', reference: outcome.reference ?? null, settledAt: at });
      return { ok: true as const, payout: { ...p, status: 'paid' as const, reference: outcome.reference ?? null, settledAt: at } };
    }
    const w = (await tx.get(db.doc(C.wallets, businessId))) as unknown as Wallet;
    const sameDay = w.payoutDay === lagosDate(new Date(p.createdAt));
    tx.update(db.doc(C.payouts, id), { status: 'failed', reason: outcome.reason ?? null, settledAt: at });
    tx.update(db.doc(C.wallets, businessId), { availableKobo: w.availableKobo + p.amountKobo, lifetimeOutKobo: w.lifetimeOutKobo - p.amountKobo, ...(sameDay ? { payoutDayKobo: Math.max(0, w.payoutDayKobo - p.amountKobo) } : {}), updatedAt: at });
    tx.create(db.doc(C.ledger, `payout_reversal_${id}`), { id: `payout_reversal_${id}`, businessId, type: 'payout_reversal', payoutId: id, amountKobo: p.amountKobo, at });
    return { ok: true as const, payout: { ...p, status: 'failed' as const, reason: outcome.reason ?? null, settledAt: at } };
  });
}

export async function recentPayouts(db: Firestore, businessId: string, limit = 10) {
  return (await db.query(C.payouts, [['businessId', '==', businessId]], { orderBy: [['createdAt', 'desc']], limit })) as unknown as Payout[];
}

export const payoutLine = (p: Payout) => `• ${p.id}: ${formatKobo(p.amountKobo)} to ${p.bank.name} ••${p.bank.last4} · ${p.status === 'processing' ? 'on its way' : p.status === 'paid' ? 'paid ✅' : 'failed, money returned'} · ${new Date(p.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' })}`;
