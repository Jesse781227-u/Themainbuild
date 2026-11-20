// Smart Reach (Phase 1): personal marketing that goes by the cheapest allowed route.
//   signals   what each customer viewed, asked about, carted, bought or replied to (ids only)
//   consent   opted in at checkout / SUBSCRIBE, or a customer from before Smart Reach who never said
//             stop (owner's choice); "Stop updates" stops everything at once
//   router    per customer: skip (no consent, reported, weekly cap) · queue (quiet hours) ·
//             open (their 24h window is open and the shop's free allowance has room) ·
//             owner_sent (a regular: the owner sends it from their own WhatsApp via a wa.me link) ·
//             unreachable (would need a paid template: Phase 2)
//   plan      counts per route and the cost, shown to the owner before anything is sent
//   sends     one record per customer per campaign: the source of truth for cost and results
//   triggers  back in stock (people who wanted it), abandoned cart (after an hour, once)
import { C } from '../db';
import type { Config } from '../config';
import type { Business } from '../domain/business';
import type { Customer, Product } from '../domain/commerce';
import type { Firestore } from '../lib/firestore';
import { increment } from '../lib/firestore';
import { randomId } from '../lib/crypto';
import { formatKobo } from '../lib/money';
import { log } from '../lib/logger';
import type { OutboundContent } from './channel';
import { windowOpen } from './channel';
import { customerConversationId } from './conversations';
import { inQuietHours, messagingRules, monthKey, quietEnds, type MessagingRules } from './messaging-costs';

const DAY = 86_400_000;

export type SignalType = 'viewed' | 'asked' | 'carted' | 'bought' | 'replied';
export type Route = 'open' | 'free_window' | 'owner_sent' | 'paid_template' | 'instagram';
export type SendStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'owner_pending' | 'owner_marked_sent';

export type ReachCustomer = Customer & {
  channel?: 'whatsapp' | 'instagram'; lastInboundAt?: string | null;
  marketingOptInAt?: string | null; marketingOptOutAt?: string | null; spamReportedAt?: string | null;
  marketingTimes?: string[] | null;   // when marketing reached them lately (the weekly cap)
  lastMarketingAt?: string | null;
};

export interface Send {
  id: string; businessId: string; campaignId: string; customerId: string; route: Route;
  cost: number; status: SendStatus; text: string; link?: string | null;
  sendAfter?: string | null; sentAt: string | null; createdAt: string;
  attributedOrderId?: string | null; revenue?: number | null;
}

export interface Campaign {
  id: string; businessId: string; source: 'owner' | 'trigger' | 'suggested'; name: string;
  text: string; button?: [string, string] | null; audience: string[];
  routePlan: Record<string, number>; estCost: number; status: 'planned' | 'sending' | 'sent' | 'cancelled';
  createdAt: string; approvedAt: string | null;
}

// ── Consent ──
export function consented(c: ReachCustomer, cfg: Pick<Config, 'REACH_CONSENT_FROM'>) {
  const optIn = c.marketingOptInAt ?? null, optOut = c.marketingOptOutAt ?? null;
  if (optOut && !(optIn && optIn > optOut)) return false;
  if (c.marketingOptIn === true || optIn) return true;
  return (c.createdAt ?? '') < cfg.REACH_CONSENT_FROM; // from before Smart Reach: in unless they said stop
}
export const optIn = (db: Firestore, customerId: string, at = new Date().toISOString()) => db.set(db.doc(C.customers, customerId), { marketingOptIn: true, marketingOptInAt: at }, { merge: true });
export const optOut = (db: Firestore, customerId: string, at = new Date().toISOString()) => db.set(db.doc(C.customers, customerId), { marketingOptIn: false, marketingOptOutAt: at }, { merge: true });

