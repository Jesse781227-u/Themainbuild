// The shop's own words for the moments customers hear from it. Owners pick from three samples
// written for their shop (warm · short · Naija), write their own, or keep the default (MESSAGES, and
// an optional step during signup). Each message may use blanks the bot fills in:
//   {customer_name} first name · {shop} shop name · {order_id} order number · {total} amount
//   {item} what was added ("2 × Zobo") · {opens} when the shop opens again
// Older messages wrote {customer}, {order} and {amount}: they still work.
// These are free-form messages, so they're only sent inside the 24-hour window; outside it the
// approved Meta template (fixed wording) is used where one exists.
import type { Business, BusinessCategory } from '../domain/business';

export const MESSAGE_KEYS = ['welcome', 'welcomeBack', 'menuIntro', 'addedToCart', 'orderConfirmed', 'paymentThanks', 'closed', 'orderReady', 'outForDelivery', 'delivered'] as const;
export type MessageKey = typeof MESSAGE_KEYS[number];

export const MESSAGE_INFO: Record<MessageKey, { label: string; when: string; blanks: string[] }> = {
  welcome: { label: 'Welcome', when: 'the first reply to a new customer', blanks: ['customer_name', 'shop'] },
  welcomeBack: { label: 'Welcome back', when: 'when a returning customer says hi', blanks: ['customer_name', 'shop'] },
  menuIntro: { label: 'Showing what you sell', when: 'above your products when a customer asks to see them', blanks: ['customer_name', 'shop'] },
  addedToCart: { label: 'Added to cart', when: 'when a customer adds something to their cart', blanks: ['customer_name', 'item', 'shop'] },
  orderConfirmed: { label: 'Order confirmed', when: 'with the payment button, after a customer confirms an order', blanks: ['customer_name', 'order_id', 'total', 'shop'] },
  paymentThanks: { label: 'Thank you after payment', when: 'with the receipt, when a customer pays', blanks: ['customer_name', 'order_id', 'total', 'shop'] },
  closed: { label: "We're closed", when: 'when a customer messages outside your opening hours', blanks: ['customer_name', 'opens', 'shop'] },
  orderReady: { label: 'Order ready', when: 'when you mark an order ready for pickup', blanks: ['customer_name', 'order_id', 'shop'] },
  outForDelivery: { label: 'Out for delivery', when: 'when you mark an order out for delivery', blanks: ['customer_name', 'order_id', 'shop'] },
  delivered: { label: 'Delivered / thank you', when: 'when an order is delivered or picked up', blanks: ['customer_name', 'order_id', 'shop'] },
};

// The three asked during signup (the ones customers see most); the rest keep the default until changed.
export const SIGNUP_MESSAGES: MessageKey[] = ['welcome', 'paymentThanks', 'menuIntro'];

export const DEFAULT_MESSAGES: Record<MessageKey, string> = {
  welcome: 'Hi {customer_name}! 👋 Welcome to *{shop}*. How can we help you today?',
  welcomeBack: 'Welcome back, {customer_name}! 👋 Good to see you again at *{shop}*.',
  menuIntro: "Here's what we have 👇",
  addedToCart: 'Added {item} to your cart 🛒',
  orderConfirmed: 'Thank you, {customer_name}! Your order is confirmed.',
  paymentThanks: "Payment received for order {order_id}: {total}. Thank you, {customer_name}! We'll keep you posted.",
  closed: "🌙 We're closed right now. We open again {opens}.",
  orderReady: 'Good news {customer_name}! Your order {order_id} is ready for pickup at {shop}.',
  outForDelivery: 'Your order {order_id} is on its way, {customer_name} 🚚',
  delivered: 'Thank you for shopping with {shop}, {customer_name}! We hope you love it. 💛',
};

export type ShopMessages = Partial<Record<MessageKey, string>>;

const MAX = 300;
// Old blank names → the ones shown to owners now.
const ALIAS: Record<string, string> = { customer: 'customer_name', name: 'customer_name', order: 'order_id', amount: 'total', shop_name: 'shop' };
const canon = (name: string) => ALIAS[name.toLowerCase()] ?? name.toLowerCase();

// An owner's own wording: what's wrong with it, or null when it's fine.
export function checkMessage(key: MessageKey, text: string): string | null {
  const t = text.trim();
  if (t.length < 2) return 'Please type the message you want customers to get.';
  if (t.length > MAX) return `That's ${t.length} characters. Please keep it under ${MAX} so it reads well on a phone.`;
  const allowed = MESSAGE_INFO[key].blanks;
  const bad = [...t.matchAll(/\{([^{}]*)\}/g)].map(m => m[1]).filter(b => !allowed.includes(canon(b)));
  if (bad.length) return `I don't know {${bad[0]}}. In this message you can use ${allowed.map(b => `{${b}}`).join(', ')}. Please check the spelling and send it again.`;
  if (/[{}]/.test(t.replace(/\{[^{}]*\}/g, ''))) return 'A { or } is missing its partner. Blanks look like {customer_name}. Please send it again.';
  return null;
}

// Keeps only blanks this message supports, so a stray "{oder}" never reaches a customer's chat.
export function cleanMessage(key: MessageKey, text: string): string {
  const allowed = new Set(MESSAGE_INFO[key].blanks);
  return text.trim().slice(0, MAX).replace(/\{(\w+)\}/g, (_m, name: string) => (allowed.has(canon(name)) ? `{${canon(name)}}` : '')).replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '').trim();
}

export type MessageVars = { customer?: string | null; order?: string; amount?: string; item?: string; opens?: string };

