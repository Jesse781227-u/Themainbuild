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

export interface ImportPhotos { id: string; businessId: string; conversationId: string; ownerPhone: string; names: string[]; photoUrls: string[]; status: 'pending' | 'done' | 'failed'; createdAt: string }

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

  // The list still waiting for Add all: the photos go with it.
  let pending = 0;
  const conv = await db.get(db.doc(C.conversations, job.conversationId));
  const draft = conv?.importDraft as (ImportDraft & { photosId?: string }) | null | undefined;
  if (draft?.photosId === id) {
    for (const it of draft.items) { const url = byName.get(it.name.toLowerCase()); if (url && !it.imageUrl) { it.imageUrl = url; pending++; } }
    await db.set(db.doc(C.conversations, job.conversationId), { importDraft: draft }, { merge: true });
  }
  // Products already added (Add all was tapped): the photo goes on any that have none.
  let added = 0;
  const products = ((await db.query(C.products, [['businessId', '==', job.businessId]])) as unknown as Product[]).filter(p => !p.deletedAt);
  for (const p of products) {
    const url = byName.get(p.name.toLowerCase());
    if (!url || p.images.length) continue;
    await db.update(db.doc(C.products, p.id), { images: [url], updatedAt: new Date().toISOString() });
    added++;
  }
  await db.update(db.doc(C.importPhotos, id), { status: 'done', matched: byName.size });
  const n = Math.max(added, pending);
  if (!n) return { ownerPhone: job.ownerPhone, businessId: job.businessId, text: '📷 I couldn\'t tell which photo in your file goes with which product. To add a photo, send it with the product\'s name as the caption.' };
  return { ownerPhone: job.ownerPhone, businessId: job.businessId, text: added ? `📷 Added the photos from your file to ${added} product${added === 1 ? '' : 's'}.` : `📷 Matched ${pending} photo${pending === 1 ? '' : 's'} from your file. They'll be added with your products when you tap *Add all*.` };
}