// ── Signals ──
export async function recordSignal(db: Firestore, s: { businessId: string; customerId: string; type: SignalType; productId?: string | null; categoryId?: string | null; variant?: string | null; at?: string }) {
  const at = s.at ?? new Date().toISOString();
  const id = `${s.customerId}_${s.type}_${s.productId ?? s.categoryId ?? 'x'}_${at}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200);
  await db.set(db.doc(C.customerSignals, id), { id, businessId: s.businessId, customerId: s.customerId, type: s.type, productId: s.productId ?? null, categoryId: s.categoryId ?? null, variant: s.variant ?? null, at });
}

// ── Routing ──
export interface Decision { customerId: string; name: string; phone: string; route: Route | null; skip?: 'no_consent' | 'reported' | 'weekly_cap' | 'unreachable' | 'owner_batch_full'; queuedUntil?: string | null; cost: number }

const isRegular = (c: ReachCustomer, r: MessagingRules, now: Date) => (c.orderCount ?? 0) >= r.regularMinOrders && !!c.lastOrderAt && now.getTime() - new Date(c.lastOrderAt).getTime() <= r.regularWithinDays * DAY;
const recentMarketing = (c: ReachCustomer, now: Date) => (c.marketingTimes ?? []).filter(t => now.getTime() - new Date(t).getTime() < 7 * DAY).length;

// The cheapest allowed route for each customer. usedService: free service messages this month so far.
export function routeAll(customers: ReachCustomer[], lastInbound: Map<string, string | null>, opts: { cfg: Config; usedService: number; now?: Date; ownerSentOk?: boolean }): Decision[] {
  const r = messagingRules(opts.cfg);
  const now = opts.now ?? new Date();
  const quiet = inQuietHours(r, now);
  let allowance = Math.max(0, r.serviceFreePerMonth - opts.usedService);
  let ownerRoom = r.ownerBatch;
  return customers.map(c => {
    const base = { customerId: c.id, name: c.name?.trim() || 'A customer', phone: c.phone, cost: 0 };
    if (!consented(c, opts.cfg)) return { ...base, route: null, skip: 'no_consent' as const };
    if (c.spamReportedAt) return { ...base, route: null, skip: 'reported' as const };
    if (recentMarketing(c, now) >= r.weeklyCap) return { ...base, route: null, skip: 'weekly_cap' as const };
    const open = (c.channel ?? 'whatsapp') === 'whatsapp' && windowOpen(lastInbound.get(c.id) ?? c.lastInboundAt ?? null, now);
    if (open && allowance > 0) {
      allowance--;
      // Quiet hours: wait for the morning, if the window is still open then.
      const until = quiet ? quietEnds(r, now) : null;
      if (until && !windowOpen(lastInbound.get(c.id) ?? c.lastInboundAt ?? null, until)) { allowance++; }
      else return { ...base, route: 'open' as const, queuedUntil: until ? until.toISOString() : null };
    }
    if (opts.ownerSentOk !== false && (c.channel ?? 'whatsapp') === 'whatsapp' && c.phone && isRegular(c, r, now)) {
      if (ownerRoom <= 0) return { ...base, route: null, skip: 'owner_batch_full' as const };
      ownerRoom--;
      return { ...base, route: 'owner_sent' as const };
    }
    return { ...base, route: null, skip: 'unreachable' as const }; // a paid template: Phase 2
  });
}

export async function serviceUsed(db: Firestore, businessId: string, now = new Date()) {
  return Number((await db.get(db.doc(C.serviceUsage, `${businessId}_${monthKey(now)}`)))?.count ?? 0);
}

export function planSummary(d: Decision[]) {
  const count = (k: string) => d.filter(x => (x.route ?? x.skip) === k).length;
  return { open: count('open'), owner_sent: count('owner_sent'), queued: d.filter(x => x.queuedUntil).length, no_consent: count('no_consent'), weekly_cap: count('weekly_cap'), reported: count('reported'), unreachable: count('unreachable'), owner_batch_full: count('owner_batch_full'), cost: d.reduce((t, x) => t + x.cost, 0) };
}

export function planText(s: ReturnType<typeof planSummary>, total: number) {
  const lines = [
    s.open ? `• ${s.open} free, in their chat${s.queued ? ` (${s.queued} wait until 8am)` : ''}` : '',
    s.owner_sent ? `• ${s.owner_sent} regulars: you send from your phone (free, I give you the links)` : '',
    s.unreachable ? `• ${s.unreachable} can't be reached for free right now` : '',
    s.weekly_cap ? `• ${s.weekly_cap} already got an update this week` : '',
    s.no_consent + s.reported ? `• ${s.no_consent + s.reported} didn't agree to updates` : '',
  ].filter(Boolean);
  return `${total} customer${total === 1 ? '' : 's'}:\n${lines.join('\n')}\nCost: ${formatKobo(s.cost)}`;
}

