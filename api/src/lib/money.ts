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

// bps/capKobo: Relay's own fee. processorBps/processorCapKobo: what Bachs takes for processing the
// payment, passed on as it is (Relay keeps none of it). Owners and customers only ever see the sum
// ("4.5%"); the split is for Relay's books.
export interface FeePolicy { bps: number; capKobo: number; processorBps?: number; processorCapKobo?: number }
export const DEFAULT_FEE: FeePolicy = { bps: 300, capKobo: 200_000, processorBps: 150, processorCapKobo: 200_000 }; // Relay 3% + Bachs 1.5%, each capped at ₦2,000

// A percentage of an amount, capped, rounded half-up to the kobo. With a policy, Relay's fee.
export function feeKobo(subtotalKobo: number, policy: Pick<FeePolicy, 'bps' | 'capKobo'> = DEFAULT_FEE) {
  if (!Number.isSafeInteger(subtotalKobo) || subtotalKobo <= 0) return 0;
  return Math.min(Math.floor((subtotalKobo * policy.bps + 5_000) / 10_000), policy.capKobo);
}

// An order's fees. Relay's is on the goods only (never delivery). Bachs takes its share of the whole
// transfer: goods and delivery, and, when the customer pays the fees on top, the fees as well, so
// its share is grossed up (fee = rate × everything the customer sends). total is what the customer
// or the owner pays.
export function orderFees(goodsKobo: number, deliveryKobo: number, policy: FeePolicy = DEFAULT_FEE, customerPays = false) {
  const relay = feeKobo(goodsKobo, policy);
  const p = policy.processorBps ?? 0;
  const base = Math.max(0, goodsKobo) + Math.max(0, deliveryKobo) + (customerPays ? relay : 0);
  const cap = policy.processorCapKobo ?? Number.MAX_SAFE_INTEGER;
  const processor = !p || base <= 0 ? 0 : customerPays
    ? Math.min(Math.floor((base * p + (10_000 - p) / 2) / (10_000 - p)), cap)
    : feeKobo(base, { bps: p, capKobo: cap });
  return { relay, processor, total: relay + processor };
}

// "4.5%" from basis points.
export const pct = (bps: number) => `${bps / 100}%`;
