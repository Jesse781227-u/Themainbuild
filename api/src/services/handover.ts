// While the owner handles a chat (a customer asked for a person, complained, or wants an order
// changed), the customer is never left with silence and the owner never forgets them:
//   · each new message gets a short "they have your message" note, at most every 10 minutes
//     (with the opening time when the shop is closed); order tracking keeps working;
//   · the owner is reminded at 10 and 30 minutes if they haven't replied;
//   · at 45 minutes with no reply, Relay tells the customer they can keep ordering and tracking,
//     and takes the chat back for new messages. The original request stays with the owner.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import type { Business } from '../domain/business';
import { openNow } from './hours';
import { adminConversationId } from './conversations';

export const ACK_EVERY_MIN = 10;
export const REMIND_AT_MIN = [10, 30] as const;
export const TAKE_BACK_MIN = 45;

export interface HandoverState { handoverAt?: string | null; handoverRequest?: string | null; ownerRepliedAt?: string | null; handoverAckAt?: string | null; handoverReminders?: number | null }

// The note a customer gets while the owner is handling the chat (null: too soon after the last one).
export function handoverAck(business: Pick<Business, 'name' | 'hours'>, conv: HandoverState, pidgin: boolean | undefined, now = new Date()): string | null {
  if (conv.handoverAckAt && now.getTime() - new Date(conv.handoverAckAt).getTime() < ACK_EVERY_MIN * 60_000) return null;
  const open = business.hours ? openNow(business.hours, now) : { open: true };
  if (!open.open) return pidgin
    ? `${business.name} don get your message. Dem go open ${open.next ?? 'soon'} and reply you here.`
    : `${business.name} has your message. They open ${open.next ?? 'soon'} and will reply here.`;
  return pidgin ? `${business.name} don get your message, dem go reply you here.` : `${business.name} has your message and will reply here.`;
}

const outboxDoc = (db: Firestore, id: string, body: Record<string, unknown>) => db.create(db.doc(C.outbox, id), { id, status: 'pending', attempts: 0, createdAt: new Date().toISOString(), ...body });

// Every minute: reminders to owners who haven't replied, and chats taken back after 45 minutes.
// Returns the outbox ids to send.
export async function handoverSweep(db: Firestore, now = new Date()): Promise<string[]> {
  const waiting = (await db.query(C.conversations, [['mode', '==', 'owner']], { limit: 500 })) as unknown as (HandoverState & { _id: string; businessId: string; channel?: string; customerId?: string })[];
  const ids: string[] = [];
  for (const conv of waiting) {
    if (!conv.handoverAt || (conv.ownerRepliedAt && conv.ownerRepliedAt >= conv.handoverAt)) continue;
    const mins = (now.getTime() - new Date(conv.handoverAt).getTime()) / 60_000;
    const sent = conv.handoverReminders ?? 0;
    const due = mins >= TAKE_BACK_MIN ? 'take_back' : REMIND_AT_MIN.filter(m => mins >= m).length > sent ? 'remind' : null;
    if (!due) continue;
    const [business, customer] = (await db.getAll([db.doc(C.businesses, conv.businessId), db.doc(C.customers, conv._id)])) as [Business | null, { name?: string; phone?: string } | null];
    if (!business) continue;
    const who = customer?.name ? `${customer.name}${customer.phone ? ` (${customer.phone})` : ''}` : customer?.phone ?? 'A customer';
    const asked = conv.handoverRequest ? `: "${conv.handoverRequest.slice(0, 160)}"` : '';
    const toOwner = (key: string, text: string) => business.ownerPhone
      ? outboxDoc(db, `${conv._id}_${key}_${conv.handoverAt!.replace(/\D/g, '')}`, { businessId: business.id, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone, conversationId: adminConversationId(business.ownerPhone), kind: `handover_${key}`, text, buttons: [{ id: 'act:menu', title: 'Menu' }] })
      : Promise.resolve(false);
    if (due === 'remind') {
      const n = REMIND_AT_MIN.filter(m => mins >= m).length;
      const last = n >= REMIND_AT_MIN.length;
      const text = `⏰ ${who} has been waiting ${REMIND_AT_MIN[n - 1]} minutes for your reply${asked}. Reply in your WhatsApp Business app.${last ? ` If you haven't replied in ${TAKE_BACK_MIN - REMIND_AT_MIN[n - 1]} minutes, I'll let them keep ordering and tracking with me; their request stays with you.` : ''}`;
      if (await toOwner(`remind${n}`, text)) ids.push(`${conv._id}_remind${n}_${conv.handoverAt.replace(/\D/g, '')}`);
      await db.set(db.doc(C.conversations, conv._id), { handoverReminders: n }, { merge: true });
      continue;
    }
    // 45 minutes, no reply: the customer can carry on with Relay; the request stays the owner's.
    if (customer?.phone && (conv.channel ?? 'whatsapp') === 'whatsapp') {
      const id = `${conv._id}_custback_${conv.handoverAt.replace(/\D/g, '')}`;
      if (await outboxDoc(db, id, { businessId: business.id, audience: 'customer', channel: 'whatsapp', to: customer.phone, conversationId: conv._id, kind: 'handover_takeback', text: `${business.name} hasn't replied yet. Your message is with them, and you can still order or track your order here.`, buttons: [{ id: 'menu', title: 'See the menu' }, { id: 'track', title: 'Track my order' }] })) ids.push(id);
    }
    if (await toOwner('takeback', `I've taken back the chat with ${who} so they can keep ordering and tracking. Their request is still waiting for you${asked}. Reply in your WhatsApp Business app.`)) ids.push(`${conv._id}_takeback_${conv.handoverAt.replace(/\D/g, '')}`);
    await db.set(db.doc(C.conversations, conv._id), { mode: 'bot', takeoverReason: null, handoverTakenBackAt: now.toISOString(), handoverAt: null, handoverReminders: null, handoverAckAt: null }, { merge: true });
  }
  return [...new Set(ids)];
}
