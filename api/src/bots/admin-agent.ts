// The Admin Bot's conversation agent: owners ask and instruct in plain words ("how far with sales
// this week vs last week?", "remove jollof, e don finish"), Relay answers from the database and acts
// through the same validated tools as the commands.
//
// The owner's rules (20 Nov):
//   • straight away (with an Undo button): add a product, mark one order packed/ready, mark one
//     item sold out, stock counts, hide/show, categories, pairings
//   • a Confirm tap first: prices, money (mark paid, delivery fees, bank details), deleting,
//     cancelling, anything sent to customers. The tap runs exactly the validated call stored here.
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import { formatKobo } from '../lib/money';
import { lagosDate } from '../lib/time';
import type { Business } from '../domain/business';
import { hasStock, stockLabel, totalStock, tracksStock, type Order, type Product } from '../domain/commerce';
import type { OutboundContent } from '../services/channel';
import { listCategories, listProducts } from '../services/catalog';
import { recentOrders } from '../services/orders';
import { getWallet, withdrawable } from '../services/wallet';
import { campaignResults } from '../services/reach-results';
import type { Campaign } from '../services/reach';
import { describeRule, evaluate, loadSegmentData, ruleFromWords } from '../services/segments';
import type { LLMProvider } from '../services/ai';
import { adminTools, isAdminTool, prepare, runTool, type AdminToolName, type ToolCtx } from './admin-tools';
import { buttons } from './common';
import { matchVariant } from './shop-agent';
import type { AgentTool } from './agent';

const DAY = 86_400_000;

// Changes that need the owner's Confirm tap (on top of the tools' own confirmations).
export const CONFIRM_FIRST = new Set<AdminToolName>(['setPrice', 'deleteProduct', 'deleteCategory', 'cancelOrder', 'markPaid', 'broadcast', 'setPaymentDetails', 'addDeliveryZone', 'deleteMyData']);
// Changes made straight away, with Undo where it can be undone exactly.
const DIRECT: AdminToolName[] = ['restock', 'adjustStock', 'setAvailability', 'addCategories', 'renameCategory', 'moveProduct', 'reorderCategory', 'updateFulfilment', 'pairProducts', 'unpairProduct', 'setSuggestions', 'handBack', 'shopLink', 'orderReceipt', 'listCustomers', 'findCustomer'];

export interface AdminHelpers {
  ctx: ToolCtx; llm: LLMProvider | null;
  reply: (c: OutboundContent | string) => Promise<unknown>;
  askConfirm: (tool: AdminToolName, args: Record<string, unknown>, prompt: string, words: string) => Promise<void>;
  setUndo: (undo: Undo | null) => Promise<void>;
  addProduct: (words: string, p: { name: string; price: string; stock?: number | null }) => Promise<void>;
}
export type Undo = { kind: 'tool'; tool: AdminToolName; args: Record<string, unknown>; label: string } | { kind: 'stock'; productId: string; stock: number | null; variants: Product['variants'] | null; label: string };

// ── Periods (Lagos days) ──
export type Period = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'last_7_days' | 'last_30_days';
export function periodDays(period: Period, now = new Date()): string[] {
  const today = lagosDate(now);
  const day = (offset: number) => lagosDate(new Date(now.getTime() - offset * DAY));
  const range = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => day(from - i));
  const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const dom = Number(today.slice(8, 10)) - 1;
  switch (period) {
    case 'today': return [today];
    case 'yesterday': return [day(1)];
    case 'this_week': return range(dow, 0);
    case 'last_week': return range(dow + 7, dow + 1);
    case 'this_month': return range(dom, 0);
    case 'last_month': { const end = dom + 1; const last = day(end); const len = Number(last.slice(8, 10)); return range(end + len - 1, end); }
    case 'last_7_days': return range(6, 0);
    case 'last_30_days': return range(29, 0);
  }
}
const PERIODS: Period[] = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'last_7_days', 'last_30_days'];
const periodOf = (v: unknown): Period => (PERIODS.includes(v as Period) ? (v as Period) : 'today');

