// Product photos inside an uploaded PDF are matched to the products in the background, so the owner
// sees their product list in seconds instead of waiting for the slow photo step.
//   upload → products read (no photos) → summary [Add all] … meanwhile: match photos → attach them to
//   the waiting list, or to the products already added → "📷 Added photos to N products".
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import type { R2BucketLike } from '../env';
import type { LLMProvider } from './ai';
import type { Product } from '../domain/commerce';
import type { ImportDraft } from '../bots/catalog-import';
import { log } from '../lib/logger';

// matches: product name (lower case) → photo URL, once matched. Add all uses them for the products it creates.
export interface ImportPhotos { id: string; businessId: string; conversationId: string; ownerPhone: string; names: string[]; photoUrls: string[]; status: 'pending' | 'done' | 'failed'; matches?: Record<string, string>; createdAt: string }

const keyOf = (url: string) => url.split('/media/')[1] ?? null;

// Returns the text for the owner, or null when there's nothing to say.
export async function matchImportPhotos(db: Firestore, llm: LLMProvider | null, images: R2BucketLike | undefined, id: string): Promise<{ text: string; ownerPhone: string; businessId: string } | null> {
  const job = (await db.get(db.doc(C.importPhotos, id))) as ImportPhotos | null;
  if (!job || job.status !== 'pending') return null;
  const fail = async (why: string) => {
    await db.update(db.doc(C.importPhotos, id), { status: 'failed', error: why.slice(0, 120) });
    return { ownerPhone: job.ownerPhone, businessId: job.businessId, text: '📷 I couldn\'t match the photos in your file to your products. To add a photo, send it with the product\'s name as the caption.' };
  };
  if (!llm?.matchPhotos || !images) return fail('no_ai_or_storage');

  const photos: { mimeType: string; bytes: Uint8Array }[] = [];
  for (const url of job.photoUrls) {
    const key = keyOf(url);
    const obj = key ? await images.get(key) : null;
    if (obj) photos.push({ mimeType: obj.httpMetadata?.contentType ?? 'image/jpeg', bytes: new Uint8Array(await new Response(obj.body).arrayBuffer()) });
    else photos.push({ mimeType: 'image/jpeg', bytes: new Uint8Array() });
  }
  let matches: (number | null)[];
  try { matches = await llm.matchPhotos({ names: job.names, photos: photos.filter(p => p.bytes.byteLength) }); }
  catch (e) { log('warn', 'photo_match_failed', { businessId: job.businessId, error: String(e instanceof Error ? e.message : e).slice(0, 120) }); return fail('ai_failed'); }
  // Back to the original photo order (photos that couldn't be loaded were left out).
  const loaded = photos.map((p, i) => (p.bytes.byteLength ? i : -1)).filter(i => i >= 0);
  const byName = new Map<string, string>();
  matches.forEach((n, i) => { if (n && !byName.has(job.names[n - 1].toLowerCase())) byName.set(job.names[n - 1].toLowerCase(), job.photoUrls[loaded[i]]); });

  // Saved first: Add all (now or later) puts them on the products it creates.
  const found = Object.fromEntries(byName);
  await db.update(db.doc(C.importPhotos, id), { status: 'done', matched: byName.size, matches: found });
  // Products already added (Add all was tapped): the photo goes on any that have none.
  const added = await attachMatched(db, job.businessId, found);
  // Still waiting for Add all: say nothing now. The "Done ✅" after Add all mentions the photos, so
  // no message ever points at a button the owner has already used.
  const conv = await db.get(db.doc(C.conversations, job.conversationId));
  if (!added && (conv?.importDraft as ImportDraft | null | undefined)?.photosId === id) return null;
  if (!added) return byName.size ? null : { ownerPhone: job.ownerPhone, businessId: job.businessId, text: "📷 I couldn't tell which photo in your file goes with which product. To add a photo, send it with the product's name as the caption." };
  return { ownerPhone: job.ownerPhone, businessId: job.businessId, text: `📷 Added photos to ${added} product${added === 1 ? '' : 's'}.` };
}

// Puts matched photos on the shop's products that have none. Returns how many got one.
export async function attachMatched(db: Firestore, businessId: string, matches: Record<string, string>, only?: Set<string>) {
  let added = 0;
  const products = ((await db.query(C.products, [['businessId', '==', businessId]])) as unknown as Product[]).filter(p => !p.deletedAt && (!only || only.has(p.id)));
  for (const p of products) {
    const url = matches[p.name.toLowerCase()];
    if (!url || p.images.length) continue;
    await db.update(db.doc(C.products, p.id), { images: [url], updatedAt: new Date().toISOString() });
    added++;
  }
  return added;
}
