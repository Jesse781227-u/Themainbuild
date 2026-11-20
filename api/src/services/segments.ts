// Smart Reach segments: groups of a shop's customers, from a rule.
//   rule = { all: [conditions] }  (every condition must hold)
//   bought / asked / viewed / carted a product or category (within N days) · spend percentile ·
//   order count · recency (active ≤30d, cooling 30–90d, lapsed 90d+) · last order older than N days ·
//   size bought · delivery area · usual order day · what they said they want (interests)
// Built-in groups for every shop (top 10%, 3+ orders, one-time, active, cooling, lapsed, and
// "bought X" per category). They are worked out from the orders and signals when used, so a paid
// order counts at once; sizes are saved for the owner's list and refreshed nightly.
// Plain words ("my sneaker buyers", "people who haven't ordered in a month") become a rule by simple
// patterns first, then the AI; either way the rule is checked (zod, ids that exist) and the owner
// sees the count before anything is sent. The AI never reads the database.
import { z } from 'zod';
import { C } from '../db';
import type { Order, Product, Category } from '../domain/commerce';
import type { Firestore } from '../lib/firestore';
import { listCategories, listProducts } from './catalog';
import { recentOrders } from './orders';
import type { LLMProvider } from './ai';
import type { ReachCustomer } from './reach';
import { log } from '../lib/logger';

const DAY = 86_400_000;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export const condition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('signal'), action: z.enum(['bought', 'asked', 'viewed', 'carted']), productId: z.string().max(64).optional(), categoryId: z.string().max(64).optional(), withinDays: z.number().int().min(1).max(730).optional() }),
  z.object({ kind: z.literal('spend_percentile'), min: z.number().min(0).max(100) }),
  z.object({ kind: z.literal('order_count'), min: z.number().int().min(0).optional(), max: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal('recency'), bucket: z.enum(['active', 'cooling', 'lapsed']) }),
  z.object({ kind: z.literal('last_order_older'), days: z.number().int().min(1).max(730) }),
  z.object({ kind: z.literal('size'), value: z.string().trim().min(1).max(20) }),
  z.object({ kind: z.literal('area'), value: z.string().trim().min(2).max(60) }),
  z.object({ kind: z.literal('usual_day'), day: z.enum(DAYS) }),
  z.object({ kind: z.literal('interest'), value: z.string().trim().min(2).max(40) }),
]);
export const ruleSchema = z.object({ all: z.array(condition).min(1).max(6) });
export type Condition = z.infer<typeof condition>;
export type Rule = z.infer<typeof ruleSchema>;

export interface SegmentData {
  customers: ReachCustomer[]; orders: Order[];
  signals: { customerId: string; type: string; productId: string | null; categoryId: string | null; variant: string | null; at: string }[];
  products: Pick<Product, 'id' | 'categoryId' | 'name' | 'variants'>[];
}

export async function loadSegmentData(db: Firestore, businessId: string): Promise<SegmentData> {
  const [customers, orders, signals, products] = await Promise.all([
    db.query(C.customers, [['businessId', '==', businessId]], { limit: 5000 }) as unknown as Promise<ReachCustomer[]>,
    recentOrders(db, [['businessId', '==', businessId], ['status', '==', 'paid']], 2000),
    db.query(C.customerSignals, [['businessId', '==', businessId]], { limit: 20_000 }) as unknown as Promise<SegmentData['signals']>,
    listProducts(db, businessId),
  ]);
  return { customers: customers.map(c => ({ ...c, id: c.id ?? (c as unknown as { _id: string })._id })), orders, signals, products };
}

