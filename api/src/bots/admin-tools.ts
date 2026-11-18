// The Admin Bot's tools. Each one has a zod schema (the only way arguments get in, whether they came
// from the rule parser or the LLM), a spec the LLM sees, and a run() that is always scoped to the
// caller's business: the business id comes from the owner's verified phone number, never from the
// arguments. Destructive tools return a confirmation prompt first and only run after a YES.
import { z } from 'zod';
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import { formatKobo, nairaToKobo } from '../lib/money';
import { lagosDate, lagosDayBounds } from '../lib/time';
import { normalisePhone } from '../lib/phone';
import { randomId } from '../lib/crypto';
import type { Business } from '../domain/business';
import { stockLabel, tracksStock, type Conversation, type Order, type Product } from '../domain/commerce';
import type { OutboundContent } from '../services/channel';
import type { ToolSpec } from '../services/ai';
import { adjustInventory, createCategories, deleteCategory, deleteProduct, findCategory, listCategories, listProducts, moveProduct, parseCategoryList, renameCategory, reorderCategory } from '../services/catalog';
import { saveZone } from '../services/delivery';
import { markOrderPaid } from '../services/on-paid';
import { cancelOrder, findOrderByRef, recentOrders } from '../services/orders';
import { createSignupSession } from '../services/signup';
import { createBroadcast, quoteBroadcast, quoteText, shopLink } from '../services/broadcasts';
import { customerConversationId } from '../services/conversations';
import { deleteOwnerData } from './deletion';
import { buttons, findProducts, list, type BotDeps } from './common';
import { productCarousel } from './product-cards';
import { messagesMenu } from './messages-flow';
import { customerList, findCustomer } from './customers';
import { receiptFilename, receiptPath } from '../services/receipt';
import { renderMessage } from '../services/shop-messages';

export interface ToolCtx {
  db: Firestore; cfg: Config; deps: BotDeps;
  business: Business; ownerPhone: string;
  imageUrl?: string | null;             // a photo sent with the message, already stored in R2
}

export interface AdminTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  spec: ToolSpec;
  schema: S;
  confirm?: (args: z.output<S>, ctx: ToolCtx) => Promise<string | null> | string | null; // prompt shown before a destructive action
  run(args: z.output<S>, ctx: ToolCtx): Promise<string | OutboundContent>;
}

const naira = z.union([z.string(), z.number()]).transform((v, c) => {
  const k = nairaToKobo(v);
  if (k === null || k <= 0) { c.addIssue({ code: z.ZodIssueCode.custom, message: 'price' }); return z.NEVER; }
  return k;
});
const qty = z.coerce.number().int();
const ref = z.string().trim().regex(/^RLY-[A-Z0-9]{5}$/i).transform(s => s.toUpperCase());

class ToolError extends Error {}

// Keeps each tool's argument types inferred from its own schema.
const def = <S extends z.ZodTypeAny>(t: AdminTool<S>) => t;

async function oneProduct(ctx: ToolCtx, query: string): Promise<Product> {
  const found = await findProducts(ctx.db, ctx.business.id, query);
  if (!found.length) throw new ToolError(`I couldn't find "${query}" in your products. Send PRODUCTS to see them.`);
  if (found.length > 1) throw new ToolError(`"${query}" matches ${found.map(p => p.name).slice(0, 5).join(', ')}. Which one?`);
  return found[0];
}

async function oneOrder(ctx: ToolCtx, orderRef: string): Promise<Order> {
  const o = await findOrderByRef(ctx.db, ctx.business.id, orderRef);
  if (!o) throw new ToolError(`I couldn't find order ${orderRef}.`);
  return o;
}

const line = (p: Product) => `• ${p.name}: ${formatKobo(p.priceKobo)}, ${stockLabel(p)}${tracksStock(p) && p.stock <= p.lowStockThreshold ? ' ⚠️ low' : ''}${p.available ? '' : ' (hidden)'}`;
const orderLine = (o: Order) => `• ${o.ref}: ${formatKobo(o.payAmountKobo)}, ${o.status.replace('_', ' ')}${o.status === 'paid' ? `, ${o.fulfilment.replace(/_/g, ' ')}` : ''}`;

