// The Shop Bot answers customers on the merchant's own WhatsApp number (and Instagram DMs).
// Flow: greeting with categories → products → add to cart → delivery or pickup → confirm → order
// (stock reserved, unique amount) → payment instructions. It stays silent while the owner has taken
// over the chat, and hands over when the customer asks for a person.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { formatKobo, feeKobo } from '../lib/money';
import { log } from '../lib/logger';
import { maskPhone } from '../lib/phone';
import type { Business } from '../domain/business';
import type { Cart, Category, Conversation, Customer, Order, OrderDelivery, Product } from '../domain/commerce';
import { hasStock, tracksStock } from '../domain/commerce';
import { send, optionIds, resolveSender, type OutboundContent } from '../services/channel';
import { listProducts } from '../services/catalog';
import { listZones, quoteDelivery } from '../services/delivery';
import { checkout, policyFor, recentOrders } from '../services/orders';
import { paymentInstructions } from '../services/bachs';
import type { ShopContext } from '../services/router';
import type { LLMProvider, ToolChoice, ToolSpec } from '../services/ai';
import { buttons, findProducts, list, notifyOwner, NO, readInput, transcribeVoice, YES, type BotDeps } from './common';
import { deleteShopperData, deletionCode } from './deletion';

const CART_HOURS = 24;

type Step = 'browse' | 'await_address' | 'confirm' | 'confirm_delete';
interface ShopState { step: Step; options?: string[]; delivery?: OrderDelivery | null }
type ShopConversation = Conversation & { shop?: ShopState | null };

const SHOP_TOOLS: ToolSpec[] = [
  { name: 'showMenu', description: 'Show what the shop sells (greeting, "what do you have", prices in general).', params: {} },
  { name: 'addToCart', description: 'Customer wants a specific product.', params: { product: { type: 'string', description: 'Product name as the customer wrote it' }, quantity: { type: 'integer', description: 'How many (default 1)' } }, required: ['product'] },
  { name: 'viewCart', description: 'Show the cart.', params: {} },
  { name: 'checkout', description: 'Customer wants to pay / place the order.', params: {} },
  { name: 'orderStatus', description: 'Customer asks about an order they placed.', params: {} },
  { name: 'talkToHuman', description: 'Customer asks for a person, the owner, or has a complaint the bot cannot handle.', params: {} },
  { name: 'offTopic', description: 'Anything not about shopping at this business.', params: {} },
];

