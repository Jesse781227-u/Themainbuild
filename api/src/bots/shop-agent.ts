// The Shop Bot's conversation agent: what it knows (context) and what it can do (tools).
// Phase 1: browsing, product questions, the cart, delivery prices, shop info, asking the owner.
// Checkout and payment stay the fixed flow (goToCheckout hands over to it); prices, stock, fees and
// hours only ever come from the database through these tools.
import type { Business } from '../domain/business';
import type { Cart, Product } from '../domain/commerce';
import { hasStock, lineName, priceOf } from '../domain/commerce';
import type { Customer } from '../domain/commerce';
import { formatKobo } from '../lib/money';
import { describeHours, openNow } from '../services/hours';
import { policyText } from '../services/policies';
import { toneLine, type AgentTool } from './agent';
import { examplesBlock } from '../services/owner-examples';

// What shop.ts hands the agent (so this file needs nothing from it).
export interface ShopHelpers {
  business: Business; customer: Customer | null; first: boolean; welcome: string | null; pidgin: boolean; voice?: boolean;
  products: Product[]; categories: { id: string; name: string }[];
  cart: () => Promise<{ cart: Cart | null; lines: { name: string; qty: number; totalKobo: number }[]; subtotalKobo: number }>;
  lastOrder: { ref: string; items: string[]; status: string } | null;
  search: (query: string) => Promise<Product[]>;
  put: (productId: string, qty: number, variantId: string | null, mode: 'add' | 'set') => Promise<{ ok: true; name: string; qty: number } | { ok: false; reason: string; name: string; left: number | null }>;
  noteInterest: (productIds: string[], type: 'viewed' | 'asked' | 'carted') => Promise<void>;
  sendText: (words: string) => Promise<void>;
  sendProducts: (products: Product[], words: string) => Promise<void>;
  sendCart: (words: string) => Promise<void>;
  sendChoices: (words: string, options: string[]) => Promise<void>;
  checkout: (words: string) => Promise<void>;
  handToOwner: (words: string, reason: string) => Promise<void>;
  askOwner: (question: string) => Promise<void>;
  shopInfo: (topic: string) => Promise<string | null>;
  quote: (area: string) => Promise<{ area: string; feeKobo: number; timeframe: string | null; later: boolean } | null>;
  // Phase 2: ordering end to end.
  savedAddress: string | null;
  orders: () => Promise<{ ref: string; status: string; total: string; items: string[]; when: string }[]>;
  orderAgain: (words: string) => Promise<void>;
  checkoutTo: (words: string, how: { deliverTo?: string | null; pickup?: boolean }) => Promise<void>;
  applyCode: (code: string) => Promise<{ ok: true; code: string; off: string } | { ok: false; reason: string }>;
  setUpdates: (on: boolean) => Promise<void>;
  pairings: (productId: string) => Promise<Product[]>;
  canPickup: boolean;
}

const naira = (kobo: number) => formatKobo(kobo);
const brief = (p: Product) => ({
  id: p.id, name: p.name, price: naira(p.priceKobo), inStock: hasStock(p),
  ...(p.variants?.length ? { options: p.variants.map(v => `${v.label}${hasStock(p, 1, v.id) ? '' : ' (sold out)'}${v.priceKobo !== null && v.priceKobo !== p.priceKobo ? ` ${naira(v.priceKobo)}` : ''}`).slice(0, 20) } : {}),
});

// "42", "black", "42 / Black", "size 42": the option whose label or values match.
export function matchVariant(p: Product, said: string | null | undefined): string | null {
  if (!p.variants?.length || !said) return null;
  const words = said.toLowerCase().replace(/\b(size|colour|color|in)\b/g, ' ').split(/[^a-z0-9.]+/).filter(Boolean);
  const scored = p.variants.map(v => {
    const vals = [v.label, ...Object.values(v.options)].map(x => x.toLowerCase());
    return { v, hits: words.filter(w => vals.some(x => x === w || x.split(/[^a-z0-9.]+/).includes(w))).length };
  }).filter(x => x.hits > 0).sort((a, b) => b.hits - a.hits);
  if (!scored.length || (scored[1] && scored[1].hits === scored[0].hits)) return null;
  return scored[0].v.id;
}

