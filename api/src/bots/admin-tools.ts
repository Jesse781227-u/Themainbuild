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
import type { Conversation, Order, Product } from '../domain/commerce';
import type { ToolSpec } from '../services/ai';
import { adjustInventory, createProduct, listProducts } from '../services/catalog';
import { saveZone } from '../services/delivery';
import { markOrderPaid } from '../services/on-paid';
import { cancelOrder, findOrderByRef, recentOrders } from '../services/orders';
import { createSignupSession } from '../services/signup';
import { createBroadcast, quoteBroadcast, quoteText, shopLink } from '../services/broadcasts';
import { customerConversationId } from '../services/conversations';
import { deleteOwnerData } from './deletion';
import { findProducts, type BotDeps } from './common';

export interface ToolCtx {
  db: Firestore; cfg: Config; deps: BotDeps;
  business: Business; ownerPhone: string;
  imageUrl?: string | null;             // a photo sent with the message, already stored in R2
}

export interface AdminTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  spec: ToolSpec;
  schema: S;
  confirm?: (args: z.output<S>, ctx: ToolCtx) => Promise<string | null> | string | null; // prompt shown before a destructive action
  run(args: z.output<S>, ctx: ToolCtx): Promise<string>;
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

const line = (p: Product) => `• ${p.name}: ${formatKobo(p.priceKobo)}, ${p.stock} in stock${p.stock <= p.lowStockThreshold ? ' ⚠️ low' : ''}${p.available ? '' : ' (hidden)'}`;
const orderLine = (o: Order) => `• ${o.ref}: ${formatKobo(o.payAmountKobo)}, ${o.status.replace('_', ' ')}${o.status === 'paid' ? `, ${o.fulfilment.replace(/_/g, ' ')}` : ''}`;

export const HELP = [
  'Here is what I can do:',
  '• add Jollof rice, 2500, 10 (name, price, stock; send a photo with it to add a picture)',
  '• restock Jollof rice 5 · price Jollof rice 3000',
  '• products · orders · unpaid · sales today',
  '• RLY-ABCDE paid · RLY-ABCDE delivered · cancel RLY-ABCDE',
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
    async run(a, ctx) {
      const existing = (await findProducts(ctx.db, ctx.business.id, a.name)).find(p => p.name.toLowerCase() === a.name.toLowerCase());
      if (existing) {
        // Sending the same product again with new numbers means "correct it".
        const changes: string[] = [];
        if (a.price !== existing.priceKobo) {
          await ctx.db.update(ctx.db.doc(C.products, existing.id), { priceKobo: a.price, updatedAt: new Date().toISOString() });
          changes.push(`price ${formatKobo(existing.priceKobo)} → ${formatKobo(a.price)}`);
        }
        if (a.stock !== undefined && a.stock !== existing.stock) {
          const now = await adjustInventory(ctx.db, existing.id, ctx.business.id, a.stock - existing.stock, 'adjustment', 'owner');
          changes.push(`stock ${existing.stock} → ${now}`);
        }
        if (!changes.length) return `You already have ${existing.name}: ${formatKobo(existing.priceKobo)}, ${existing.stock} in stock. Nothing changed.`;
        return `Updated ${existing.name}: ${changes.join(', ')}.`;
      }
      // Never default a new product to 0 stock: customers would see it as sold out.
      if (a.stock === undefined) return `How many ${a.name} do you have? Send it again with the stock at the end, e.g. "${a.name}, ${a.price / 100}, 10". For a service, use how many you can take on.`;
      const p = await createProduct(ctx.db, { businessId: ctx.business.id, name: a.name, priceKobo: a.price, stock: a.stock ?? 0, description: a.description ?? '', images: ctx.imageUrl ? [ctx.imageUrl] : [] });
      return `Added ${p.name}: ${formatKobo(p.priceKobo)}, ${p.stock} in stock${ctx.imageUrl ? ', with the photo' : ''}.`;
    },
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
    async confirm(a, ctx) { const p = await oneProduct(ctx, a.product); return `Delete ${p.name} (${p.stock} in stock)? Customers won't see it any more.`; },
    async run(a, ctx) {
      const p = await oneProduct(ctx, a.product);
      await ctx.db.update(ctx.db.doc(C.products, p.id), { deletedAt: new Date().toISOString(), available: false });
      return `Deleted ${p.name}.`;
    },
  }),
  listProducts: def({
    spec: { name: 'listProducts', description: 'List the products with price and stock.', params: {} },
    schema: z.object({}),
    async run(_a, ctx) {
      const ps = await listProducts(ctx.db, ctx.business.id);
      return ps.length ? `Your products (${ps.length}):\n${ps.slice(0, 40).map(line).join('\n')}` : 'No products yet. Send e.g. "add Jollof rice, 2500, 10".';
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
      await ctx.db.update(ctx.db.doc(C.orders, o.id), { fulfilment: a.status, updatedAt: new Date().toISOString() });
      return `${o.ref}: ${a.status.replace(/_/g, ' ')}.`;
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

export async function runTool(tool: AdminToolName, rawArgs: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const t = adminTools[tool] as unknown as AdminTool;
  const parsed = t.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) return "I didn't get all the details for that. Send HELP for examples.";
  try { return await t.run(parsed.data, ctx); }
  catch (e) { if (e instanceof ToolError) return e.message; throw e; }
}

export const newActionId = () => randomId(6);
