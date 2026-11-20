import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import type { Channel, Conversation } from '../domain/commerce';

// Events can be processed out of order; the window is measured from the newest inbound message.
const latest = (a: unknown, b: string) => (typeof a === 'string' && a > b ? a : b);
const digits = (s: string) => s.replace(/[^A-Za-z0-9]/g, '');

// One conversation per (business, channel, customer). The customer key is the E.164 phone for
// WhatsApp and the Instagram-scoped user id for Instagram.
export const customerId = (businessId: string, channel: Channel, customerKey: string) => `${businessId}_${channel === 'whatsapp' ? 'wa' : 'ig'}_${digits(customerKey)}`;
export const customerConversationId = customerId;
// The owner's chat with the Relay Admin Bot, keyed by their number (they may not have a business yet).
export const adminConversationId = (ownerPhone: string) => `admin_${digits(ownerPhone)}`;

// Called for every inbound message before any handler runs: keeps the 24-hour window and the
// customer record current.
export async function recordCustomerInbound(db: Firestore, args: { businessId: string; channel: Channel; customerKey: string; phone?: string | null; name?: string | null; at: string; fromAd?: boolean; text?: string | null; messageId?: string | null }) {
  const id = customerConversationId(args.businessId, args.channel, args.customerKey);
  await db.runTransaction(async tx => {
    const [conv, customer] = await tx.getAll([db.doc(C.conversations, id), db.doc(C.customers, id)]);
    const lastInboundAt = latest(conv?.lastInboundAt, args.at);
    // Merge writes never touch counters, opt-in or takeover mode; those get defaults only when new.
    // lastAsk: their latest words, so an answer the owner sends from their own app can be learnt from.
    tx.set(db.doc(C.conversations, id), { id, businessId: args.businessId, channel: args.channel, customerId: id, lastInboundAt, updatedAt: args.at, ...(args.text?.trim() ? { lastAsk: { t: args.text.trim().slice(0, 400), at: args.at, id: args.messageId ?? args.at } } : {}), ...(conv ? {} : { mode: 'bot' }) }, { merge: true });
    tx.set(db.doc(C.customers, id), {
      id, businessId: args.businessId, channel: args.channel, ...(args.phone ? { phone: args.phone } : {}), ...(args.name ? { name: args.name } : {}),
      lastInboundAt, updatedAt: args.at,
      // Came from a click-to-WhatsApp ad: a free 72-hour window opens (Smart Reach uses it).
      ...(args.fromAd ? { adReferralAt: args.at } : {}),
      ...(customer ? {} : { marketingOptIn: false, orderCount: 0, totalSpentKobo: 0, createdAt: args.at }),
    }, { merge: true });
  });
  return id;
}

export async function recordAdminInbound(db: Firestore, args: { ownerPhone: string; businessId: string | null; at: string }) {
  const id = adminConversationId(args.ownerPhone);
  await db.runTransaction(async tx => {
    const conv = await tx.get(db.doc(C.conversations, id));
    tx.set(db.doc(C.conversations, id), { id, businessId: args.businessId, channel: 'whatsapp', customerId: null, kind: 'admin', lastInboundAt: latest(conv?.lastInboundAt, args.at), updatedAt: args.at }, { merge: true });
  });
  return id;
}

export async function getConversation(db: Firestore, id: string) {
  return (await db.get(db.doc(C.conversations, id))) as (Conversation & { kind?: string }) | null;
}
