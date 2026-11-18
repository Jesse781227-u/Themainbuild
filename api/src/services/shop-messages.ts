// The shop's own words for the moments customers hear from it: welcome, payment thank-you, order
// ready, out for delivery, delivered. Owners approve AI drafts during signup and can change them
// any time (MESSAGES). Each message may use blanks the bot fills in:
//   {customer} first name · {shop} business name · {order} order number · {amount} amount paid
// These are free-form messages, so they're only sent inside the 24-hour window; outside it the
// approved Meta template (fixed wording) is used where one exists.
import type { Business } from '../domain/business';

export const MESSAGE_KEYS = ['welcome', 'paymentThanks', 'orderReady', 'outForDelivery', 'delivered'] as const;
export type MessageKey = typeof MESSAGE_KEYS[number];

export const MESSAGE_INFO: Record<MessageKey, { label: string; when: string; blanks: string[] }> = {
  welcome: { label: 'Welcome', when: 'when a new customer says hi', blanks: ['customer', 'shop'] },
  paymentThanks: { label: 'Payment thank-you', when: 'when a customer pays (their receipt)', blanks: ['customer', 'shop', 'order', 'amount'] },
  orderReady: { label: 'Order ready', when: 'when you mark an order ready for pickup', blanks: ['customer', 'shop', 'order'] },
  outForDelivery: { label: 'Out for delivery', when: 'when you mark an order out for delivery', blanks: ['customer', 'shop', 'order'] },
  delivered: { label: 'Delivered / thank you', when: 'when an order is delivered or picked up', blanks: ['customer', 'shop', 'order'] },
};

export const DEFAULT_MESSAGES: Record<MessageKey, string> = {
  welcome: 'Hi {customer}, welcome to {shop} 👋',
  paymentThanks: 'Payment received for order {order}: {amount}. Thank you, {customer}! We\'ll keep you posted.',
  orderReady: 'Good news {customer}! Your order {order} is ready for pickup at {shop}.',
  outForDelivery: 'Your order {order} is on its way, {customer} 🚚',
  delivered: 'Thank you for shopping with {shop}, {customer}! We hope you love it. 💛',
};

export type ShopMessages = Partial<Record<MessageKey, string>>;

const MAX = 500;

// Keeps only blanks this message supports, so an owner's typo can't leave "{oder}" in a customer's chat.
export function cleanMessage(key: MessageKey, text: string): string {
  const allowed = new Set(MESSAGE_INFO[key].blanks);
  return text.trim().slice(0, MAX).replace(/\{(\w+)\}/g, (m, name: string) => (allowed.has(name) ? m : '')).replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '').trim();
}

export function renderMessage(business: Pick<Business, 'name'> & { messages?: ShopMessages | null }, key: MessageKey, vars: { customer?: string | null; order?: string; amount?: string }) {
  const template = business.messages?.[key] || DEFAULT_MESSAGES[key];
  const first = vars.customer?.trim().split(/\s+/)[0] ?? '';
  return template
    .replace(/\{customer\}/g, first)
    .replace(/\{shop\}/g, business.name)
    .replace(/\{order\}/g, vars.order ?? '')
    .replace(/\{amount\}/g, vars.amount ?? '')
    // A missing first name leaves "Hi , welcome" or "Thank you, !": tidy the gap.
    .replace(/\s+([,!.])/g, '$1').replace(/,\s*([!.])/g, '$1').replace(/ {2,}/g, ' ')
    .trim();
}

// The prompt the AI drafts all five from, in the shop's voice. It must keep the blanks as written.
export function draftPrompt(business: Pick<Business, 'name' | 'category' | 'city' | 'area'> & { ownerName?: string | null }, typeLabel: string, only?: MessageKey) {
  const keys = only ? [only] : MESSAGE_KEYS;
  return [
    `Write short WhatsApp messages for a small ${typeLabel.toLowerCase()} business in Nigeria called "${business.name}"${business.area || business.city ? ` (${[business.area, business.city].filter(Boolean).join(', ')})` : ''}.`,
    'Warm, friendly and professional, like a good Nigerian small business owner would write. Plain English (a light local touch is fine). At most one or two emojis. Each under 240 characters.',
    'Use these blanks exactly as written where they fit; the bot fills them in: {customer} = the customer\'s first name, {shop} = the business name, {order} = the order number, {amount} = the amount paid.',
    'Never invent facts (no prices, discounts, delivery times, addresses, phone numbers or opening hours).',
    'Messages to write:',
    ...keys.map(k => `- ${k}: sent ${MESSAGE_INFO[k].when}. Blanks you may use: ${MESSAGE_INFO[k].blanks.map(b => `{${b}}`).join(', ')}.`),
    only ? 'Write a fresh version, different from the usual wording.' : '',
  ].filter(Boolean).join('\n');
}
