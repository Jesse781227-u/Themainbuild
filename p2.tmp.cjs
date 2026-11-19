const fs=require('fs');
let f, s;
const rep=(a,b)=>{if(!s.includes(a))throw new Error(f+' missing: '+a.slice(0,70));s=s.replace(a,b);};
f='src/services/import-photos.ts';s=fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n');
rep(`export interface ImportPhotos { id: string; businessId: string; conversationId: string; ownerPhone: string; names: string[]; photoUrls: string[]; status: 'pending' | 'done' | 'failed'; createdAt: string }`,`// matches: product name (lower case) → photo URL, once matched. Add all uses them for the products it creates.
export interface ImportPhotos { id: string; businessId: string; conversationId: string; ownerPhone: string; names: string[]; photoUrls: string[]; status: 'pending' | 'done' | 'failed'; matches?: Record<string, string>; createdAt: string }`);
const a = s.indexOf('  // The list still waiting for Add all');
const b = s.lastIndexOf('}');
s = s.slice(0, a) + `  // Saved first: Add all (now or later) puts them on the products it creates.
  const matches = Object.fromEntries(byName);
  await db.update(db.doc(C.importPhotos, id), { status: 'done', matched: byName.size, matches });
  // Products already added (Add all was tapped): the photo goes on any that have none.
  const added = await attachMatched(db, job.businessId, matches);
  // Still waiting for Add all: say nothing now. The "Done ✅" after Add all mentions the photos, so
  // no message ever points at a button the owner has already used.
  const conv = await db.get(db.doc(C.conversations, job.conversationId));
  if (!added && (conv?.importDraft as ImportDraft | null | undefined)?.photosId === id) return null;
  if (!added) return byName.size ? null : { ownerPhone: job.ownerPhone, businessId: job.businessId, text: "📷 I couldn't tell which photo in your file goes with which product. To add a photo, send it with the product's name as the caption." };
  return { ownerPhone: job.ownerPhone, businessId: job.businessId, text: \`📷 Added photos to \${added} product\${added === 1 ? '' : 's'}.\` };
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
`;
fs.writeFileSync(f,s);

f='src/bots/catalog-import.ts';s=fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n');
const a2 = s.indexOf('// Saves the confirmed draft.');
const b2 = s.indexOf('  const usedCats = new Set(');
s = s.slice(0, a2) + `const ADDING_NOTE_MS = 3_000;

// Saves the confirmed draft. Returns the messages and how many products were created.
async function apply(f: FlowCtx, notify?: (o: Out) => Promise<unknown>): Promise<{ out: Out[]; created: number }> {
  const draft = f.state.importDraft;
  if (!draft?.items.length) return { out: ['That list was already added or cancelled. Send it again if you need to.'], created: 0 };
  await saveDraft(f, null);
  // A long list takes a while: say so instead of going quiet.
  const timer = notify ? setTimeout(() => { notify('Adding your products…').catch(() => undefined); }, ADDING_NOTE_MS) : null;
  try {
    return await applyDraft(f, draft);
  } finally { if (timer) clearTimeout(timer); }
}

async function applyDraft(f: FlowCtx, draft: ImportDraft): Promise<{ out: Out[]; created: number }> {
  // Photos from the file that were matched in the background (before Add all).
  const photosRef = draft.photosId ? f.db.doc(C.importPhotos, draft.photosId) : null;
  const photoJob = photosRef ? ((await f.db.get(photosRef)) as ImportPhotos | null) : null;
  const matched = photoJob?.matches ?? {};
  await createCategories(f.db, f.business.id, [...new Set(draft.items.map(i => i.category))]);
  const cats = await listCategories(f.db, f.business.id);
  const byName = new Map((await listProducts(f.db, f.business.id)).map(p => [p.name.toLowerCase(), p] as [string, Product]));
  let created = 0, updated = 0;
  const createdIds = new Set<string>();
  const one = async (it: ImportItem) => {
    const cat = findCategory(cats, it.category) ?? cats[0];
    const existing = byName.get(it.name.toLowerCase());
    const imageUrl = it.imageUrl ?? matched[it.name.toLowerCase()] ?? null;
    try {
      if (existing) {
        await f.db.update(f.db.doc(C.products, existing.id), { priceKobo: it.priceKobo, ...(it.stock !== null ? { stock: it.stock } : {}), ...(imageUrl ? { images: [imageUrl, ...existing.images.filter(u => u !== imageUrl)].slice(0, 10) } : {}), updatedAt: new Date().toISOString() });
        updated++;
      } else {
        const p = await createProduct(f.db, { businessId: f.business.id, name: it.name, priceKobo: it.priceKobo, stock: it.stock, categoryId: cat.id, description: it.description, images: imageUrl ? [imageUrl] : [] });
        createdIds.add(p.id);
        created++;
      }
    } catch (e) { log('warn', 'import_item_failed', { businessId: f.business.id, error: String(e instanceof Error ? e.message : e).slice(0, 120) }); }
  };
  // Categories in parallel (each category's product count is one document, so its items go in turn).
  const groups = new Map<string, ImportItem[]>();
  for (const it of draft.items) { const k = (findCategory(cats, it.category) ?? cats[0]).id; groups.set(k, [...(groups.get(k) ?? []), it]); }
  await Promise.all([...groups.values()].map(async items => { for (const it of items) await one(it); }));
  // The photos finished matching while these were being added: put them on now.
  if (photosRef && photoJob?.status === 'pending') {
    const now = (await f.db.get(photosRef)) as ImportPhotos | null;
    if (now?.matches) await attachMatched(f.db, f.business.id, now.matches, createdIds);
  }
` + s.slice(b2);
rep(`  if (input.choiceId === 'imp:all') return apply(f);`,`  if (input.choiceId === 'imp:all') return apply(f, notify);`);
rep(`import { slowJob } from '../services/presence';`,`import { slowJob } from '../services/presence';
import { attachMatched, type ImportPhotos } from '../services/import-photos';`);
fs.writeFileSync(f,s);
