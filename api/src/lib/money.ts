// All money is integer kobo (₦1 = 100 kobo). Never use floating point for amounts.

export const KOBO_PER_NAIRA = 100;

// Parses "1500", "1,500.5", "₦1,500.50", "N1500" or a number into kobo exactly (no float maths on
// strings). Returns null for anything that isn't a non-negative amount with at most 2 decimals.
export function nairaToKobo(input: string | number): number | null {
  const text = typeof input === 'number' ? (Number.isFinite(input) ? input.toFixed(2) : '') : String(input);
  // "₦2,500", "NGN 2500", "2500 naira", "2.5k" (the AI sometimes writes prices like that).
  let cleaned = text.trim().replace(/^(₦|ngn|n)\s*/i, '').replace(/\s*(naira|ngn)$/i, '').replace(/,/g, '');
  const k = /^(\d+(?:\.\d+)?)k$/i.exec(cleaned);
  if (k) cleaned = String(Math.round(Number(k[1]) * 1000));
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const kobo = Number(m[1]) * KOBO_PER_NAIRA + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(kobo) ? kobo : null;
}

export function formatKobo(kobo: number) {
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(kobo));
  const naira = Math.floor(abs / 100).toLocaleString('en-US');
  const rest = abs % 100;
  return `${sign}₦${naira}${rest ? '.' + String(rest).padStart(2, '0') : ''}`;
}

export interface FeePolicy { bps: number; capKobo: number }
export const DEFAULT_FEE: FeePolicy = { bps: 100, capKobo: 200_000 }; // 1%, capped at ₦2,000

// Relay's fee: a percentage of the goods subtotal only (never the delivery fee), capped, rounded
// half-up to the kobo. The customer pays it on top.
export function feeKobo(subtotalKobo: number, policy: FeePolicy = DEFAULT_FEE) {
  if (!Number.isSafeInteger(subtotalKobo) || subtotalKobo <= 0) return 0;
  return Math.min(Math.floor((subtotalKobo * policy.bps + 5_000) / 10_000), policy.capKobo);
}
