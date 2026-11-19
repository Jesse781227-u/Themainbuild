// Targeted Status posts. WhatsApp's API can't post a Status or choose who sees it, so the owner posts
// it by hand; Relay prepares everything:
//   the picture (status-image.ts) + a caption + the 5 customers most likely to buy, to @mention
//   → [I've posted it] [Change people] [Skip] → the rest of the matching customers can get a
//   personal message instead (a campaign: opted-in only, cost shown first).
// A day after it's posted, the owner hears who of the 5 messaged or ordered (attribution window).
// Nothing is automated on the owner's phone: prepare and guide only.
import { C } from '../db';
import type { Business } from '../domain/business';
import type { Customer, Order, Product } from '../domain/commerce';
import type { Firestore } from '../lib/firestore';
import { randomId } from '../lib/crypto';
import { formatKobo } from '../lib/money';
import type { R2BucketLike } from '../env';
import { listCategories, listProducts } from './catalog';
import { recentOrders } from './orders';
import { shopColour } from './placeholder';
import { statusImage } from './status-image';
import { productImageKey } from '../routes/media';
import { adminConversationId } from './conversations';

export const MENTIONS = 5;                  // WhatsApp: up to 5 contacts per Status
export const COOLDOWN_DAYS = 7;             // a customer is suggested at most once a week
export const ATTRIBUTION_HOURS = 24;        // a message or order this soon after posting counts
const DAY = 86_400_000;

export type StatusCustomer = Customer & {
  interests?: Record<string, string> | null;   // p_<productId> / c_<categoryId> → when they last looked or asked
  lastStatusMentionAt?: string | null; statusMentionCount?: number;
  marketingOptOutAt?: string | null; spamReportedAt?: string | null;
};

export interface Ranked { customerId: string; name: string; phone: string; score: number; cooling: boolean }
export interface Target { productIds: string[]; categoryId: string | null }

export interface StatusPost {
  id: string; businessId: string; productIds: string[]; categoryId: string | null;
  imageUrl: string; caption: string; title: string;
  ranking: string[];                 // everyone who can be mentioned, best first
  offset: number;                    // where "Change people" has got to in the ranking
  suggestedMentions: { customerId: string; name: string; phone: string }[];
  wider: string[];                   // the other matching customers (for a personal message instead)
  status: 'prepared' | 'posted' | 'skipped';
  confirmedPostedAt: string | null; reportedAt: string | null;
  results?: { ordered: string[]; messaged: string[]; salesKobo: number } | null;
  createdAt: string;
}

