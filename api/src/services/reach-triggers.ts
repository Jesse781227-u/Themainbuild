// Smart Reach Phase 3: the remaining automatic updates, Relay's daily suggestion and the weekly summary.
//   price_drop           people who looked at / asked about / carted it (60 days) and haven't bought it
//   after_delivery       "hope you love it", a day after delivery (free routes only)
//   first_order_thanks   in the receipt step (on-paid.ts), with the "send me updates" ask
//   usual_order_due      regulars (3+ orders) whose usual gap has passed: OFF until the owner turns it on
//   win_back             no order for 60+ days: OFF until the owner turns it on
// Automatic updates only use free routes; each fires once per cause (the campaign id says which).
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import type { Config } from '../config';
import type { Business } from '../domain/business';
import type { Order, Product } from '../domain/commerce';
import { formatKobo } from '../lib/money';
import { lagosDate } from '../lib/time';
import { adminConversationId } from './conversations';
import { listProducts } from './catalog';
import { recentOrders } from './orders';
import { executeCampaign, planCampaign, TRIGGER_LABEL, triggerOn, type Campaign, type ReachCustomer, type TriggerType } from './reach';
import { campaignResults } from './reach-results';
import { monthKey } from './messaging-costs';
import { activeShops } from './active-shops';

const DAY = 86_400_000;
type Deps = { enqueue: (jobs: { kind: 'outbox'; messageId: string }[]) => Promise<void> };
type Sig = { customerId: string; type: string; productId: string | null; variant: string | null; at: string };

async function fire(db: Firestore, cfg: Config, deps: Deps, business: Business, trigger: TriggerType, input: { id: string; name: string; text: string; button?: [string, string] | null; audience: string[] }, now: Date) {
  if (!input.audience.length) return null;
  const id = input.id.replace(/[^A-Za-z0-9_-]/g, '_');
  const planned = await planCampaign(db, cfg, business, { ...input, id, source: 'trigger', trigger }, now);
  if (!planned.created) return null;
  return executeCampaign(db, cfg, deps, business, id, { freeOnly: true }, now);
}

// Who wanted this product lately and hasn't bought it.
async function interested(db: Firestore, businessId: string, productId: string, now: Date) {
  const since = new Date(now.getTime() - 60 * DAY).toISOString();
  const signals = ((await db.query(C.customerSignals, [['businessId', '==', businessId], ['productId', '==', productId]], { limit: 2000 })) as unknown as Sig[]).filter(s => s.at >= since);
  const wanted = new Set(signals.filter(s => s.type !== 'bought').map(s => s.customerId));
  for (const s of signals) if (s.type === 'bought') wanted.delete(s.customerId);
  return [...wanted];
}

export async function priceDrop(db: Firestore, cfg: Config, deps: Deps, business: Business, product: Pick<Product, 'id' | 'name'>, fromKobo: number, toKobo: number, now = new Date()) {
  if (business.status !== 'active' || toKobo >= fromKobo || !triggerOn(business, 'price_drop')) return null;
  return fire(db, cfg, deps, business, 'price_drop', {
    id: `pd_${product.id}_${toKobo}`, name: `Price drop: ${product.name}`,
    text: `Hi {name}, ${product.name} at ${business.name} is now ${formatKobo(toKobo)} (was ${formatKobo(fromKobo)}) 🎉`,
    button: [`buy:${product.id}`, 'Add to cart'], audience: await interested(db, business.id, product.id, now),
  }, now);
}

// Orders delivered a day ago (or more, up to a week) that haven't had their follow-up.
export async function afterDelivery(db: Firestore, cfg: Config, deps: Deps, now = new Date()) {
  const dayAgo = new Date(now.getTime() - DAY).toISOString(), weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const orders = ((await db.query(C.orders, [['fulfilment', '==', 'delivered']], { limit: 300 })) as unknown as (Order & { deliveredAt?: string | null; afterDeliveryAt?: string | null })[])
    .filter(o => !o.afterDeliveryAt && (o.deliveredAt ?? o.updatedAt) <= dayAgo && (o.deliveredAt ?? o.updatedAt) >= weekAgo);
  let fired = 0;
  const businesses = new Map<string, Business | null>();
  for (const o of orders) {
    await db.update(db.doc(C.orders, o.id), { afterDeliveryAt: now.toISOString() });
    if (!businesses.has(o.businessId)) businesses.set(o.businessId, (await db.get(db.doc(C.businesses, o.businessId))) as Business | null);
    const business = businesses.get(o.businessId);
    if (!business || business.status !== 'active' || !triggerOn(business, 'after_delivery')) continue;
    const item = o.items[0]?.name ?? 'your order';
    const r = await fire(db, cfg, deps, business, 'after_delivery', { id: `ad_${o.id}`, name: 'After delivery', text: `Hi {name}, hope you're enjoying your ${item}! Anything else you need from ${business.name}?`, button: ['menu', 'See what we have'], audience: [o.customerId] }, now);
    if (r?.sent || r?.queued) fired++;
  }
  return fired;
}