// ── Campaigns ──
async function loadAudience(db: Firestore, businessId: string, ids?: string[] | null) {
  const customers = ids
    ? ((await db.getAll(ids.map(id => db.doc(C.customers, id)))) as (ReachCustomer | null)[]).filter((c): c is ReachCustomer => !!c && c.businessId === businessId)
    : ((await db.query(C.customers, [['businessId', '==', businessId]], { limit: 5000 })) as unknown as ReachCustomer[]);
  const withId = customers.map(c => ({ ...c, id: c.id ?? (c as unknown as { _id: string })._id })).filter(c => c.phone || c.channel === 'instagram');
  const convs = await db.getAll(withId.map(c => db.doc(C.conversations, c.id)));
  return { customers: withId, lastInbound: new Map(withId.map((c, i) => [c.id, (convs[i]?.lastInboundAt as string | undefined) ?? c.lastInboundAt ?? null])) };
}

// Plans a campaign (nothing is sent): the route for everyone, saved for [Send all].
export async function planCampaign(db: Firestore, cfg: Config, business: Business, input: { name: string; text: string; source: Campaign['source']; button?: [string, string] | null; audience?: string[] | null; id?: string }, now = new Date()) {
  const { customers, lastInbound } = await loadAudience(db, business.id, input.audience ?? null);
  const decisions = routeAll(customers, lastInbound, { cfg, usedService: await serviceUsed(db, business.id, now), now });
  const summary = planSummary(decisions);
  const id = input.id ?? `c_${randomId(9).replace(/[^A-Za-z0-9]/g, 'x')}`;
  const campaign: Campaign = { id, businessId: business.id, source: input.source, name: input.name.slice(0, 80), text: input.text.slice(0, 900), button: input.button ?? null, audience: customers.map(c => c.id), routePlan: summary, estCost: summary.cost, status: 'planned', createdAt: now.toISOString(), approvedAt: null };
  const created = await db.create(db.doc(C.campaigns, id), { ...campaign });
  return { campaign, decisions, summary, created };
}