export function shopSystem(h: ShopHelpers) {
  const b = h.business;
  return [
    `You are the WhatsApp shop assistant for "${b.name}", a small ${String(b.category ?? 'other').replace(/_/g, ' ')} business in Nigeria. You help customers find products, answer questions about the shop, fill their cart and get delivery prices.`,
    'Use the tools for every fact. To show products call showProducts; to show the cart call showCart; for a quick question with a few answers call offerChoices. Show at most one of these per reply.',
    'When a customer asks what you have of a kind ("what smoothies do you have?"), show the matching products, up to 10. The cards show names and prices: don\'t list them in your words too; one short line before the cards is enough.',
    'When they want to pay or check out, call goToCheckout: the system sends the order summary and payment details, so never write account numbers, totals to pay or payment steps yourself.',
    'If a product has options (sizes, colours) and they didn\'t say which, ask which one (offerChoices with the options in stock).',
    'Bargaining ("how much last?", "reduce am"): never lower or invent a price. State the price politely and offer to ask the owner; call askOwner only if they want that.',
    'Complaints, refunds, a wrong or late order, custom orders, an angry customer, or anything you can\'t do with the tools: call handToOwner.',
    'Off-topic requests: one friendly line, then back to the shop. Light small talk is fine.',
    toneLine(b.tone),
    'Use their first name now and then, not in every message. Suggest at most one extra item, and only right after adding to cart, once per chat.',
    'As soon as they say checkout, pay, "that\'s all", "I\'ll pick it up" or where to deliver it, call goToCheckout (with pickup=true or deliverTo). Never hold checkout up with suggestions.',
    'If they ask to be told about new items or offers, call setUpdates(on=true); if they don\'t want promos, setUpdates(on=false).',
    'If they want more than is in stock, say how many are left and ask; never add a different quantity than they asked for.',
    'Don\'t greet or say welcome unless they greeted you first; just answer.',
  ].join('\n');
}

export function shopContext(h: ShopHelpers, cartNow: Awaited<ReturnType<ShopHelpers['cart']>>) {
  const b = h.business;
  const open = b.hours ? openNow(b.hours) : null;
  const visible = h.products.filter(p => p.available && !p.deletedAt);
  const catName = new Map(h.categories.map(c => [c.id, c.name]));
  const catalogue = visible.length <= 60
    ? visible.map(p => `${p.id} | ${p.name} | ${naira(p.priceKobo)} | ${hasStock(p) ? 'in stock' : 'sold out'}${p.categoryId ? ` | ${catName.get(p.categoryId) ?? ''}` : ''}${p.variants?.length ? ` | options: ${p.variants.map(v => `${v.label}${hasStock(p, 1, v.id) ? '' : ' (sold out)'}`).join(', ').slice(0, 160)}` : ''}`).join('\n')
    : `${visible.length} products: use searchProducts. Sections: ${h.categories.map(c => c.name).join(', ')}`;
  const name = h.customer?.name && h.customer.name !== 'A customer' ? h.customer.name.split(' ')[0] : null;
  return [
    'CONTEXT (facts you may use):',
    `Shop: ${b.name}. ${b.hours ? `Hours: ${describeHours(b.hours)}. ${open?.open ? 'Open now.' : `Closed now${open?.next ? `, opens ${open.next}` : ''}.`}` : 'No opening hours set (orders any time).'}`,
    `Fulfilment: ${b.fulfilment ?? 'delivery'}${b.prepTime ? `, ready in about ${b.prepTime}` : ''}.`,
    b.messages?.welcome ? `The shop's own welcome message (copy its tone, not its words): "${b.messages.welcome.slice(0, 200)}"` : '',
    examplesBlock((b as { ownerExamples?: unknown }).ownerExamples),
    b.policies ? `Policies: ${policyText(b.policies)?.replace(/\n/g, ' ').slice(0, 400) ?? ''}` : '',
    `Catalogue (id | name | price | stock | section | options):\n${catalogue}`,
    `Customer: ${name ?? 'name unknown'}; ${h.customer?.orderCount ?? 0} past orders.${h.lastOrder ? ` Last order ${h.lastOrder.ref} (${h.lastOrder.status}): ${h.lastOrder.items.join(', ')}.` : ''}${h.savedAddress ? ` Saved delivery address: ${h.savedAddress}.` : ''}`,
    `Pickup: ${h.canPickup ? 'yes' : 'no'}. Delivery: ${b.fulfilment === 'pickup' ? 'no' : 'yes'}.`,
    cartNow.lines.length ? `Their cart: ${cartNow.lines.map(l => `${l.qty} × ${l.name} = ${naira(l.totalKobo)}`).join('; ')}. Subtotal ${naira(cartNow.subtotalKobo)}.` : 'Their cart is empty.',
    h.pidgin ? 'They write in Pidgin: reply in Pidgin.' : '',
    h.voice ? 'Their message is a voice note, written out by a machine: small mistakes are possible; if a product or number is unclear, ask.' : '',
    h.first && h.welcome ? `This is the start of the chat. The line "${h.welcome}" is sent before your reply automatically, so don't greet again.` : '',
  ].filter(Boolean).join('\n');
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v: unknown, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : d; };