export const HELP = [
  'Here is what I can do:',
  '• add Black AF1 25k (send a photo with it as the caption; add a stock number at the end if you track stock)',
  '• send your whole menu or price list as a PDF or photo (or paste it) to add everything at once',
  '• restock Black AF1 5 · price Black AF1 27k',
  '• categories · add category Watches · rename category Bags to Handbags · move Bags to the top · move Black AF1 to Sneakers',
  '• messages (see or change your welcome, payment thank-you and order update messages)',
  '• customers (who buys, what they like, where they live) · customer Kemi · customers recent · customers quiet',
  '• pair Jollof rice with Zobo, Plantain (what to suggest when customers add it) · unpair Jollof rice · suggestions off',
  '• products · orders · unpaid · sales today',
  '• RLY-ABCDE paid · RLY-ABCDE delivered · cancel RLY-ABCDE · receipt RLY-ABCDE (the PDF)',
  '• delivery zone Lekki, 1500, same day',
  '• payment details GTBank 0123456789 Mama Kitchen',
  '• broadcast <message> (to customers who opted in; you see the cost first) · link (a wa.me link for your Status)',
  '• handback (let the bot answer customers again)',
  '• connect (link your WhatsApp Business number)',
  'You can also send a voice note.',
].join('\n');

export const OFF_TOPIC = "I can only help you run your shop on Relay: products, stock, orders, payments and customers. Send HELP to see what I can do.";