// Who's in the group.
export function evaluate(rule: Rule, d: SegmentData, now = new Date()): string[] {
  const t = now.getTime();
  const catOf = new Map(d.products.map(p => [p.id, p.categoryId ?? null]));
  const ordersOf = new Map<string, Order[]>();
  for (const o of d.orders) ordersOf.set(o.customerId, [...(ordersOf.get(o.customerId) ?? []), o]);
  const spend = (id: string) => (ordersOf.get(id) ?? []).reduce((s, o) => s + o.subtotalKobo, 0);
  const lastOrder = (c: ReachCustomer) => { const os = ordersOf.get(c.id) ?? []; const at = os.map(o => o.paidAt ?? o.createdAt).sort().pop() ?? c.lastOrderAt ?? null; return at ? (t - new Date(at).getTime()) / DAY : Infinity; };
  const spends = d.customers.map(c => spend(c.id)).sort((a, b) => a - b);
  const percentile = (v: number) => (spends.length ? (spends.filter(x => x <= v).length / spends.length) * 100 : 0);

  const holds = (c: ReachCustomer, k: Condition): boolean => {
    const os = ordersOf.get(c.id) ?? [];
    switch (k.kind) {
      case 'signal': {
        const since = k.withinDays ? t - k.withinDays * DAY : 0;
        const match = (pid: string | null, cid: string | null) => (k.productId ? pid === k.productId : true) && (k.categoryId ? (cid ?? (pid ? catOf.get(pid) : null)) === k.categoryId : true);
        if (k.action === 'bought' && os.some(o => new Date(o.paidAt ?? o.createdAt).getTime() >= since && o.items.some(l => match(l.productId, null)))) return true;
        return d.signals.some(s => s.customerId === c.id && s.type === k.action && new Date(s.at).getTime() >= since && match(s.productId, s.categoryId));
      }
      case 'spend_percentile': return spend(c.id) > 0 && percentile(spend(c.id)) >= k.min;
      case 'order_count': { const n = os.length || (c.orderCount ?? 0); return (k.min === undefined || n >= k.min) && (k.max === undefined || n <= k.max); }
      case 'recency': { const a = lastOrder(c); return k.bucket === 'active' ? a <= 30 : k.bucket === 'cooling' ? a > 30 && a <= 90 : a > 90 && a !== Infinity; }
      case 'last_order_older': { const a = lastOrder(c); return a !== Infinity && a > k.days; }
      case 'size': return os.some(o => o.items.some(l => l.name.toLowerCase().includes(`(${k.value.toLowerCase()}`) || l.name.toLowerCase().includes(`/ ${k.value.toLowerCase()})`) || l.name.toLowerCase().includes(` ${k.value.toLowerCase()} /`)));
      case 'area': return os.some(o => (o.delivery?.address ?? '').toLowerCase().includes(k.value.toLowerCase()));
      case 'usual_day': {
        if (os.length < 3) return false;
        const count = os.filter(o => DAYS[new Date(new Date(o.createdAt).getTime() + 3_600_000).getUTCDay()] === k.day).length;
        return count / os.length >= 0.5;
      }
      case 'interest': return (c.interestWords ?? []).some(w => w.toLowerCase().includes(k.value.toLowerCase()));
    }
  };
  return d.customers.filter(c => rule.all.every(k => holds(c, k))).map(c => c.id);
}

// The built-in groups for a shop.
export function systemSegments(categories: Pick<Category, 'id' | 'name'>[]): { key: string; name: string; rule: Rule }[] {
  return [
    { key: 'top10', name: 'Top 10% by spend', rule: { all: [{ kind: 'spend_percentile', min: 90 }] } },
    { key: 'loyal', name: '3+ orders', rule: { all: [{ kind: 'order_count', min: 3 }] } },
    { key: 'one_time', name: 'Bought once', rule: { all: [{ kind: 'order_count', min: 1, max: 1 }] } },
    { key: 'active', name: 'Active (ordered in 30 days)', rule: { all: [{ kind: 'recency', bucket: 'active' }] } },
    { key: 'cooling', name: 'Cooling (30–90 days)', rule: { all: [{ kind: 'recency', bucket: 'cooling' }] } },
    { key: 'lapsed', name: 'Lapsed (90+ days)', rule: { all: [{ kind: 'recency', bucket: 'lapsed' }] } },
    ...categories.map(c => ({ key: `cat_${c.id}`, name: `Bought ${c.name}`, rule: { all: [{ kind: 'signal' as const, action: 'bought' as const, categoryId: c.id }] } })),
  ];
}

// Sizes of every group, saved for the owner (nightly, and when they look).
export async function refreshSegments(db: Firestore, businessId: string, now = new Date()) {
  const [data, cats] = await Promise.all([loadSegmentData(db, businessId), listCategories(db, businessId)]);
  const owned = (await db.query(C.segments, [['businessId', '==', businessId], ['system', '==', false]], { limit: 100 })) as unknown as { _id: string; rule: Rule }[];
  const at = now.toISOString();
  const out: { key: string; name: string; size: number }[] = [];
  for (const s of systemSegments(cats)) {
    const size = evaluate(s.rule, data, now).length;
    await db.set(db.doc(C.segments, `${businessId}_${s.key}`), { id: `${businessId}_${s.key}`, businessId, name: s.name, rule: s.rule, system: true, size, refreshedAt: at });
    out.push({ key: s.key, name: s.name, size });
  }
  for (const s of owned) { const r = ruleSchema.safeParse(s.rule); if (r.success) await db.update(db.doc(C.segments, s._id), { size: evaluate(r.data, data, now).length, refreshedAt: at }); }
  return out;
}

// ── Plain words → a rule ──
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2).map(w => w.replace(/s$/, ''));

