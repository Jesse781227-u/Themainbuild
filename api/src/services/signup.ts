// Embedded Signup: the merchant connects their own WhatsApp Business number (with coexistence, so
// they keep using the WhatsApp Business app). The Admin Bot sends a one-time link to /connect/<token>;
// that page runs Meta's Embedded Signup and posts the result to /api/v1/signup/complete.
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import { randomId } from '../lib/crypto';
import { saveWhatsAppConnection } from './whatsapp';

const SESSION_HOURS = 24;
export const REMINDER_MINUTES = 60; // one nudge if the link hasn't been used by then

export async function createSignupSession(db: Firestore, cfg: Config, businessId: string, now = new Date()) {
  const token = randomId(18).replace(/[^A-Za-z0-9]/g, 'x');
  await db.create(db.doc(C.signupSessions, token), { token, businessId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + SESSION_HOURS * 3600_000).toISOString(), usedAt: null, reminderDueAt: new Date(now.getTime() + REMINDER_MINUTES * 60_000).toISOString() });
  return `${cfg.API_BASE_URL}/connect/${token}`;
}

export async function getSignupSession(db: Firestore, token: string, now = new Date()) {
  if (!/^[A-Za-z0-9]{10,64}$/.test(token)) return null;
  const s = await db.get(db.doc(C.signupSessions, token));
  if (!s || s.usedAt || String(s.expiresAt) <= now.toISOString()) return null;
  return s as { token: string; businessId: string; expiresAt: string };
}

export class SignupError extends Error {}

// Exchanges the Embedded Signup code for a business token, checks the number belongs to the WABA the
// merchant just shared, subscribes Relay's app to that WABA's webhooks, and stores the connection.
// TODO(jesse): confirm against Meta's current Embedded Signup docs for coexistence: whether the
// number needs POST /{phone-number-id}/register (it should not for coexistence numbers) and whether
// any extra sync calls are required to import the existing app contacts/history.
export async function completeSignup(db: Firestore, cfg: Config, doFetch: typeof fetch, input: { token: string; code: string; wabaId: string; phoneNumberId: string }) {
  const session = await getSignupSession(db, input.token);
  if (!session) throw new SignupError('LINK_EXPIRED');
  if (!cfg.META_APP_ID || !cfg.META_APP_SECRET) throw new SignupError('SIGNUP_NOT_CONFIGURED');
  const graph = `https://graph.facebook.com/${cfg.META_GRAPH_VERSION}`;

  const tokenRes = await doFetch(`${graph}/oauth/access_token?${new URLSearchParams({ client_id: cfg.META_APP_ID, client_secret: cfg.META_APP_SECRET, code: input.code })}`);
  const tokenJson = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenRes.ok || !tokenJson.access_token) throw new SignupError('CODE_EXCHANGE_FAILED');
  const accessToken = tokenJson.access_token;
  const auth = { authorization: `Bearer ${accessToken}` };

  const numbersRes = await doFetch(`${graph}/${encodeURIComponent(input.wabaId)}/phone_numbers`, { headers: auth });
  const numbers = (await numbersRes.json().catch(() => ({}))) as { data?: { id: string; display_phone_number?: string }[] };
  const number = numbers.data?.find(n => n.id === input.phoneNumberId);
  if (!numbersRes.ok || !number) throw new SignupError('NUMBER_NOT_IN_WABA');

  const subRes = await doFetch(`${graph}/${encodeURIComponent(input.wabaId)}/subscribed_apps`, { method: 'POST', headers: auth });
  if (!subRes.ok) throw new SignupError('SUBSCRIBE_FAILED');

  // The number must not already belong to another business.
  const existing = await db.get(db.doc(C.channelAccounts, `whatsapp_${input.phoneNumberId}`));
  if (existing && existing.businessId !== session.businessId) throw new SignupError('NUMBER_IN_USE');

  await saveWhatsAppConnection(db, cfg, { businessId: session.businessId, wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, accessToken });
  const at = new Date().toISOString();
  await db.update(db.doc(C.businesses, session.businessId), { status: 'active', whatsappDisplayNumber: number.display_phone_number ?? null, updatedAt: at });
  await db.update(db.doc(C.signupSessions, input.token), { usedAt: at, reminderDueAt: null });
  return { businessId: session.businessId, displayNumber: number.display_phone_number ?? null };
}
