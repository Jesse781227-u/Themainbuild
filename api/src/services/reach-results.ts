// Smart Reach results. A reply or a paid order within 48 hours of an update counts for that update;
// if a customer got several, the last one before the reply/order gets it ("last send wins").
// Worked out from the sends log, the customer signals and the orders, so the report always matches
// the sends. Each campaign's report goes to the owner once, 48 hours after it was sent.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import type { Order } from '../domain/commerce';
import type { Business } from '../domain/business';
import { formatKobo } from '../lib/money';
import { recentOrders } from './orders';
import { adminConversationId } from './conversations';
import type { Campaign, Send } from './reach';

export const ATTRIBUTION_MS = 48 * 3_600_000;
const reached = (s: Send) => !!s.sentAt && ['sent', 'delivered', 'read', 'owner_marked_sent'].includes(s.status);

// For one customer: which of their sends a moment in time belongs to (the latest before it, within 48h).
function owner(sends: Send[], at: string) {
  const before = sends.filter(s => reached(s) && s.sentAt! <= at && new Date(at).getTime() - new Date(s.sentAt!).getTime() <= ATTRIBUTION_MS);
  return before.sort((a, b) => b.sentAt!.localeCompare(a.sentAt!))[0] ?? null;
}

export interface CampaignResult { sent: number; replied: number; ordered: number; revenueKobo: number; costKobo: number; perNaira: number | null }

export async function campaignResults(db: Firestore, campaignId: string, opts: { write?: boolean } = {}): Promise<CampaignResult> {
  const mine = ((await db.query(C.sends, [['campaignId', '==', campaignId]], { limit: 2000 })) as unknown as Send[]).filter(reached);
  let replied = 0, ordered = 0, revenueKobo = 0;
  for (const s of mine) {
    // Every send this customer got, from any campaign, to apply "last send wins".
    const all = ((await db.query(C.sends, [['customerId', '==', s.customerId]], { limit: 200 })) as unknown as Send[]).filter(x => x.businessId === s.businessId);
    const replies = ((await db.query(C.customerSignals, [['customerId', '==', s.customerId], ['type', '==', 'replied']], { limit: 200 })) as unknown as { at: string }[]);
    if (replies.some(r => owner(all, r.at)?.id === s.id)) replied++;
    const orders = (await recentOrders(db, [['customerId', '==', s.customerId]], 50)).filter((o: Order) => o.businessId === s.businessId && o.status === 'paid');
    const won = orders.filter(o => owner(all, o.paidAt ?? o.createdAt)?.id === s.id);
    if (won.length) {
      ordered++;
      const revenue = won.reduce((t, o) => t + o.subtotalKobo, 0);
      revenueKobo += revenue;
      if (opts.write) await db.update(db.doc(C.sends, s.id), { attributedOrderId: won[0].id, revenue });
    }
  }
  const costKobo = mine.reduce((t, s) => t + (s.cost ?? 0), 0);
  return { sent: mine.length, replied, ordered, revenueKobo, costKobo, perNaira: costKobo ? Math.round((revenueKobo / costKobo) * 10) / 10 : null };
}

export function resultText(name: string, r: CampaignResult) {
  return `📊 *${name}*: sent ${r.sent} → ${r.replied} replied → ${r.ordered} ordered → ${formatKobo(r.revenueKobo)}. Cost ${formatKobo(r.costKobo)}${r.perNaira !== null ? `, so ₦${r.perNaira} back for every ₦1` : ''}.`;
}

// Campaigns sent more than 48 hours ago and not reported yet → the owner's outbox. Returns the ids.
export async function dueCampaignReports(db: Firestore, now = new Date()) {
  const cutoff = new Date(now.getTime() - ATTRIBUTION_MS).toISOString();
  const due = ((await db.query(C.campaigns, [['status', '==', 'sent']], { limit: 200 })) as unknown as Campaign[]).filter(c => !c.reportedAt && (c.approvedAt ?? c.createdAt) <= cutoff);
  const ids: string[] = [];
  for (const c of due) {
    const r = await campaignResults(db, c.id, { write: true });
    await db.update(db.doc(C.campaigns, c.id), { reportedAt: now.toISOString(), results: r });
    if (!r.sent) continue;
    const business = (await db.get(db.doc(C.businesses, c.businessId))) as Business | null;
    if (!business?.ownerPhone) continue;
    const id = `${c.businessId}_reach_${c.id}`;
    if (await db.create(db.doc(C.outbox, id), { id, businessId: c.businessId, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone, conversationId: adminConversationId(business.ownerPhone), kind: 'reach_report', text: resultText(c.name, r), buttons: [{ id: 'act:reach', title: 'Smart Reach' }, { id: 'act:menu', title: 'Menu' }], status: 'pending', attempts: 0, createdAt: now.toISOString() })) ids.push(id);
  }
  return ids;
}
