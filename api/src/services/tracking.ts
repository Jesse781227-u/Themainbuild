// Order tracking for customers: a step tracker per open order (Paid → Ready → Out for delivery →
// Delivered, or Paid → Ready for pickup → Picked up), with the time it left the shop, the rider and
// when it should arrive. The owner gives the rider and arrival time in plain words ("Musa
// 0803 123 4567, 1 hour"), when marking an order out for delivery.
import type { Firestore } from '../lib/firestore';
import { formatKobo } from '../lib/money';
import type { Order } from '../domain/commerce';
import { recentOrders } from './orders';

export interface Rider { name: string | null; phone: string | null }
export type Tracked = Order & { rider?: Rider | null; eta?: string | null; readyAt?: string | null; outAt?: string | null; deliveredAt?: string | null };

const hhmm = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : null);
export const prettyPhone = (p: string) => {
  const d = p.replace(/\D/g, '');
  const local = d.startsWith('234') && d.length === 13 ? `0${d.slice(3)}` : d;
  return local.length === 11 ? `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}` : p.trim();
};

// "Musa 0803 123 4567, 1 hour" · "with Tunde, e go reach by 3pm" · "08031234567 30 mins" · "Bolt rider, about 45 minutes".
const PHONE = /(?:\+?234[\s-]?|0)[789][01]\d(?:[\s-]?\d){7}/;
const ETA = /\b(?:(?:in\s+|for\s+)?(?:about\s+|around\s+|roughly\s+)?\d{1,3}(?:\.\d)?\s*(?:mins?|minutes?|hrs?|hours?|h)\b|(?:by|before|around|at)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b|\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|(?:later\s+)?today(?:\s+(?:morning|afternoon|evening))?|tomorrow(?:\s+(?:morning|afternoon|evening))?|this\s+(?:morning|afternoon|evening)|tonight|an?\s+hour|half\s+an?\s+hour)/i;
const FILLER = /\b(?:rider|dispatch(?:er)?|driver|is|na|be|with|by|e\s+go\s+reach|go\s+reach|will\s+(?:arrive|reach|deliver)|arriving|arrive|reach|in|about|around|eta|delivering|taking\s+it|don\s+leave|left|on\s+the\s+way|number|phone|call|the|and|he|she|it|e|go)\b/gi;

export function parseRider(text: string): { rider: Rider | null; eta: string | null } {
  let rest = ` ${text.replace(/\s+/g, ' ').trim()} `;
  const phoneM = PHONE.exec(rest);
  const phone = phoneM ? prettyPhone(phoneM[0]) : null;
  if (phoneM) rest = rest.replace(phoneM[0], ' ');
  const etaM = ETA.exec(rest);
  let eta = etaM ? etaM[0].trim().replace(/^(?:in|for)\s+/i, '').replace(/(\d)\s*(?:mins?|minutes?)\b/i, '$1 minutes').replace(/(\d)\s*(?:hrs?|hours?|h)\b/i, '$1 hours').replace(/(^|\s)1 hours$/i, '$11 hour') : null;
  if (eta && /^\d/.test(eta)) eta = `about ${eta}`;
  if (etaM) rest = rest.replace(etaM[0], ' ');
  const words = rest.replace(FILLER, ' ').replace(/[^\p{L}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  const name = words ? words.split(' ').slice(0, 3).map(w => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 40) : null;
  return { rider: name || phone ? { name: name || null, phone } : null, eta };
}

const STEPS = {
  delivery: [['paid', 'Paid', '✅'], ['ready', 'Ready', '📦'], ['out_for_delivery', 'Out for delivery', '🛵'], ['delivered', 'Delivered', '🎉']],
  pickup: [['paid', 'Paid', '✅'], ['ready', 'Ready for pickup', '📦'], ['picked_up', 'Picked up', '🎉']],
} as const;

export function stepper(o: Tracked): string {
  const steps = o.delivery?.method === 'pickup' ? STEPS.pickup : STEPS.delivery;
  const now = o.fulfilment === 'pending' ? 'paid' : o.fulfilment;
  const at = Math.max(0, steps.findIndex(s => s[0] === now));
  return steps.map(([, label, icon], i) => (i < at ? `✅ ${label}` : i === at ? `${i === 0 ? '✅' : icon} *${label}*` : `⬜ ${label}`)).join('  ');
}

// The details under the steps: when it left, who's bringing it, when it should arrive.
export function trackingDetail(o: Tracked, shopAddress?: string | null): string {
  const pickup = o.delivery?.method === 'pickup';
  if (o.fulfilment === 'delivered' || o.fulfilment === 'picked_up') return `${pickup ? 'Picked up' : 'Delivered'}${o.deliveredAt ? ` at ${hhmm(o.deliveredAt)}` : ''}. Enjoy! 🙏`;
  if (o.fulfilment === 'out_for_delivery') {
    const who = o.rider ? `Rider: ${[o.rider.name, o.rider.phone].filter(Boolean).join(', ')}` : '';
    return [[o.outAt ? `Left the shop at ${hhmm(o.outAt)}` : 'On its way', who].filter(Boolean).join(' · '), o.eta ? `Arriving ${/^(about|around|by|before|at|today|tomorrow|tonight|this|later|half|an?\b)/i.test(o.eta) ? o.eta : `in ${o.eta}`}` : ''].filter(Boolean).join('\n');
  }
  if (o.fulfilment === 'ready') return pickup ? `Ready for you${shopAddress ? ` at ${shopAddress}` : ''}.` : "Packed and ready. I'll tell you as soon as it leaves the shop.";
  return pickup ? "We're getting it ready. I'll tell you when you can pick it up." : "We're getting it ready. I'll tell you when it leaves the shop.";
}

export function trackingCard(o: Tracked, shopAddress?: string | null): string {
  const what = o.items.length === 1 ? `${o.items[0].qty > 1 ? `${o.items[0].qty} × ` : ''}${o.items[0].name}` : `${o.items.length} items`;
  if (o.status === 'awaiting_payment') return `💸 *${o.ref}* · ${what}\nWaiting for payment of ${formatKobo(o.payAmountKobo)}${o.holdExpiresAt ? ` (held till ${hhmm(o.holdExpiresAt)})` : ''}.`;
  if (o.status !== 'paid') return `*${o.ref}* · ${what}\nThis order was ${o.status === 'expired' ? 'not paid in time' : 'cancelled'}.`;
  return `📦 *${o.ref}* · ${what}\n${stepper(o)}\n${trackingDetail(o, shopAddress)}`;
}

// What a customer sees for "where is my order?": every open order (newest first, up to 3), or
// their last order when nothing is open.
export async function customerOrders(db: Firestore, customerId: string, now = new Date()): Promise<Tracked[]> {
  const recent = (await recentOrders(db, [['customerId', '==', customerId]], 10)) as Tracked[];
  const open = recent.filter(o => (o.status === 'paid' && !['delivered', 'picked_up'].includes(o.fulfilment)) || (o.status === 'awaiting_payment' && (!o.holdExpiresAt || new Date(o.holdExpiresAt) > now)));
  return open.length ? open.slice(0, 3) : recent.slice(0, 1);
}