export async function ruleFromWords(text: string, ctx: { categories: Pick<Category, 'id' | 'name'>[]; products: Pick<Product, 'id' | 'name'>[]; llm?: LLMProvider | null }): Promise<Rule | null> {
  const t = text.toLowerCase();
  const conds: Condition[] = [];
  // Time: "haven't ordered in a month / 2 months / 6 weeks".
  const m = /(?:haven'?t|have not|not|no) (?:ordered|bought|bought anything)(?: (?:in|for))? (?:a |an |the last )?(\d+)?\s*(day|week|month)s?/.exec(t);
  if (m) conds.push({ kind: 'last_order_older', days: (Number(m[1]) || 1) * (m[2] === 'day' ? 1 : m[2] === 'week' ? 7 : 30) });
  if (/\b(top|best|biggest) (customers|spenders|buyers)\b|\bvips?\b/.test(t)) conds.push({ kind: 'spend_percentile', min: 90 });
  if (/\b(regulars?|loyal|repeat)\b/.test(t)) conds.push({ kind: 'order_count', min: 3 });
  if (/\b(one-?time|bought once|only once)\b/.test(t)) conds.push({ kind: 'order_count', min: 1, max: 1 });
  if (/\b(lapsed|lost|gone quiet)\b/.test(t)) conds.push({ kind: 'recency', bucket: 'lapsed' });
  // "my sneaker buyers" / "people who bought bags" / "asked about the hoodie".
  const action = /\b(asked|enquired|inquired)\b/.test(t) ? 'asked' : /\b(looked|viewed|checked out)\b/.test(t) ? 'viewed' : /\b(bought|buyers?|customers? of|purchased)\b/.test(t) ? 'bought' : null;
  if (action) {
    const ws = words(t);
    const cat = ctx.categories.find(c => words(c.name).some(w => ws.includes(w)));
    const prod = cat ? null : ctx.products.find(p => words(p.name).filter(w => ws.includes(w)).length >= Math.min(2, words(p.name).length));
    if (cat) conds.push({ kind: 'signal', action, categoryId: cat.id });
    else if (prod) conds.push({ kind: 'signal', action, productId: prod.id });
  }
  const area = /\b(?:in|around|from) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)\b/.exec(text);
  if (area && !/^(the|a|my)$/i.test(area[1])) conds.push({ kind: 'area', value: area[1] });
  if (conds.length) { const r = ruleSchema.safeParse({ all: conds }); if (r.success) return r.data; }
  return aiRule(text, ctx);
}

async function aiRule(text: string, ctx: { categories: Pick<Category, 'id' | 'name'>[]; products: Pick<Product, 'id' | 'name'>[]; llm?: LLMProvider | null }): Promise<Rule | null> {
  if (!ctx.llm?.writeTexts) return null;
  try {
    const out = await ctx.llm.writeTexts({
      prompt: [
        'Turn a shop owner\'s description of a group of their customers into a JSON rule. Reply with only the JSON.',
        'Format: {"all":[conditions]}. Conditions: {"kind":"signal","action":"bought|asked|viewed|carted","categoryId"?,"productId"?,"withinDays"?} · {"kind":"spend_percentile","min":0-100} · {"kind":"order_count","min"?,"max"?} · {"kind":"recency","bucket":"active|cooling|lapsed"} · {"kind":"last_order_older","days":n} · {"kind":"area","value":"Yaba"} · {"kind":"size","value":"42"} · {"kind":"usual_day","day":"mon"…"sun"}.',
        `Categories (id: name): ${ctx.categories.slice(0, 40).map(c => `${c.id}: ${c.name}`).join('; ')}`,
        `Products (id: name): ${ctx.products.slice(0, 80).map(p => `${p.id}: ${p.name}`).join('; ')}`,
        `Owner's words: """${text.slice(0, 300)}"""`,
      ].join('\n'),
      keys: ['rule'],
    });
    const parsed = ruleSchema.safeParse(JSON.parse(String(out.rule ?? '').replace(/^```(?:json)?|```$/g, '').trim()));
    if (!parsed.success) return null;
    // Only ids that exist in this shop.
    const ok = parsed.data.all.every(k => k.kind !== 'signal' || ((!k.categoryId || ctx.categories.some(c => c.id === k.categoryId)) && (!k.productId || ctx.products.some(p => p.id === k.productId))));
    return ok ? parsed.data : null;
  } catch (e) {
    log('warn', 'segment_ai_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) });
    return null;
  }
}

// A rule in words, for the owner ("bought Sneakers · 3+ orders").
export function describeRule(rule: Rule, names: { categories: Pick<Category, 'id' | 'name'>[]; products: Pick<Product, 'id' | 'name'>[] }) {
  return rule.all.map(k => {
    switch (k.kind) {
      case 'signal': return `${k.action} ${k.categoryId ? names.categories.find(c => c.id === k.categoryId)?.name ?? 'that section' : k.productId ? names.products.find(p => p.id === k.productId)?.name ?? 'that product' : 'anything'}${k.withinDays ? ` in the last ${k.withinDays} days` : ''}`;
      case 'spend_percentile': return `top ${100 - k.min}% by spend`;
      case 'order_count': return k.max === k.min ? `${k.min} order${k.min === 1 ? '' : 's'}` : `${k.min ?? 0}+ orders`;
      case 'recency': return k.bucket;
      case 'last_order_older': return `no order for ${k.days}+ days`;
      case 'size': return `size ${k.value}`;
      case 'area': return `in ${k.value}`;
      case 'usual_day': return `usually orders on ${k.day}`;
      case 'interest': return `wants ${k.value}`;
    }
  }).join(' · ');
}
