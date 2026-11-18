// "Goes well with…": after a customer adds something to their cart, suggest a few items that go
// with it (cross-sell) and, sometimes, a slightly better version of it (upsell).
// Where suggestions come from, best first:
//   1. the owner's own pairings (PAIR Black AF1 WITH Sneaker cleaner)
//   2. what this shop's customers actually bought together (paid orders)
//   3. the AI's pick from the shop's catalogue, cached on the product for a week
// Only in-stock items that aren't already in the cart. With no good signal, nothing is suggested:
// a wrong suggestion (a handbag with jollof) is worse than none.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { hasStock, type Category, type Product } from '../domain/commerce';
import { recentOrders } from './orders';
import { listProducts, listCategories } from './catalog';
import { log } from '../lib/logger';
import type { LLMProvider } from './ai';

export const MAX_CROSS = 4;
const AI_TTL_MS = 7 * 86_400_000;
const ORDERS_LOOKED_AT = 100;

export interface PairCache { ids: string[]; upsell: string | null; at: string }
export type PairedProduct = Product & { pairsWith?: string[] | null; aiPairs?: PairCache | null };
export interface Suggestions { cross: Product[]; upsell: Product | null }

// A bit dearer, same category: the "upgrade" (10–70% more).
function ruleUpsell(anchor: Product, pool: Product[]) {
  return pool
    .filter(p => p.categoryId && p.categoryId === anchor.categoryId && p.priceKobo > anchor.priceKobo * 1.1 && p.priceKobo <= anchor.priceKobo * 1.7)
    .sort((a, b) => a.priceKobo - b.priceKobo)[0] ?? null;
}

async function boughtTogether(db: Firestore, businessId: string, anchorId: string) {
  const orders = await recentOrders(db, [['businessId', '==', businessId], ['status', '==', 'paid']], ORDERS_LOOKED_AT);
  const count = new Map<string, number>();
  for (const o of orders) {
    if (!o.items.some(l => l.productId === anchorId)) continue;
    for (const l of o.items) if (l.productId !== anchorId) count.set(l.productId, (count.get(l.productId) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

async function aiPairs(db: Firestore, llm: LLMProvider | null | undefined, business: { name: string; category?: string }, anchor: PairedProduct, all: Product[], cats: Category[], now: number): Promise<PairCache | null> {
  if (anchor.aiPairs && now - new Date(anchor.aiPairs.at).getTime() < AI_TTL_MS) return anchor.aiPairs;
  if (!llm?.pickPairs || all.length < 2) return null;
  const catName = new Map(cats.map(c => [c.id, c.name]));
  const item = (p: Product) => ({ id: p.id, name: p.name, category: (p.categoryId && catName.get(p.categoryId)) || '', priceNaira: Math.round(p.priceKobo / 100) });
  try {
    const picked = await llm.pickPairs({
      shop: business.name, shopType: business.category ?? 'other',
      anchor: item(anchor),
      candidates: all.filter(p => p.id !== anchor.id).slice(0, 150).map(item),
    });
    const valid = new Set(all.map(p => p.id));
    const cache: PairCache = { ids: picked.cross.filter(id => valid.has(id) && id !== anchor.id).slice(0, 6), upsell: picked.upsell && valid.has(picked.upsell) && picked.upsell !== anchor.id ? picked.upsell : null, at: new Date(now).toISOString() };
    await db.update(db.doc(C.products, anchor.id), { aiPairs: cache });
    return cache;
  } catch (e) {
    log('warn', 'pairs_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) });
    return null;
  }
}

export async function suggestFor(db: Firestore, llm: LLMProvider | null | undefined, business: { id: string; name: string; category?: string }, anchor: PairedProduct, inCart: Set<string>, now = Date.now()): Promise<Suggestions> {
  const [all, cats] = await Promise.all([listProducts(db, business.id, { availableOnly: true }), listCategories(db, business.id)]);
  const byId = new Map(all.map(p => [p.id, p]));
  const usable = (id: string) => { const p = byId.get(id); return p && p.id !== anchor.id && !inCart.has(p.id) && hasStock(p) ? p : null; };

  const ranked: string[] = [...(anchor.pairsWith ?? [])];
  ranked.push(...await boughtTogether(db, business.id, anchor.id));
  let ai: PairCache | null = null;
  if (ranked.filter(id => usable(id)).length < MAX_CROSS) {
    ai = await aiPairs(db, llm, business, anchor, all, cats, now);
    if (ai) ranked.push(...ai.ids);
  }

  const pool = all.filter(p => usable(p.id));
  const upsell = (ai?.upsell ? usable(ai.upsell) : null) ?? ruleUpsell(anchor, pool);
  const seen = new Set<string>(upsell ? [upsell.id] : []);
  const cross: Product[] = [];
  for (const id of ranked) {
    const p = usable(id);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id); cross.push(p);
    if (cross.length === MAX_CROSS) break;
  }
  return { cross, upsell };
}
