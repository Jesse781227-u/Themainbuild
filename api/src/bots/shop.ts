// The Shop Bot answers customers on the merchant's own WhatsApp number (and Instagram DMs).
// Flow: greeting with categories → products → add to cart → delivery or pickup → confirm → order
// (stock reserved, unique amount) → payment instructions. It stays silent while the owner has taken
// over the chat, and hands over when the customer asks for a person.
import { C } from '../db';
import { checkOffer, lookOffer, looksLikeCode, offerReason } from '../services/offers';
import { consented, optIn, optOut, recordSignal, type ReachCustomer, type SignalType } from '../services/reach';
import type { Firestore } from '../lib/firestore';
import { formatKobo, feeKobo } from '../lib/money';
import { log } from '../lib/logger';
import { maskPhone } from '../lib/phone';
import type { Business } from '../domain/business';
import type { Cart, Category, Conversation, Customer, Order, OrderDelivery, Product } from '../domain/commerce';
import { hasStock, lineName, priceOf, tracksStock, variantOf, type CartLine } from '../domain/commerce';
import { send, optionIds, resolveSender, type OutboundContent } from '../services/channel';
import { listCategories, listProducts } from '../services/catalog';
import { categoryCarousel, productCarousel, productDetails, suggestionMessage } from './product-cards';
import { suggestFor } from '../services/suggestions';
import { noteInterest } from '../services/status-posts';
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
import { conversational, isFail, PIDGIN, runAgent } from './agent';
import { loadMemory, remember, saveMemory } from './agent-memory';
import { debugNote, recordAgentTurn } from './agent-stats';
import { shopContext, shopSystem, shopTools, type ShopHelpers } from './shop-agent';

const CART_HOURS = 24;
// A new conversation (welcome first) after this long without a message.
const SESSION_HOURS = 12;

