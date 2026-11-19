// Gentle follow-ups to owners, never more than these:
//   - one reminder an hour after the connect link was sent, if it wasn't used (then "Reply CALL")
//   - one "day 2" message: personalise your greeting (if the drafted one was never changed) and add
//     photos to products still on a coloured letter card
// They go through the outbox like everything else, so they're only delivered inside the owner's
// 24-hour window (no approved template for them yet); outside it they're dropped, not forced.
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import type { Business } from '../domain/business';
import type { Product } from '../domain/commerce';
import { adminConversationId } from './conversations';

async function queueOwner(db: Firestore, business: Pick<Business, 'id' | 'ownerPhone'>, kind: string, text: string, at: string) {
  if (!business.ownerPhone) return null;
  const id = `${business.id}_${kind}`;
  const created = await db.create(db.doc(C.outbox, id), { id, businessId: business.id, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone, conversationId: adminConversationId(business.ownerPhone), kind, text, status: 'pending', attempts: 0, createdAt: at });
  return created ? id : null;
}

export async function connectReminders(db: Firestore, cfg: Config, now = new Date()): Promise<string[]> {
  const due = await db.query(C.signupSessions, [['reminderDueAt', '<=', now.toISOString()]], { limit: 50 });
  const ids: string[] = [];
  for (const s of due) {
    await db.update(db.doc(C.signupSessions, s._id), { reminderDueAt: null });
    if (s.usedAt || String(s.expiresAt) <= now.toISOString()) continue;
    const business = (await db.get(db.doc(C.businesses, String(s.businessId)))) as Business | null;
    if (!business || business.status !== 'onboarding') continue;
    const id = await queueOwner(db, business, 'connect_reminder', `${business.name} is all set up and waiting 🙂 One last step: connect your WhatsApp number so customers can start ordering. Your link is still valid:\n${cfg.API_BASE_URL}/connect/${s._id}\n\nWant help? Reply *CALL* and a real person will walk you through it.`, now.toISOString());
    if (id) ids.push(id);
  }
  return ids;
}

export async function dayTwoNudges(db: Firestore, now = new Date()): Promise<string[]> {
  const from = new Date(now.getTime() - 72 * 3600_000).toISOString(), to = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const recent = (await db.query(C.businesses, [['createdAt', '>=', from], ['createdAt', '<=', to]], { limit: 200 })) as unknown as Business[];
  const ids: string[] = [];
  for (const b of recent) {
    if (b.nudgedAt || !['onboarding', 'active'].includes(b.status)) continue;
    await db.update(db.doc(C.businesses, b.id), { nudgedAt: now.toISOString() });
    const products = ((await db.query(C.products, [['businessId', '==', b.id]])) as unknown as Product[]).filter(p => !p.deletedAt && p.available);
    const noPhoto = products.filter(p => !p.images.length).length;
    const tips = [
      !b.messagesEdited ? '✍️ Want to personalise the greeting customers get? Send *MESSAGES* to see it and change it in your own words.' : '',
      noPhoto ? `📷 ${noPhoto} product${noPhoto === 1 ? ' still shows' : 's still show'} a coloured letter card. Photos sell better: send a photo with the product's name as the caption to add one.` : '',
    ].filter(Boolean);
    if (!tips.length) continue;
    const id = await queueOwner(db, b, 'nudge_day2', `Hi${b.ownerName ? ` ${b.ownerName.split(' ')[0]}` : ''} 👋 Two small things that help ${b.name} sell more:\n\n${tips.join('\n\n')}`, now.toISOString());
    if (id) ids.push(id);
  }
  return ids;
}
