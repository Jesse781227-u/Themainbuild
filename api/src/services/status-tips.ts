// "👟 New in Shoes. Make a Status?": suggested to the owner on its own when new products arrive, a
// sold-out item is back, or a price drops. At most once a day per shop; owners can turn it off
// (STATUS TIPS OFF). Only for shops that are live (not during signup).
import { C } from '../db';
import type { Business } from '../domain/business';
import type { Firestore } from '../lib/firestore';
import { formatKobo } from '../lib/money';
import { lagosDate } from '../lib/time';
import { buttons, notifyOwner, type BotDeps } from '../bots/common';

export type TipReason = { kind: 'new'; name: string; count?: number } | { kind: 'restock'; name: string } | { kind: 'price'; name: string; fromKobo: number; toKobo: number };

export async function suggestStatus(db: Firestore, deps: BotDeps, business: Business, reason: TipReason, target: { productId?: string; categoryId?: string }, now = new Date()) {
  if (business.status !== 'active' || business.statusTips === false || !business.ownerPhone) return false;
  const today = lagosDate(now);
  if (business.lastStatusTipDate === today) return false;
  await db.update(db.doc(C.businesses, business.id), { lastStatusTipDate: today });
  business.lastStatusTipDate = today;
  const text = reason.kind === 'new'
    ? `🆕 ${reason.count && reason.count > 1 ? `${reason.count} new products, including *${reason.name}*` : `*${reason.name}* is new`} in your shop. Make a Status so your customers see it? I'll pick the people most likely to buy.`
    : reason.kind === 'restock'
      ? `🔁 *${reason.name}* is back in stock. Make a Status? I'll pick the customers who wanted it.`
      : `🏷️ *${reason.name}* is now ${formatKobo(reason.toKobo)} (was ${formatKobo(reason.fromKobo)}). Make a Status so your customers see the new price?`;
  const tap = target.productId ? `act:status:p:${target.productId}` : `act:status:c:${target.categoryId}`;
  await notifyOwner(db, deps, business, 'status_tip', text, today, buttons(text, [[tap, 'Make a Status'], ['act:tipsoff', 'Stop these tips'], ['act:menu', 'Menu']]));
  return true;
}