export async function handleShop(ctx: ShopContext, deps: BotDeps) {
  const { db, cfg, businessId, conversationId } = ctx;
  const [conv, business, customer] = (await db.getAll([db.doc(C.conversations, conversationId), db.doc(C.businesses, businessId), db.doc(C.customers, conversationId)])) as [ShopConversation | null, Business | null, Customer | null];
  if (!conv || !business || business.status === 'deleted') return;
  // Marketing opt-out is honoured even while the owner has taken over the chat.
  const optText = (ctx.event.text ?? '').trim().toLowerCase();
  if (/^(stop|unsubscribe|stop all)$/.test(optText)) {
    await db.set(db.doc(C.customers, conversationId), { marketingOptIn: false, marketingOptOutAt: new Date().toISOString() }, { merge: true });
    if (conv.mode === 'owner') return;
    await send(db, cfg, deps.transport, { from: { businessId }, conversationId, to: ctx.event.from, content: { type: 'text', text: `You won't get updates from ${business.name} any more. You can still order here any time; send SUBSCRIBE to get updates again.` } });
    return;
  }
  if (conv.mode === 'owner') return; // the owner is handling this chat until they hand back

  const to = ctx.event.from;
  const state: ShopState = conv.shop ?? { step: 'browse' };
  const setState = (s: ShopState | null) => db.set(db.doc(C.conversations, conversationId), { shop: s }, { merge: true });
  const reply = async (content: OutboundContent | string, next?: ShopState) => {
    const c: OutboundContent = typeof content === 'string' ? { type: 'text', text: content } : content;
    await send(db, cfg, deps.transport, { from: { businessId }, conversationId, to, content: c });
    const options = optionIds(c);
    if (next || options.length) await setState({ ...(next ?? state), options });
  };

  const input = readInput(ctx.event);
  let text = input.text;
  if (input.audioId) {
    const token = ctx.event.source === 'whatsapp' ? await resolveSender(db, cfg, { businessId }).then(s => s.accessToken).catch(() => null) : null;
    const heard = token ? await transcribeVoice(cfg, deps, token, input.audioId) : null;
    if (!heard) return reply("Sorry, I couldn't play that voice note. Please type your message.");
    text = heard;
  }
  const lower = text.trim().toLowerCase();
  // A tapped option, or its number typed back (Instagram, or anyone who prefers typing).
  const choice = input.choiceId ?? (/^\d{1,2}$/.test(lower) ? state.options?.[Number(lower) - 1] ?? null : null);

  // ── Data deletion (Data Deletion page) ──
  if (state.step === 'confirm_delete') {
    if (choice === 'delete_yes' || YES.test(lower)) {
      // Reply first: the confirmation needs the conversation (24-hour window) that is about to go.
      const ref = deletionCode();
      await send(db, cfg, deps.transport, { from: { businessId }, conversationId, to, content: { type: 'text', text: `Done. ${business.name} no longer has your details on Relay. Reference: ${ref}` } });
      await deleteShopperData(db, { businessId, conversationId, customerKey: to }, ref);
      log('info', 'shopper_data_deleted', { businessId, ref });
      return;
    }
    await reply('OK, nothing was deleted.', { step: 'browse' });
    return;
  }
  if (/^delete my (data|details|info(rmation)?)$/.test(lower)) {
    return reply(buttons(`Delete your details (name, number, cart and chat history) from ${business.name} on Relay? Orders you've paid for are kept for accounting.`, [['delete_yes', 'Yes, delete'], ['delete_no', 'No']]), { step: 'confirm_delete' });
  }

  if (/^(subscribe|start updates|yes to updates)$/.test(lower)) {
    if (ctx.event.source !== 'whatsapp') return reply('Updates are only sent on WhatsApp for now.');
    await db.set(db.doc(C.customers, conversationId), { marketingOptIn: true, marketingOptInAt: new Date().toISOString() }, { merge: true });
    return reply(`You'll now get occasional updates and offers from ${business.name}. Send STOP any time to stop them.`);
  }

  // ── Talk to a person ──
  if (/\b(human|agent|real person|customer (care|service)|talk to (someone|the owner|owner|a person)|speak to)\b/.test(lower)) return handOver(ctx, deps, business, customer, reply);

  // ── Choices from lists and buttons ──
  if (choice) {
    const [kind, id] = choice.split(':');
    if (kind === 'menu') return greet(ctx, business, customer, reply);
    if (kind === 'cat') return showCategory(db, business, id, reply);
    if (kind === 'prod') return showProduct(db, business, id, reply);
    if (kind === 'add') return addToCart(ctx, business, id, 1, reply);
    if (kind === 'cart') return showCart(ctx, business, reply);
    if (kind === 'clear') { await db.delete(db.doc(C.carts, conversationId)); return reply(buttons('Cart cleared.', [['menu', 'See the menu']]), { step: 'browse' }); }
    if (kind === 'checkout') return startCheckout(ctx, business, reply);
    if (kind === 'deliver') return reply('Please send your delivery address (area and street).', { step: 'await_address' });
    if (kind === 'pickup') return confirmOrder(ctx, business, { method: 'pickup', feeKobo: 0, timeframe: 'Ready for pickup' }, reply);
    if (kind === 'confirm' && state.step === 'confirm') return placeOrder(ctx, deps, business, state.delivery ?? null, reply);
    if (kind === 'delete_no') return reply('OK, nothing was deleted.', { step: 'browse' });
  }

  if (state.step === 'await_address' && text.length >= 3 && !/^(menu|cancel|cart)$/.test(lower)) {
    const quote = await quoteDelivery(db, businessId, text, 'self_arranged');
    if (!quote) return reply(buttons(`Sorry, ${business.name} doesn't deliver to "${text.slice(0, 60)}" yet.`, [['pickup', 'Pickup instead'], ['menu', 'Back to menu']]), { step: 'browse' });
    return confirmOrder(ctx, business, quote, reply);
  }
  if (state.step === 'confirm' && YES.test(lower)) return placeOrder(ctx, deps, business, state.delivery ?? null, reply);
  if (state.step === 'confirm' && NO.test(lower)) return reply(buttons('No problem. Your cart is saved.', [['menu', 'Menu'], ['cart', 'View cart']]), { step: 'browse' });

  // ── Free text ──
  const intent = await shopIntent(lower, text, deps.llm, db, businessId);
  switch (intent?.tool) {
    case 'viewCart': return showCart(ctx, business, reply);
    case 'checkout': return startCheckout(ctx, business, reply);
    case 'orderStatus': return orderStatus(db, conversationId, reply);
    case 'talkToHuman': return handOver(ctx, deps, business, customer, reply);
    case 'offTopic': return reply(buttons(`I'm ${business.name}'s shop assistant, so I can only help with our products and your orders.`, [['menu', 'See the menu'], ['cart', 'View cart']]));
    case 'addToCart': {
      const found = await findProducts(db, businessId, String(intent.args.product ?? ''));
      const available = found.filter(p => p.available);
      if (available.length === 1) return addToCart(ctx, business, available[0].id, Math.max(1, Math.min(99, Number(intent.args.quantity) || 1)), reply);
      if (available.length > 1) return reply(list('Which one?', 'Choose', available.map(p => ({ id: `prod:${p.id}`, title: p.name, description: formatKobo(p.priceKobo) }))));
      return reply(buttons(`Sorry, we don't have "${String(intent.args.product ?? '').slice(0, 40)}".`, [['menu', 'See the menu']]));
    }
    default: return greet(ctx, business, customer, reply);
  }
}

