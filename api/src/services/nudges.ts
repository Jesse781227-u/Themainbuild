// Gentle follow-ups to owners, never more than these:
//   - one reminder an hour after the connect link was sent, if it wasn't used (then "Reply CALL")
//   - after go-live, one at a time and each once only (afterLiveNudges):
//       ~1 min      the shop's WhatsApp picture, if it has none [Skip]                    (PICTURE)
//       day 1–2     add the contacts already on the number? [Yes, add them] [No]          (CONTACTS)
//       first sale / day 2  photos for the best sellers, if some have none               (PHOTOS)
//       day 3–5     how did you hear about Relay? [A friend] [Instagram] [Other]
// They go through the outbox like everything else, so they're only delivered inside the owner's
// 24-hour window (no approved template for them yet); outside it they're dropped, not forced.
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import type { Business } from '../domain/business';
import type { Product } from '../domain/commerce';
import type { OutboundContent } from './channel';
import { adminConversationId } from './conversations';
import { buttons } from '../bots/common';

async function queueOwner(db: Firestore, business: Pick<Business, 'id' | 'ownerPhone'>, kind: string, text: string, at: string, content?: OutboundContent) {
  if (!business.ownerPhone) return null;
  const id = `${business.id}_${kind}`;
  const created = await db.create(db.doc(C.outbox, id), { id, businessId: business.id, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone, conversationId: adminConversationId(business.ownerPhone), kind, text, ...(content ? { content } : {}), status: 'pending', attempts: 0, createdAt: at });
  return created ? id : null;
}

// The follow-up questions, also used by their commands (PICTURE, CONTACTS).
export const PICTURE_ASK = () => buttons("Send a logo or a nice photo of your shop and I'll make it your WhatsApp picture.", [['lp:skip', 'Skip']]);
export const CONTACTS_ASK = () => buttons('WhatsApp can share the contacts already on your number. Add them to your customer list? Only you see them.', [['lc:yes', 'Yes, add them'], ['lc:no', 'No']]);
export const PHOTOS_TIP = 'Want photos on your best sellers? Send a photo with the product name as the caption, e.g. *Green Goddess*.';
export const SOURCE_ASK = () => buttons('Quick one: how did you hear about Relay?', [['src:friend', 'A friend'], ['src:instagram', 'Instagram'], ['src:other', 'Other']]);

type Nudge = 'picture' | 'contacts' | 'photos' | 'source';
const MIN = 60_000, HOUR = 3_600_000, DAY = 24 * HOUR;

// Every minute: at most one nudge per shop per run, at least ~20 hours apart (the picture comes first).
export async function afterLiveNudges(db: Firestore, now = new Date()): Promise<string[]> {
  const shops = (await db.query(C.businesses, [['wentLiveAt', '>=', new Date(now.getTime() - 6 * DAY).toISOString()]], { limit: 300 })) as unknown as Business[];
  const ids: string[] = [];
  for (const b of shops) {
    if (b.status !== 'active' || !b.ownerPhone || !b.wentLiveAt) continue;
    const age = now.getTime() - new Date(b.wentLiveAt).getTime();
    const sent = b.nudges ?? {};
    if (sent.last && now.getTime() - new Date(sent.last).getTime() < 20 * HOUR) continue;
    let pick: { kind: Nudge; content?: OutboundContent; text: string; step?: 'live_photo' | 'live_contacts' | 'live_source' } | null = null;
    if (!sent.picture && !b.profilePhotoUrl && age >= MIN && age < DAY) pick = { kind: 'picture', content: PICTURE_ASK(), text: 'Your WhatsApp picture', step: 'live_photo' };
    else if (!sent.contacts && age >= DAY && age < 3 * DAY) pick = { kind: 'contacts', content: CONTACTS_ASK(), text: 'Add your contacts?', step: 'live_contacts' };
    else if (!sent.photos && (b.firstSaleAt || age >= 2 * DAY) && age < 5 * DAY) {
      const products = ((await db.query(C.products, [['businessId', '==', b.id]])) as unknown as Product[]).filter(p => !p.deletedAt && p.available);
      if (products.some(p => !p.images.length)) pick = { kind: 'photos', text: PHOTOS_TIP };
      else { await db.update(db.doc(C.businesses, b.id), { nudges: { ...sent, photos: now.toISOString() } }); continue; }
    } else if (!sent.source && !b.acquisitionSource && age >= 3 * DAY && age < 6 * DAY) pick = { kind: 'source', content: SOURCE_ASK(), text: 'How did you hear about Relay?', step: 'live_source' };
    if (!pick) continue;
    const at = now.toISOString();
    await db.update(db.doc(C.businesses, b.id), { nudges: { ...sent, [pick.kind]: at, last: at } });
    const id = await queueOwner(db, b, `nudge_${pick.kind}`, pick.text, at, pick.content);
    // The answer (a photo, a tap) is read by the live step; anything else goes to the Admin Bot.
    if (pick.step) await db.set(db.doc(C.conversations, adminConversationId(b.ownerPhone)), { onboarding: { stage: 'live', step: pick.step, businessId: b.id, welcomed: true, nameSet: true, lastSeenAt: at } }, { merge: true });
    if (id) ids.push(id);
  }
  return ids;
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