// The message a customer gets: the owner's words with their first name, and Stop updates.
export function personal(text: string, c: { name: string }) {
  const first = c.name === 'A customer' ? '' : c.name.split(' ')[0];
  return text.replace(/\{name\}/gi, first).replace(/\s+([,!.])/g, '$1').replace(/^[,\s]+/, '').trim();
}
const waLink = (phone: string, text: string) => `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;

// [Send all]: free routes go out (or wait for 8am), regulars become links for the owner. Every
// customer gets one sends record; running it twice changes nothing.
export async function executeCampaign(db: Firestore, cfg: Config, deps: { enqueue: (jobs: { kind: 'outbox'; messageId: string }[]) => Promise<void> }, business: Business, campaignId: string, opts: { freeOnly?: boolean } = {}, now = new Date()) {
  const campaign = (await db.get(db.doc(C.campaigns, campaignId))) as Campaign | null;
  if (!campaign || campaign.businessId !== business.id) return null;
  if (campaign.status !== 'planned') return { campaign, links: [] as { name: string; link: string }[], sent: 0, queued: 0 };
  await db.update(db.doc(C.campaigns, campaignId), { status: 'sending', approvedAt: now.toISOString() });
  // Planned again at send time: someone may have said stop or ordered since.
  const { customers, lastInbound } = await loadAudience(db, business.id, campaign.audience);
  const decisions = routeAll(customers, lastInbound, { cfg, usedService: await serviceUsed(db, business.id, now), now, ownerSentOk: !opts.freeOnly });
  const byId = new Map(customers.map(c => [c.id, c]));
  const at = now.toISOString();
  const outbox: string[] = [];
  const links: { name: string; link: string }[] = [];
  let sent = 0, queued = 0;
  for (const d of decisions) {
    if (!d.route) continue;
    const c = byId.get(d.customerId)!;
    const text = personal(campaign.text, d);
    const sendId = `${campaignId}_${d.customerId}`.replace(/[^A-Za-z0-9_-]/g, '_');
    const content: OutboundContent = { type: 'interactive', interactive: { type: 'button', body: { text: text.slice(0, 1024) }, action: { buttons: [...(campaign.button ? [campaign.button] : []), ['stopupd', 'Stop updates']].map(([id, title]) => ({ type: 'reply', reply: { id, title } })) } } };
    const record: Send = { id: sendId, businessId: business.id, campaignId, customerId: d.customerId, route: d.route, cost: d.cost, status: d.route === 'owner_sent' ? 'owner_pending' : d.queuedUntil ? 'queued' : 'sent', text, link: d.route === 'owner_sent' ? waLink(c.phone, text) : null, sendAfter: d.queuedUntil ?? null, sentAt: d.route === 'open' && !d.queuedUntil ? at : null, createdAt: at };
    if (!(await db.create(db.doc(C.sends, sendId), { ...record }))) continue; // already sent once
    if (d.route === 'owner_sent') { links.push({ name: d.name, link: record.link! }); continue; }
    if (d.queuedUntil) { queued++; await db.set(db.doc(C.sends, sendId), { content }, { merge: true }); continue; }
    const mid = `reach_${sendId}`;
    await db.create(db.doc(C.outbox, mid), { id: mid, businessId: business.id, audience: 'customer', channel: c.channel ?? 'whatsapp', to: c.phone, conversationId: customerConversationId(business.id, c.channel ?? 'whatsapp', c.phone), kind: 'reach', text, content, status: 'pending', attempts: 0, createdAt: at });
    outbox.push(mid);
    await noteMarketing(db, d.customerId, at);
    sent++;
  }
  if (outbox.length) await deps.enqueue(outbox.map(messageId => ({ kind: 'outbox' as const, messageId })));
  await db.update(db.doc(C.campaigns, campaignId), { status: 'sent' });
  log('info', 'reach_sent', { businessId: business.id, campaignId, sent, queued, ownerLinks: links.length });
  return { campaign, links, sent, queued };
}

async function noteMarketing(db: Firestore, customerId: string, at: string) {
  const c = (await db.get(db.doc(C.customers, customerId))) as ReachCustomer | null;
  const recent = [...(c?.marketingTimes ?? []), at].filter(t => new Date(at).getTime() - new Date(t).getTime() < 7 * DAY).slice(-10);
  await db.set(db.doc(C.customers, customerId), { marketingTimes: recent, lastMarketingAt: at }, { merge: true });
}

// The owner tapped [Mark all sent] (or one link): those sends count, and the cap applies to them.
export async function markOwnerSent(db: Firestore, businessId: string, campaignId: string, now = new Date()) {
  const sends = ((await db.query(C.sends, [['campaignId', '==', campaignId]], { limit: 500 })) as unknown as Send[]).filter(s => s.businessId === businessId && s.status === 'owner_pending');
  const at = now.toISOString();
  for (const s of sends) { await db.update(db.doc(C.sends, s.id), { status: 'owner_marked_sent', sentAt: at }); await noteMarketing(db, s.customerId, at); }
  return sends.length;
}

// Every few minutes: queued sends whose quiet hours are over go out, if still allowed.
export async function releaseQueuedSends(db: Firestore, cfg: Config, now = new Date()) {
  const due = ((await db.query(C.sends, [['status', '==', 'queued']], { limit: 200 })) as unknown as (Send & { content?: OutboundContent })[]).filter(s => s.sendAfter && s.sendAfter <= now.toISOString());
  const ids: string[] = [];
  for (const s of due) {
    const c = (await db.get(db.doc(C.customers, s.customerId))) as ReachCustomer | null;
    const conv = await db.get(db.doc(C.conversations, s.customerId));
    if (!c || !consented(c, cfg) || !windowOpen((conv?.lastInboundAt as string | null) ?? null, now)) { await db.update(db.doc(C.sends, s.id), { status: 'failed' }); continue; }
    const mid = `reach_${s.id}`;
    if (await db.create(db.doc(C.outbox, mid), { id: mid, businessId: s.businessId, audience: 'customer', channel: c.channel ?? 'whatsapp', to: c.phone, conversationId: s.customerId, kind: 'reach', text: s.text, ...(s.content ? { content: s.content } : {}), status: 'pending', attempts: 0, createdAt: now.toISOString() })) ids.push(mid);
    await db.update(db.doc(C.sends, s.id), { status: 'sent', sentAt: now.toISOString() });
    await noteMarketing(db, s.customerId, now.toISOString());
  }
  return ids;
}

// ── Triggers ──
export type TriggerType = 'back_in_stock' | 'abandoned_cart' | 'price_drop' | 'usual_order_due' | 'win_back' | 'after_delivery' | 'first_order_thanks';
export const TRIGGER_LABEL: Record<TriggerType, string> = { back_in_stock: 'Back in stock', abandoned_cart: 'Left in cart', price_drop: 'Price drop', usual_order_due: 'Usual order time', win_back: 'Win back', after_delivery: 'After delivery', first_order_thanks: 'First-order thanks' };
export const PHASE1_TRIGGERS: TriggerType[] = ['back_in_stock', 'abandoned_cart'];

// On unless the owner turned it off; the defaults depend on what the shop sells (Smart Reach Q5).
export function triggerOn(business: Pick<Business, 'category' | 'reachTriggers'>, type: TriggerType) {
  const set = business.reachTriggers?.[type];
  if (typeof set === 'boolean') return set;
  const food = business.category === 'food_beverage';
  const on: TriggerType[] = food ? ['abandoned_cart', 'after_delivery', 'first_order_thanks', 'usual_order_due'] : ['back_in_stock', 'price_drop', 'abandoned_cart', 'after_delivery', 'first_order_thanks'];
  return on.includes(type);
}

// A sold-out product (or size) is back: everyone who viewed, asked about or carted it in the last
// 60 days and hasn't bought it since hears about it, once per restock, by a free route.
export async function backInStock(db: Firestore, cfg: Config, deps: { enqueue: (jobs: { kind: 'outbox'; messageId: string }[]) => Promise<void> }, business: Business, product: Product, variantId: string | null, restockKey: string, now = new Date()) {
  if (business.status !== 'active' || !triggerOn(business, 'back_in_stock')) return null;
  const since = new Date(now.getTime() - 60 * DAY).toISOString();
  const signals = ((await db.query(C.customerSignals, [['businessId', '==', business.id], ['productId', '==', product.id]], { limit: 2000 })) as unknown as { customerId: string; type: SignalType; variant: string | null; at: string }[]).filter(s => s.at >= since);
  const wanted = new Set(signals.filter(s => s.type !== 'bought' && (!variantId || !s.variant || s.variant === variantId)).map(s => s.customerId));
  for (const s of signals) if (s.type === 'bought') wanted.delete(s.customerId);
  if (!wanted.size) return null;
  const label = variantId ? `${product.name} (${product.variants?.find(v => v.id === variantId)?.label ?? ''})` : product.name;
  const id = `bis_${product.id}_${restockKey}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const planned = await planCampaign(db, cfg, business, { id, name: `Back in stock: ${label}`, source: 'trigger', text: `Good news {name}! ${label} is back in stock at ${business.name} 🎉`, button: [`buy:${product.id}`, 'Add to cart'], audience: [...wanted] }, now);
  if (!planned.created) return null; // this restock already fired
  // Triggers only use the free chat route automatically; regulars' links wait for the owner.
  return executeCampaign(db, cfg, deps, business, id, { freeOnly: true }, now);
}

