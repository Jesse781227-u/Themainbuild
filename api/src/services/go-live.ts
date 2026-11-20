// After the owner connects their number: the go-live kit and the last few (optional) questions.
//   1. "🎉 <shop> is live!" with the shop link (wa.me/<number>)
//   2. a Status image ("Now taking orders on WhatsApp 24/7"), /golive/<businessId>.png
//   3. a short announcement to forward to customers
//   4. questions, one at a time, in the Admin Bot chat (onboarding stage "live"):
//      profile photo (only if the WhatsApp Business profile has none) → add existing contacts? →
//      how did you hear about Relay?
// Everything goes through the outbox, so a closed 24-hour window can't lose it.
import { C } from '../db';
import type { Config } from '../config';
import type { QueueJob, R2BucketLike } from '../env';
import type { Firestore } from '../lib/firestore';
import { log } from '../lib/logger';
import { randomId } from '../lib/crypto';
import type { Business } from '../domain/business';
import type { OutboundContent } from './channel';
import { adminConversationId } from './conversations';
import { trackStep } from './onboarding-events';
import { liveQuestion, type Onboarding } from '../bots/onboarding';
import { posterPng, shopColour, wrap } from './placeholder';
import { resolveSender } from './channel';
import { submitTemplates } from './templates';
import { getWhatsAppConnection } from './whatsapp';
import { listProducts } from './catalog';

export const goLivePath = (businessId: string) => `/golive/${businessId}.png`;
const digitsOf = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

// The Status image: the shop colour, "Now taking orders on WhatsApp 24/7", the name and the number.
export function statusImage(business: Pick<Business, 'id' | 'name' | 'whatsappDisplayNumber'>) {
  const name = wrap(business.name.toUpperCase(), 14).slice(0, 3);
  return posterPng(shopColour(business.id), [
    { text: 'Now taking orders', scale: 5, gapAfter: 14 },
    { text: 'on WhatsApp 24/7', scale: 5, gapAfter: 60 },
    ...name.map((text, i) => ({ text, scale: 6, band: true, gapAfter: i === name.length - 1 ? 60 : 30 })),
    ...(business.whatsappDisplayNumber ? [{ text: 'Order here:', scale: 3, gapAfter: 14 }, { text: business.whatsappDisplayNumber, scale: 4 }] : []),
  ]);
}

// The WhatsApp Business profile picture, copied into our storage. Live numbers only.
// TODO(jesse): verify against Meta's docs that coexistence numbers return profile_picture_url from
// GET /{phone-number-id}/whatsapp_business_profile, and how long that URL stays valid.
async function fetchProfilePhoto(db: Firestore, cfg: Config, doFetch: typeof fetch, images: R2BucketLike, business: Business): Promise<string | null> {
  try {
    const sender = await resolveSender(db, cfg, { businessId: business.id });
    const res = await doFetch(`https://graph.facebook.com/${cfg.META_GRAPH_VERSION}/${encodeURIComponent(sender.phoneNumberId)}/whatsapp_business_profile?fields=profile_picture_url`, { headers: { authorization: `Bearer ${sender.accessToken}` } });
    const json = (await res.json().catch(() => ({}))) as { data?: { profile_picture_url?: string }[] };
    const url = json.data?.[0]?.profile_picture_url;
    if (!res.ok || !url) return null;
    const img = await doFetch(url);
    if (!img.ok) return null;
    const type = img.headers.get('content-type') ?? 'image/jpeg';
    const key = `businesses/${business.id}/profile/wa-${randomId(4).replace(/[^A-Za-z0-9]/g, 'x')}.${type.includes('png') ? 'png' : 'jpg'}`;
    await images.put(key, await img.arrayBuffer(), { httpMetadata: { contentType: type } });
    return `${cfg.API_BASE_URL}/media/${key}`;
  } catch (e) {
    log('warn', 'profile_photo_fetch_failed', { businessId: business.id, error: String(e instanceof Error ? e.message : e).slice(0, 120) });
    return null;
  }
}