// ── Who to mention ──
// For a product (or a whole category), each customer scores for:
//   having bought it (3) or something in its category (2), weighted by how recent (2-month decay)
//   having opened or asked about it (1.5) or its category (1), weighted by how recent (2 weeks)
//   being active lately, and buying often
// Only customers with a link to it count. Opted out or reported spam: never. Mentioned in the last
// COOLDOWN_DAYS: not suggested again yet (still in the wider audience). The more often someone has
// been mentioned, the lower they rank, so the same people aren't tagged every time.
export function scoreAudience(input: { customers: StatusCustomer[]; orders: Order[]; products: Pick<Product, 'id' | 'categoryId'>[]; target: Target; now?: Date; cooldownDays?: number }): Ranked[] {
  const now = (input.now ?? new Date()).getTime();
  const catOf = new Map(input.products.map(p => [p.id, p.categoryId ?? null]));
  const wanted = new Set(input.target.productIds);
  const cats = new Set([input.target.categoryId, ...input.target.productIds.map(id => catOf.get(id))].filter((x): x is string => !!x));
  const age = (iso: string | null | undefined) => (iso ? Math.max(0, (now - new Date(iso).getTime()) / DAY) : Infinity);
  const byCustomer = new Map<string, Order[]>();
  for (const o of input.orders) if (o.status === 'paid') byCustomer.set(o.customerId, [...(byCustomer.get(o.customerId) ?? []), o]);

  const out: Ranked[] = [];
  for (const c of input.customers) {
    if (!c.phone || c.spamReportedAt || (c.marketingOptOutAt && !c.marketingOptIn)) continue;
    let link = 0;
    for (const o of byCustomer.get(c.id) ?? []) {
      const w = Math.exp(-age(o.paidAt ?? o.createdAt) / 60);
      for (const l of o.items) link += wanted.has(l.productId) ? 3 * w : cats.has(catOf.get(l.productId) ?? '') ? 2 * w : 0;
    }
    for (const [key, at] of Object.entries(c.interests ?? {})) {
      const w = Math.exp(-age(at) / 14);
      if (key.startsWith('p_') && wanted.has(key.slice(2))) link += 1.5 * w;
      else if (key.startsWith('p_') && cats.has(catOf.get(key.slice(2)) ?? '')) link += 1 * w;
      else if (key.startsWith('c_') && cats.has(key.slice(2))) link += 1 * w;
    }
    if (link <= 0) continue;
    const active = age(c.lastOrderAt ?? c.updatedAt) <= 30 ? 0.3 : 0;
    const loyal = Math.min(0.5, (c.orderCount ?? 0) * 0.1);
    const score = (link + active + loyal) * Math.pow(0.85, c.statusMentionCount ?? 0);
    out.push({ customerId: c.id, name: c.name?.trim() || 'A customer', phone: c.phone, score: Math.round(score * 1000) / 1000, cooling: age(c.lastStatusMentionAt) < (input.cooldownDays ?? COOLDOWN_DAYS) });
  }
  return out.sort((a, b) => b.score - a.score || a.customerId.localeCompare(b.customerId));
}

export async function rankAudience(db: Firestore, businessId: string, target: Target, now = new Date()) {
  const [customers, orders, products] = await Promise.all([
    db.query(C.customers, [['businessId', '==', businessId]], { limit: 3000 }) as unknown as Promise<StatusCustomer[]>,
    recentOrders(db, [['businessId', '==', businessId], ['status', '==', 'paid']], 1000),
    listProducts(db, businessId),
  ]);
  const ranked = scoreAudience({ customers: customers.map(c => ({ ...c, id: c.id ?? (c as unknown as { _id: string })._id })), orders, products, target, now });
  return { ranking: ranked.filter(r => !r.cooling), all: ranked };
}

// ── The post ──
const mediaKey = (url: string | undefined) => (url && url.includes('/media/') ? url.split('/media/')[1] : null);
async function bytesOf(images: R2BucketLike | undefined, url: string | null | undefined) {
  const key = mediaKey(url ?? undefined);
  if (!images || !key) return null;
  const obj = await images.get(key).catch(() => null);
  return obj ? new Uint8Array(await new Response(obj.body).arrayBuffer()) : null;
}

const firstName = (n: string) => n.split(' ')[0];
export const mentionLine = (m: StatusPost['suggestedMentions']) => m.map(x => `${firstName(x.name)} (…${x.phone.replace(/\D/g, '').slice(-4)})`).join(' · ');