// A cart left for an hour: one reminder, by a free route, then never again for that cart.
export async function abandonedCarts(db: Firestore, cfg: Config, deps: { enqueue: (jobs: { kind: 'outbox'; messageId: string }[]) => Promise<void> }, now = new Date()) {
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const carts = ((await db.query(C.carts, [['updatedAt', '<=', hourAgo]], { limit: 200 })) as unknown as { id?: string; _id: string; businessId: string; customerId: string; items: { productId: string }[]; expiresAt: string; reminderAt?: string | null; updatedAt: string }[])
    .filter(c => !c.reminderAt && c.items?.length && c.expiresAt > now.toISOString());
  let fired = 0;
  for (const cart of carts) {
    const id = cart.id ?? cart._id;
    await db.set(db.doc(C.carts, id), { reminderAt: now.toISOString() }, { merge: true });
    const business = (await db.get(db.doc(C.businesses, cart.businessId))) as Business | null;
    if (!business || business.status !== 'active' || !triggerOn(business, 'abandoned_cart')) continue;
    const p = (await db.get(db.doc(C.products, cart.items[0].productId))) as Product | null;
    const what = p ? `${p.name}${cart.items.length > 1 ? ` and ${cart.items.length - 1} more` : ''}` : 'your items';
    const campaignId = `cart_${id}_${cart.updatedAt}`.replace(/[^A-Za-z0-9_-]/g, '_');
    const planned = await planCampaign(db, cfg, business, { id: campaignId, name: 'Left in cart', source: 'trigger', text: `Hi {name}, your cart at ${business.name} is saved: ${what}. Ready to check out?`, button: ['checkout', 'Checkout'], audience: [cart.customerId] }, now);
    if (!planned.created) continue;
    const r = await executeCampaign(db, cfg, deps, business, campaignId, { freeOnly: true }, now);
    if (r?.sent || r?.queued) fired++;
  }
  return fired;
}