type Reply = (content: OutboundContent | string, next?: ShopState) => Promise<void>;

async function shopIntent(lower: string, text: string, llm: LLMProvider | null, db: Firestore, businessId: string): Promise<ToolChoice | null> {
  if (/^(hi|hello|hey|good (morning|afternoon|evening)|menu|start|catalog(ue)?|price ?list|what do you (have|sell)\??)\b/.test(lower)) return { tool: 'showMenu', args: {} };
  if (/^(cart|my cart|view cart|basket)$/.test(lower)) return { tool: 'viewCart', args: {} };
  if (/^(checkout|check out|pay|place order|order now)$/.test(lower)) return { tool: 'checkout', args: {} };
  if (/\b(where is my order|order status|my order|track)\b/.test(lower)) return { tool: 'orderStatus', args: {} };
  // "2 jollof rice" / "jollof rice x2" / "jollof rice"
  const m = /^(\d{1,2})\s*x?\s+(.+)$/.exec(lower) ?? /^(.+?)\s*x\s*(\d{1,2})$/.exec(lower);
  const [q, n] = m ? (/^\d/.test(m[1]) ? [m[2], Number(m[1])] : [m[1], Number(m[2])]) : [lower, 1];
  if ((await findProducts(db, businessId, q)).length) return { tool: 'addToCart', args: { product: q, quantity: n } };
  if (!llm) return null;
  try {
    const choice = await llm.chooseTool({ system: 'You route a customer message for a small shop in Nigeria to the shop assistant. Choose exactly one tool. Use offTopic for anything not about shopping at this business.', message: text.slice(0, 500), tools: SHOP_TOOLS });
    return choice && SHOP_TOOLS.some(t => t.name === choice.tool) ? choice : null;
  } catch (e) { log('warn', 'llm_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); return null; }
}

async function greet(ctx: ShopContext, business: Business, customer: Customer | null, reply: Reply) {
  const name = customer?.name?.split(' ')[0];
  const hello = (customer?.orderCount ?? 0) > 0 ? `Welcome back${name ? `, ${name}` : ''}! 👋` : `Welcome to ${business.name}${name ? `, ${name}` : ''}! 👋`;
  const products = await listProducts(ctx.db, business.id, { availableOnly: true });
  if (!products.length) return reply(`${hello} We're updating our menu right now. Please check back soon.`, { step: 'browse' });
  const cats = ((await ctx.db.query(C.categories, [['businessId', '==', business.id]])) as unknown as Category[]).filter(c => products.some(p => p.categoryId === c.id)).sort((a, b) => a.sortOrder - b.sortOrder);
  if (cats.length) return reply(list(`${hello} What would you like today?`, 'Categories', cats.map(c => ({ id: `cat:${c.id}`, title: c.name, description: `${products.filter(p => p.categoryId === c.id).length} items` })), 'Categories'), { step: 'browse' });
  return reply(list(`${hello} Here's what we have:`, 'See products', products.map(p => ({ id: `prod:${p.id}`, title: p.name, description: formatKobo(p.priceKobo) })), 'Products'), { step: 'browse' });
}

async function showCategory(db: Firestore, business: Business, categoryId: string, reply: Reply) {
  const products = (await listProducts(db, business.id, { availableOnly: true })).filter(p => p.categoryId === categoryId);
  if (!products.length) return reply(buttons('Nothing available here right now.', [['menu', 'Back to menu']]));
  return reply(list('Choose a product:', 'Products', products.map(p => ({ id: `prod:${p.id}`, title: p.name, description: formatKobo(p.priceKobo) })), 'Products'));
}

async function showProduct(db: Firestore, business: Business, productId: string, reply: Reply) {
  const p = (await db.get(db.doc(C.products, productId))) as Product | null;
  if (!p || p.businessId !== business.id || p.deletedAt || !p.available) return reply(buttons('Sorry, that item is no longer available.', [['menu', 'Back to menu']]));
  if (p.images[0]) await reply({ type: 'image', link: p.images[0], caption: p.name });
  const soldOut = !hasStock(p);
  const body = `${p.name}: ${formatKobo(p.priceKobo)}${p.description ? `\n${p.description}` : ''}${soldOut ? '\nSold out right now.' : ''}`;
  return reply(buttons(body, soldOut ? [['menu', 'Menu']] : [[`add:${p.id}`, 'Add to cart'], ['menu', 'Menu'], ['cart', 'View cart']]));
}

async function loadCart(db: Firestore, ctx: ShopContext): Promise<Cart | null> {
  const cart = (await db.get(db.doc(C.carts, ctx.conversationId))) as Cart | null;
  return cart && cart.expiresAt > new Date().toISOString() && cart.businessId === ctx.businessId ? cart : null;
}

async function addToCart(ctx: ShopContext, business: Business, productId: string, qty: number, reply: Reply) {
  const { db } = ctx;
  const p = (await db.get(db.doc(C.products, productId))) as Product | null;
  if (!p || p.businessId !== business.id || p.deletedAt || !p.available) return reply(buttons('Sorry, that item is no longer available.', [['menu', 'Back to menu']]));
  const cart = await loadCart(db, ctx);
  const items = cart?.items.filter(i => i.productId !== p.id) ?? [];
  const already = cart?.items.find(i => i.productId === p.id)?.qty ?? 0;
  const want = already + qty;
  if (tracksStock(p) && want > p.stock) return reply(buttons(`Sorry, only ${p.stock} ${p.name} left.`, [['cart', 'View cart'], ['menu', 'Menu']]));
  const now = new Date();
  await db.set(db.doc(C.carts, ctx.conversationId), { id: ctx.conversationId, businessId: business.id, customerId: ctx.conversationId, channel: ctx.event.source, items: [...items, { productId: p.id, qty: want }], expiresAt: new Date(now.getTime() + CART_HOURS * 3600_000).toISOString(), updatedAt: now.toISOString() });
  return showCart(ctx, business, reply, `Added ${qty} × ${p.name}.`);
}

async function cartLines(db: Firestore, cart: Cart) {
  const products = (await db.getAll(cart.items.map(i => db.doc(C.products, i.productId)))) as (Product | null)[];
  const lines = cart.items.map((i, n) => ({ ...i, product: products[n] })).filter(l => l.product && !l.product.deletedAt);
  const subtotal = lines.reduce((s, l) => s + l.product!.priceKobo * l.qty, 0);
  return { lines, subtotal, text: lines.map(l => `• ${l.qty} × ${l.product!.name}: ${formatKobo(l.product!.priceKobo * l.qty)}`).join('\n') };
}

async function showCart(ctx: ShopContext, business: Business, reply: Reply, prefix = '') {
  const cart = await loadCart(ctx.db, ctx);
  if (!cart?.items.length) return reply(buttons(`${prefix ? prefix + '\n' : ''}Your cart is empty.`, [['menu', 'See the menu']]));
  const { text, subtotal } = await cartLines(ctx.db, cart);
  return reply(buttons(`${prefix ? prefix + '\n\n' : ''}Your cart:\n${text}\nSubtotal: ${formatKobo(subtotal)}`, [['checkout', 'Checkout'], ['menu', 'Keep shopping'], ['clear', 'Clear cart']]), { step: 'browse' });
}

async function startCheckout(ctx: ShopContext, business: Business, reply: Reply) {
  const cart = await loadCart(ctx.db, ctx);
  if (!cart?.items.length) return reply(buttons('Your cart is empty.', [['menu', 'See the menu']]));
  const zones = await listZones(ctx.db, business.id);
  if (!zones.length) return confirmOrder(ctx, business, { method: 'pickup', feeKobo: 0, timeframe: 'Ready for pickup' }, reply);
  return reply(buttons('Delivery or pickup?', [['deliver', 'Delivery'], ['pickup', 'Pickup']]), { step: 'browse' });
}

async function confirmOrder(ctx: ShopContext, business: Business, delivery: OrderDelivery, reply: Reply) {
  const cart = await loadCart(ctx.db, ctx);
  if (!cart?.items.length) return reply(buttons('Your cart is empty.', [['menu', 'See the menu']]), { step: 'browse' });
  const { text, subtotal } = await cartLines(ctx.db, cart);
  const fee = feeKobo(subtotal, policyFor(business, ctx.cfg));
  const body = [
    'Please confirm your order:', text,
    `Subtotal: ${formatKobo(subtotal)}`,
    delivery.method === 'pickup' ? 'Pickup: free' : `Delivery (${delivery.address ?? ''}): ${formatKobo(delivery.feeKobo)}${delivery.timeframe ? `, ${delivery.timeframe}` : ''}`,
    `Service fee: ${formatKobo(fee)}`,
    `Total: about ${formatKobo(subtotal + delivery.feeKobo + fee)} (the exact amount comes next)`,
  ].join('\n');
  return reply(buttons(body, [['confirm', 'Confirm order'], ['menu', 'Not yet']]), { step: 'confirm', delivery });
}

async function placeOrder(ctx: ShopContext, deps: BotDeps, business: Business, delivery: OrderDelivery | null, reply: Reply) {
  const cart = await loadCart(ctx.db, ctx);
  if (!cart?.items.length) return reply(buttons('Your cart is empty.', [['menu', 'See the menu']]), { step: 'browse' });
  let order: Order;
  try {
    order = await checkout(ctx.db, { cartId: cart.id, businessId: business.id, policy: policyFor(business, ctx.cfg), delivery });
  } catch (e) {
    const code = String(e instanceof Error ? e.message : e);
    if (code.includes('INSUFFICIENT_STOCK') || code.includes('PRODUCT_UNAVAILABLE')) return reply(buttons('Sorry, something in your cart just sold out. Please check your cart.', [['cart', 'View cart'], ['menu', 'Menu']]), { step: 'browse' });
    throw e;
  }
  const minutes = Math.round((new Date(order.holdExpiresAt).getTime() - Date.now()) / 60_000);
  await reply(`${paymentInstructions(order, (business as Business & { paymentDetails?: string | null }).paymentDetails ?? null)}\nWe're holding your items for ${minutes} minutes.`, { step: 'browse' });
  await notifyOwner(ctx.db, deps, business, 'order_placed', `New order ${order.ref}: ${formatKobo(order.payAmountKobo)} awaiting payment (${order.items.map(l => `${l.qty}× ${l.name}`).join(', ')}).`, order.id);
}

async function orderStatus(db: Firestore, customerId: string, reply: Reply) {
  const [o] = await recentOrders(db, [['customerId', '==', customerId]], 1);
  if (!o) return reply(buttons("You don't have any orders with us yet.", [['menu', 'See the menu']]));
  const status = o.status === 'awaiting_payment' ? `waiting for payment of ${formatKobo(o.payAmountKobo)}` : o.status === 'paid' ? `paid, ${o.fulfilment.replace(/_/g, ' ')}` : o.status;
  return reply(`Order ${o.ref}: ${status}.`);
}

async function handOver(ctx: ShopContext, deps: BotDeps, business: Business, customer: Customer | null, reply: Reply) {
  await ctx.db.set(ctx.db.doc(C.conversations, ctx.conversationId), { mode: 'owner', takeoverAt: new Date().toISOString(), takeoverReason: 'customer_request' }, { merge: true });
  await reply(`I've let ${business.name} know. They'll reply to you here shortly.`);
  // The owner sees the full number (it's their customer); logs never do.
  const where = ctx.event.source === 'whatsapp' ? ctx.event.from : 'Instagram';
  const who = customer?.name ? `${customer.name} (${where})` : ctx.event.source === 'whatsapp' ? ctx.event.from : 'An Instagram customer';
  log('info', 'handover_requested', { businessId: business.id, from: ctx.event.source === 'whatsapp' ? maskPhone(ctx.event.from) : 'instagram' });
  await notifyOwner(ctx.db, deps, business, 'handover', `${who} wants to talk to you. Reply to them in your WhatsApp Business app${ctx.event.source === 'instagram' ? ' or Instagram' : ''}. The bot stays quiet in that chat until you send HANDBACK here.`);
}
