// "Delete my data", as promised on the Data Deletion page (public/data-deletion.html).
// Profiles, conversations, carts and connected-account tokens are deleted; orders, payments and the
// ledger are kept for accounting but no longer link to a phone number (the customer record that held
// it is gone). Each request gets a reference code; the request record holds no personal data.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { randomId } from '../lib/crypto';

export const deletionCode = () => 'DEL-' + randomId(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X');

async function scrubInboundEvents(db: Firestore, from: string) {
  const events = await db.query(C.inboundEvents, [['from', '==', from]], { limit: 500 });
  if (!events.length) return;
  const batch = db.batch();
  for (const e of events) batch.update(db.doc(C.inboundEvents, e._id), { from: null, text: null, message: null, contactName: null });
  await batch.commit();
}

export async function deleteShopperData(db: Firestore, args: { businessId: string; conversationId: string; customerKey: string }, ref = deletionCode()) {
  const batch = db.batch();
  batch.delete(db.doc(C.customers, args.conversationId));
  batch.delete(db.doc(C.conversations, args.conversationId));
  batch.delete(db.doc(C.carts, args.conversationId));
  batch.set(db.doc(C.deletionRequests, ref), { id: ref, kind: 'shopper', businessId: args.businessId, status: 'done', at: new Date().toISOString() });
  await batch.commit();
  await scrubInboundEvents(db, args.customerKey);
  return ref;
}

export async function deleteOwnerData(db: Firestore, businessId: string, ownerPhone: string, ref = deletionCode()) {
  const accounts = await db.query(C.channelAccounts, [['businessId', '==', businessId]]);
  const batch = db.batch();
  for (const a of accounts) batch.delete(db.doc(C.channelAccounts, a._id));
  batch.delete(db.doc(C.whatsappConnections, businessId));
  batch.delete(db.doc(C.instagramConnections, businessId));
  batch.delete(db.doc(C.ownerPhones, ownerPhone));
  // The admin conversation itself is deleted by the Admin Bot after it sends the confirmation.
  batch.update(db.doc(C.businesses, businessId), { status: 'deleted', ownerPhone: null, paymentDetails: null, deletedAt: new Date().toISOString() });
  batch.set(db.doc(C.deletionRequests, ref), { id: ref, kind: 'owner', businessId, status: 'done', at: new Date().toISOString() });
  await batch.commit();
  await scrubInboundEvents(db, ownerPhone);
  return ref;
}
