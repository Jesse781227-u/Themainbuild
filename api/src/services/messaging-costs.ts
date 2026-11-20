// WhatsApp's message rules and prices for Smart Reach, in one place (Nov 2026). Values come from
// config so they can change without code changes. Prices are what Meta charges the shop's number;
// the owner pays them at cost from the wallet (Smart Reach Q2), Relay adds nothing.
//   service    free-form reply inside the 24h window: free up to SERVICE_FREE_PER_MONTH per number
//   marketing  template: always charged
//   utility    template (receipts, updates outside the window): charged
//   free entry a customer who came from a click-to-WhatsApp ad / Page button: free for FREE_ENTRY_WINDOW_HOURS
//   owner-sent the owner sends it from the WhatsApp Business app: not an API message (OWNER_SENT_FREE)
import type { Config } from '../config';
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { increment } from '../lib/firestore';

export type MessageCategory = 'service' | 'marketing' | 'utility';

export interface MessagingRules {
  windowHours: number; freeEntryHours: number; serviceFreePerMonth: number; ownerSentFree: boolean;
  weeklyCap: number; quietFrom: number; quietTo: number;          // Lagos hours, e.g. 21 → 8
  regularMinOrders: number; regularWithinDays: number; ownerBatch: number;
  koboPer: Record<MessageCategory, number>; placeholder: Record<MessageCategory, boolean>;
}

export function messagingRules(cfg: Config): MessagingRules {
  const kobo = (usd: number) => Math.round(usd * cfg.NGN_PER_USD * 100);
  return {
    windowHours: 24, freeEntryHours: cfg.FREE_ENTRY_WINDOW_HOURS, serviceFreePerMonth: cfg.SERVICE_FREE_PER_MONTH, ownerSentFree: cfg.OWNER_SENT_FREE !== 'false',
    weeklyCap: cfg.REACH_WEEKLY_CAP, quietFrom: cfg.REACH_QUIET_FROM, quietTo: cfg.REACH_QUIET_TO,
    regularMinOrders: 3, regularWithinDays: 90, ownerBatch: 30,
    koboPer: { marketing: kobo(cfg.MARKETING_USD), utility: kobo(cfg.UTILITY_USD), service: kobo(cfg.SERVICE_USD) },
    // Utility and service prices aren't confirmed yet: the route plan says "estimated" for them.
    placeholder: { marketing: false, utility: cfg.UTILITY_USD_IS_PLACEHOLDER !== 'false', service: cfg.SERVICE_USD_IS_PLACEHOLDER !== 'false' },
  };
}

// Lagos hour (UTC+1, no daylight saving).
export const lagosHour = (now: Date) => (now.getUTCHours() + 1) % 24;
export const inQuietHours = (r: Pick<MessagingRules, 'quietFrom' | 'quietTo'>, now: Date) => { const h = lagosHour(now); return r.quietFrom > r.quietTo ? h >= r.quietFrom || h < r.quietTo : h >= r.quietFrom && h < r.quietTo; };
// The next end of quiet hours (08:00 Lagos).
export function quietEnds(r: Pick<MessagingRules, 'quietTo'>, now: Date) {
  const lagos = new Date(now.getTime() + 3_600_000);
  const end = new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate(), r.quietTo - 1, 0, 0));
  if (end <= now) end.setUTCDate(end.getUTCDate() + 1);
  return end;
}
export const monthKey = (now: Date) => { const l = new Date(now.getTime() + 3_600_000); return `${l.getUTCFullYear()}-${String(l.getUTCMonth() + 1).padStart(2, '0')}`; };

// Every free-form message a shop number sends counts toward its free monthly allowance.
export const countServiceMessage = (db: Firestore, businessId: string, now = new Date()) =>
  db.set(db.doc(C.serviceUsage, `${businessId}_${monthKey(now)}`), { businessId, month: monthKey(now), count: increment(1), updatedAt: now.toISOString() }, { merge: true });
