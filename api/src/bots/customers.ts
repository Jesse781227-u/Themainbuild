// The owner's customer book (CUSTOMERS): who buys, how much, what they like, where they live.
// Everything comes from what Relay already records: the customer (name, number, totals) and their
// orders (items, delivery addresses). Nothing extra is collected from customers.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { formatKobo } from '../lib/money';
import type { Business } from '../domain/business';
import type { Customer, Order } from '../domain/commerce';
import type { OutboundContent } from '../services/channel';
import { recentOrders } from '../services/orders';
import { list } from './common';

export type CustomerSort = 'top' | 'recent' | 'quiet';
const PAGE = 8;
const QUIET_DAYS = 30;
const DAY = 86_400_000;

const isInstagram = (c: Pick<Customer, 'id'>) => c.id.includes('_ig_');
const digits = (s: string) => s.replace(/\D/g, '');

export function prettyPhone(phone: string) {
  const d = digits(phone);
  if (d.startsWith('234') && d.length === 13) return `+234 ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}`;
  return phone.startsWith('+') ? phone : `+${d}`;
}

const contact = (c: Customer) => (isInstagram(c) ? 'Instagram customer' : prettyPhone(c.phone));
const displayName = (c: Customer) => c.name?.trim() || contact(c);

export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return 'never';
  const days = Math.floor((now - new Date(iso).getTime()) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} week${days < 14 ? '' : 's'} ago`;
  return `${Math.floor(days / 30)} months ago`;
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });

async function allCustomers(db: Firestore, businessId: string) {
  return (await db.query(C.customers, [['businessId', '==', businessId]], { limit: 2000 })) as unknown as Customer[];
}

function sorted(customers: Customer[], sort: CustomerSort, now = Date.now()) {
  const buyers = customers.filter(c => (c.orderCount ?? 0) > 0);
  if (sort === 'recent') return buyers.sort((a, b) => String(b.lastOrderAt ?? '').localeCompare(String(a.lastOrderAt ?? '')));
  const bySpend = (a: Customer, b: Customer) => (b.totalSpentKobo ?? 0) - (a.totalSpentKobo ?? 0);
  if (sort === 'quiet') return buyers.filter(c => !c.lastOrderAt || now - new Date(c.lastOrderAt).getTime() > QUIET_DAYS * DAY).sort(bySpend);
  return buyers.sort(bySpend);
}

const row = (c: Customer, now: number) => ({
  id: `cust:${c.id}`,
  title: displayName(c),
  description: `${formatKobo(c.totalSpentKobo ?? 0)} · ${c.orderCount} order${c.orderCount === 1 ? '' : 's'} · last ${ago(c.lastOrderAt, now)}`,
});

const SORT_LABEL: Record<CustomerSort, string> = { top: 'Top spenders', recent: 'Most recent', quiet: `No order in ${QUIET_DAYS}+ days` };

// The list: a summary, then customers you can tap for their full card.
export async function customerList(db: Firestore, business: Pick<Business, 'id' | 'name'>, sort: CustomerSort = 'top', page = 0, now = Date.now()): Promise<OutboundContent | string> {
  const everyone = await allCustomers(db, business.id);
  const buyers = everyone.filter(c => (c.orderCount ?? 0) > 0);
  if (!buyers.length) {
    return everyone.length
      ? `${everyone.length} ${everyone.length === 1 ? 'person has' : 'people have'} chatted with your shop, but nobody has paid for an order yet. Customers appear here after their first order.`
      : 'No customers yet. Once people order from your shop they appear here with what they bought, how much they spent and where they live.';
  }
  const shown = sorted(everyone, sort, now);
  const total = buyers.reduce((s, c) => s + (c.totalSpentKobo ?? 0), 0);
  const quiet = sorted(everyone, 'quiet', now).length;
  const fresh = buyers.filter(c => now - new Date(c.createdAt).getTime() < 7 * DAY).length;
  const lurkers = everyone.length - buyers.length;
  const body = [
    `👥 *Your customers: ${buyers.length}*`,
    `💰 ${formatKobo(total)} spent in total`,
    fresh ? `🆕 ${fresh} new this week` : '',
    quiet ? `😴 ${quiet} haven't ordered in ${QUIET_DAYS}+ days` : '',
    lurkers ? `💬 ${lurkers} more chatted but haven't bought yet` : '',
    '',
    shown.length ? `Showing: ${SORT_LABEL[sort]}. Tap a customer to see everything about them, or send CUSTOMER and a name or number.` : `Nobody in "${SORT_LABEL[sort]}" right now.`,
  ].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n');

  const start = page * PAGE;
  const rows = shown.slice(start, start + PAGE).map(c => row(c, now));
  if (start + PAGE < shown.length) rows.push({ id: `custs:${sort}:${page + 1}`, title: '➡️ More customers', description: `${start + PAGE + 1}–${Math.min(start + 2 * PAGE, shown.length)} of ${shown.length}` });
  const other: CustomerSort[] = (['top', 'recent', 'quiet'] as CustomerSort[]).filter(s => s !== sort);
  for (const s of other) if (rows.length < 10) rows.push({ id: `custs:${s}:0`, title: s === 'top' ? '⭐ Top spenders' : s === 'recent' ? '🕒 Most recent' : '😴 Gone quiet', description: `Sort by ${SORT_LABEL[s].toLowerCase()}` });
  return list(body, 'See customers', rows, SORT_LABEL[sort]);
}