export async function prepareStatus(db: Firestore, cfg: { API_BASE_URL: string }, images: R2BucketLike | undefined, business: Business, target: Target, now = new Date()): Promise<StatusPost | null> {
  const [products, cats] = await Promise.all([listProducts(db, business.id), listCategories(db, business.id)]);
  const items = target.productIds.length ? products.filter(p => target.productIds.includes(p.id)) : products.filter(p => p.categoryId === target.categoryId && p.available);
  if (!items.length) return null;
  const cat = target.categoryId ? cats.find(c => c.id === target.categoryId) : null;
  const one = target.productIds.length === 1 ? items[0] : null;
  const title = one ? one.name : `New in ${cat?.name ?? 'our shop'}`;
  const price = one ? formatKobo(one.priceKobo) : `from ${formatKobo(Math.min(...items.map(p => p.priceKobo)))}`;
  const pictured = one ?? items.find(p => p.images[0]) ?? items[0];
  const id = randomId(12).replace(/[^A-Za-z0-9]/g, 'x');

  const jpeg = statusImage({ hex: shopColour(business.id), shopName: business.name, title, price, photo: await bytesOf(images, pictured.images[0]), logo: await bytesOf(images, business.profilePhotoUrl) });
  const key = productImageKey(business.id, `status-${id}.jpg`);
  if (!images) throw new Error('NO_IMAGE_STORAGE');
  await images.put(key, jpeg.slice().buffer as ArrayBuffer, { httpMetadata: { contentType: 'image/jpeg' } });

  const { ranking, all } = await rankAudience(db, business.id, { productIds: one ? [one.id] : items.map(p => p.id), categoryId: target.categoryId ?? one?.categoryId ?? null }, now);
  const mentions = ranking.slice(0, MENTIONS).map(r => ({ customerId: r.customerId, name: r.name, phone: r.phone }));
  const mentioned = new Set(mentions.map(m => m.customerId));
  const caption = one
    ? `✨ ${title}\n${price}${one.description ? `\n${one.description.slice(0, 120)}` : ''}\n\nReply to this Status to order 💬`
    : `✨ ${title}: ${items.slice(0, 4).map(p => p.name).join(', ')}${items.length > 4 ? '…' : ''}\n${price}\n\nReply to this Status to order 💬`;
  const post: StatusPost = {
    id, businessId: business.id, productIds: items.map(p => p.id).slice(0, 30), categoryId: target.categoryId ?? one?.categoryId ?? null,
    imageUrl: `${cfg.API_BASE_URL}/media/${key}`, caption, title,
    ranking: ranking.map(r => r.customerId).slice(0, 100), offset: 0, suggestedMentions: mentions,
    wider: all.filter(r => !mentioned.has(r.customerId)).map(r => r.customerId).slice(0, 2000),
    status: 'prepared', confirmedPostedAt: null, reportedAt: null, createdAt: now.toISOString(),
  };
  await db.create(db.doc(C.statusPosts, id), { ...post });
  return post;
}

export async function loadPost(db: Firestore, businessId: string, id: string | null) {
  if (!id) return null;
  const p = (await db.get(db.doc(C.statusPosts, id))) as StatusPost | null;
  return p && p.businessId === businessId ? p : null;
}

// "Change people": the next 5 in the ranking (round again when it runs out).
export async function nextMentions(db: Firestore, post: StatusPost) {
  if (post.ranking.length <= MENTIONS) return post;
  let offset = post.offset + MENTIONS;
  if (offset >= post.ranking.length) offset = 0;
  const ids = post.ranking.slice(offset, offset + MENTIONS);
  const docs = (await db.getAll(ids.map(id => db.doc(C.customers, id)))) as (StatusCustomer | null)[];
  const mentions = docs.map((c, i) => (c ? { customerId: ids[i], name: c.name?.trim() || 'A customer', phone: c.phone } : null)).filter((x): x is NonNullable<typeof x> => !!x);
  const wider = [...new Set([...post.wider, ...post.suggestedMentions.map(m => m.customerId)])].filter(id => !ids.includes(id));
  await db.update(db.doc(C.statusPosts, post.id), { offset, suggestedMentions: mentions, wider });
  return { ...post, offset, suggestedMentions: mentions, wider };
}

// "I've posted it": the cooldown starts for the people mentioned.
export async function confirmPosted(db: Firestore, post: StatusPost, now = new Date()) {
  if (post.status === 'posted') return false;
  const at = now.toISOString();
  await db.update(db.doc(C.statusPosts, post.id), { status: 'posted', confirmedPostedAt: at });
  for (const m of post.suggestedMentions) {
    const c = (await db.get(db.doc(C.customers, m.customerId))) as StatusCustomer | null;
    if (c && c.businessId === post.businessId) await db.update(db.doc(C.customers, m.customerId), { lastStatusMentionAt: at, statusMentionCount: (c.statusMentionCount ?? 0) + 1 });
  }
  return true;
}