export const adminTools = {
  addProduct: def({
    spec: { name: 'addProduct', description: 'Add a new product to the catalogue.', params: { name: { type: 'string', description: 'Product name' }, price: { type: 'string', description: 'Price in naira, e.g. "2500"' }, stock: { type: 'integer', description: 'Units in stock' }, description: { type: 'string', description: 'Short description' } }, required: ['name', 'price'] },
    schema: z.object({ name: z.string().trim().min(1).max(120), price: naira, stock: qty.min(0).max(1_000_000).optional(), description: z.string().max(500).optional() }),
    // admin.ts sends new products through products-flow (category, confirmation card); never reached.
    async run() { return 'To add a product send its name and price, e.g. "add Black AF1 25k".'; },
  }),
  setPrice: def({
    spec: { name: 'setPrice', description: "Change a product's price.", params: { product: { type: 'string', description: 'Product name' }, price: { type: 'string', description: 'New price in naira' } }, required: ['product', 'price'] },
    schema: z.object({ product: z.string().min(1), price: naira }),
    async run(a, ctx) {
      const p = await oneProduct(ctx, a.product);
      await ctx.db.update(ctx.db.doc(C.products, p.id), { priceKobo: a.price, updatedAt: new Date().toISOString() });
      return `${p.name} is now ${formatKobo(a.price)} (was ${formatKobo(p.priceKobo)}). Orders already placed keep their price.`;
    },
  }),
  restock: def({
    spec: { name: 'restock', description: 'Add units to a product\'s stock.', params: { product: { type: 'string', description: 'Product name' }, quantity: { type: 'integer', description: 'Units to add' } }, required: ['product', 'quantity'] },
    schema: z.object({ product: z.string().min(1), quantity: qty.min(1).max(1_000_000) }),
    async run(a, ctx) {
      const p = await oneProduct(ctx, a.product);
      const n = await adjustInventory(ctx.db, p.id, ctx.business.id, a.quantity, 'restock', 'owner');
      return `${p.name}: +${a.quantity}, now ${n} in stock.`;
    },
  }),
  adjustStock: def({
    spec: { name: 'adjustStock', description: 'Correct stock, e.g. after selling offline (negative) or a count.', params: { product: { type: 'string', description: 'Product name' }, change: { type: 'integer', description: 'Units to add (positive) or remove (negative)' } }, required: ['product', 'change'] },
    schema: z.object({ product: z.string().min(1), change: qty.refine(n => n !== 0) }),
    async run(a, ctx) {
      const p = await oneProduct(ctx, a.product);
      try {
        const n = await adjustInventory(ctx.db, p.id, ctx.business.id, a.change, 'adjustment', 'owner');
        return `${p.name}: ${a.change > 0 ? '+' : ''}${a.change}, now ${n} in stock.`;
      } catch (e) { if (String(e).includes('INSUFFICIENT_STOCK')) return `${p.name} only has ${p.stock} in stock.`; throw e; }
    },
  }),
  setAvailability: def({
    spec: { name: 'setAvailability', description: 'Show or hide a product from customers.', params: { product: { type: 'string', description: 'Product name' }, available: { type: 'boolean', description: 'true to show, false to hide' } }, required: ['product', 'available'] },
    schema: z.object({ product: z.string().min(1), available: z.boolean() }),
    async run(a, ctx) {
      const p = await oneProduct(ctx, a.product);
      await ctx.db.update(ctx.db.doc(C.products, p.id), { available: a.available, updatedAt: new Date().toISOString() });
      return `${p.name} is now ${a.available ? 'visible to' : 'hidden from'} customers.`;
    },
  }),
  deleteProduct: def({
    spec: { name: 'deleteProduct', description: 'Permanently remove a product from the catalogue.', params: { product: { type: 'string', description: 'Product name' } }, required: ['product'] },
    schema: z.object({ product: z.string().min(1) }),
    async confirm(a, ctx) { const p = await oneProduct(ctx, a.product); return `Delete ${p.name} (${stockLabel(p)})? Customers won't see it any more.`; },
    async run(a, ctx) {
      const p = await oneProduct(ctx, a.product);
      await deleteProduct(ctx.db, ctx.business.id, p.id);
      return `Deleted ${p.name}.`;
    },
  }),
  listProducts: def({
    spec: { name: 'listProducts', description: 'List the products with price and stock, grouped by category.', params: {} },
    schema: z.object({}),
    async run(_a, ctx) {
      const [ps, cats] = await Promise.all([listProducts(ctx.db, ctx.business.id), listCategories(ctx.db, ctx.business.id)]);
      if (!ps.length) return 'No products yet. Send e.g. "add Black AF1 25k", with a photo if you have one.';
      const groups = [...cats.map(c => ({ name: c.name, items: ps.filter(p => p.categoryId === c.id) })), { name: 'No category', items: ps.filter(p => !p.categoryId || !cats.some(c => c.id === p.categoryId)) }].filter(g => g.items.length);
      return `Your products (${ps.length}):\n${groups.map(g => `\n*${g.name}*\n${g.items.slice(0, 25).map(line).join('\n')}`).join('\n')}`.slice(0, 4000);
    },
  }),
  listCategories: def({
    spec: { name: 'listCategories', description: 'List the product categories with how many products each has.', params: {} },
    schema: z.object({}),
    async run(_a, ctx) {
      const cats = await listCategories(ctx.db, ctx.business.id);
      return cats.length ? `Your categories:\n${cats.map((c, i) => `${i + 1}. ${c.name} (${c.productCount} product${c.productCount === 1 ? '' : 's'})`).join('\n')}\n\nSend e.g. "add category Watches", "rename category Bags to Handbags", "move Bags to the top".` : 'No categories yet. Send e.g. "add category Sneakers, Bags".';
    },
  }),
  addCategories: def({
    spec: { name: 'addCategories', description: 'Create one or more product categories.', params: { names: { type: 'string', description: 'Category names, comma separated' } }, required: ['names'] },
    schema: z.object({ names: z.string().trim().min(1).max(400) }),
    async run(a, ctx) {
      const names = parseCategoryList(a.names);
      if (!names.length) return 'Send the category names, e.g. "add category Sneakers, Bags".';
      const created = await createCategories(ctx.db, ctx.business.id, names);
      return created.length ? `Created ✅ ${created.map(c => c.name).join(' · ')}` : 'You already have those categories.';
    },
  }),
  renameCategory: def({
    spec: { name: 'renameCategory', description: 'Rename a product category.', params: { category: { type: 'string', description: 'Current name' }, name: { type: 'string', description: 'New name' } }, required: ['category', 'name'] },
    schema: z.object({ category: z.string().min(1), name: z.string().trim().min(2).max(24) }),
    async run(a, ctx) {
      const c = findCategory(await listCategories(ctx.db, ctx.business.id), a.category);
      if (!c) throw new ToolError(`I couldn't find a category called "${a.category}". Send CATEGORIES to see them.`);
      try { return `Renamed ${c.name} to ${await renameCategory(ctx.db, ctx.business.id, c.id, a.name)}.`; }
      catch (e) { if (String(e).includes('CATEGORY_EXISTS')) return `You already have a category called ${a.name}.`; throw e; }
    },
  }),
  deleteCategory: def({
    spec: { name: 'deleteCategory', description: 'Delete a product category (its products are moved first).', params: { category: { type: 'string', description: 'Category name' } }, required: ['category'] },
    schema: z.object({ category: z.string().min(1) }),
    async confirm(a, ctx) {
      const c = findCategory(await listCategories(ctx.db, ctx.business.id), a.category);
      if (!c) throw new ToolError(`I couldn't find a category called "${a.category}". Send CATEGORIES to see them.`);
      return c.productCount ? null : `Delete the category ${c.name}?`;
    },
    async run(a, ctx) {
      const cats = await listCategories(ctx.db, ctx.business.id);
      const c = findCategory(cats, a.category)!;
      if (c.productCount) {
        const others = cats.filter(x => x.id !== c.id);
        if (!others.length) return `${c.name} has ${c.productCount} product${c.productCount === 1 ? '' : 's'} and it's your only category. Add another category first.`;
        return list(`${c.name} has ${c.productCount} product${c.productCount === 1 ? '' : 's'}. Move them to…`, 'Choose category', others.slice(0, 10).map(o => ({ id: `movecat:${c.id}:${o.id}`, title: o.name })), 'Move to');
      }
      await deleteCategory(ctx.db, ctx.business.id, c.id);
      return `Deleted the category ${c.name}.`;
    },
  }),
  reorderCategory: def({
    spec: { name: 'reorderCategory', description: 'Change where a category appears in the customer menu.', params: { category: { type: 'string', description: 'Category name' }, position: { type: 'string', description: '"top", "bottom" or a number (1 = first)' } }, required: ['category', 'position'] },
    schema: z.object({ category: z.string().min(1), position: z.union([z.string(), z.number()]).transform(v => String(v).toLowerCase().trim()) }),
    async run(a, ctx) {
      const cats = await listCategories(ctx.db, ctx.business.id);
      const c = findCategory(cats, a.category);
      if (!c) throw new ToolError(`I couldn't find a category called "${a.category}". Send CATEGORIES to see them.`);
      const pos = /^(top|first)$/.test(a.position) ? 0 : /^(bottom|last|end)$/.test(a.position) ? cats.length : Number(a.position) - 1;
      if (!Number.isInteger(pos) || pos < 0) return 'Say where: "move Bags to the top", "to the bottom", or "to position 2".';
      return `New order: ${(await reorderCategory(ctx.db, ctx.business.id, c.id, pos)).join(' · ')}`;
    },
  }),
  listCustomers: def({
    spec: { name: 'listCustomers', description: 'Show the owner\'s customers: who spent most, who ordered recently, or who has gone quiet.', params: { sort: { type: 'string', description: 'How to sort', enum: ['top', 'recent', 'quiet'] } } },
    schema: z.object({ sort: z.enum(['top', 'recent', 'quiet']).default('top') }),
    async run(a, ctx) { return customerList(ctx.db, ctx.business, a.sort); },
  }),
  findCustomer: def({
    spec: { name: 'findCustomer', description: 'Look up one customer by name or phone number: their address, spending, favourite products and last purchases.', params: { query: { type: 'string', description: 'Name or phone number' } }, required: ['query'] },
    schema: z.object({ query: z.string().trim().min(1).max(60) }),
    async run(a, ctx) { return findCustomer(ctx.db, ctx.business, a.query); },
  }),
  orderReceipt: def({
    spec: { name: 'orderReceipt', description: 'Get the PDF receipt of a paid order.', params: { order: { type: 'string', description: 'Order number like RLY-ABCDE' } }, required: ['order'] },
    schema: z.object({ order: ref }),
    async run(a, ctx) {
      const o = await oneOrder(ctx, a.order);
      if (o.status !== 'paid') return `${o.ref} isn't paid yet, so there's no receipt.`;
      let token = (o as Order & { receiptToken?: string | null }).receiptToken;
      if (!token) { // paid before receipts existed
        token = randomId(18).replace(/[^A-Za-z0-9]/g, 'x');
        await ctx.db.update(ctx.db.doc(C.orders, o.id), { receiptToken: token });
      }
      return { type: 'document', link: `${ctx.cfg.API_BASE_URL}${receiptPath(token)}`, filename: receiptFilename(o), caption: `Receipt for ${o.ref}: ${formatKobo(o.payAmountKobo)}.` };
    },
  }),
  pairProducts: def({
    spec: { name: 'pairProducts', description: 'Set what to suggest to customers who add a product to their cart ("pair Jollof rice with Zobo, Plantain").', params: { product: { type: 'string', description: 'The product customers add' }, with: { type: 'string', description: 'Products to suggest with it, comma separated' } }, required: ['product', 'with'] },
    schema: z.object({ product: z.string().trim().min(1).max(120), with: z.string().trim().min(1).max(500) }),
    async run(a, ctx) {
      const p = await oneProduct(ctx, a.product);
      const picks: Product[] = [];
      for (const name of a.with.split(/,|\band\b/i).map(s => s.trim()).filter(Boolean).slice(0, 4)) {
        const q = await oneProduct(ctx, name);
        if (q.id !== p.id && !picks.some(x => x.id === q.id)) picks.push(q);
      }
      if (!picks.length) throw new ToolError('Tell me what to suggest with it, e.g. "pair Jollof rice with Zobo, Plantain".');
      await ctx.db.update(ctx.db.doc(C.products, p.id), { pairsWith: picks.map(x => x.id), updatedAt: new Date().toISOString() });
      return `Done ✅ When a customer adds ${p.name}, I'll suggest ${picks.map(x => x.name).join(', ')} first.`;
    },
  }),
  unpairProduct: def({
    spec: { name: 'unpairProduct', description: 'Remove the owner\'s own suggestions for a product.', params: { product: { type: 'string', description: 'Product name' } }, required: ['product'] },
    schema: z.object({ product: z.string().trim().min(1).max(120) }),
    async run(a, ctx) {
      const p = await oneProduct(ctx, a.product);
      await ctx.db.update(ctx.db.doc(C.products, p.id), { pairsWith: [], aiPairs: null, updatedAt: new Date().toISOString() });
      return `Cleared. I'll go back to suggesting what customers usually buy with ${p.name}.`;
    },
  }),
  setSuggestions: def({
    spec: { name: 'setSuggestions', description: 'Turn "goes well with" suggestions to customers on or off.', params: { on: { type: 'boolean', description: 'true = on' } }, required: ['on'] },
    schema: z.object({ on: z.boolean() }),
    async run(a, ctx) {
      await ctx.db.update(ctx.db.doc(C.businesses, ctx.business.id), { suggestions: a.on, updatedAt: new Date().toISOString() });
      return a.on ? 'Suggestions are on ✅ After a customer adds something, I show a few items that go with it.' : 'Suggestions are off. Send SUGGESTIONS ON to turn them back on.';
    },
  }),
  shopMessages: def({
    spec: { name: 'shopMessages', description: 'See or change the messages customers get (welcome, payment thank-you, order ready, out for delivery, delivered).', params: {} },
    schema: z.object({}),
    async run() { return messagesMenu(); },
  }),
  previewCategory: def({
    spec: { name: 'previewCategory', description: 'Show the owner the carousel customers see for a category (or the whole shop).', params: { category: { type: 'string', description: 'Category name (optional)' } } },
    schema: z.object({ category: z.string().trim().optional() }),
    async run(a, ctx) {
      const [products, cats] = await Promise.all([listProducts(ctx.db, ctx.business.id), listCategories(ctx.db, ctx.business.id)]);
      const visible = products.filter(p => p.available);
      const cat = a.category ? findCategory(cats, a.category) : cats.find(c => visible.some(p => p.categoryId === c.id)) ?? null;
      if (a.category && !cat) throw new ToolError(`I couldn't find a category called "${a.category}". Send CATEGORIES to see them.`);
      const items = cat ? visible.filter(p => p.categoryId === cat.id) : visible;
      if (!items.length) return cat ? `${cat.name} has no visible products yet.` : 'No products yet.';
      // The same cards customers get; tapping them here does nothing for the owner.
      return productCarousel(ctx.cfg, ctx.business, items, { title: cat?.name ?? 'Your products', key: cat?.id ?? 'all' })[0];
    },
  }),
  moveProduct: def({
    spec: { name: 'moveProduct', description: 'Move a product to another category.', params: { product: { type: 'string', description: 'Product name' }, category: { type: 'string', description: 'Target category name' } }, required: ['product', 'category'] },
    schema: z.object({ product: z.string().min(1), category: z.string().min(1) }),
    async run(a, ctx) {
      const c = findCategory(await listCategories(ctx.db, ctx.business.id), a.category);
      if (!c) throw new ToolError(`I couldn't find a category called "${a.category}". Send CATEGORIES to see them.`);
      const p = await oneProduct(ctx, a.product);
      return (await moveProduct(ctx.db, ctx.business.id, p.id, c.id)) ? `Moved ${p.name} to ${c.name}.` : `${p.name} is already in ${c.name}.`;
    },
  }),
  listOrders: def({
    spec: { name: 'listOrders', description: 'List orders.', params: { filter: { type: 'string', description: 'Which orders', enum: ['today', 'unpaid', 'paid', 'recent'] } } },
    schema: z.object({ filter: z.enum(['today', 'unpaid', 'paid', 'recent']).default('recent') }),
    async run(a, ctx) {
      const filters: [string, '==', unknown][] = [['businessId', '==', ctx.business.id]];
      if (a.filter === 'unpaid') filters.push(['status', '==', 'awaiting_payment']);
      if (a.filter === 'paid') filters.push(['status', '==', 'paid']);
      let orders = await recentOrders(ctx.db, filters, 20);
      if (a.filter === 'today') { const { start } = lagosDayBounds(); orders = orders.filter(o => o.createdAt >= start.toISOString()); }
      const label = { today: "Today's orders", unpaid: 'Awaiting payment', paid: 'Paid orders', recent: 'Recent orders' }[a.filter];
      return orders.length ? `${label}:\n${orders.slice(0, 15).map(orderLine).join('\n')}` : `${label}: none.`;
    },
  }),
  salesToday: def({
    spec: { name: 'salesToday', description: "Today's sales summary.", params: {} },
    schema: z.object({}),
    async run(_a, ctx) {
      const day = await ctx.db.get(ctx.db.doc(C.dailyStats, `${ctx.business.id}_${lagosDate()}`));
      const unpaid = await recentOrders(ctx.db, [['businessId', '==', ctx.business.id], ['status', '==', 'awaiting_payment']], 50);
      return `Today: ${Number(day?.ordersPaid ?? 0)} paid orders, ${formatKobo(Number(day?.salesKobo ?? 0))} in sales${Number(day?.deliveryKobo ?? 0) ? ` + ${formatKobo(Number(day?.deliveryKobo))} delivery` : ''}. ${unpaid.length} awaiting payment.`;
    },
  }),
  markPaid: def({
    spec: { name: 'markPaid', description: 'Mark an order as paid (e.g. cash or a transfer the owner saw).', params: { order: { type: 'string', description: 'Order number like RLY-ABCDE' } }, required: ['order'] },
    schema: z.object({ order: ref }),
    async confirm(a, ctx) { const o = await oneOrder(ctx, a.order); return o.status === 'paid' ? null : `Mark ${o.ref} (${formatKobo(o.payAmountKobo)}) as paid? The customer will get a receipt.`; },
    async run(a, ctx) {
      const o = await oneOrder(ctx, a.order);
      const r = await markOrderPaid(ctx.db, o.id, ctx.business.id, `manual_${o.id}`);
      if (!r.applied) return r.reason === 'already_paid' ? `${o.ref} is already paid.` : `${o.ref} can't be marked paid (${r.reason}).`;
      await ctx.deps.enqueue(r.outboxIds.map(messageId => ({ kind: 'outbox' as const, messageId })));
      return `${o.ref} marked paid.${r.order.needsAttention ? ' ⚠️ Its hold had expired and some items are out of stock.' : ''}`;
    },
  }),
  cancelOrder: def({
    spec: { name: 'cancelOrder', description: 'Cancel an unpaid order and return its stock.', params: { order: { type: 'string', description: 'Order number like RLY-ABCDE' } }, required: ['order'] },
    schema: z.object({ order: ref }),
    async confirm(a, ctx) { const o = await oneOrder(ctx, a.order); return `Cancel ${o.ref} (${formatKobo(o.payAmountKobo)}, ${o.status.replace('_', ' ')})?`; },
    async run(a, ctx) {
      const o = await oneOrder(ctx, a.order);
      const r = await cancelOrder(ctx.db, o.id, ctx.business.id);
      return { cancelled: `Cancelled ${o.ref}.${o.status === 'awaiting_payment' ? ' The stock is back.' : ''}`, paid: `${o.ref} is already paid, so I can't cancel it here. Refund the customer, then adjust stock if needed.`, already_cancelled: `${o.ref} was already cancelled.`, not_found: `I couldn't find ${o.ref}.` }[r];
    },
  }),
  updateFulfilment: def({
    spec: { name: 'updateFulfilment', description: 'Update delivery/pickup progress of a paid order.', params: { order: { type: 'string', description: 'Order number' }, status: { type: 'string', description: 'New status', enum: ['ready', 'out_for_delivery', 'delivered', 'picked_up'] } }, required: ['order', 'status'] },
    schema: z.object({ order: ref, status: z.enum(['ready', 'out_for_delivery', 'delivered', 'picked_up']) }),
    async run(a, ctx) {
      const o = await oneOrder(ctx, a.order);
      if (o.status !== 'paid') return `${o.ref} isn't paid yet.`;
      const at = new Date().toISOString();
      await ctx.db.update(ctx.db.doc(C.orders, o.id), { fulfilment: a.status, updatedAt: at });
      // Tell the customer, in the shop's own words (MESSAGES). Once per status; inside the 24-hour window only.
      const key = ({ ready: 'orderReady', out_for_delivery: 'outForDelivery', delivered: 'delivered', picked_up: 'delivered' } as const)[a.status];
      const customer = (await ctx.db.get(ctx.db.doc(C.customers, o.customerId))) as { phone?: string; name?: string } | null;
      let told = false;
      if (customer?.phone) {
        const id = `${o.id}_${a.status}`;
        told = await ctx.db.create(ctx.db.doc(C.outbox, id), {
          id, businessId: o.businessId, audience: 'customer', channel: o.channel, to: customer.phone,
          conversationId: customerConversationId(o.businessId, o.channel, customer.phone), kind: `order_${a.status}`,
          text: renderMessage(ctx.business, key, { customer: customer.name, order: o.ref }), status: 'pending', attempts: 0, createdAt: at,
        });
        if (told) await ctx.deps.enqueue([{ kind: 'outbox', messageId: id }]);
      }
      return `${o.ref}: ${a.status.replace(/_/g, ' ')}.${told ? ' The customer has been told.' : ''}`;
    },
  }),
  addDeliveryZone: def({
    spec: { name: 'addDeliveryZone', description: 'Add an area the business delivers to, with its fee.', params: { area: { type: 'string', description: 'Area name customers will type, e.g. Lekki' }, fee: { type: 'string', description: 'Delivery fee in naira' }, timeframe: { type: 'string', description: 'e.g. same day' } }, required: ['area', 'fee'] },
    schema: z.object({ area: z.string().trim().min(2).max(60), fee: z.union([z.string(), z.number()]).transform((v, c) => { const k = nairaToKobo(v); if (k === null) { c.addIssue({ code: 'custom', message: 'fee' }); return z.NEVER; } return k; }), timeframe: z.string().max(60).optional() }),
    async run(a, ctx) {
      await saveZone(ctx.db, { id: `${ctx.business.id}_${a.area.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, businessId: ctx.business.id, name: a.area, match: a.area, feeKobo: a.fee, timeframe: a.timeframe ?? 'Arranged after payment', active: true });
      return `Delivery to ${a.area}: ${formatKobo(a.fee)}${a.timeframe ? `, ${a.timeframe}` : ''}. Relay takes no fee on delivery.`;
    },
  }),
  setPaymentDetails: def({
    spec: { name: 'setPaymentDetails', description: 'Set the bank details customers pay into.', params: { details: { type: 'string', description: 'Bank, account number and account name' } }, required: ['details'] },
    schema: z.object({ details: z.string().trim().min(6).max(160) }),
    async run(a, ctx) {
      await ctx.db.update(ctx.db.doc(C.businesses, ctx.business.id), { paymentDetails: a.details, updatedAt: new Date().toISOString() });
      return `Customers will be told to pay to: ${a.details}`;
    },
  }),
  handBack: def({
    spec: { name: 'handBack', description: 'Let the bot answer customers again after the owner took over a chat.', params: { customer: { type: 'string', description: "Customer's phone number; omit for all chats" } } },
    schema: z.object({ customer: z.string().optional() }),
    async run(a, ctx) {
      let ids: string[];
      if (a.customer) {
        const phone = normalisePhone(a.customer);
        if (!phone) return `"${a.customer}" doesn't look like a phone number.`;
        ids = [customerConversationId(ctx.business.id, 'whatsapp', phone)];
      } else {
        ids = (await ctx.db.query(C.conversations, [['businessId', '==', ctx.business.id], ['mode', '==', 'owner']], { limit: 100 })).map(c => c._id);
      }
      const convs = (await ctx.db.getAll(ids.map(id => ctx.db.doc(C.conversations, id)))) as (Conversation | null)[];
      const active = convs.filter(c => c?.businessId === ctx.business.id && c.mode === 'owner') as Conversation[];
      if (!active.length) return 'The bot is already answering all your chats.';
      const batch = ctx.db.batch();
      for (const c of active) batch.update(ctx.db.doc(C.conversations, c.id), { mode: 'bot', handedBackAt: new Date().toISOString() });
      await batch.commit();
      return `Done: the bot is answering ${active.length === 1 ? 'that chat' : `${active.length} chats`} again.`;
    },
  }),
  connectWhatsApp: def({
    spec: { name: 'connectWhatsApp', description: "Get the link to connect the business's own WhatsApp Business number.", params: {} },
    schema: z.object({}),
    async run(_a, ctx) {
      const conn = await ctx.db.get(ctx.db.doc(C.whatsappConnections, ctx.business.id));
      if (conn?.status === 'connected') return 'Your WhatsApp Business number is already connected.';
      const link = await createSignupSession(ctx.db, ctx.cfg, ctx.business.id);
      return `Open this link on a phone or computer to connect your WhatsApp Business number (valid 24 hours):\n${link}\nYou keep using the WhatsApp Business app as normal.`;
    },
  }),
  deleteMyData: def({
    spec: { name: 'deleteMyData', description: "Delete the owner's Relay account and data.", params: {} },
    schema: z.object({}),
    confirm: () => 'Delete your Relay account? This disconnects your WhatsApp and Instagram and stops the bots. Paid orders and records the law requires us to keep are kept. This cannot be undone.',
    async run(_a, ctx) { const code = await deleteOwnerData(ctx.db, ctx.business.id, ctx.ownerPhone); return `Your account is deleted. Reference: ${code}. Thank you for using Relay.`; },
  }),
  broadcast: def({
    spec: { name: 'broadcast', description: 'Send a promotional update to customers who opted in.', params: { message: { type: 'string', description: 'The message to send, in the owner\'s words' } }, required: ['message'] },
    schema: z.object({ message: z.string().trim().min(5).max(700) }),
    async confirm(a, ctx) {
      const q = await quoteBroadcast(ctx.db, ctx.cfg, ctx.business.id);
      if (!q) throw new ToolError('Broadcasts are not switched on yet. Send LINK to get a link you can share in your Status instead.');
      if (!q.audience) throw new ToolError("No customers have opted in to updates yet. Customers opt in by sending SUBSCRIBE to your number. Send LINK to get a link you can share in your Status.");
      return quoteText(q, a.message);
    },
    async run(a, ctx) {
      const { outboxIds } = await createBroadcast(ctx.db, ctx.cfg, ctx.business, a.message);
      await ctx.deps.enqueue(outboxIds.map(messageId => ({ kind: 'outbox' as const, messageId })));
      return `Sending to ${outboxIds.length} customer${outboxIds.length === 1 ? '' : 's'}. They can reply STOP to opt out.`;
    },
  }),
  shopLink: def({
    spec: { name: 'shopLink', description: 'Get a wa.me link to the shop (with an optional prefilled message) to share in Status, groups or Instagram.', params: { message: { type: 'string', description: 'Prefilled message the customer sends, e.g. "Hi, I want to order"' } } },
    schema: z.object({ message: z.string().trim().max(200).optional() }),
    async run(a, ctx) {
      const link = shopLink((ctx.business as Business & { whatsappDisplayNumber?: string | null }).whatsappDisplayNumber, a.message || 'Hi! I would like to order');
      return link ? `Share this link in your Status, groups or Instagram bio. Customers who tap it start a chat with your shop:\n${link}` : 'Connect your WhatsApp Business number first (send CONNECT).';
    },
  }),
  help: def({ spec: { name: 'help', description: 'Explain what the Admin Bot can do.', params: {} }, schema: z.object({}), async run() { return HELP; } }),
  greet: def({
    spec: { name: 'greet', description: 'The owner says hello.', params: {} },
    schema: z.object({}),
    async run(_a, ctx) {
      const first = ctx.business.ownerName?.split(' ')[0];
      const notConnected = ctx.business.status === 'onboarding' ? '\n\nYour WhatsApp number isn\'t connected yet, so customers can\'t order. Send CONNECT to get the link.' : '';
      // Button titles are sent back as text, so they work as commands.
      return buttons(`Hi${first ? ` ${first}` : ''} 👋 What would you like to do for ${ctx.business.name}?${notConnected}`, [['g:products', 'Products'], ['g:orders', 'Orders'], ['g:help', 'Help']]);
    },
  }),
  offTopic: def({ spec: { name: 'offTopic', description: 'Anything not about running this shop (general questions, chit-chat, other topics).', params: {} }, schema: z.object({}), async run() { return OFF_TOPIC; } }),
};

export type AdminToolName = keyof typeof adminTools;
export const isAdminTool = (name: string): name is AdminToolName => Object.prototype.hasOwnProperty.call(adminTools, name);
export const adminToolSpecs = () => Object.values(adminTools).map(t => t.spec);

export type Prepared = { kind: 'run'; tool: AdminToolName; args: Record<string, unknown> } | { kind: 'confirm'; tool: AdminToolName; args: Record<string, unknown>; prompt: string } | { kind: 'reply'; text: string };

// Validates a proposed tool call and decides whether it needs confirmation. Unknown tools and
// arguments that fail validation never run.
export async function prepare(tool: string, rawArgs: Record<string, unknown>, ctx: ToolCtx): Promise<Prepared> {
  if (!isAdminTool(tool)) return { kind: 'reply', text: OFF_TOPIC };
  const t = adminTools[tool] as unknown as AdminTool;
  const parsed = t.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) return { kind: 'reply', text: tool === 'addProduct' ? 'To add a product send its name, price and stock, e.g. "add Jollof rice, 2500, 10".' : "I didn't get all the details for that. Send HELP for examples." };
  try {
    const prompt = t.confirm ? await t.confirm(parsed.data, ctx) : null;
    // Store the raw args: they are re-validated when the owner confirms.
    return prompt ? { kind: 'confirm', tool, args: rawArgs, prompt } : { kind: 'run', tool, args: rawArgs };
  } catch (e) { if (e instanceof ToolError) return { kind: 'reply', text: e.message }; throw e; }
}

export async function runTool(tool: AdminToolName, rawArgs: Record<string, unknown>, ctx: ToolCtx): Promise<string | OutboundContent> {
  const t = adminTools[tool] as unknown as AdminTool;
  const parsed = t.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) return "I didn't get all the details for that. Send HELP for examples.";
  try { return await t.run(parsed.data, ctx); }
  catch (e) { if (e instanceof ToolError) return e.message; throw e; }
}

export const newActionId = () => randomId(6);