// One customer's card: contact, addresses, money, favourites, last purchases.
export async function customerCard(db: Firestore, business: Pick<Business, 'id'>, customerId: string, now = Date.now()): Promise<OutboundContent | string> {
  const c = (await db.get(db.doc(C.customers, customerId))) as Customer | null;
  if (!c || c.businessId !== business.id) return 'I couldn\'t find that customer. Send CUSTOMERS to see your list.';
  const orders = (await recentOrders(db, [['customerId', '==', c.id]], 50)).filter(o => o.businessId === business.id);
  const paid = orders.filter(o => o.status === 'paid');

  const addresses = [...new Set(orders.map(o => o.delivery?.address?.trim()).filter((a): a is string => !!a))].slice(0, 3);
  const pickups = paid.filter(o => o.delivery?.method === 'pickup' || !o.delivery?.address).length;

  const qty = new Map<string, number>();
  for (const o of paid) for (const l of o.items) qty.set(l.name, (qty.get(l.name) ?? 0) + l.qty);
  const favourites = [...qty.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const spent = c.totalSpentKobo ?? 0;
  const lines = [
    `👤 *${displayName(c)}*`,
    `📞 ${contact(c)}`,
    ...(addresses.length ? addresses.map((a, i) => `📍 ${a}${i === 0 && addresses.length > 1 ? ' (latest)' : ''}`) : [`📍 ${pickups ? 'Always picks up' : 'No delivery address yet'}`]),
    '',
    `💰 Spent *${formatKobo(spent)}* over ${c.orderCount} order${c.orderCount === 1 ? '' : 's'}${c.orderCount > 1 ? ` (about ${formatKobo(Math.round(spent / c.orderCount))} each)` : ''}`,
    `📅 Customer since ${shortDate(c.createdAt)} · last order ${ago(c.lastOrderAt, now)}`,
  ];
  if (favourites.length) lines.push('', `❤️ Favourites: ${favourites.map(([n, q]) => `${n} (${q})`).join(', ')}`);
  if (paid.length) {
    lines.push('', '🛍️ Last purchases:');
    for (const o of paid.slice(0, 3)) {
      const items = o.items.map(l => `${l.qty} × ${l.name}`).join(', ');
      lines.push(`• ${shortDate(o.paidAt ?? o.createdAt)}: ${items}, ${formatKobo(o.payAmountKobo)} (${o.fulfilment.replace(/_/g, ' ')})`);
    }
  }
  const unpaid = orders.filter(o => o.status === 'awaiting_payment');
  if (unpaid.length) lines.push('', `⏳ Unpaid: ${unpaid.map(o => `${o.ref} ${formatKobo(o.payAmountKobo)}`).join(', ')}`);

  let text = lines.join('\n');
  if (text.length > 1000) text = `${text.slice(0, 997)}…`;
  if (isInstagram(c)) return text;
  // A button that opens a chat with them in the owner's own WhatsApp.
  return {
    type: 'interactive',
    interactive: { type: 'cta_url', body: { text }, action: { name: 'cta_url', parameters: { display_text: 'Chat on WhatsApp', url: `https://wa.me/${digits(c.phone)}` } } },
  };
}

// CUSTOMER Kemi / CUSTOMER 0809…: one match opens the card, several give a short list.
export async function findCustomer(db: Firestore, business: Pick<Business, 'id' | 'name'>, query: string, now = Date.now()): Promise<OutboundContent | string> {
  const q = query.trim().toLowerCase();
  const qd = digits(q).replace(/^0/, '');
  const matches = (await allCustomers(db, business.id)).filter(c =>
    (qd.length >= 4 && digits(c.phone).includes(qd)) || (!!c.name && c.name.toLowerCase().includes(q)));
  if (!matches.length) return `No customer matches "${query.trim()}". Send CUSTOMERS to see your list.`;
  if (matches.length === 1) return customerCard(db, business, matches[0].id, now);
  const rows = sorted(matches, 'top', now).concat(matches.filter(c => !(c.orderCount > 0))).slice(0, 10).map(c => row(c, now));
  return list(`${matches.length} customers match "${query.trim()}". Tap one:`, 'See customers', rows, 'Matches');
}

// Taps on the list: a customer (cust:<id>) or another page/sort (custs:<sort>:<page>).
export async function handleCustomerChoice(db: Firestore, business: Pick<Business, 'id' | 'name'>, choiceId: string | null) {
  if (choiceId?.startsWith('cust:')) return customerCard(db, business, choiceId.slice(5));
  const m = choiceId ? /^custs:(top|recent|quiet):(\d{1,3})$/.exec(choiceId) : null;
  if (m) return customerList(db, business, m[1] as CustomerSort, Number(m[2]));
  return null;
}