export function shopTools(h: ShopHelpers): AgentTool<null>[] {
  const product = (id: unknown) => h.products.find(p => p.id === str(id, 64) && p.available && !p.deletedAt) ?? null;
  return [
    {
      spec: { name: 'searchProducts', description: 'Find products by words (name, kind, colour, size). Returns ids, names, prices, stock and options.', params: { query: { type: 'string', description: 'What they asked for, e.g. "black sneakers"' }, maxPrice: { type: 'number', description: 'Optional: most they want to pay, in naira' } }, required: ['query'] },
      async run(a) {
        const max = Number(a.maxPrice) > 0 ? Number(a.maxPrice) * 100 : null;
        const found = (await h.search(str(a.query, 80))).filter(p => !max || p.priceKobo <= max).slice(0, 8);
        await h.noteInterest(found.slice(0, 5).map(p => p.id), 'asked');
        return { result: found.length ? found.map(brief) : { found: 0 } };
      },
    },
    {
      spec: { name: 'getProduct', description: 'Everything about one product: description, price, options and what is in stock.', params: { productId: { type: 'string', description: 'The product id' } }, required: ['productId'] },
      async run(a) {
        const p = product(a.productId);
        if (!p) return { result: { error: 'not found' } };
        await h.noteInterest([p.id], 'viewed');
        return { result: { ...brief(p), description: p.description?.slice(0, 300) ?? null, ...(p.variants?.length ? { options: p.variants.map(v => ({ option: v.label, price: naira(priceOf(p, v.id)), inStock: hasStock(p, 1, v.id), ...(v.stock !== null && v.stock <= 3 ? { left: v.stock } : {}) })) } : { left: p.stock !== null && p.stock <= 5 ? p.stock : undefined }) } };
      },
    },
    {
      spec: { name: 'addToCart', description: 'Put a product in their cart. For products with options, give the option they chose (e.g. "42", "Black").', params: { productId: { type: 'string', description: 'The product id' }, option: { type: 'string', description: 'The size/colour they chose, if the product has options' }, quantity: { type: 'integer', description: 'How many to add (default 1)' } }, required: ['productId'] },
      async run(a) {
        const p = product(a.productId);
        if (!p) return { result: { ok: false, reason: 'not found' } };
        const variantId = matchVariant(p, str(a.option, 40));
        if (p.variants?.length && !variantId) return { result: { ok: false, reason: 'which option?', options: p.variants.filter(v => hasStock(p, 1, v.id)).map(v => v.label) } };
        const r = await h.put(p.id, Math.max(1, Math.min(99, int(a.quantity, 1))), variantId, 'add');
        if (r.ok) await h.noteInterest([p.id], 'carted');
        const c = await h.cart();
        return { result: r.ok ? { ok: true, added: lineName(p, variantId), nowInCart: r.qty, subtotal: naira(c.subtotalKobo) } : { ok: false, reason: r.reason === 'stock' ? (r.left ? `only ${r.left} left` : 'sold out') : r.reason } };
      },
    },
    {
      spec: { name: 'viewCart', description: 'What is in their cart now, with the subtotal (read only).', params: {} },
      async run() { const c = await h.cart(); return { result: c.lines.length ? { lines: c.lines.map(l => ({ item: l.name, qty: l.qty, total: naira(l.totalKobo) })), subtotal: naira(c.subtotalKobo) } : { empty: true } }; },
    },
    {
      spec: { name: 'showCart', description: 'Show their cart with Checkout / Keep shopping buttons, under your reply.', params: {} },
      async run() { const c = await h.cart(); return { result: { shown: true, items: c.lines.length, subtotal: naira(c.subtotalKobo) }, show: words => h.sendCart(words) }; },
    },
    {
      spec: { name: 'showProducts', description: 'Show product cards (photo, price, Add to cart) under your reply.', params: { productIds: { type: 'string', description: 'Product ids, comma-separated (up to 10)' } }, required: ['productIds'] },
      async run(a) {
        const list = str(a.productIds, 800).split(',').map(x => product(x.trim())).filter((p): p is Product => !!p).slice(0, 10);
        if (!list.length) return { result: { error: 'no such products' } };
        await h.noteInterest(list.slice(0, 5).map(p => p.id), 'viewed');
        return { result: { shown: list.map(p => p.name) }, show: words => h.sendProducts(list, words) };
      },
    },
    {
      spec: { name: 'offerChoices', description: 'Ask a quick question with up to 3 tap-able answers (each ≤ 20 characters).', params: { options: { type: 'string', description: 'The answers, separated by |' } }, required: ['options'] },
      async run(a) {
        const opts = str(a.options, 200).split('|').map(x => x.trim().slice(0, 20)).filter(Boolean).slice(0, 3);
        if (!opts.length) return { result: { error: 'no options' } };
        return { result: { shown: opts }, show: words => h.sendChoices(words, opts) };
      },
    },
    {
      spec: { name: 'updateCart', description: 'Change how many of an item is in their cart ("make it 2"); quantity 0 removes it.', params: { productId: { type: 'string', description: 'The product id' }, option: { type: 'string', description: 'Its size/colour, if it has options' }, quantity: { type: 'integer', description: 'The new quantity (0 removes)' } }, required: ['productId', 'quantity'] },
      async run(a) {
        const p = h.products.find(x => x.id === str(a.productId, 64)) ?? null;
        if (!p) return { result: { ok: false, reason: 'not found' } };
        const c0 = await h.cart();
        const inCart = c0.cart?.items.filter(i => i.productId === p.id) ?? [];
        const variantId = p.variants?.length ? (matchVariant(p, str(a.option, 40)) ?? (inCart.length === 1 ? inCart[0].variantId ?? null : null)) : null;
        if (p.variants?.length && !variantId) return { result: { ok: false, reason: 'which option?', inCart: inCart.map(i => lineName(p, i.variantId)) } };
        const qty = Math.max(0, Math.min(99, int(a.quantity, 1)));
        const r = await h.put(p.id, qty, variantId, 'set');
        const c = await h.cart();
        return { result: r.ok ? { ok: true, item: lineName(p, variantId), nowInCart: qty, subtotal: naira(c.subtotalKobo), cartEmpty: !c.lines.length } : { ok: false, reason: r.reason === 'stock' ? (r.left ? `only ${r.left} left` : 'sold out') : r.reason } };
      },
    },
    {
      spec: { name: 'orderAgain', description: 'Same as last time: put their last paid order back in the cart and show it.', params: {} },
      async run() { return h.lastOrder ? { result: { lastOrder: h.lastOrder.items }, takeover: words => h.orderAgain(words) } : { result: { error: 'no past order' } }; },
    },
    {
      spec: { name: 'orderStatus', description: 'Their recent orders with status (paid, packed, out for delivery…).', params: {} },
      async run() { const o = await h.orders(); return { result: o.length ? o : { none: true } }; },
    },
    {
      spec: { name: 'applyOfferCode', description: 'Use a personal offer code they typed (e.g. "ADA-7KX2"). Only real codes work.', params: { code: { type: 'string', description: 'The code' } }, required: ['code'] },
      async run(a) { return { result: await h.applyCode(str(a.code, 20)) }; },
    },
    {
      spec: { name: 'setUpdates', description: 'They want (on=true) or don\'t want (on=false) news and offers from the shop.', params: { on: { type: 'boolean', description: 'true to get updates, false to stop' } }, required: ['on'] },
      async run(a) { const on = a.on === true || a.on === 'true'; await h.setUpdates(on); return { result: { updates: on ? 'on' : 'off' } }; },
    },
    {
      spec: { name: 'suggestPairings', description: 'Items that go well with a product (only after they add something, or before checkout; suggest one).', params: { productId: { type: 'string', description: 'The product they added' } }, required: ['productId'] },
      async run(a) { const ps = await h.pairings(str(a.productId, 64)); return { result: ps.length ? ps.slice(0, 3).map(brief) : { none: true } }; },
    },
    {
      spec: { name: 'deliveryQuote', description: 'The delivery price to an area or address.', params: { area: { type: 'string', description: 'Area, street or landmark, e.g. "Yaba" or "Lekki Phase 1"' } }, required: ['area'] },
      async run(a) {
        if (h.business.fulfilment === 'pickup') return { result: { delivers: false, pickupOnly: true } };
        const q = await h.quote(str(a.area, 120));
        return { result: q ? { delivers: true, area: q.area, fee: q.feeKobo ? naira(q.feeKobo) : (q.later ? 'confirmed by the shop per order' : 'free'), ...(q.timeframe ? { when: q.timeframe } : {}) } : { delivers: false, pickup: h.business.fulfilment !== 'delivery' } };
      },
    },
    {
      spec: { name: 'shopInfo', description: 'The shop\'s opening hours, location, delivery areas, policies (returns, refunds) or how payment works.', params: { topic: { type: 'string', description: 'Which topic', enum: ['hours', 'location', 'delivery', 'policy', 'payment'] } }, required: ['topic'] },
      async run(a) {
        const topic = str(a.topic, 20);
        if (topic === 'payment') return { result: { howToPay: 'At checkout the system sends the exact amount and how to pay (bank transfer or a pay link). Payment is confirmed automatically.' } };
        return { result: { answer: (await h.shopInfo(topic)) ?? 'not set by the shop' } };
      },
    },
    {
      spec: { name: 'goToCheckout', description: 'They want to pay / place the order: start checkout (the system sends the summary and payment details). Give deliverTo when they said where (or "saved" for their saved address), or pickup=true.', params: { deliverTo: { type: 'string', description: 'Delivery address/area they gave, or "saved"' }, pickup: { type: 'boolean', description: 'true if they will pick it up' } } },
      async run(a) {
        const c = await h.cart();
        if (!c.lines.length) return { result: { error: 'cart is empty' } };
        const to = str(a.deliverTo, 200);
        const deliverTo = to.toLowerCase() === 'saved' ? h.savedAddress : to || null;
        return { result: { started: true }, takeover: words => (deliverTo || a.pickup === true ? h.checkoutTo(words, { deliverTo, pickup: a.pickup === true }) : h.checkout(words)) };
      },
    },
    {
      spec: { name: 'askOwner', description: 'Pass a question to the shop owner (e.g. bargaining, a custom request). The bot keeps chatting.', params: { question: { type: 'string', description: 'The question for the owner, in one line' } }, required: ['question'] },
      async run(a) { await h.askOwner(str(a.question, 300)); return { result: { sent: true, note: 'The owner will reply in this chat.' } }; },
    },
    {
      spec: { name: 'handToOwner', description: 'Hand the chat to the owner (complaint, refund, wrong/late order, angry customer, anything the tools can\'t do). The bot then stays quiet.', params: { reason: { type: 'string', description: 'Short reason' } }, required: ['reason'] },
      async run(a) { const reason = str(a.reason, 120); return { result: { handedOver: true }, takeover: words => h.handToOwner(words, reason) }; },
    },
  ];
}