type Step = 'browse' | 'await_address' | 'confirm' | 'confirm_delete';
interface ShopState {
  step: Step; options?: string[]; delivery?: OrderDelivery | null;
  suggested?: string[];      // products we've already suggested pairings for
  sayOptions?: string[] | null; // the agent's quick answers (say:1…3), so a tap comes back as its words
  greetedAt?: string | null; // when this conversation's welcome was sent
  pidgin?: boolean;          // the customer writes in Pidgin: the bot's own words follow
}
interface Run { deps: BotDeps; state: ShopState; first?: boolean /* the first message of this conversation */; agent?: boolean /* the conversation agent is on */; voice?: boolean /* this message was a voice note */ }
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
  // A tap arrives as a choice, not text, so the button is checked by its id.
  const firstInput = readInput(ctx.event);
  const optText = (ctx.event.text ?? firstInput.text ?? '').trim().toLowerCase();
  // "Stop updates" (the button on every update, or typed): no more marketing, at once.
  if (firstInput.choiceId === 'stopupd' || /^(stop|unsubscribe|stop all|stop updates|no more updates)$/.test(optText)) {
    await optOut(db, conversationId);
    if (conv.mode === 'owner') return;
    await send(db, cfg, deps.transport, { from: sender, conversationId, to: ctx.event.from, content: { type: 'text', text: `Done. No more updates from ${business.name}. You can still order here any time; send *START UPDATES* to get them again.` } });
    return;
  }
  // Replying soon after an update counts for it (Smart Reach results).
  const c0 = customer as (Customer & { lastMarketingAt?: string | null }) | null;
  if (!ctx.test && c0?.lastMarketingAt && Date.now() - new Date(c0.lastMarketingAt).getTime() < 48 * 3_600_000) await recordSignal(db, { businessId, customerId: conversationId, type: 'replied' }).catch(() => undefined);
  if (conv.mode === 'owner') return; // the owner is handling this chat until they hand back

  const to = ctx.event.from;
  if (!ctx.test && ctx.event.source === 'whatsapp') await showTyping(db, cfg, deps.transport, sender, to, ctx.event.messageId);
  const state: ShopState = conv.shop ?? { step: 'browse' };
  const setState = (s: ShopState | null) => db.set(db.doc(C.conversations, conversationId), { shop: s }, { merge: true });
  const reply = async (content: OutboundContent | string, next?: ShopState) => {
    const c: OutboundContent = testFooter(typeof content === 'string' ? { type: 'text', text: content } : content, !!ctx.test);
    await send(db, cfg, deps.transport, { from: sender, conversationId, to, content: shopWords(c, business) });
    const options = optionIds(c);
    if (next || options.length) await setState({ ...(next ?? state), suggested: next?.suggested ?? state.suggested, greetedAt: state.greetedAt ?? null, pidgin: state.pidgin ?? false, options });
  };

  const run: Run = { deps, state, agent: !!deps.llm?.converse && cfg.AGENT_ENABLED !== 'false' };
  const input = readInput(ctx.event);
  let text = input.text;
  if (input.audioId) {
    const token = ctx.event.source === 'whatsapp' ? await resolveSender(db, cfg, { businessId }).then(s => s.accessToken).catch(() => null) : null;
    const reactTo = (emoji: string) => react(db, cfg, deps.transport, { from: sender, conversationId, to, messageId: ctx.event.messageId, emoji });
    const heard = token ? await slowJob(() => transcribeVoice(cfg, deps, token, input.audioId!), { react: reactTo, ok: r => !!r }) : null;
    if (!heard) return reply("Sorry, I couldn't play that voice note. Please type your message.");
    text = heard;
    run.voice = true;
  }
  // A quick answer the agent offered ("say:<n>"): it comes back as the words on the button.
  const agentChoice = input.choiceId?.startsWith('say:') || (/^\d{1,2}$/.test(text.trim()) && state.options?.[Number(text.trim()) - 1]?.startsWith('say:'));
  if (agentChoice) text = (input.choiceId?.startsWith('say:') ? text : state.sayOptions?.[Number(text.trim()) - 1]) || text;
  const lower = text.trim().toLowerCase();
  // A tapped option, or its number typed back (Instagram, or anyone who prefers typing).
  const choice = agentChoice ? null : input.choiceId ?? (/^\d{1,2}$/.test(lower) ? state.options?.[Number(lower) - 1] ?? null : null);

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
    await optIn(db, conversationId);
    return reply(`You'll now get occasional updates and offers from ${business.name}. Tap *Stop updates* on any of them, or send STOP, to stop.`);
  }

  // ── "Are you a bot?": an honest answer, in their language, and the way to a person (PRD: disclose when asked) ──
  if (AI_QUESTION.test(lower)) {
    const pidgin = PIDGIN.test(lower) || state.pidgin;
    return reply(buttons(pidgin
      ? `Na *${business.name}* AI assistant dey talk 🤖. I fit show you wetin we get, take your order and answer questions. If you wan talk to the owner, type *talk to the owner*.`
      : `I'm *${business.name}*'s AI assistant 🤖. I can show you what we have, take your order and answer questions. To talk to the owner, type *talk to the owner*.`,
    [['menu', say(pidgin, 'See what we have', 'See wetin we get')], ['cart', 'My cart']]));
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
    // A size/colour picked from the list ("addv:<product>:<option>"), or the first of two options.
    if (kind === 'addv') return addToCart(ctx, run, business, id, 1, reply, choice.split(':')[2] ?? null);
    if (kind === 'opt1') return pickVariant(ctx, business, id, reply, choice.split(':').slice(2).join(':'));
    if (kind === 'cart') return showCart(ctx, business, reply);
    if (kind === 'clear') { await db.delete(db.doc(C.carts, conversationId)); return reply(buttons('Cart cleared.', [['menu', 'See the menu']]), { step: 'browse' }); }
    if (kind === 'checkout') return startCheckout(ctx, business, reply);
    if (kind === 'deliver') return reply('Please send your delivery address (area and street).', { step: 'await_address' });
    if (kind === 'pickup') return confirmOrder(ctx, business, pickup(business), reply);
    if (kind === 'confirm' && state.step === 'confirm') return placeOrder(ctx, deps, business, state.delivery ?? null, reply);
    // The "Send me updates" box at checkout: only ticked when they tap it.
    if (kind === 'optin') {
      if (!ctx.test) await optIn(db, conversationId);
      return reply(buttons(`👍 You'll get updates from ${business.name} when new things arrive. Tap *Stop updates* on any of them to stop.`, state.step === 'confirm' ? [['confirm', 'Confirm order'], ['menu', 'Keep shopping']] : [['menu', 'See the menu']]), state.step === 'confirm' ? { ...state } : undefined);
    }
    if (kind === 'testpay' && ctx.test) return testPaid(ctx, business, id, reply);
    if (kind === 'delete_no') return reply('OK, nothing was deleted.', { step: 'browse' });
  }

  // A personal offer code, typed at the confirm step (or before checking out).
  if (looksLikeCode(text) && !choice) {
    const cart = await loadCart(db, ctx);
    const offer = await lookOffer(db, text);
    const r = checkOffer(offer, { businessId, customerId: conversationId }, cart ? (await cartLines(db, cart)).subtotal : 0);
    if (!r.ok) return reply(buttons(offerReason(r.reason), state.step === 'confirm' ? [['confirm', 'Confirm order'], ['menu', 'Keep shopping']] : [['cart', 'My cart'], ['menu', 'See the menu']]), { ...state });
    await db.set(db.doc(C.conversations, conversationId), { offerCode: r.offer.code }, { merge: true });
    if (state.step === 'confirm' && state.delivery) return confirmOrder(ctx, business, state.delivery, reply);
    return reply(buttons(`✅ Code ${r.offer.code} saved: ${r.offer.percentOff ? `${r.offer.percentOff}% off` : `${formatKobo(r.offer.amountOffKobo ?? 0)} off`} at checkout.`, [['checkout', 'Checkout'], ['menu', 'See the menu']]), { ...state });
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
  // Exact things answer at once (free); anything conversational goes to the agent; if the agent
  // can't answer, the old routing and menus do.
  let intent = await shopIntent(lower, text, run.agent ? null : deps.llm, db, businessId, { fuzzy: !(run.agent && conversational(lower)) });
  if (!intent && run.agent) {
    if (await shopAgent(ctx, run, business, customer, text, reply)) return;
    intent = await shopIntent(lower, text, deps.llm, db, businessId, { fuzzy: true });
  }
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
      if (matches.length) { await interest(ctx, matches.slice(0, 5).map(p => `p_${p.id}`), 'asked'); }
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
    // The owner trying their shop: the way back instead of tracking (they have no real orders).
    ctx.test ? ['act:exittest', 'Back to my dashboard'] : ['track', 'Track my order'],
  ];
  return reply(buttons(closed ? `${hello}\n\n${closed}` : hello, options), { step: 'browse' });
}