// ── A day later: did the people mentioned come? ──
export async function statusResults(db: Firestore, post: StatusPost) {
  const from = post.confirmedPostedAt!, to = new Date(new Date(from).getTime() + ATTRIBUTION_HOURS * 3_600_000).toISOString();
  const ordered: string[] = [], messaged: string[] = [];
  let salesKobo = 0;
  for (const m of post.suggestedMentions) {
    const orders = (await recentOrders(db, [['customerId', '==', m.customerId]], 20)).filter(o => o.businessId === post.businessId && o.status === 'paid' && o.createdAt >= from && o.createdAt <= to);
    if (orders.length) { ordered.push(m.customerId); salesKobo += orders.reduce((t, o) => t + o.subtotalKobo, 0); continue; }
    const conv = await db.get(db.doc(C.conversations, m.customerId));
    const last = conv?.lastInboundAt as string | undefined;
    if (last && last >= from && last <= to) messaged.push(m.customerId);
  }
  return { ordered, messaged, salesKobo };
}

export function resultsText(post: StatusPost, r: { ordered: string[]; messaged: string[]; salesKobo: number }) {
  const n = post.suggestedMentions.length;
  const head = `📊 Your Status for *${post.title}*:`;
  if (!r.ordered.length && !r.messaged.length) return `${head} none of the ${n} you mentioned ordered within a day. A Status often takes a few posts to work: try another with something new next week.`;
  return `${head} ${r.ordered.length ? `${r.ordered.length} of the ${n} you mentioned ordered 🎉 (${formatKobo(r.salesKobo)})` : `none of the ${n} you mentioned ordered yet`}${r.messaged.length ? `, and ${r.messaged.length} more messaged you` : ''}.`;
}

// Posts confirmed more than a day ago and not reported yet: the result goes to the owner's outbox.
// Returns the outbox ids to send.
export async function dueStatusReports(db: Firestore, now = new Date()) {
  const cutoff = new Date(now.getTime() - ATTRIBUTION_HOURS * 3_600_000).toISOString();
  const posts = ((await db.query(C.statusPosts, [['status', '==', 'posted']], { limit: 200 })) as unknown as StatusPost[]).filter(p => !p.reportedAt && p.confirmedPostedAt && p.confirmedPostedAt <= cutoff);
  const ids: string[] = [];
  for (const post of posts) {
    const r = await statusResults(db, post);
    await db.update(db.doc(C.statusPosts, post.id), { reportedAt: now.toISOString(), results: r });
    const business = (await db.get(db.doc(C.businesses, post.businessId))) as Business | null;
    if (!business?.ownerPhone || business.status === 'deleted') continue;
    const id = `${post.businessId}_status_${post.id}`;
    const created = await db.create(db.doc(C.outbox, id), {
      id, businessId: post.businessId, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone, conversationId: adminConversationId(business.ownerPhone),
      kind: 'status_results', text: resultsText(post, r), status: 'pending', attempts: 0, createdAt: now.toISOString(),
      buttons: [{ id: 'act:status', title: 'Make another' }, { id: 'act:menu', title: 'Menu' }],
    });
    if (created) ids.push(id);
  }
  return ids;
}

// What customers open or ask about, for "who to mention" (product and category ids only, never
// what they wrote). Keeps the 60 most recent.
export async function noteInterest(db: Firestore, customerId: string, businessId: string, keys: string[], now = new Date()) {
  if (!keys.length) return;
  const c = (await db.get(db.doc(C.customers, customerId))) as StatusCustomer | null;
  if (!c || c.businessId !== businessId) return;
  const at = now.toISOString();
  const merged = { ...(c.interests ?? {}), ...Object.fromEntries(keys.map(k => [k, at])) };
  const kept = Object.fromEntries(Object.entries(merged).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 60));
  await db.update(db.doc(C.customers, customerId), { interests: kept });
}