export async function goLive(db: Firestore, cfg: Config, opts: { businessId: string; enqueue: (jobs: QueueJob[]) => Promise<void>; fetch?: typeof fetch; images?: R2BucketLike }) {
  const business = (await db.get(db.doc(C.businesses, opts.businessId))) as Business | null;
  if (!business?.ownerPhone) return;
  const at = new Date().toISOString();

  if (!business.profilePhotoUrl && cfg.META_SEND_MODE === 'live' && opts.fetch && opts.images) {
    const url = await fetchProfilePhoto(db, cfg, opts.fetch, opts.images, business);
    if (url) { await db.update(db.doc(C.businesses, business.id), { profilePhotoUrl: url, updatedAt: at }); business.profilePhotoUrl = url; }
  }

  // Smart Reach: send the shop's marketing templates to Meta for review (paid updates need them).
  if (cfg.META_SEND_MODE === 'live' && opts.fetch) await submitShopTemplates(db, cfg, business, opts.fetch).catch(e => log('warn', 'templates_submit_failed', { businessId: business.id, error: String(e instanceof Error ? e.message : e).slice(0, 120) }));

  const number = business.whatsappDisplayNumber ?? '';
  const link = digitsOf(number) ? `https://wa.me/${digitsOf(number)}` : null;
  const step: Onboarding['step'] = business.profilePhotoUrl ? 'live_contacts' : 'live_photo';
  const messages: { kind: string; text: string; content?: OutboundContent }[] = [
    { kind: 'golive', text: `🎉 ${business.name} is live! Customers who message ${number || 'your number'} now get your shop assistant, any time of day.${link ? `\n\nYour shop link: ${link}\nPut it in your Instagram bio and share it everywhere.` : ''}\n\nYou keep using the WhatsApp Business app as normal. If you reply to a customer yourself, the assistant steps back in that chat.` },
    { kind: 'golive_status', text: 'Post this on your WhatsApp Status 👆', content: { type: 'image', link: `${cfg.API_BASE_URL}${goLivePath(business.id)}`, caption: 'Post this on your WhatsApp Status, so your contacts know they can order any time 👆' } },
    { kind: 'golive_forward', text: 'Forward this to your customers 👇' },
    { kind: 'golive_announce', text: `Hi! 👋 You can now order from ${business.name} right here on WhatsApp, any time: see everything we have, order and pay in a few taps.${link ? ` Start here: ${link}` : ''}` },
    { kind: 'golive_q', text: 'A few last questions', content: liveQuestion(step, business) ?? undefined },
  ];
  const ids: string[] = [];
  for (const m of messages) {
    const id = `${business.id}_${m.kind}`;
    const created = await db.create(db.doc(C.outbox, id), {
      id, businessId: business.id, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone, conversationId: adminConversationId(business.ownerPhone),
      kind: m.kind, text: m.text, ...(m.content ? { content: m.content } : {}), status: 'pending', attempts: 0, createdAt: at,
    });
    if (created) ids.push(id);
  }
  if (!ids.length) return; // already done (a repeated signup callback)
  const ob: Onboarding = { stage: 'live', step, businessId: business.id, welcomed: true, nameSet: true, lastSeenAt: at };
  await db.set(db.doc(C.conversations, adminConversationId(business.ownerPhone)), { onboarding: ob }, { merge: true });
  await db.set(db.doc(C.ownerPhones, business.ownerPhone), { onboardingStage: 'live' }, { merge: true });
  await trackStep(db, { ownerPhone: business.ownerPhone, businessId: business.id, step: 'connect', event: 'completed' });
  await trackStep(db, { ownerPhone: business.ownerPhone, businessId: business.id, step: 'live', event: 'entered' });
  // TODO(jesse): when the owner agreed (business.importContacts), add the contacts WhatsApp syncs for
  // coexistence numbers to customers. The sync webhook's format is unverified (see signup.ts).
  await opts.enqueue(ids.map(messageId => ({ kind: 'outbox' as const, messageId })));
}

export async function submitShopTemplates(db: Firestore, cfg: Config, business: Business, doFetch: typeof fetch) {
  const conn = await getWhatsAppConnection(db, business.id);
  if (!conn?.wabaId) return [];
  const sender = await resolveSender(db, cfg, { businessId: business.id });
  const sample = (await listProducts(db, business.id)).find(p => p.images?.[0])?.images[0] ?? null;
  const results = await submitTemplates(db, cfg, { businessId: business.id, wabaId: conn.wabaId, token: sender.accessToken, sampleImageUrl: sample }, doFetch);
  log('info', 'templates_submitted', { businessId: business.id, ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
  return results;
}
