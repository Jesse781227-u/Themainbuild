// After the owner connects their number: one message, "🎉 <shop> is live!" with the shop link
// (wa.me/<number>). No Status image or message to forward (the owner found them unnecessary, 21 Nov).
// The follow-ups (picture, contacts, photos, how did you hear) come later as nudges (nudges.ts).
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
// (the go-live questions are nudges now: nudges.ts)
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
  // One message, and nothing else in this session (the owner, 21 Nov: "the congratulations you are
  // live is enough"). The picture, photos, contacts and "how did you hear" come later as nudges.
  const messages: { kind: string; text: string; content?: OutboundContent }[] = [
    { kind: 'golive', text: `🎉 ${business.name} is live${number ? ` on ${number}` : ''}!${link ? `\nYour shop link: ${link}` : ''}\nIf you reply to a customer yourself, I'll step back in that chat.` },
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
  // Signup is over: the owner chat is the everyday Admin Bot now. wentLiveAt times the nudges.
  await db.set(db.doc(C.conversations, adminConversationId(business.ownerPhone)), { onboarding: null }, { merge: true });
  await db.update(db.doc(C.businesses, business.id), { wentLiveAt: at, updatedAt: at });
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