export async function salesFor(db: Firestore, businessId: string, period: Period, now = new Date()) {
  const days = periodDays(period, now);
  const stats = await db.getAll(days.map(d => db.doc(C.dailyStats, `${businessId}_${d}`)));
  const orders = stats.reduce((t, s) => t + Number(s?.ordersPaid ?? 0), 0);
  const sales = stats.reduce((t, s) => t + Number(s?.salesKobo ?? 0), 0);
  const delivery = stats.reduce((t, s) => t + Number(s?.deliveryKobo ?? 0), 0);
  return { period, from: days[0], to: days[days.length - 1], paidOrders: orders, sales: formatKobo(sales), salesKobo: sales, delivery: formatKobo(delivery) };
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const orderBrief = (o: Order) => ({ ref: o.ref, status: o.status === 'paid' ? `paid, ${o.fulfilment.replace(/_/g, ' ')}` : o.status.replace(/_/g, ' '), total: formatKobo(o.payAmountKobo), items: o.items.map(i => `${i.qty} × ${i.name}`).join(', '), date: o.createdAt.slice(0, 10) });
const textOf = (c: OutboundContent | string) => (typeof c === 'string' ? c : JSON.stringify(c).replace(/"(type|id|messaging_product)":"[^"]*",?/g, '').slice(0, 1500));

export function adminSystem(business: Business) {
  return [
    `You are Relay's assistant for the owner of "${business.name}", a small business in Nigeria, chatting on WhatsApp. You answer questions about their shop and do what they ask, only through the tools.`,
    'Answers are short conversational summaries (no dumps): give the key numbers, compare when asked ("₦X this week vs ₦Y last week, up 20%"), and for long lists give the top 5 and offer the rest.',
    '"Remove X, e don finish" / "X don finish" / "we no get X again" means mark it sold out (markSoldOut), not delete. Only delete when they clearly say delete/remove it permanently.',
    'Some changes need the owner\'s Confirm tap (prices, money, deleting, cancelling, sending to customers). Call the tool straight away: it only shows the Confirm button, nothing changes until they tap it. Then say what will change ("Tap *Yes* to make Zobo ₦1,300"), never "I\'ve set" or "done".',
    'You can\'t schedule changes for later; offer to do it now.',
    'Simple changes happen straight away with an Undo button; say what you did in one line.',
    'If a request is unclear (which product? which order?), ask one short question. Never guess product names or order numbers.',
    'Only help with running this shop on Relay; other topics get one friendly line.',
  ].join('\n');
}

export async function adminContext(ctx: ToolCtx, now = new Date()) {
  const [products, cats, today, unpaid, paid] = await Promise.all([
    listProducts(ctx.db, ctx.business.id), listCategories(ctx.db, ctx.business.id), salesFor(ctx.db, ctx.business.id, 'today', now),
    recentOrders(ctx.db, [['businessId', '==', ctx.business.id], ['status', '==', 'awaiting_payment']], 50),
    recentOrders(ctx.db, [['businessId', '==', ctx.business.id], ['status', '==', 'paid']], 50),
  ]);
  const live = products.filter(p => !p.deletedAt);
  const catName = new Map(cats.map(c => [c.id, c.name]));
  const toGo = paid.filter(o => !['delivered', 'picked_up'].includes(o.fulfilment));
  return [
    'CONTEXT (facts you may use):',
    `Shop: ${ctx.business.name}. Today (${today.from}): ${today.sales} from ${today.paidOrders} paid orders. ${unpaid.length} orders waiting for payment, ${toGo.length} paid orders still to deliver/hand over.`,
    `Sections: ${cats.map(c => c.name).join(', ') || 'none'}.`,
    live.length <= 80
      ? `Products (name | price | stock | section | visible):\n${live.map(p => `${p.name} | ${formatKobo(p.priceKobo)} | ${tracksStock(p) || p.variants?.length ? stockLabel(p) : 'not counted'}${hasStock(p) ? '' : ' (sold out)'} | ${catName.get(p.categoryId ?? '') ?? '-'} | ${p.available ? 'shown' : 'hidden'}${p.variants?.length ? ` | options: ${p.variants.map(v => `${v.label}${v.stock === 0 ? ' (sold out)' : ''}`).join(', ').slice(0, 120)}` : ''}`).join('\n')}`
      : `${live.length} products: use stockList.`,
    `Today's date: ${lagosDate(now)} (Africa/Lagos).`,
  ].join('\n');
}

function findProduct(products: Product[], name: string): Product | Product[] | null {
  const n = name.toLowerCase().trim();
  if (!n) return null;
  const exact = products.filter(p => p.name.toLowerCase() === n);
  if (exact.length === 1) return exact[0];
  const hits = products.filter(p => p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase()) || n.split(/\s+/).filter(w => w.length > 2).every(w => p.name.toLowerCase().includes(w.replace(/s$/, ''))));
  return hits.length === 1 ? hits[0] : hits.length ? hits.slice(0, 5) : null;
}

export function adminTools2(h: AdminHelpers): AgentTool<null>[] {
  const { ctx } = h;
  const tools: AgentTool<null>[] = [
    // ── Reading ──
    {
      spec: { name: 'salesSummary', description: 'Paid sales and order count for a period (Lagos days). Call twice to compare periods.', params: { period: { type: 'string', description: 'Which period', enum: PERIODS } }, required: ['period'] },
      async run(a) { const s = await salesFor(ctx.db, ctx.business.id, periodOf(a.period)); return { result: { ...s, salesKobo: undefined } }; },
    },
    {
      spec: { name: 'topProducts', description: 'Best-selling products in a period (by quantity, with revenue).', params: { period: { type: 'string', description: 'Which period', enum: PERIODS } }, required: ['period'] },
      async run(a) {
        const days = new Set(periodDays(periodOf(a.period)));
        const orders = (await recentOrders(ctx.db, [['businessId', '==', ctx.business.id], ['status', '==', 'paid']], 500)).filter(o => days.has(lagosDate(new Date(o.paidAt ?? o.createdAt))));
        const by = new Map<string, { qty: number; kobo: number }>();
        for (const o of orders) for (const l of o.items) { const x = by.get(l.name) ?? { qty: 0, kobo: 0 }; by.set(l.name, { qty: x.qty + l.qty, kobo: x.kobo + l.qty * l.priceKobo }); }
        return { result: [...by].sort((x, y) => y[1].qty - x[1].qty).slice(0, 10).map(([name, v]) => ({ name, sold: v.qty, revenue: formatKobo(v.kobo) })) };
      },
    },
    {
      spec: { name: 'ordersList', description: 'Orders: today, unpaid (waiting for payment), to_deliver (paid, not delivered yet) or recent.', params: { filter: { type: 'string', description: 'Which orders', enum: ['today', 'unpaid', 'to_deliver', 'recent'] } }, required: ['filter'] },
      async run(a) {
        const f = str(a.filter, 20);
        const all = await recentOrders(ctx.db, [['businessId', '==', ctx.business.id]], 100);
        const today = lagosDate();
        const pick = f === 'unpaid' ? all.filter(o => o.status === 'awaiting_payment') : f === 'to_deliver' ? all.filter(o => o.status === 'paid' && !['delivered', 'picked_up'].includes(o.fulfilment)) : f === 'today' ? all.filter(o => lagosDate(new Date(o.createdAt)) === today) : all;
        return { result: { count: pick.length, orders: pick.slice(0, 10).map(orderBrief) } };
      },
    },
    {
      spec: { name: 'stockList', description: 'Products by stock: low (running out), out (sold out) or all.', params: { filter: { type: 'string', description: 'Which', enum: ['low', 'out', 'all'] } }, required: ['filter'] },
      async run(a) {
        const f = str(a.filter, 10);
        const ps = (await listProducts(ctx.db, ctx.business.id)).filter(p => !p.deletedAt);
        const pick = f === 'out' ? ps.filter(p => !hasStock(p)) : f === 'low' ? ps.filter(p => hasStock(p) && p.stock !== null && p.stock <= p.lowStockThreshold) : ps;
        return { result: { count: pick.length, products: pick.slice(0, 20).map(p => ({ name: p.name, price: formatKobo(p.priceKobo), stock: tracksStock(p) || p.variants?.length ? stockLabel(p) : 'not counted' })) } };
      },
    },
    {
      spec: { name: 'customerLookup', description: 'One customer by name or phone: spending, favourite products, last purchases.', params: { query: { type: 'string', description: 'Name or phone number' } }, required: ['query'] },
      async run(a) { return { result: textOf(await runTool('findCustomer', { query: str(a.query, 60) }, ctx)) }; },
    },
    {
      spec: { name: 'customerGroup', description: 'How many customers fit a description ("my sneaker buyers", "people who haven\'t ordered in a month", "top customers"), with a few names.', params: { description: { type: 'string', description: 'The group in the owner\'s words' } }, required: ['description'] },
      async run(a) {
        const [cats, products] = await Promise.all([listCategories(ctx.db, ctx.business.id), listProducts(ctx.db, ctx.business.id)]);
        const rule = await ruleFromWords(str(a.description, 160), { categories: cats, products, llm: h.llm });
        if (!rule) return { result: { error: 'could not tell who that is' } };
        const data = await loadSegmentData(ctx.db, ctx.business.id);
        const ids = evaluate(rule, data);
        const names = data.customers.filter(c => ids.includes(c.id)).slice(0, 5).map(c => c.name?.split(' ')[0] ?? 'A customer');
        return { result: { group: describeRule(rule, { categories: cats, products }), count: ids.length, some: names, sendTip: 'They can message this group with: tell <group> about <news>' } };
      },
    },
    {
      spec: { name: 'walletBalance', description: 'Money in the shop\'s Relay wallet and how much can be withdrawn today.', params: {} },
      async run() { const w = await getWallet(ctx.db, ctx.business.id); return { result: { available: formatKobo(w.availableKobo), withdrawableToday: formatKobo(withdrawable(w, ctx.business)) } }; },
    },
    {
      spec: { name: 'campaignResults', description: 'Results of the Smart Reach updates sent in the last 30 days (sent, replied, ordered, revenue, cost).', params: {} },
      async run() {
        const since = new Date(Date.now() - 30 * DAY).toISOString();
        const cs = ((await ctx.db.query(C.campaigns, [['businessId', '==', ctx.business.id]], { limit: 200 })) as unknown as Campaign[]).filter(c => c.status === 'sent' && (c.approvedAt ?? c.createdAt) >= since).slice(0, 8);
        const out = [];
        for (const c of cs) { const r = await campaignResults(ctx.db, c.id); out.push({ name: c.name, sent: r.sent, replied: r.replied, ordered: r.ordered, revenue: formatKobo(r.revenueKobo), cost: formatKobo(r.costKobo) }); }
        return { result: out.length ? out : { none: true } };
      },
    },
    // ── Changes ──
    {
      spec: { name: 'markSoldOut', description: 'Mark a product (or one size/colour of it) sold out. Customers still see it, marked sold out. Has an Undo button.', params: { product: { type: 'string', description: 'Product name' }, option: { type: 'string', description: 'Size/colour, if only one option is sold out' } }, required: ['product'] },
      async run(a) {
        const products = (await listProducts(ctx.db, ctx.business.id)).filter(p => !p.deletedAt);
        const found = findProduct(products, str(a.product, 80));
        if (!found) return { result: { error: `no product called "${str(a.product, 40)}"` } };
        if (Array.isArray(found)) return { result: { error: 'which one?', candidates: found.map(p => p.name) } };
        const p = found;
        const variantId = matchVariant(p, str(a.option, 40));
        const before: Undo = { kind: 'stock', productId: p.id, stock: p.stock, variants: p.variants ?? null, label: `${p.name} back in stock` };
        if (variantId) {
          const variants = p.variants!.map(v => (v.id === variantId ? { ...v, stock: 0 } : v));
          await ctx.db.update(ctx.db.doc(C.products, p.id), { variants, stock: totalStock(variants), updatedAt: new Date().toISOString() });
        } else await ctx.db.update(ctx.db.doc(C.products, p.id), { stock: 0, ...(p.variants?.length ? { variants: p.variants.map(v => ({ ...v, stock: 0 })) } : {}), updatedAt: new Date().toISOString() });
        await h.setUndo(before);
        const what = variantId ? `${p.name} (${p.variants!.find(v => v.id === variantId)!.label})` : p.name;
        return { result: { done: true, soldOut: what }, show: async words => { await h.reply(buttons(words, [['undo', 'Undo'], ['act:products', 'My products']])); } };
      },
    },
    {
      spec: { name: 'addProduct', description: 'Add a new product (shows the owner a card to check before customers see it).', params: { name: { type: 'string', description: 'Product name' }, price: { type: 'string', description: 'Price in naira' }, stock: { type: 'integer', description: 'Units in stock (optional)' } }, required: ['name', 'price'] },
      async run(a) {
        const name = str(a.name, 120), price = str(a.price, 20);
        if (!name || !price) return { result: { error: 'need a name and a price' } };
        return { result: { started: true }, show: words => h.addProduct(words, { name, price, stock: Number.isInteger(Number(a.stock)) ? Number(a.stock) : null }) };
      },
    },
  ];
  // The command tools, same schemas: some straight away, some behind a Confirm tap.
  for (const name of [...DIRECT, ...CONFIRM_FIRST] as AdminToolName[]) {
    if (!isAdminTool(name) || name === 'deleteMyData') continue;
    const t = adminTools[name];
    tools.push({
      spec: { ...t.spec, description: `${t.spec.description}${CONFIRM_FIRST.has(name) ? ' (Needs the owner\'s Confirm tap.)' : ''}` },
      async run(a) {
        const prepared = await prepare(name, a, ctx);
        if (prepared.kind === 'reply') return { result: { error: prepared.text } };
        if (prepared.kind === 'confirm' || mustConfirm(name)) {
          const prompt = prepared.kind === 'confirm' ? prepared.prompt : confirmPrompt(name, a);
          return { result: { waitingForConfirm: true, question: prompt }, show: words => h.askConfirm(name, prepared.args, prompt, words) };
        }
        const out = await runTool(name, prepared.args, ctx);
        const undo = undoFor(name, prepared.args);
        if (undo) await h.setUndo(undo);
        const rich = typeof out !== 'string' && out.type !== 'text';
        return {
          result: { done: true, said: textOf(out) },
          show: rich ? async words => { await h.reply(words); await h.reply(out); } : undo ? async words => { await h.reply(buttons(words, [['undo', 'Undo'], ['act:menu', 'Menu']])); } : undefined,
        };
      },
    });
  }
  return tools;
}

export function confirmPrompt(name: AdminToolName, a: Record<string, unknown>) {
  if (name === 'setPrice') return `Change the price of *${str(a.product, 80)}* to ₦${Number(String(a.price).replace(/[^\d.]/g, '')).toLocaleString('en-NG')}?`;
  if (name === 'addDeliveryZone') return `Deliver to *${str(a.area, 60)}* for ₦${Number(String(a.fee).replace(/[^\d.]/g, '')).toLocaleString('en-NG')}${a.timeframe ? ` (${str(a.timeframe, 40)})` : ''}?`;
  if (name === 'setPaymentDetails') return `Customers will pay into: ${str(a.details, 160)}. Save this?`;
  return `${adminTools[name].spec.description} OK?`;
}

function undoFor(name: AdminToolName, a: Record<string, unknown>): Undo | null {
  if (name === 'setAvailability') return { kind: 'tool', tool: 'setAvailability', args: { product: a.product, available: !(a.available === true || a.available === 'true') }, label: 'Put back' };
  if (name === 'restock') return { kind: 'tool', tool: 'adjustStock', args: { product: a.product, change: -Number(a.quantity) }, label: 'Stock put back' };
  if (name === 'adjustStock') return { kind: 'tool', tool: 'adjustStock', args: { product: a.product, change: -Number(a.change) }, label: 'Stock put back' };
  return null;
}

// The Undo button: puts back exactly what the last direct change did (within 10 minutes).
export async function applyUndo(db: Firestore, ctx: ToolCtx, undo: (Undo & { expiresAt: string }) | null | undefined): Promise<string> {
  if (!undo || undo.expiresAt < new Date().toISOString()) return 'Nothing to undo now.';
  if (undo.kind === 'stock') {
    const p = (await db.get(db.doc(C.products, undo.productId))) as Product | null;
    if (!p || p.businessId !== ctx.business.id) return 'That product is gone.';
    await db.update(db.doc(C.products, p.id), { stock: undo.stock, ...(undo.variants ? { variants: undo.variants } : {}), updatedAt: new Date().toISOString() });
    return `↩️ Undone: ${undo.label}.`;
  }
  const out = await runTool(undo.tool, undo.args, ctx);
  return `↩️ Undone. ${typeof out === 'string' ? out : ''}`.trim();
}

export type { Config };

// The tools that change something (or ask the owner to confirm a change): a reply that says
// "I've changed…" needs one of them called.
const READ_ONLY = new Set(['salesSummary', 'topProducts', 'ordersList', 'stockList', 'customerLookup', 'customerGroup', 'walletBalance', 'campaignResults', 'shopLink', 'orderReceipt', 'listCustomers', 'findCustomer']);
export const ACTION_TOOLS = ['markSoldOut', 'addProduct', ...DIRECT, ...CONFIRM_FIRST].filter(n => !READ_ONLY.has(n));
// A Confirm tap is forced only on changes without their own check (prices, delivery fees, bank
// details); deleting, cancelling, marking paid and sending keep their own questions and guards.
export const mustConfirm = (name: AdminToolName) => CONFIRM_FIRST.has(name) && !adminTools[name].confirm;
