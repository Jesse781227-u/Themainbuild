// The 20:00 Africa/Lagos daily summary for each owner, sent by the Admin Bot. It reads the day's
// stats written by the on-paid pipeline (keyed by the Lagos date the payment landed on), so "today"
// is always the Lagos day. Each business gets at most one summary per Lagos date.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { formatKobo } from '../lib/money';
import { lagosDate } from '../lib/time';
import type { Business } from '../domain/business';
import type { Product } from '../domain/commerce';
import { tracksStock } from '../domain/commerce';
import { adminConversationId } from './conversations';
import { recentOrders } from './orders';

export interface DailySummary { date: string; ordersPaid: number; salesKobo: number; deliveryKobo: number; unpaid: number; lowStock: string[] }

export async function buildSummary(db: Firestore, businessId: string, now = new Date()): Promise<DailySummary> {
  const date = lagosDate(now);
  const day = await db.get(db.doc(C.dailyStats, `${businessId}_${date}`));
  const unpaid = await recentOrders(db, [['businessId', '==', businessId], ['status', '==', 'awaiting_payment']], 100);
  const products = (await db.query(C.products, [['businessId', '==', businessId]])) as unknown as Product[];
  const lowStock = products.filter(p => !p.deletedAt && p.available && tracksStock(p) && p.stock <= p.lowStockThreshold).sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0)).map(p => `${p.name} (${p.stock})`);
  return { date, ordersPaid: Number(day?.ordersPaid ?? 0), salesKobo: Number(day?.salesKobo ?? 0), deliveryKobo: Number(day?.deliveryKobo ?? 0), unpaid: unpaid.length, lowStock };
}

const prettyDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export function summaryText(name: string, s: DailySummary) {
  return [
    `📊 ${name}, ${prettyDate(s.date)}`,
    `Paid orders: ${s.ordersPaid}`,
    `Sales: ${formatKobo(s.salesKobo)}${s.deliveryKobo ? ` (+ ${formatKobo(s.deliveryKobo)} delivery)` : ''}`,
    `Awaiting payment: ${s.unpaid}`,
    `Low stock: ${s.lowStock.length ? s.lowStock.slice(0, 8).join(', ') : 'none'}`,
    'Send ORDERS or PRODUCTS for details.',
  ].join('\n');
}

// Queues one summary per business with an owner. Returns the outbox ids to enqueue.
export async function queueDailySummaries(db: Firestore, now = new Date()) {
  // TODO(jesse): page through businesses once there are more than a few hundred.
  const businesses = (await db.query(C.businesses, [['status', '==', 'active']], { limit: 500 })) as unknown as Business[];
  const ids: string[] = [];
  for (const b of businesses) {
    if (!b.ownerPhone) continue;
    const s = await buildSummary(db, b.id, now);
    const id = `${b.id}_summary_${s.date}`;
    const created = await db.create(db.doc(C.outbox, id), {
      id, businessId: b.id, audience: 'owner', channel: 'whatsapp', to: b.ownerPhone, conversationId: adminConversationId(b.ownerPhone),
      kind: 'daily_summary', text: summaryText(b.name, s), status: 'pending', attempts: 0, createdAt: now.toISOString(),
      // Template body (Y11): {{1}} business, {{2}} date, {{3}} paid orders, {{4}} sales, {{5}} awaiting payment, {{6}} low stock.
      template: { key: 'daily_summary', params: [b.name, prettyDate(s.date), String(s.ordersPaid), formatKobo(s.salesKobo), String(s.unpaid), s.lowStock.slice(0, 5).join(', ') || 'none'] },
    });
    if (created) ids.push(id);
  }
  return ids;
}