// While the owner tries their own shop: every message says how to get back.
export const TEST_FOOTER = '🧪 Test mode · type EXIT to go back';
function testFooter(c: OutboundContent, test: boolean): OutboundContent {
  if (!test) return c;
  if (c.type === 'text') return { ...c, text: `${c.text}\n\n${TEST_FOOTER}` };
  const ia = (c as { interactive?: { body?: { text?: string } } }).interactive;
  if (c.type === 'interactive' && ia?.body?.text !== undefined) return { ...c, interactive: { ...ia, body: { text: `${ia.body.text.slice(0, 1024 - TEST_FOOTER.length - 2)}\n\n${TEST_FOOTER}` } } } as OutboundContent;
  return c;
}

// Customers writing in Pidgin ("where una dey?", "abeg wetin una get").
const GREETING = /^(hi+|hello+|hey+|hiya|helo|good (morning|afternoon|evening|day)|howdy|how far|how you dey|how una dey|hi there|hello there|morning|evening|afternoon)[\s!.,🙂👋😊]*(there|o|oo)?[\s!.]*$/i;
const MENU_ASK = /\b(menu|catalog(ue)?|price ?list|prices|what do you (sell|have)|what (do )?you have|wetin (una|you) (dey )?(sell|get|have)|wetin una get|show me (what you have|your (products|items|stuff))|send (me )?(your )?(menu|catalog(ue)?|list|prices)|see (your|what you have)|your products)\b/i;
const ASK_PREFIX = /^(please\s+|abeg\s+|hi,?\s+|hello,?\s+)*(do you (have|sell|stock)|have you got|you get|una get|una dey sell|you dey sell|is there|are there|any|how much (is|are|be|for|na)|what'?s the price of|price of|price for|i (want|need|would like)( to buy)?|i wan( buy)?|can i (get|buy|order)|looking for)\s+/i;

// "Are you a bot / human / AI?", "is this a robot?", "na human dey reply?", "you be machine?".
const AI_QUESTION = /\b(are|r)\s+(you|u)\s+(a\s+|an\s+)?(bot|robot|machine|ai|human|real person|real human|person)\b|\bis\s+(this|it)\s+(a\s+|an\s+)?(bot|robot|machine|ai|real person|human)\b|\b(am i|i dey)\s+(talking|chatting|talk|chat)\s+(to|with)\s+(a\s+)?(bot|robot|machine|ai|human|person)\b|\bna\s+(human|person|bot|robot|machine|ai)\s+(dey|be|i dey)\b|\b(you|u)\s+be\s+(bot|robot|machine|ai|human)\b/i;

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

  // A conversational message ("how far, you get that black sneakers for 42? how much last?"): the
  // agent answers it (after the welcome line); short product asks stay instant below.
  if (run.agent && conversational(lower)) return false;
  // A specific product ("do you have boots?", "how much is the hoodie"): just the matching ones.
  const wanted = lower.replace(ASK_PREFIX, '').replace(/^(the|a|an|some|una|your)\s+/, '').replace(/[?.!]+$/, '').replace(/\s+(abeg|please|o)$/, '').trim();
  if (wanted && wanted !== lower.replace(/[?.!]+$/, '') || ASK_PREFIX.test(lower)) {
    const exact = (await findProducts(ctx.db, business.id, wanted)).filter(p => p.available);
    const matches = exact.length ? exact : await search(ctx.db, business.id, wanted);
    if (matches.length) {
      await interest(ctx, matches.slice(0, 5).map(p => `p_${p.id}`), 'asked');
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
  const ok = last.items.filter((l, n) => { const p = products[n]; return p && !p.deletedAt && p.available && (p.variants?.length ? !!l.variantId && hasStock(p, 1, l.variantId) : !l.variantId && hasStock(p)); });
  if (!ok.length) return reply(buttons(`Sorry, the items from your last order (${last.ref}) aren't available right now.`, [['menu', 'See what we have']]));
  const now = new Date();
  await ctx.db.set(ctx.db.doc(C.carts, ctx.conversationId), { id: ctx.conversationId, businessId: business.id, customerId: ctx.conversationId, channel: ctx.event.source, items: ok.map(i => ({ productId: i.productId, qty: i.qty, ...(i.variantId ? { variantId: i.variantId } : {}) })), expiresAt: new Date(now.getTime() + CART_HOURS * 3600_000).toISOString(), updatedAt: now.toISOString(), suggestedAt: now.toISOString() });
  return showCart(ctx, business, reply, ok.length < last.items.length ? `Here's your last order again (some items aren't available right now).` : `Here's your last order again 👍`);
}

type Reply = (content: OutboundContent | string, next?: ShopState) => Promise<void>;

// More than a short ask: several words with chat in them, a question plus something else, Pidgin.

// ── The conversation agent (bots/agent.ts, shop-agent.ts) ──
// True when it answered; false sends the message to the fixed flow (also after a fallback).
async function shopAgent(ctx: ShopContext, run: Run, business: Business, customer: Customer | null, text: string, reply: Reply): Promise<boolean> {
  const { db, cfg, conversationId } = ctx;
  const [products, categories, memory, orders] = await Promise.all([listProducts(db, business.id), listCategories(db, business.id), loadMemory(db, conversationId), recentOrders(db, [['customerId', '==', conversationId]], 5)]);
  const last = orders.find(o => o.businessId === business.id) ?? null;
  const welcome = run.first ? shortWelcome(business, customer) : null;
  const closed = run.first ? closedNote(business, customer) : null;
  const intro = (words: string) => [welcome, closed, words].filter(Boolean).join('\n\n');
  const cart = async () => {
    const c = await loadCart(db, ctx);
    if (!c?.items.length) return { cart: c, lines: [], subtotalKobo: 0 };
    const { lines, subtotal } = await cartLines(db, c);
    return { cart: c, lines: lines.map(l => ({ name: lineName(l.product!, l.variantId), qty: l.qty, totalKobo: priceOf(l.product!, l.variantId) * l.qty })), subtotalKobo: subtotal };
  };
  const helpers: ShopHelpers = {
    business, customer, first: !!run.first, welcome, voice: !!run.voice, pidgin: !!run.state.pidgin, products: products.filter(p => p.available && !p.deletedAt), categories,
    lastOrder: last ? { ref: last.ref, items: last.items.map(i => `${i.qty} × ${i.name}`), status: last.status === 'paid' ? `paid, ${last.fulfilment.replace(/_/g, ' ')}` : last.status } : null,
    cart,
    search: q => search(db, business.id, q),
    put: async (id, qty, variantId, mode) => { const r = await putInCart(ctx, business, id, qty, variantId, mode); return r.ok ? { ok: true, name: r.name, qty: r.qty } : { ok: false, reason: r.reason, name: r.name, left: r.left }; },
    noteInterest: (ids, type) => interest(ctx, ids.map(id => `p_${id}`), type),
    sendText: words => reply(intro(words)),
    sendProducts: (list, words) => sendAll(reply, productCarousel(ctx.cfg, business, list, { title: list.length === 1 ? list[0].name : 'For you', key: 'all', intro: intro(words) })),
    sendCart: words => showCart(ctx, business, reply, intro(words)),
    sendChoices: async (words, options) => {
      const ids = options.map((_, i) => `say:${i + 1}`);
      await reply(buttons(intro(words), options.map((o, i) => [ids[i], o] as [string, string])), { ...run.state, step: 'browse', sayOptions: options });
    },
    checkout: async words => { if (words) await reply(intro(words)); await startCheckout(ctx, business, reply); },
    handToOwner: async () => handOver(ctx, run.deps, business, customer, reply),
    askOwner: async q => {
      if (ctx.test) return;
      const who = customer?.name ? `${customer.name} (${ctx.event.source === 'whatsapp' ? ctx.event.from : 'Instagram'})` : ctx.event.source === 'whatsapp' ? ctx.event.from : 'An Instagram customer';
      await notifyOwner(db, run.deps, business, 'customer_question', `💬 ${who} asks: ${q}\nReply to them in your WhatsApp Business app.`);
    },
    shopInfo: topic => shopInfo(db, business, topic, run.state.pidgin),
    savedAddress: (customer as (Customer & { savedAddress?: string | null }) | null)?.savedAddress ?? null,
    canPickup: business.fulfilment !== 'delivery',
    orders: async () => orders.filter(o => o.businessId === business.id).slice(0, 3).map(o => ({ ref: o.ref, status: o.status === 'paid' ? `paid, ${o.fulfilment.replace(/_/g, ' ')}` : o.status.replace(/_/g, ' '), total: formatKobo(o.payAmountKobo), items: o.items.map(i => `${i.qty} × ${i.name}`), when: o.createdAt.slice(0, 10) })),
    orderAgain: async words => { if (words) await reply(intro(words)); await orderAgain(ctx, run, business, reply); },
    checkoutTo: async (words, how) => {
      if (words) await reply(intro(words));
      if (how.pickup && business.fulfilment !== 'delivery') return confirmOrder(ctx, business, pickup(business), reply);
      const q = how.deliverTo ? await quoteDelivery(db, business.id, how.deliverTo, 'self_arranged') : null;
      if (q) return confirmOrder(ctx, business, { ...q, address: how.deliverTo!.slice(0, 200) }, reply);
      if (how.deliverTo && business.shipsInterstate && business.interstatePricing === 'quote') return confirmOrder(ctx, business, { method: 'self_arranged', feeKobo: 0, address: how.deliverTo.slice(0, 200), timeframe: `delivery price to be confirmed by ${business.name}` }, reply);
      return startCheckout(ctx, business, reply);
    },
    applyCode: async code => {
      const c = await loadCart(db, ctx);
      const r = checkOffer(await lookOffer(db, code), { businessId: business.id, customerId: conversationId }, c ? (await cartLines(db, c)).subtotal : 0);
      if (!r.ok) return { ok: false, reason: offerReason(r.reason) };
      await db.set(db.doc(C.conversations, conversationId), { offerCode: r.offer.code }, { merge: true });
      return { ok: true, code: r.offer.code, off: r.offer.percentOff ? `${r.offer.percentOff}% off` : `${formatKobo(r.offer.amountOffKobo ?? 0)} off` };
    },
    setUpdates: async on => { if (ctx.test) return; if (on) await optIn(db, conversationId); else await optOut(db, conversationId); },
    pairings: async id => {
      const p = products.find(x => x.id === id);
      if (!p) return [];
      const c = await loadCart(db, ctx);
      const s = await suggestFor(db, null, business, p, new Set([...(c?.items.map(i => i.productId) ?? []), p.id])).catch(() => null);
      return s ? [...s.cross, ...(s.upsell ? [s.upsell] : [])] : [];
    },
    quote: async area => {
      const q = await quoteDelivery(db, business.id, area, 'self_arranged');
      if (q) return { area: q.address ?? area, feeKobo: q.feeKobo, timeframe: q.timeframe ?? null, later: false };
      if (business.shipsInterstate && business.interstatePricing === 'quote') return { area, feeKobo: 0, timeframe: null, later: true };
      return null;
    },
  };
  const cartNow = await cart();
  const r = await runAgent({ llm: run.deps.llm, system: shopSystem(helpers), context: shopContext(helpers, cartNow), memory, message: text, tools: shopTools(helpers), c: null, maxSteps: cfg.AGENT_MAX_STEPS, timeoutMs: cfg.AGENT_TIMEOUT_MS });
  await recordAgentTurn(db, cfg, business, 'shop', r).catch(() => undefined);
  const botNumber = await resolveSender(db, cfg, ctx.test ? { adminBot: true } : { businessId: business.id }).then(s => s.phoneNumberId).catch(() => '');
  await debugNote(db, cfg, { phone: ctx.event.from, botNumber, r }).catch(() => undefined);
  if (isFail(r)) {
    // Something was already changed: show the cart rather than lose it.
    if (r.calls.some(c => c.ok && (c.name === 'addToCart' || c.name === 'updateCart'))) { await showCart(ctx, business, reply, welcome ?? ''); return true; }
    // Twice in a row the assistant couldn't answer in its own words: a person takes over.
    const misses = Number(((await db.get(db.doc(C.conversations, conversationId)))?.agentMisses as number | undefined) ?? 0) + 1;
    await db.set(db.doc(C.conversations, conversationId), { agentMisses: misses }, { merge: true });
    if (misses >= 2 && r.failed === 'ungrounded') { await db.set(db.doc(C.conversations, conversationId), { agentMisses: 0 }, { merge: true }); await handOver(ctx, run.deps, business, customer, reply); return true; }
    return false;
  }
  await db.set(db.doc(C.conversations, conversationId), { agentMisses: 0 }, { merge: true });
  await saveMemory(db, conversationId, remember(memory, text, r.text, r.calls.map(c => c.name)));
  if (r.finish) await r.finish(r.text); else await reply(intro(r.text), { ...run.state, step: run.state.step ?? 'browse' });
  return true;
}

async function shopIntent(lower: string, text: string, llm: LLMProvider | null, db: Firestore, businessId: string, opts: { fuzzy?: boolean } = {}): Promise<ToolChoice | null> {
  if (opts.fuzzy !== false && /^(hi|hello|hey|good (morning|afternoon|evening)|menu|start|catalog(ue)?|price ?list|what do you (have|sell)\??)\b/.test(lower)) return { tool: 'showMenu', args: {} };
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
  if (opts.fuzzy !== false && (await findProducts(db, businessId, q)).length) return { tool: 'addToCart', args: { product: q, quantity: n } };
  if (opts.fuzzy !== false && (await search(db, businessId, q)).length) return { tool: 'addToCart', args: { product: q, quantity: n } }; // shows the matches
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
  if (key !== 'all' && !page) await interest(ctx, [`c_${key}`]);
  const products = await visible(ctx.db, business.id);
  const cat = key === 'all' ? null : (await listCategories(ctx.db, business.id)).find(c => c.id === key);
  if (key !== 'all' && !cat) return reply(buttons('That section is no longer available.', [['menu', 'Back to menu']]));
  const items = cat ? products.filter(p => p.categoryId === cat.id) : products;
  if (!items.length) return reply(buttons('Nothing here right now.', [['menu', 'Back to menu']]));
  return sendAll(reply, productCarousel(ctx.cfg, business, items, { title: cat?.name ?? 'Our products', key, page }));
}

async function showProduct(ctx: ShopContext, business: Business, productId: string, reply: Reply) {
  await interest(ctx, [`p_${productId}`]);
  const p = (await ctx.db.get(ctx.db.doc(C.products, productId))) as Product | null;
  if (!p || p.businessId !== business.id || p.deletedAt || !p.available) return reply(buttons('Sorry, that item is no longer available.', [['menu', 'Back to menu']]));
  return sendAll(reply, productDetails(ctx.cfg, p));
}

// Tapping Buy on a card: sold out says so; otherwise one goes into the cart.
async function buy(ctx: ShopContext, run: Run, business: Business, productId: string, reply: Reply) {
  const p = (await ctx.db.get(ctx.db.doc(C.products, productId))) as Product | null;
  if (!p || p.businessId !== business.id || p.deletedAt || !p.available) return reply(buttons('Sorry, that item is no longer available.', [['menu', 'Back to menu']]));
  if (!hasStock(p)) return reply(buttons(`Sorry, ${p.name} is sold out right now.`, [['menu', 'Back to menu'], ['cart', 'My cart']]));
  if (p.variants?.length) return pickVariant(ctx, business, p.id, reply);
  return addToCart(ctx, run, business, p.id, 1, reply);
}

// "Which size?": the options still in stock as a list. More than fit in one list with two kinds of
// option (size and colour): the first kind, then the second. first: the value already picked.
async function pickVariant(ctx: ShopContext, business: Business, productId: string, reply: Reply, first?: string) {
  const p = (await ctx.db.get(ctx.db.doc(C.products, productId))) as Product | null;
  if (!p || p.businessId !== business.id || p.deletedAt || !p.available || !p.variants?.length) return reply(buttons('Sorry, that item is no longer available.', [['menu', 'Back to menu']]));
  const names = p.optionNames ?? [];
  const inStock = p.variants.filter(v => hasStock(p, 1, v.id));
  if (!inStock.length) return reply(buttons(`Sorry, ${p.name} is sold out right now.`, [['menu', 'Back to menu'], ['cart', 'My cart']]));
  const soldOut = p.variants.filter(v => !hasStock(p, 1, v.id)).map(v => v.label);
  const note = soldOut.length ? `\nSold out: ${soldOut.slice(0, 8).join(', ')}${soldOut.length > 8 ? '…' : ''}` : '';
  const what = (n: string | undefined) => (n ?? 'option').toLowerCase();
  const row = (v: typeof inStock[number]) => ({ id: `addv:${p.id}:${v.id}`, title: v.label, description: `${formatKobo(priceOf(p, v.id))}${v.stock !== null && v.stock <= 3 ? ` · only ${v.stock} left` : ''}` });
  if (first !== undefined) {
    const matching = inStock.filter(v => v.options[names[0]] === first);
    if (!matching.length) return pickVariant(ctx, business, productId, reply);
    return reply(list(`*${p.name}*, ${what(names[0])} ${first}. Which ${what(names[1])}?`, `Pick ${what(names[1])}`, matching.slice(0, 10).map(row), names[1] ?? 'Options'), { step: 'browse' });
  }
  if (inStock.length <= 10 || names.length < 2) {
    return reply(list(`*${p.name}* · ${formatKobo(p.priceKobo)}\nWhich ${names.length === 2 ? `${what(names[0])} and ${what(names[1])}` : what(names[0])}?${note}`, `Pick ${what(names[0])}`, inStock.slice(0, 10).map(row), names[0] ?? 'Options'), { step: 'browse' });
  }
  const firsts = [...new Set(inStock.map(v => v.options[names[0]]))].slice(0, 10);
  return reply(list(`*${p.name}* · ${formatKobo(p.priceKobo)}\nWhich ${what(names[0])}?${note}`, `Pick ${what(names[0])}`, firsts.map(x => ({ id: `opt1:${p.id}:${x}`, title: x })), names[0]), { step: 'browse' });
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

// What this customer looked at or asked about, for Status mentions (ids only; never in TEST mode).
const interest = (ctx: ShopContext, keys: string[], type: SignalType = 'viewed', variant: string | null = null) => (ctx.test ? Promise.resolve() : Promise.all([
  ...keys.map(k => recordSignal(ctx.db, { businessId: ctx.businessId, customerId: ctx.conversationId, type, productId: k.startsWith('p_') ? k.slice(2) : null, categoryId: k.startsWith('c_') ? k.slice(2) : null, variant })),
]).then(() => noteInterest(ctx.db, ctx.conversationId, ctx.businessId, keys)).catch(e => log('warn', 'interest_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 80) })));

// The cart write itself (also used by the conversation agent): checks the product, the option and
// the stock, then adds qty (or sets it, with mode "set"; 0 removes the line).
export type PutResult =
  | { ok: true; product: Product; name: string; qty: number; cart: Cart | null; items: CartLine[] }
  | { ok: false; reason: 'unavailable' | 'needs_option' | 'stock'; product: Product | null; name: string; left: number | null };
async function putInCart(ctx: ShopContext, business: Business, productId: string, qty: number, variantId: string | null, mode: 'add' | 'set' = 'add'): Promise<PutResult> {
  const { db } = ctx;
  const p = (await db.get(db.doc(C.products, productId))) as Product | null;
  if (!p || p.businessId !== business.id || p.deletedAt || !p.available) return { ok: false, reason: 'unavailable', product: null, name: '', left: null };
  // A product with sizes/colours needs one picked first.
  const v = variantOf(p, variantId);
  if (p.variants?.length && !v) return { ok: false, reason: 'needs_option', product: p, name: p.name, left: null };
  if (!p.variants?.length) variantId = null;
  const name = lineName(p, variantId);
  const cart = await loadCart(db, ctx);
  const same = (i: CartLine) => i.productId === p.id && (i.variantId ?? null) === variantId;
  const items = cart?.items.filter(i => !same(i)) ?? [];
  const already = cart?.items.find(same)?.qty ?? 0;
  const want = mode === 'set' ? qty : already + qty;
  const left = v ? v.stock : p.stock;
  if (left !== null && want > left) return { ok: false, reason: 'stock', product: p, name, left };
  const now = new Date();
  const next = want > 0 ? [...items, { productId: p.id, qty: want, ...(variantId ? { variantId } : {}) }] : items;
  await db.set(db.doc(C.carts, ctx.conversationId), { id: ctx.conversationId, businessId: business.id, customerId: ctx.conversationId, channel: ctx.event.source, items: next, expiresAt: new Date(now.getTime() + CART_HOURS * 3600_000).toISOString(), updatedAt: now.toISOString(), suggestedAt: cart?.suggestedAt ?? null });
  return { ok: true, product: p, name, qty: want, cart, items };
}

async function addToCart(ctx: ShopContext, run: Run, business: Business, productId: string, qty: number, reply: Reply, variantId: string | null = null) {
  if (variantId || !((await ctx.db.get(ctx.db.doc(C.products, productId))) as Product | null)?.variants?.length) await interest(ctx, [`p_${productId}`], 'carted', variantId);
  const { db } = ctx;
  const put = await putInCart(ctx, business, productId, qty, variantId);
  if (!put.ok && put.reason === 'unavailable') return reply(buttons('Sorry, that item is no longer available.', [['menu', 'Back to menu']]));
  if (!put.ok && put.reason === 'needs_option') return pickVariant(ctx, business, productId, reply);
  if (!put.ok) return reply(buttons(put.left ? `Sorry, only ${put.left} ${put.name} left.` : `Sorry, ${put.name} is sold out right now.`, [['cart', 'My cart'], ['menu', 'See the menu']]));
  const { product: p, name, cart, items } = put;
  variantId = p.variants?.length ? variantId : null;
  // Then what goes with it: one suggestion per cart (adding from a suggestion doesn't bring another),
  // and never twice for the same item in a chat.
  const suggest = business.suggestions !== false && !cart?.suggestedAt && !run.state.suggested?.includes(p.id);
  if (suggest) run.state.suggested = [...(run.state.suggested ?? []), p.id].slice(-30);
  const added = renderMessage(business, 'addedToCart', { customer: (await db.get(db.doc(C.customers, ctx.conversationId)) as Customer | null)?.name, item: `${qty} × ${name}` });
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
  const subtotal = lines.reduce((s, l) => s + priceOf(l.product!, l.variantId) * l.qty, 0);
  return { lines, subtotal, text: lines.map(l => `• ${l.qty} × ${lineName(l.product!, l.variantId)}: ${formatKobo(priceOf(l.product!, l.variantId) * l.qty)}`).join('\n') };
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
  const break_ = pausedNote(business);
  if (break_) return reply(buttons(`${break_} Your cart is saved, so you can check out then.`, [['menu', 'See the menu']]));
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
  const { text, subtotal: goods } = await cartLines(ctx.db, cart);
  const code = ((await ctx.db.get(ctx.db.doc(C.conversations, ctx.conversationId)))?.offerCode as string | undefined) ?? null;
  const offer = code ? checkOffer(await lookOffer(ctx.db, code), { businessId: business.id, customerId: ctx.conversationId }, goods) : null;
  const discount = offer?.ok ? offer.discountKobo : 0;
  const subtotal = goods - discount;
  const policy = policyFor(business, ctx.cfg);
  const fee = customerFee(feeKobo(subtotal, policy), policy);
  const body = [
    'Please confirm your order:', text,
    `Subtotal: ${formatKobo(goods)}`,
    ...(discount ? [`Code ${code}: -${formatKobo(discount)}`] : []),
    delivery.method === 'pickup' ? `Pickup: free${business.prepTime ? `, ready in about ${business.prepTime}` : ''}${shopAddress(business) ? `\n📍 Pick up from: ${shopAddress(business)}` : ''}` : quoteLater(delivery) ? `Delivery (${delivery.address ?? ''}): ${delivery.timeframe}` : `Delivery (${delivery.address ?? ''}): ${formatKobo(delivery.feeKobo)}${delivery.timeframe ? `, ${delivery.timeframe}` : ''}`,
    ...(fee ? [`Service fee: ${formatKobo(fee)}`] : []),
    quoteLater(delivery) ? `Total: about ${formatKobo(subtotal + fee)} plus delivery (${business.name} confirms the delivery price)` : `Total: ${formatKobo(subtotal + delivery.feeKobo + fee)}`,
  ].join('\n');
  // Updates: an unticked box (a button) for customers who haven't agreed yet.
  const who = (await ctx.db.get(ctx.db.doc(C.customers, ctx.conversationId))) as ReachCustomer | null;
  const ask = !ctx.test && !(who && consented(who, ctx.cfg));
  return reply(buttons(body, [['confirm', 'Confirm order'], ['menu', 'Keep shopping'], ...(ask ? [['optin', 'Send me updates'] as [string, string]] : [])]), { step: 'confirm', delivery });
}

async function placeOrder(ctx: ShopContext, deps: BotDeps, business: Business, delivery: OrderDelivery | null, reply: Reply) {
  const cart = await loadCart(ctx.db, ctx);
  if (!cart?.items.length) return reply(buttons('Your cart is empty.', [['menu', 'See the menu']]), { step: 'browse' });
  if (ctx.test) return testOrder(ctx, business, cart, delivery, reply);
  let order: Order;
  try {
    const offerCode = ((await ctx.db.get(ctx.db.doc(C.conversations, ctx.conversationId)))?.offerCode as string | undefined) ?? null;
    order = await checkout(ctx.db, { cartId: cart.id, businessId: business.id, policy: policyFor(business, ctx.cfg), delivery, offerCode });
    if (offerCode) await ctx.db.set(ctx.db.doc(C.conversations, ctx.conversationId), { offerCode: null }, { merge: true });
  } catch (e) {
    const code = String(e instanceof Error ? e.message : e);
    if (code.startsWith('OFFER_')) {
      await ctx.db.set(ctx.db.doc(C.conversations, ctx.conversationId), { offerCode: null }, { merge: true });
      return reply(buttons(`${offerReason(code.slice(6).toLowerCase() as 'used')} The order wasn't placed; tap Confirm to order without it.`, [['confirm', 'Confirm order'], ['menu', 'Keep shopping']]), { step: 'confirm', delivery });
    }
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
  if (delivery?.address && delivery.method !== 'pickup' && !ctx.test) await ctx.db.set(ctx.db.doc(C.customers, ctx.conversationId), { savedAddress: delivery.address.slice(0, 200) }, { merge: true });
  const placed = `New order ${order.ref}: ${formatKobo(order.payAmountKobo)} awaiting payment (${order.items.map(l => `${l.qty}× ${l.name}`).join(', ')}).`;
  await notifyOwner(ctx.db, deps, business, 'order_placed', placed, order.id, buttons(placed, [[`act:order:${order.ref}`, 'View order'], [`act:msgcust:${order.ref}`, 'Message customer'], ['act:menu', 'Menu']]));
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
// The owner paused the shop (PAUSE): customers can look, not order. Null when not paused.
function pausedNote(business: Business, now = new Date()) {
  const until = business.pausedUntil;
  if (!until || (until !== 'open' && new Date(until) <= now)) return null;
  const when = until === 'open' ? '' : ` We're back ${new Date(until).toLocaleString('en-GB', { weekday: 'long', hour: 'numeric', timeZone: 'Africa/Lagos' })}.`;
  return `⏸️ We're taking a short break and not taking orders right now.${when}`;
}

function closedNote(business: Business, customer?: Customer | null, now = new Date()) {
  const paused = pausedNote(business, now);
  if (paused) return `${paused} Have a look at what we have meanwhile.`;
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
