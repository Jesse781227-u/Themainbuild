import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import { encrypt } from '../lib/crypto';

// A merchant's own WhatsApp Business number, connected through Embedded Signup (Phase 3 wires the
// signup flow). The access token is stored encrypted; channelAccounts maps the number back to the
// business so inbound webhooks can be routed.
export async function saveWhatsAppConnection(db: Firestore, cfg: Config, v: { businessId: string; wabaId: string; phoneNumberId: string; accessToken: string }) {
  const at = new Date().toISOString();
  const batch = db.batch();
  batch.set(db.doc(C.whatsappConnections, v.businessId), { businessId: v.businessId, wabaId: v.wabaId, phoneNumberId: v.phoneNumberId, accessTokenEncrypted: encrypt(v.accessToken, cfg), status: 'connected', updatedAt: at });
  batch.set(db.doc(C.channelAccounts, `whatsapp_${v.phoneNumberId}`), { id: `whatsapp_${v.phoneNumberId}`, businessId: v.businessId, channel: 'whatsapp', accountId: v.phoneNumberId });
  await batch.commit();
}

export async function getWhatsAppConnection(db: Firestore, businessId: string) {
  const d = await db.get(db.doc(C.whatsappConnections, businessId));
  if (!d) return null;
  return { businessId, wabaId: d.wabaId as string, phoneNumberId: d.phoneNumberId as string, status: d.status as string, accessTokenConfigured: Boolean(d.accessTokenEncrypted), updatedAt: d.updatedAt as string };
}

// A merchant's Instagram professional account, for basic DMs.
// TODO(jesse): the Instagram connect flow (Instagram Login, token exchange and refresh) once the
// messaging permission is approved (Y9). Until then this is called from an admin script.
export async function saveInstagramConnection(db: Firestore, cfg: Config, v: { businessId: string; igAccountId: string; accessToken: string }) {
  const at = new Date().toISOString();
  const batch = db.batch();
  batch.set(db.doc(C.instagramConnections, v.businessId), { businessId: v.businessId, igAccountId: v.igAccountId, accessTokenEncrypted: encrypt(v.accessToken, cfg), status: 'connected', updatedAt: at });
  batch.set(db.doc(C.channelAccounts, `instagram_${v.igAccountId}`), { id: `instagram_${v.igAccountId}`, businessId: v.businessId, channel: 'instagram', accountId: v.igAccountId });
  await batch.commit();
}
