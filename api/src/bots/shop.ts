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
import { listCategories, listProducts } from '../services/catalog';
import { categoryCarousel, productCarousel, productDetails, suggestionMessage } from './product-cards';
import { suggestFor } from '../services/suggestions';
import { DEFAULT_MESSAGES, fill, renderMessage } from '../services/shop-messages';
import { createPayLink, payMessage } from '../services/paylinks';
import { byPriority, listZones, quoteDelivery } from '../services/delivery';
import { describeLocation } from '../services/location';
import { describeHours, openNow } from '../services/hours';
import { policyText, POLICY_QUESTION } from '../services/policies';
import { checkout, customerFee, policyFor, recentOrders } from '../services/orders';
import { testOrder, testPaid } from './test-mode';
import { paymentInstructions } from '../services/bachs';
import type { ShopContext } from '../services/router';
import type { LLMProvider, ToolChoice, ToolSpec } from '../services/ai';
import { buttons, findProducts, list, notifyOwner, NO, readInput, transcribeVoice, YES, type BotDeps } from './common';
import { deleteShopperData, deletionCode } from './deletion';
import { react, showTyping, slowJob } from '../services/presence';

const CART_HOURS = 24;
// A new conversation (welcome first) after this long without a message.
const SESSION_HOURS = 12;

type Step = 'browse' | 'await_address' | 'confirm' | 'confirm_delete';
interface ShopState {
  step: Step; options?: string[]; delivery?: OrderDelivery | null;
  suggested?: string[];      // products we've already suggested pairings for
  greetedAt?: string | null; // when this conversation's welcome was sent
  pidgin?: boolean;          // the customer writes in Pidgin: the bot's own words follow
}
interface Run { deps: BotDeps; state: ShopState; first?: boolean /* the first message of this conversation */ }
type ShopConversation = Conversation & { shop?: ShopState | null };

const SHOP_TOOLS: ToolSpec[] = [
  { name: 'showMenu', description: 'Show what the shop sells (greeting, "what do you have", prices in general).', params: {} },
  { name: 'addToCart', description: 'Customer wants a specific product.', params: { product: { type: 'string', description: 'Product name as the customer wrote it' }, quantity: { type: 'integer', description: 'How many (default 1)' } }, required: ['product'] },
  { name: 'viewCart', description: 'Show the cart.', params: {} },
  { name: 'checkout', description: 'Customer wants to pay / place the order.', params: {} },
  { name: 'orderStatus', description: 'Customer asks about an order they placed.', params: {} },
  { name: 'shopInfo', description: 'Customer asks about opening hours, where the shop is, delivery areas, or the return/refund/exchange policy.', params: { topic: { type: 'string', description: 'What they ask about', enum: ['hours', 'location', 'delivery', 'policy'] } }, required: ['topic'] },
  { name: 'talkToHuman', description: 'Customer asks for a person, the owner, or has a complaint the bot cannot handle.', params: {} },
  { name: 'offTopic', description: 'Anything not about shopping at this business.', params: {} },
];