// Regulars whose usual gap between orders has passed; and customers gone quiet for 60+ days.
export function dueCustomers(customers: ReachCustomer[], orders: Order[], now = new Date()) {
  const byCustomer = new Map<string, string[]>();
  for (const o of orders) byCustomer.set(o.customerId, [...(byCustomer.get(o.customerId) ?? []), o.paidAt ?? o.createdAt]);
  const usual: { id: string; last: string }[] = [], lapsed: { id: string; last: string }[] = [];
  for (const c of customers) {
    const times = (byCustomer.get(c.id) ?? []).sort();
    const last = times.at(-1) ?? c.lastOrderAt ?? null;
    if (!last) continue;
    const since = (now.getTime() - new Date(last).getTime()) / DAY;
    if (times.length >= 3) {
      const gaps = times.slice(1).map((t, i) => (new Date(t).getTime() - new Date(times[i]).getTime()) / DAY);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      if (avg >= 2 && since >= avg && since < avg * 2) usual.push({ id: c.id, last });
    }
    if (since >= 60 && since < 365) lapsed.push({ id: c.id, last });
  }
  return { usual, lapsed };
}

export async function regularsAndWinBack(db: Firestore, cfg: Config, deps: Deps, business: Business, now = new Date()) {
  const wantUsual = triggerOn(business, 'usual_order_due'), wantBack = triggerOn(business, 'win_back');
  if (business.status !== 'active' || (!wantUsual && !wantBack)) return { usual: 0, winBack: 0 };
  const [customers, orders] = await Promise.all([
    db.query(C.customers, [['businessId', '==', business.id]], { limit: 5000 }) as unknown as Promise<ReachCustomer[]>,
    recentOrders(db, [['businessId', '==', business.id], ['status', '==', 'paid']], 2000),
  ]);
  const { usual, lapsed } = dueCustomers(customers.map(c => ({ ...c, id: c.id ?? (c as unknown as { _id: string })._id })), orders, now);
  let u = 0, w = 0;
  // One update per customer per cycle: the id carries the order it follows.
  if (wantUsual) for (const c of usual) if ((await fire(db, cfg, deps, business, 'usual_order_due', { id: `due_${c.id}_${c.last}`, name: 'Usual order time', text: `Hi {name}! It's about time for your usual from ${business.name}. Want the same again?`, button: ['menu', 'Order again'], audience: [c.id] }, now))?.sent) u++;
  if (wantBack) for (const c of lapsed) if ((await fire(db, cfg, deps, business, 'win_back', { id: `wb_${c.id}_${c.last}`, name: 'Win back', text: `Hi {name}, we miss you at ${business.name}! Come and see what's new.`, button: ['menu', 'See what\'s new'], audience: [c.id] }, now))?.sent) w++;
  return { usual: u, winBack: w };
}

// ── Relay suggests: at most once a day per shop ──
export async function suggestReach(db: Firestore, business: Business, now = new Date()) {
  const today = lagosDate(now);
  if (business.status !== 'active' || !business.ownerPhone || business.lastReachSuggestDate === today) return null;
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  const signals = ((await db.query(C.customerSignals, [['businessId', '==', business.id]], { limit: 5000 })) as unknown as Sig[]).filter(s => s.at >= since && s.productId);
  const bought = new Set(signals.filter(s => s.type === 'bought').map(s => `${s.customerId}|${s.productId}`));
  const people = new Map<string, Set<string>>();
  for (const s of signals) if (['asked', 'viewed', 'carted'].includes(s.type) && !bought.has(`${s.customerId}|${s.productId}`)) people.set(s.productId!, (people.get(s.productId!) ?? new Set()).add(s.customerId));
  const best = [...people].sort((a, b) => b[1].size - a[1].size)[0];
  if (!best || best[1].size < 3) return null;
  const product = (await listProducts(db, business.id)).find(p => p.id === best[0]);
  if (!product) return null;
  await db.update(db.doc(C.businesses, business.id), { lastReachSuggestDate: today });
  business.lastReachSuggestDate = today;
  const id = `${business.id}_reachsug_${today}`;
  await db.create(db.doc(C.outbox, id), {
    id, businessId: business.id, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone, conversationId: adminConversationId(business.ownerPhone), kind: 'reach_suggest',
    text: `💡 ${best[1].size} people looked at *${product.name}* this week but didn't buy. Send them an update?`,
    buttons: [{ id: `act:reachask:${product.id}`, title: 'Write an update' }, { id: 'act:reach', title: 'Smart Reach' }], status: 'pending', attempts: 0, createdAt: now.toISOString(),
  });
  return id;
}

