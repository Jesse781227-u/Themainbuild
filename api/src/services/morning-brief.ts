// The 7am Africa/Lagos morning brief for each live shop: what to deliver today, who still owes
// (orders waiting for payment), and what is running low or sold out. Short, with Orders and
// Sold out / restock one tap away. Nothing to say → no message. At most one per shop per Lagos day.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { formatKobo } from '../lib/money';
import { lagosDate } from '../lib/time';
import type { Business } from '../domain/business';
import { hasStock, tracksStock, type Order } from '../domain/commerce';
import { adminConversationId } from './conversations';
import { listProducts } from './catalog';
import { recentOrders } from './orders';
import { activeShops } from './active-shops';

export interface Brief { toDeliver: Order[]; owes: Order[]; low: string[]; soldOut: string[] }

export async function buildBrief(db: Firestore, businessId: string): Promise<Brief> {
  const [orders, products] = await Promise.all([recentOrders(db, [['businessId', '==', businessId]], 200), listProducts(db, businessId)]);
  const live = products.filter(p => p.available && !p.deletedAt);
  return {
    toDeliver: orders.filter(o => o.status === 'paid' && !['delivered', 'picked_up'].includes(o.fulfilment)).reverse(), // oldest first
    owes: orders.filter(o => o.status === 'awaiting_payment'),
    low: live.filter(p => tracksStock(p) && hasStock(p) && p.stock !== null && p.stock <= p.lowStockThreshold).map(p => `${p.name} (${p.stock})`),
    soldOut: live.filter(p => !hasStock(p)).map(p => p.name),
  };
}

const list = (items: string[], max = 4) => `${items.slice(0, max).join(', ')}${items.length > max ? ` and ${items.length - max} more` : ''}`;

export function briefText(business: Pick<Business, 'name' | 'ownerName'>, b: Brief): string | null {
  if (!b.toDeliver.length && !b.owes.length && !b.low.length && !b.soldOut.length) return null;
  const first = business.ownerName?.split(' ')[0];
  const owed = b.owes.reduce((t, o) => t + o.payAmountKobo, 0);
  return [
    `☀️ Good morning${first ? ` ${first}` : ''}! *${business.name}* today:`,
    b.toDeliver.length ? `🚚 To deliver (${b.toDeliver.length}): ${list(b.toDeliver.map(o => o.ref))}` : '',
    b.owes.length ? `💸 Waiting for payment (${b.owes.length}): ${formatKobo(owed)} in all` : '',
    b.low.length ? `📦 Running low: ${list(b.low)}` : '',
    b.soldOut.length ? `⛔ Sold out: ${list(b.soldOut)}` : '',
  ].filter(Boolean).join('\n');
}

// Every live shop's brief into the outbox (deduplicated per Lagos day). Returns the outbox ids.
export async function queueMorningBriefs(db: Firestore, now = new Date()) {
  const date = lagosDate(now);
  const ids: string[] = [];
  for await (const business of activeShops(db)) {
    if (!business.ownerPhone) continue;
    const text = briefText(business, await buildBrief(db, business.id));
    if (!text) continue;
    const id = `${business.id}_brief_${date}`;
    const created = await db.create(db.doc(C.outbox, id), {
      id, businessId: business.id, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone, conversationId: adminConversationId(business.ownerPhone),
      kind: 'morning_brief', text, buttons: [{ id: 'act:orders', title: 'Orders' }, { id: 'act:soldout', title: 'Sold out / restock' }, { id: 'act:menu', title: 'Menu' }],
      status: 'pending', attempts: 0, createdAt: now.toISOString(),
    });
    if (created) ids.push(id);
  }
  return ids;
}