export async function handleShop(ctx: ShopContext, deps: BotDeps) {
  const { db, cfg, businessId, conversationId } = ctx;
  const [conv, business, customer] = (await db.getAll([db.doc(C.conversations, conversationId), db.doc(C.businesses, businessId), db.doc(C.customers, conversationId)])) as [ShopConversation | null, Business | null, Customer | null];
  if (!conv || !business || business.status === 'deleted') return;
  const sender = ctx.test ? { adminBot: true as const } : { businessId };
  // Marketing opt-out is honoured even while the owner has taken over the chat.
  const optText = (ctx.event.text ?? '').trim().toLowerCase();
  if (/^(stop|unsubscribe|stop all)$/.test(optText)) {
    await db.set(db.doc(C.customers, conversationId), { marketingOptIn: false, marketingOptOutAt: new Date().toISOString() }, { merge: true });
    if (conv.mode === 'owner') return;
    await send(db, cfg, deps.transport, { from: sender, conversationId, to: ctx.event.from, content: { type: 'text', text: `You won't get updates from ${business.name} any more. You can still order here any time; send SUBSCRIBE to get updates again.` } });
    return;
  }
  if (conv.mode === 'owner') return; // the owner is handling this chat until they hand back

  const to = ctx.event.from;
  if (!ctx.test && ctx.event.source === 'whatsapp') await showTyping(db, cfg, deps.transport, sender, to, ctx.event.messageId);
  const state: ShopState = conv.shop ?? { step: 'browse' };
  const setState = (s: ShopState | null) => db.set(db.doc(C.conversations, conversationId), { shop: s }, { merge: true });
  const reply = async (content: OutboundContent | string, next?: ShopState) => {
    const c: OutboundContent = typeof content === 'string' ? { type: 'text', text: content } : content;
    await send(db, cfg, deps.transport, { from: sender, conversationId, to, content: shopWords(c, business) });
    const options = optionIds(c);
    if (next || options.length) await setState({ ...(next ?? state), suggested: next?.suggested ?? state.suggested, greetedAt: state.greetedAt ?? null, pidgin: state.pidgin ?? false, options });
  };

  const run: Run = { deps, state };
  const input = readInput(ctx.event);
  let text = input.text;
  if (input.audioId) {
    const token = ctx.event.source === 'whatsapp' ? await resolveSender(db, cfg, { businessId }).then(s => s.accessToken).catch(() => null) : null;
    const reactTo = (emoji: string) => react(db, cfg, deps.transport, { from: sender, conversationId, to, messageId: ctx.event.messageId, emoji });
    const heard = token ? await slowJob(() => transcribeVoice(cfg, deps, token, input.audioId!), { react: reactTo, ok: r => !!r }) : null;
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
      await send(db, cfg, deps.transport, { from: sender, conversationId, to, content: { type: 'text', text: `Done. ${business.name} no longer has your details on Relay. Reference: ${ref}` } });
      await deleteShopperData(db, { businessId, conversationId, customerKey: to }, ref);
      log('info', 'shopper_data_deleted', { businessId, ref });
      return;
    }
    await reply('OK, nothing was deleted.', { step: 'browse' });
    return;
  }
  if (/^delete my (data|details|info(rmation)?)$/.test(lower)) {
    return reply(buttons(`Delete your details (name, number, cart and chat history) from ${business.name} on Relay? Orders you've paid for are kept for accounting.`, [['delete_yes', 'Yes, delete my info'], ['delete_no', 'No, keep it']]), { step: 'confirm_delete' });
  }

  if (/^(subscribe|start updates|yes to updates)$/.test(lower)) {
    if (ctx.event.source !== 'whatsapp') return reply('Updates are only sent on WhatsApp for now.');
    await db.set(db.doc(C.customers, conversationId), { marketingOptIn: true, marketingOptInAt: new Date().toISOString() }, { merge: true });
    return reply(`You'll now get occasional updates and offers from ${business.name}. Send STOP any time to stop them.`);
  }

  // ── Talk to a person ──
  if (/\b(human|agent|real person|customer (care|service)|talk to (someone|the owner|owner|a person)|speak to)\b/.test(lower)) return handOver(ctx, deps, business, customer, reply);

  // ── The first message of a conversation: welcome first, then answer what they actually said ──
  if (!choice && text.trim()) {
    const fresh = !state.greetedAt || Date.now() - new Date(state.greetedAt).getTime() > SESSION_HOURS * 3600_000;
    if (PIDGIN.test(lower)) state.pidgin = true;
    else if (fresh) state.pidgin = false;
    if (fresh) {
      run.first = true;
      state.greetedAt = new Date().toISOString();
      await setState({ ...state, step: 'browse' });
      const handled = await firstMessage(ctx, run, business, customer, text, reply);
      if (handled) return;
    }
  }

  // ── Choices from lists and buttons ──
  if (choice) {
    const [kind, id] = choice.split(':');
    if (kind === 'ask') return reply(state.pidgin ? 'Sure! Wetin you wan know? Ask about anything: prices, delivery, opening hours… 🙂' : 'Sure! What would you like to know? You can ask about prices, delivery, opening hours or anything else. 🙂');
    if (kind === 'track') return orderStatus(db, conversationId, reply);
    if (kind === 'again') return orderAgain(ctx, run, business, reply);
    if (kind === 'menu') return greet(ctx, business, customer, reply, { again: true });
    if (kind === 'cats') return greet(ctx, business, customer, reply, { again: true, page: Number(id) || 0 });
    if (kind === 'cat') return showCategory(ctx, business, id, reply);
    if (kind === 'more') return showCategory(ctx, business, id, reply, Number(choice.split(':')[2]) || 0);
    if (kind === 'prod' || kind === 'det') return showProduct(ctx, business, id, reply);
    if (kind === 'buy') return buy(ctx, run, business, id, reply);
    if (kind === 'add') return addToCart(ctx, run, business, id, 1, reply);
    if (kind === 'cart') return showCart(ctx, business, reply);
    if (kind === 'clear') { await db.delete(db.doc(C.carts, conversationId)); return reply(buttons('Cart cleared.', [['menu', 'See the menu']]), { step: 'browse' }); }
    if (kind === 'checkout') return startCheckout(ctx, business, reply);
    if (kind === 'deliver') return reply('Please send your delivery address (area and street).', { step: 'await_address' });
    if (kind === 'pickup') return confirmOrder(ctx, business, pickup(business), reply);
    if (kind === 'confirm' && state.step === 'confirm') return placeOrder(ctx, deps, business, state.delivery ?? null, reply);
    if (kind === 'testpay' && ctx.test) return testPaid(ctx, business, id, reply);
    if (kind === 'delete_no') return reply('OK, nothing was deleted.', { step: 'browse' });
  }

  if (state.step === 'await_address' && text.length >= 3 && !/^(menu|cancel|cart)$/.test(lower)) {
    const quote = await quoteDelivery(db, businessId, text, 'self_arranged');
    if (!quote && business.shipsInterstate && business.interstatePricing === 'quote') return confirmOrder(ctx, business, { method: 'self_arranged', feeKobo: 0, address: text.slice(0, 200), timeframe: `delivery price to be confirmed by ${business.name}` }, reply);
    if (!quote) return reply(buttons(`Sorry, ${business.name} doesn't deliver to "${text.slice(0, 60)}" yet.`, [...(business.fulfilment !== 'delivery' ? [['pickup', "I'll pick it up"] as [string, string]] : []), ['menu', 'Back to menu']]), { step: 'browse' });
    return confirmOrder(ctx, business, quote, reply);
  }
  if (state.step === 'confirm' && YES.test(lower)) return placeOrder(ctx, deps, business, state.delivery ?? null, reply);
  if (state.step === 'confirm' && NO.test(lower)) return reply(buttons('No problem. Your cart is saved.', [['menu', 'See the menu'], ['cart', 'My cart']]), { step: 'browse' });

  // ── Free text ──
  const intent = await shopIntent(lower, text, deps.llm, db, businessId);
  switch (intent?.tool) {
    case 'viewCart': return showCart(ctx, business, reply);
    case 'checkout': return startCheckout(ctx, business, reply);
    case 'orderStatus': return orderStatus(db, conversationId, reply);
    case 'shopInfo': {
      const info = await shopInfo(db, business, String(intent.args.topic ?? ''));
      if (info) return reply(buttons(info, [['menu', 'See the menu'], ['cart', 'My cart']]));
      return handOver(ctx, deps, business, customer, reply);
    }
    case 'talkToHuman': return handOver(ctx, deps, business, customer, reply);
    case 'offTopic': return reply(buttons(`I'm ${business.name}'s shop assistant, so I can only help with our products and your orders.`, [['menu', 'See the menu'], ['cart', 'My cart']]));
    case 'addToCart': {
      const asked = String(intent.args.product ?? '');
      const found = await findProducts(db, businessId, asked);
      const available = found.filter(p => p.available);
      if (available.length === 1) return addToCart(ctx, run, business, available[0].id, Math.max(1, Math.min(99, Number(intent.args.quantity) || 1)), reply);
      const matches = available.length > 1 ? available : await search(db, businessId, asked);
      if (matches.length) return sendAll(reply, productCarousel(ctx.cfg, business, matches, { title: `Results for "${asked.slice(0, 30)}"`, key: 'all' }));
      return reply(buttons(`Sorry, we don't have "${asked.slice(0, 40)}" right now.`, [['menu', 'See the menu']]));
    }
    // Nothing more specific: the welcome on a first message (never the whole menu unasked).
    default: return run.first ? welcomeOnly(ctx, run, business, customer, reply) : greet(ctx, business, customer, reply);
  }
}