// Everyone the suggestion was about (for "Write an update").
export const interestedIn = interested;

// ── The weekly summary (and this month's message costs) ──
export async function weeklySummary(db: Firestore, businessId: string, now = new Date()) {
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  const campaigns = ((await db.query(C.campaigns, [['businessId', '==', businessId]], { limit: 500 })) as unknown as Campaign[]).filter(c => (c.approvedAt ?? c.createdAt) >= since && ['sent', 'sending'].includes(c.status));
  const byKind = new Map<string, { sent: number; ordered: number; revenueKobo: number }>();
  let sent = 0, ordered = 0, revenueKobo = 0;
  for (const c of campaigns) {
    const r = await campaignResults(db, c.id);
    const key = c.trigger ? TRIGGER_LABEL[c.trigger] : 'Your updates';
    const k = byKind.get(key) ?? { sent: 0, ordered: 0, revenueKobo: 0 };
    byKind.set(key, { sent: k.sent + r.sent, ordered: k.ordered + r.ordered, revenueKobo: k.revenueKobo + r.revenueKobo });
    sent += r.sent; ordered += r.ordered; revenueKobo += r.revenueKobo;
  }
  const best = [...byKind].filter(([, v]) => v.ordered > 0).sort((a, b) => b[1].revenueKobo - a[1].revenueKobo || b[1].ordered - a[1].ordered)[0] ?? null;
  const month = monthKey(now);
  const costs = ((await db.query(C.ledger, [['businessId', '==', businessId], ['type', '==', 'message_cost']], { limit: 500 })) as unknown as { amountKobo: number; at: string }[]).filter(e => monthKey(new Date(e.at)) === month).reduce((t, e) => t + e.amountKobo, 0);
  const text = !sent ? null : [
    `📈 Smart Reach this week: ${sent} sent → ${ordered} ordered → ${formatKobo(revenueKobo)}.`,
    best ? `Best: *${best[0]}* (${best[1].ordered} order${best[1].ordered === 1 ? '' : 's'}, ${formatKobo(best[1].revenueKobo)}).` : '',
    `Message costs this month: ${formatKobo(costs)}.`,
  ].filter(Boolean).join('\n');
  return { sent, ordered, revenueKobo, best: best?.[0] ?? null, costsKobo: costs, text };
}

// Mondays (Lagos): each live shop's summary to the owner, once a week.
export async function weeklySummaries(db: Firestore, now = new Date()) {
  if (new Date(now.getTime() + 3_600_000).getUTCDay() !== 1) return [];
  const week = lagosDate(now);
  const ids: string[] = [];
  for await (const b of activeShops(db)) {
    if (!b.ownerPhone) continue;
    const s = await weeklySummary(db, b.id, now);
    if (!s.text) continue;
    const id = `${b.id}_reachweek_${week}`;
    if (await db.create(db.doc(C.outbox, id), { id, businessId: b.id, audience: 'owner', channel: 'whatsapp', to: b.ownerPhone, conversationId: adminConversationId(b.ownerPhone), kind: 'reach_weekly', text: s.text, buttons: [{ id: 'act:reach', title: 'Smart Reach' }], status: 'pending', attempts: 0, createdAt: now.toISOString() })) ids.push(id);
  }
  return ids;
}

// Daily: Relay's suggestion and the regulars / win-back updates for every live shop.
export async function dailyReach(db: Firestore, cfg: Config, deps: Deps, now = new Date()) {
  const ids: string[] = [];
  for await (const business of activeShops(db)) {
    const s = await suggestReach(db, business, now).catch(() => null);
    if (s) ids.push(s);
    await regularsAndWinBack(db, cfg, deps, business, now).catch(() => null);
  }
  return ids;
}