export function renderMessage(business: Pick<Business, 'name'> & { messages?: ShopMessages | null }, key: MessageKey, vars: MessageVars) {
  return fill(business.messages?.[key] || DEFAULT_MESSAGES[key], business.name, vars);
}

export function fill(template: string, shop: string, vars: MessageVars) {
  const first = vars.customer?.trim().split(/\s+/)[0] ?? '';
  const values: Record<string, string> = { customer_name: first, shop, order_id: vars.order ?? '', total: vars.amount ?? '', item: vars.item ?? '', opens: vars.opens ?? 'soon' };
  return template
    .replace(/\{(\w+)\}/g, (m, name: string) => values[canon(name)] ?? m)
    // A missing first name leaves "Hi , welcome" or "Thank you, !": tidy the gap.
    .replace(/\s+([,!.])/g, '$1').replace(/,\s*([!.])/g, '$1').replace(/^[,\s]+/, '').replace(/ {2,}/g, ' ')
    .trim();
}

export const SAMPLE_VARS: MessageVars = { customer: 'Ada', order: 'RLY-7KQ2M', amount: '₦12,500', item: '2 × Zobo', opens: 'at 8am' };

// ── Three samples per message, written for this shop ──
export const TONES = [
  { id: 'warm', label: 'warm and chatty' },
  { id: 'short', label: 'short and professional' },
  { id: 'naija', label: 'playful, with a light Naija touch' },
] as const;

// Without the AI: one of each tone for each message, using the shop's name and the right words for
// what it sells.
export function fallbackSamples(key: MessageKey, b: Pick<Business, 'name'> & { category?: BusinessCategory | null }): [string, string, string] {
  const food = b.category === 'food_beverage';
  const goods = food ? 'menu' : 'collection';
  const n = b.name;
  const s: Record<MessageKey, [string, string, string]> = {
    welcome: [
      `Hi {customer_name}! 👋 Welcome to *${n}*. We're so glad you're here. What can we get for you today?`,
      `Welcome to *${n}*. How can we help you today?`,
      `Hello {customer_name}! Welcome to *${n}* 🙌 Wetin we fit do for you today?`,
    ],
    welcomeBack: [
      `Welcome back, {customer_name}! 💛 It's lovely to see you again at *${n}*. What would you like today?`,
      `Welcome back to *${n}*, {customer_name}. How can we help?`,
      `{customer_name}! You don come back 🎉 Welcome back to *${n}*. Wetin we go get you today?`,
    ],
    menuIntro: [
      `Here's our ${goods}, made with love 💛 Have a look and tap anything you like 👇`,
      `Here's what we have 👇`,
      `See wetin we get for you 😋 Take your pick 👇`,
    ],
    addedToCart: [
      `Lovely choice! 😍 {item} is in your cart.`,
      `Added {item} to your cart.`,
      `Correct choice! {item} don enter your cart 🛒`,
    ],
    orderConfirmed: [
      `Thank you so much, {customer_name}! 🙏 Your order {order_id} is confirmed. Total: {total}.`,
      `Order {order_id} confirmed. Total: {total}.`,
      `Order {order_id} don set, {customer_name} 🙌 Total na {total}.`,
    ],
    paymentThanks: [
      `Thank you, {customer_name}! 💛 We've received your payment of {total} for order {order_id}. Your receipt is attached, and we'll keep you posted.`,
      `Payment of {total} received for order {order_id}. Receipt attached. Thank you.`,
      `We don receive your {total}, {customer_name}! 🙌 Order {order_id} dey ready to roll. Your receipt dey here. Thank you!`,
    ],
    closed: [
      `Hi {customer_name}! We're closed right now 🌙 We open again {opens}, and we'd love to help you then.`,
      `We're closed right now. We open again {opens}.`,
      `We don close for today o 🌙 We go open again {opens}.`,
    ],
    orderReady: [
      `Good news, {customer_name}! 🎉 Your order {order_id} is ready for pickup at ${n}. See you soon!`,
      `Order {order_id} is ready for pickup.`,
      `{customer_name}, your order {order_id} don ready! 🎉 Come pick am up at ${n}.`,
    ],
    outForDelivery: [
      `Your order {order_id} is on its way to you, {customer_name}! 🚚 It won't be long now.`,
      `Order {order_id} is out for delivery.`,
      `Your order {order_id} don dey road, {customer_name} 🚚 E go reach you soon!`,
    ],
    delivered: [
      `Thank you for shopping with ${n}, {customer_name}! 💛 We hope you love it. Come back soon!`,
      `Order {order_id} delivered. Thank you for shopping with ${n}.`,
      `Thank you well well, {customer_name}! 🙏 Enjoy am, and come back soon to ${n}.`,
    ],
  };
  return s[key];
}

// The prompt for the AI's three samples of one message, in this shop's voice.
export function samplesPrompt(business: Pick<Business, 'name' | 'city' | 'area'>, typeLabel: string, key: MessageKey) {
  const info = MESSAGE_INFO[key];
  return [
    `Write three short WhatsApp messages for a small ${typeLabel.toLowerCase()} business in Nigeria called "${business.name}"${business.area || business.city ? ` (${[business.area, business.city].filter(Boolean).join(', ')})` : ''}.`,
    `The message is sent ${info.when}.`,
    `Write it three ways: "warm" (warm and chatty), "short" (short and professional), "naija" (playful, with a light touch of Nigerian Pidgin; never forced or hard to read).`,
    `Use the shop's name. Use these blanks exactly as written where they fit, the bot fills them in: ${info.blanks.map(b => `{${b}}`).join(', ')}. No other blanks.`,
    'At most one or two emojis each. Each under 250 characters. Never invent facts (no prices, discounts, delivery times, addresses, phone numbers or opening hours).',
  ].join('\n');
}