// The welcome (or welcome back) with a few light options: no carousel.
async function welcomeOnly(ctx: ShopContext, run: Run, business: Business, customer: Customer | null, reply: Reply) {
  const name = customer?.name?.split(' ')[0];
  const returning = (customer?.orderCount ?? 0) > 0;
  const closed = closedNote(business, customer);
  const hello = renderMessage(business, returning ? 'welcomeBack' : 'welcome', { customer: name });
  const lastPaid = returning ? (await recentOrders(ctx.db, [['customerId', '==', ctx.conversationId]], 10)).find(o => o.businessId === business.id && o.status === 'paid') : undefined;
  const options: [string, string][] = [
    ...(lastPaid ? [['again', 'Order again'] as [string, string]] : []),
    ['menu', say(run.state.pidgin, 'See what we have', 'See wetin we get')],
    ...(lastPaid ? [] : [['ask', 'Ask a question'] as [string, string]]),
    ['track', 'Track my order'],
  ];
  return reply(buttons(closed ? `${hello}\n\n${closed}` : hello, options), { step: 'browse' });
}

// Customers writing in Pidgin ("where una dey?", "abeg wetin una get").
const PIDGIN = /\b(una|wetin|abeg|dey|abi|wahala|sabi|oya|wan|how far|na so|sef|shey|biko|make i|i go|e don|no vex|dis|dat)\b/i;
const GREETING = /^(hi+|hello+|hey+|hiya|helo|good (morning|afternoon|evening|day)|howdy|how far|how you dey|how una dey|hi there|hello there|morning|evening|afternoon)[\s!.,🙂👋😊]*(there|o|oo)?[\s!.]*$/i;
const MENU_ASK = /\b(menu|catalog(ue)?|price ?list|prices|what do you (sell|have)|what (do )?you have|wetin (una|you) (dey )?(sell|get|have)|wetin una get|show me (what you have|your (products|items|stuff))|send (me )?(your )?(menu|catalog(ue)?|list|prices)|see (your|what you have)|your products)\b/i;
const ASK_PREFIX = /^(please\s+|abeg\s+|hi,?\s+|hello,?\s+)*(do you (have|sell|stock)|have you got|you get|una get|una dey sell|you dey sell|is there|are there|any|how much (is|are|be|for|na)|what'?s the price of|price of|price for|i (want|need|would like)( to buy)?|i wan( buy)?|can i (get|buy|order)|looking for)\s+/i;

// Pidgin versions of the bot's own words (the owner's messages stay as they wrote them).
const say = (pidgin: boolean | undefined, english: string, naija: string) => (pidgin ? naija : english);

// "Hi Ada! 👋 Welcome to *X*. How can we help you today?" → "Hi Ada! 👋 Welcome to *X*." (for when we
// answer straight away, the closing question goes).
function shortWelcome(business: Business, customer: Customer | null) {
  const name = customer?.name?.split(' ')[0];
  const returning = (customer?.orderCount ?? 0) > 0;
  const full = renderMessage(business, returning ? 'welcomeBack' : 'welcome', { customer: name });
  const short = full.replace(/\s*[^.!?\n]*\?\s*$/, '').trim();
  return short.length >= 5 ? short : full;
}

async function firstMessage(ctx: ShopContext, run: Run, business: Business, customer: Customer | null, text: string, reply: Reply): Promise<boolean> {
  const lower = text.trim().toLowerCase();
  const pidgin = run.state.pidgin;
  const closed = closedNote(business, customer);

  // Just a greeting: the welcome and a few light options, no carousel.
  if (GREETING.test(lower)) { await welcomeOnly(ctx, run, business, customer, reply); return true; }
  const welcome = closed ? `${shortWelcome(business, customer)}\n\n${closed}` : shortWelcome(business, customer);

  // Asking to see everything: the welcome line, then the sections.
  if (MENU_ASK.test(lower) && !ASK_PREFIX.test(lower)) { await greet(ctx, business, customer, reply, { intro: welcome }); return true; }

  // A question about the shop (where, when, delivery, returns): the welcome line and the answer.
  const topic = infoTopic(lower);
  if (topic) {
    const info = await shopInfo(ctx.db, business, topic, pidgin);
    if (!info) return false;
    await reply(buttons(`${welcome}\n\n${info}`, [['menu', say(pidgin, 'See what we have', 'See wetin we get')], ['ask', 'Ask a question']]), { step: 'browse' });
    return true;
  }

  // A specific product ("do you have boots?", "how much is the hoodie"): just the matching ones.
  const wanted = lower.replace(ASK_PREFIX, '').replace(/^(the|a|an|some|una|your)\s+/, '').replace(/[?.!]+$/, '').replace(/\s+(abeg|please|o)$/, '').trim();
  if (wanted && wanted !== lower.replace(/[?.!]+$/, '') || ASK_PREFIX.test(lower)) {
    const exact = (await findProducts(ctx.db, business.id, wanted)).filter(p => p.available);
    const matches = exact.length ? exact : await search(ctx.db, business.id, wanted);
    if (matches.length) {
      await sendAll(reply, productCarousel(ctx.cfg, business, matches, { title: `"${wanted.slice(0, 30)}"`, key: 'all', intro: welcome }));
      return true;
    }
    // Nothing like it: say so, and offer the closest section.
    const cats = await listCategories(ctx.db, business.id);
    const words = wanted.split(/\s+/).filter(w => w.length >= 3);
    const near = cats.find(c => words.some(w => c.name.toLowerCase().includes(w.replace(/s$/, ''))));
    await reply(buttons(`${welcome}\n\n${say(pidgin, `Sorry, we don't have "${wanted.slice(0, 40)}" right now.`, `Sorry o, we no get "${wanted.slice(0, 40)}" right now.`)}`, [...(near ? [[`cat:${near.id}`, `See ${near.name}`] as [string, string]] : []), ['menu', say(pidgin, 'See what we have', 'See wetin we get')]]), { step: 'browse' });
    return true;
  }
  // Something else ("I want to order", a product name on its own…): the usual handling.
  return false;
}

// Which shop question this is, if any (English or Pidgin).
function infoTopic(lower: string): 'policy' | 'hours' | 'location' | 'delivery' | null {
  if (POLICY_QUESTION.test(lower)) return 'policy';
  if (/\b(what time|opening hours|are you open|open today|open now|when do you (open|close)|closing time|close today|una (dey )?open|una don close|what time una|una dey work)\b/.test(lower)) return 'hours';
  if (/\b(where are you|where is (the )?(shop|store)|your (address|location)|located|where una dey|where (you|una) (dey|de)|wia una dey|una address|where una shop)\b/.test(lower)) return 'location';
  if (/\b(do you deliver|delivery (fee|price|cost)|how much (is|for) delivery|una (dey|fit) deliver|you dey deliver|una dey do delivery)\b/.test(lower)) return 'delivery';
  return null;
}

// "Order again": their last paid order's items back in the cart (what's still available).
async function orderAgain(ctx: ShopContext, run: Run, business: Business, reply: Reply) {
  const last = (await recentOrders(ctx.db, [['customerId', '==', ctx.conversationId]], 10)).find(o => o.businessId === business.id && o.status === 'paid');
  if (!last) return greet(ctx, business, null, reply, { again: true });
  const products = (await ctx.db.getAll(last.items.map(i => ctx.db.doc(C.products, i.productId)))) as (Product | null)[];
  const ok = last.items.filter((_, n) => { const p = products[n]; return p && !p.deletedAt && p.available && hasStock(p); });
  if (!ok.length) return reply(buttons(`Sorry, the items from your last order (${last.ref}) aren't available right now.`, [['menu', 'See what we have']]));
  const now = new Date();
  await ctx.db.set(ctx.db.doc(C.carts, ctx.conversationId), { id: ctx.conversationId, businessId: business.id, customerId: ctx.conversationId, channel: ctx.event.source, items: ok.map(i => ({ productId: i.productId, qty: i.qty })), expiresAt: new Date(now.getTime() + CART_HOURS * 3600_000).toISOString(), updatedAt: now.toISOString(), suggestedAt: now.toISOString() });
  return showCart(ctx, business, reply, ok.length < last.items.length ? `Here's your last order again (some items aren't available right now).` : `Here's your last order again 👍`);
}

type Reply = (content: OutboundContent | string, next?: ShopState) => Promise<void>;

async function shopIntent(lower: string, text: string, llm: LLMProvider | null, db: Firestore, businessId: string): Promise<ToolChoice | null> {
  if (/^(hi|hello|hey|good (morning|afternoon|evening)|menu|start|catalog(ue)?|price ?list|what do you (have|sell)\??)\b/.test(lower)) return { tool: 'showMenu', args: {} };
  if (/^(cart|my cart|view cart|basket)$/.test(lower)) return { tool: 'viewCart', args: {} };
  if (/^(checkout|check out|pay|place order|order now)$/.test(lower)) return { tool: 'checkout', args: {} };
  if (/\b(where is my order|order status|my order|track)\b/.test(lower)) return { tool: 'orderStatus', args: {} };
  if (POLICY_QUESTION.test(lower)) return { tool: 'shopInfo', args: { topic: 'policy' } };
  if (/\b(what time|opening hours|are you open|open today|open now|when do you (open|close)|closing time|close today)\b/.test(lower)) return { tool: 'shopInfo', args: { topic: 'hours' } };
  if (/\b(where are you|where is (the )?(shop|store)|your (address|location)|located)\b/.test(lower)) return { tool: 'shopInfo', args: { topic: 'location' } };
  if (/\b(do you deliver|delivery (fee|price|cost)|how much (is|for) delivery)\b/.test(lower)) return { tool: 'shopInfo', args: { topic: 'delivery' } };
  // "2 jollof rice" / "jollof rice x2" / "jollof rice"
  const m = /^(\d{1,2})\s*x?\s+(.+)$/.exec(lower) ?? /^(.+?)\s*x\s*(\d{1,2})$/.exec(lower);
  const [q, n] = m ? (/^\d/.test(m[1]) ? [m[2], Number(m[1])] : [m[1], Number(m[2])]) : [lower, 1];
  if ((await findProducts(db, businessId, q)).length) return { tool: 'addToCart', args: { product: q, quantity: n } };
  if ((await search(db, businessId, q)).length) return { tool: 'addToCart', args: { product: q, quantity: n } }; // shows the matches
  if (!llm) return null;
  try {
    const choice = await llm.chooseTool({ system: 'You route a customer message for a small shop in Nigeria to the shop assistant. Choose exactly one tool. Use offTopic for anything not about shopping at this business.', message: text.slice(0, 500), tools: SHOP_TOOLS });
    return choice && SHOP_TOOLS.some(t => t.name === choice.tool) ? choice : null;
  } catch (e) { log('warn', 'llm_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); return null; }
}

// Products customers can see: everything not hidden or deleted, including sold-out items (shown marked).
const visible = async (db: Firestore, businessId: string) => (await listProducts(db, businessId)).filter(p => p.available);

async function greet(ctx: ShopContext, business: Business, customer: Customer | null, reply: Reply, opts: { again?: boolean; page?: number; intro?: string } = {}) {
  const page = opts.page ?? 0;
  const name = customer?.name?.split(' ')[0];
  // What's above the products: the shop's own "here's what we have" message (MESSAGES to change),
  // after the welcome line when this is the first message.
  const show = renderMessage(business, 'menuIntro', { customer: name });
  let hello = opts.intro ? `${opts.intro}\n\n${show}` : show;
  const closed = opts.intro || opts.again ? null : closedNote(business, customer);
  if (closed) hello = `${closed}\n\n${hello}`;
  const products = await visible(ctx.db, business.id);
  if (!products.length) return reply(`${hello} We're updating our menu right now. Please check back soon.`, { step: 'browse' });
  const cats = (await listCategories(ctx.db, business.id)).filter(c => products.some(p => p.categoryId === c.id));
  // One category (or none yet): go straight to the products.
  if (cats.length <= 1) return sendAll(reply, productCarousel(ctx.cfg, business, cats.length ? products.filter(p => p.categoryId === cats[0].id) : products, { title: cats[0]?.name ?? 'Our products', key: cats[0]?.id ?? 'all', intro: hello }));
  return reply(categoryCarousel(ctx.cfg, cats, products, { intro: hello, page }), { step: 'browse' });
}

async function showCategory(ctx: ShopContext, business: Business, key: string, reply: Reply, page = 0) {
  const products = await visible(ctx.db, business.id);
  const cat = key === 'all' ? null : (await listCategories(ctx.db, business.id)).find(c => c.id === key);
  if (key !== 'all' && !cat) return reply(buttons('That section is no longer available.', [['menu', 'Back to menu']]));
  const items = cat ? products.filter(p => p.categoryId === cat.id) : products;
  if (!items.length) return reply(buttons('Nothing here right now.', [['menu', 'Back to menu']]));
  return sendAll(reply, productCarousel(ctx.cfg, business, items, { title: cat?.name ?? 'Our products', key, page }));
}

async function showProduct(ctx: ShopContext, business: Business, productId: string, reply: Reply) {
  const p = (await ctx.db.get(ctx.db.doc(C.products, productId))) as Product | null;
  if (!p || p.businessId !== business.id || p.deletedAt || !p.available) return reply(buttons('Sorry, that item is no longer available.', [['menu', 'Back to menu']]));
  return sendAll(reply, productDetails(ctx.cfg, p));
}

// Tapping Buy on a card: sold out says so; otherwise one goes into the cart.
async function buy(ctx: ShopContext, run: Run, business: Business, productId: string, reply: Reply) {
  const p = (await ctx.db.get(ctx.db.doc(C.products, productId))) as Product | null;
  if (!p || p.businessId !== business.id || p.deletedAt || !p.available) return reply(buttons('Sorry, that item is no longer available.', [['menu', 'Back to menu']]));
  if (!hasStock(p)) return reply(buttons(`Sorry, ${p.name} is sold out right now.`, [['menu', 'Back to menu'], ['cart', 'My cart']]));
  return addToCart(ctx, run, business, p.id, 1, reply);
}

// Free-text search across product names and their categories: "black sneakers", "zobo".
async function search(db: Firestore, businessId: string, query: string) {
  // Plurals to their singular: "boots" → boot, "watches" → watch, "shoes" → shoe (not "sho", which
  // would find "Shoulder bag").
  const singular = (w: string) => (/(sh|ch|x|ss|z)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !/^\d+$/.test(w) && !/^(see|show|the|and|for|you|have|any|some|your)$/.test(w)).map(singular);
  if (!words.length) return [];
  const [products, cats] = await Promise.all([visible(db, businessId), listCategories(db, businessId)]);
  const catName = new Map(cats.map(c => [c.id, c.name.toLowerCase()]));
  return products
    .map(p => ({ p, score: words.filter(w => p.name.toLowerCase().includes(w) || (catName.get(p.categoryId ?? '') ?? '').includes(w)).length }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.p);
}

// Sends several messages; an optional intro goes first.
async function sendAll(reply: Reply, out: OutboundContent[], intro?: string) {
  if (intro) await reply(intro);
  for (const o of out) await reply(o, { step: 'browse' });
}

async function loadCart(db: Firestore, ctx: ShopContext): Promise<Cart | null> {
  const cart = (await db.get(db.doc(C.carts, ctx.conversationId))) as Cart | null;
  return cart && cart.expiresAt > new Date().toISOString() && cart.businessId === ctx.businessId ? cart : null;
}

async function addToCart(ctx: ShopContext, run: Run, business: Business, productId: string, qty: number, reply: Reply) {
  const { db } = ctx;
  const p = (await db.get(db.doc(C.products, productId))) as Product | null;
  if (!p || p.businessId !== business.id || p.deletedAt || !p.available) return reply(buttons('Sorry, that item is no longer available.', [['menu', 'Back to menu']]));
  const cart = await loadCart(db, ctx);
  const items = cart?.items.filter(i => i.productId !== p.id) ?? [];
  const already = cart?.items.find(i => i.productId === p.id)?.qty ?? 0;
  const want = already + qty;
  if (tracksStock(p) && want > p.stock) return reply(buttons(`Sorry, only ${p.stock} ${p.name} left.`, [['cart', 'My cart'], ['menu', 'See the menu']]));
  const now = new Date();
  await db.set(db.doc(C.carts, ctx.conversationId), { id: ctx.conversationId, businessId: business.id, customerId: ctx.conversationId, channel: ctx.event.source, items: [...items, { productId: p.id, qty: want }], expiresAt: new Date(now.getTime() + CART_HOURS * 3600_000).toISOString(), updatedAt: now.toISOString(), suggestedAt: cart?.suggestedAt ?? null });
  // Then what goes with it: one suggestion per cart (adding from a suggestion doesn't bring another),
  // and never twice for the same item in a chat.
  const suggest = business.suggestions !== false && !cart?.suggestedAt && !run.state.suggested?.includes(p.id);
  if (suggest) run.state.suggested = [...(run.state.suggested ?? []), p.id].slice(-30);
  const added = renderMessage(business, 'addedToCart', { customer: (await db.get(db.doc(C.customers, ctx.conversationId)) as Customer | null)?.name, item: `${qty} × ${p.name}` });
  // The suggestion goes first and the cart last, so the cart's Checkout button is at the bottom and
  // nothing arrives under it a moment later.
  const picks = suggest ? await suggestFor(db, run.deps.llm, business, p, new Set([...items.map(i => i.productId), p.id])).catch(e => { log('warn', 'suggestions_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); return null; }) : null;
  const out = picks ? suggestionMessage(ctx.cfg, p, picks) : null;
  if (out) {
    await db.update(db.doc(C.carts, ctx.conversationId), { suggestedAt: new Date().toISOString() });
    await reply(out, { step: 'browse' });
  }
  await showCart(ctx, business, reply, added);
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
  return reply(buttons(`${prefix ? prefix + '\n\n' : ''}Your cart:\n${text}\nSubtotal: ${formatKobo(subtotal)}`, [['checkout', 'Checkout'], ['menu', 'Keep shopping'], ['clear', 'Empty my cart']]), { step: 'browse' });
}

async function startCheckout(ctx: ShopContext, business: Business, reply: Reply) {
  const cart = await loadCart(ctx.db, ctx);
  if (!cart?.items.length) return reply(buttons('Your cart is empty.', [['menu', 'See the menu']]));
  const open = openNow(business.hours);
  if (!open.open && business.afterHours === 'menu') return reply(buttons(`Sorry, we're closed right now${open.next ? ` and open again at ${open.next}` : ''}. Your cart is saved, so you can check out then.`, [['menu', 'See the menu']]));
  if (business.fulfilment === 'pickup') return confirmOrder(ctx, business, pickup(business), reply);
  if (business.fulfilment === 'delivery') return reply('Please send your delivery address (area and street).', { step: 'await_address' });
  const zones = await listZones(ctx.db, business.id);
  if (!zones.length && !business.shipsInterstate) return confirmOrder(ctx, business, pickup(business), reply);
  return reply(buttons('Delivery or pickup?', [['deliver', 'Deliver to me'], ['pickup', "I'll pick it up"]]), { step: 'browse' });
}

async function confirmOrder(ctx: ShopContext, business: Business, delivery: OrderDelivery, reply: Reply) {
  const cart = await loadCart(ctx.db, ctx);
  if (!cart?.items.length) return reply(buttons('Your cart is empty.', [['menu', 'See the menu']]), { step: 'browse' });
  const { text, subtotal } = await cartLines(ctx.db, cart);
  const policy = policyFor(business, ctx.cfg);
  const fee = customerFee(feeKobo(subtotal, policy), policy);
  const body = [
    'Please confirm your order:', text,
    `Subtotal: ${formatKobo(subtotal)}`,
    delivery.method === 'pickup' ? `Pickup: free${business.prepTime ? `, ready in about ${business.prepTime}` : ''}${shopAddress(business) ? `\n📍 Pick up from: ${shopAddress(business)}` : ''}` : quoteLater(delivery) ? `Delivery (${delivery.address ?? ''}): ${delivery.timeframe}` : `Delivery (${delivery.address ?? ''}): ${formatKobo(delivery.feeKobo)}${delivery.timeframe ? `, ${delivery.timeframe}` : ''}`,
    ...(fee ? [`Service fee: ${formatKobo(fee)}`] : []),
    quoteLater(delivery) ? `Total: about ${formatKobo(subtotal + fee)} plus delivery (${business.name} confirms the delivery price)` : `Total: ${formatKobo(subtotal + delivery.feeKobo + fee)}`,
  ].join('\n');
  return reply(buttons(body, [['confirm', 'Confirm order'], ['menu', 'Keep shopping']]), { step: 'confirm', delivery });
}

async function placeOrder(ctx: ShopContext, deps: BotDeps, business: Business, delivery: OrderDelivery | null, reply: Reply) {
  const cart = await loadCart(ctx.db, ctx);
  if (!cart?.items.length) return reply(buttons('Your cart is empty.', [['menu', 'See the menu']]), { step: 'browse' });
  if (ctx.test) return testOrder(ctx, business, cart, delivery, reply);
  let order: Order;
  try {
    order = await checkout(ctx.db, { cartId: cart.id, businessId: business.id, policy: policyFor(business, ctx.cfg), delivery });
  } catch (e) {
    const code = String(e instanceof Error ? e.message : e);
    if (code.includes('INSUFFICIENT_STOCK') || code.includes('PRODUCT_UNAVAILABLE')) return reply(buttons('Sorry, something in your cart just sold out. Please check your cart.', [['cart', 'My cart'], ['menu', 'See the menu']]), { step: 'browse' });
    throw e;
  }
  const minutes = Math.round((new Date(order.holdExpiresAt).getTime() - Date.now()) / 60_000);
  if (ctx.cfg.PAYMENTS_MODE === 'simulated') {
    // A "Pay ₦X" button to the test payment page (until Bachs payment links exist).
    const link = await createPayLink(ctx.db, order);
    await reply(payMessage(ctx.cfg, order, link.token, minutes, renderMessage(business, 'orderConfirmed', { customer: (await ctx.db.get(ctx.db.doc(C.customers, ctx.conversationId)) as Customer | null)?.name, order: order.ref, amount: formatKobo(order.payAmountKobo) })), { step: 'browse' });
  } else {
    await reply(`${paymentInstructions(order, (business as Business & { paymentDetails?: string | null }).paymentDetails ?? null)}\nWe're holding your items for ${minutes} minutes.`, { step: 'browse' });
  }
  await notifyOwner(ctx.db, deps, business, 'order_placed', `New order ${order.ref}: ${formatKobo(order.payAmountKobo)} awaiting payment (${order.items.map(l => `${l.qty}× ${l.name}`).join(', ')}).`, order.id);
}

async function orderStatus(db: Firestore, customerId: string, reply: Reply) {
  const [o] = await recentOrders(db, [['customerId', '==', customerId]], 1);
  if (!o) return reply(buttons("You don't have any orders with us yet.", [['menu', 'See the menu']]));
  const status = o.status === 'awaiting_payment' ? `waiting for payment of ${formatKobo(o.payAmountKobo)}` : o.status === 'paid' ? `paid, ${o.fulfilment.replace(/_/g, ' ')}` : o.status;
  return reply(`Order ${o.ref}: ${status}.`);
}

async function handOver(ctx: ShopContext, deps: BotDeps, business: Business, customer: Customer | null, reply: Reply) {
  if (ctx.test) return reply(`🧪 In your real shop, this tells the customer you'll reply, alerts you here, and the assistant goes quiet in that chat until you send HANDBACK. (Test mode: nothing was sent.)`);
  await ctx.db.set(ctx.db.doc(C.conversations, ctx.conversationId), { mode: 'owner', takeoverAt: new Date().toISOString(), takeoverReason: 'customer_request' }, { merge: true });
  await reply(`I've let ${business.name} know. They'll reply to you here shortly.`);
  // The owner sees the full number (it's their customer); logs never do.
  const where = ctx.event.source === 'whatsapp' ? ctx.event.from : 'Instagram';
  const who = customer?.name ? `${customer.name} (${where})` : ctx.event.source === 'whatsapp' ? ctx.event.from : 'An Instagram customer';
  log('info', 'handover_requested', { businessId: business.id, from: ctx.event.source === 'whatsapp' ? maskPhone(ctx.event.from) : 'instagram' });
  await notifyOwner(ctx.db, deps, business, 'handover', `${who} wants to talk to you. Reply to them in your WhatsApp Business app${ctx.event.source === 'instagram' ? ' or Instagram' : ''}. The bot stays quiet in that chat until you send HANDBACK here.`);
}

// Pickup, with the shop's preparation time when it has one (food), at the shop's address.
const pickup = (business: Business): OrderDelivery => ({ method: 'pickup', feeKobo: 0, timeframe: business.prepTime ? `Ready for pickup in about ${business.prepTime}` : 'Ready for pickup', ...(shopAddress(business) ? { address: shopAddress(business)! } : {}) });
// Where pickup customers go: "12 Herbert Macaulay Way, Yaba, Lagos — near Tejuosho Market".
export const shopAddress = (b: Pick<Business, 'address' | 'area' | 'city' | 'landmark'>) => (b.area || b.city || b.address ? describeLocation({ street: b.address ?? null, area: b.area ?? null, city: b.city ?? null, landmark: b.landmark ?? null }) : null);
// Other states with "I quote per order": the delivery price isn't known yet.
const quoteLater = (d: OrderDelivery) => d.method !== 'pickup' && !d.feeKobo && /to be confirmed/.test(d.timeframe ?? '');

// When the shop is closed: the shop's own "we're closed" message, and what the customer can still
// do (null when open or no hours are set).
function closedNote(business: Business, customer?: Customer | null, now = new Date()) {
  const open = openNow(business.hours, now);
  if (open.open) return null;
  // No opening time coming up (closed all week): the 'we open again …' sentence is left out.
  const template = business.messages?.closed || DEFAULT_MESSAGES.closed;
  const note = fill(open.next ? template : template.replace(/[^.!?\n]*\{opens\}[^.!?\n]*[.!?]?/g, ''), business.name, { customer: customer?.name, opens: `at ${open.next}` });
  return business.afterHours === 'menu' ? `${note} Have a look at what we have meanwhile.` : `${note} You can still order, and we'll get it ready when we open.`;
}

// Answers from the shop's own settings; null when there's nothing to say (a person answers instead).
async function shopInfo(db: Firestore, business: Business, topic: string, pidgin?: boolean): Promise<string | null> {
  if (topic === 'location') {
    const where = shopAddress(business);
    if (!where) return null;
    const hours = business.hours ? describeHours(business.hours) : null;
    return pidgin
      ? `Na here we dey: 📍 ${where}.${hours ? `\nWe dey open ${hours}.` : ''}`
      : `📍 ${business.name}: ${where}.${hours ? `\nOpening hours: ${hours}.` : ''}`;
  }
  if (topic === 'hours' && pidgin && business.hours) {
    const open = openNow(business.hours);
    return `We dey open ${describeHours(business.hours)}.${open.open ? ' We dey open now o.' : ` We don close for now${open.next ? `, we go open again ${open.next}` : ''}.`}`;
  }
  if (topic === 'policy') { const p = policyText(business.policies); return p ? `Our policy at ${business.name}:\n${p}` : null; }
  if (topic === 'hours') {
    if (!business.hours) return `You can order from ${business.name} here any time.`;
    const open = openNow(business.hours);
    return `Our opening hours: ${describeHours(business.hours)}.${open.open ? " We're open now." : ` We're closed right now${open.next ? ` and open again at ${open.next}` : ''}.`}`;
  }
  if (topic === 'delivery') {
    const zones = await listZones(db, business.id);
    if (business.fulfilment === 'pickup' || (!zones.length && !business.shipsInterstate)) return `${business.name} does pickup only for now.`;
    const lines = zones.sort(byPriority).map(z => `• ${z.name}: ${z.feeKobo ? formatKobo(z.feeKobo) : 'free'}`);
    if (business.shipsInterstate && business.interstatePricing === 'quote') lines.push('• Other states: price confirmed per order');
    return `Delivery from ${business.name}:\n${lines.join('\n')}${business.fulfilment === 'both' ? '\nPickup is free.' : ''}`;
  }
  return null;
}

// "Menu" is a food word: other shops get "Browse the shop" / "Back to the shop" on their buttons.
function shopWords(c: OutboundContent, business: Business): OutboundContent {
  if (business.category === 'food_beverage' || c.type !== 'interactive') return c;
  const swap: Record<string, string> = { 'See the menu': 'Browse the shop', 'Back to menu': 'Back to the shop' };
  const json = JSON.stringify(c).replace(/"title":"(See the menu|Back to menu)"/g, (_m, t: string) => `"title":"${swap[t]}"`);
  return JSON.parse(json) as OutboundContent;
}
