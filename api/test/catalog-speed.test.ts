import { clearFirestore, db, seed } from './helpers';
import { geminiProvider } from '../src/services/ai';
import { matchImportPhotos } from '../src/services/import-photos';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

before(async () => { await clearFirestore(); await seed(); });

const answer = (items: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(items) }] } }] }), { status: 200 });
const cfg = { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'main', GEMINI_FALLBACK_MODEL: 'backup,lite' };
const pdf = { mimeType: 'application/pdf', bytes: new ArrayBuffer(10) };

test('catalogue reading: a busy model hands over at once; the first good answer wins', async () => {
  const calls: string[] = [];
  const llm = geminiProvider(cfg, (async (url: string) => {
    const model = /models\/([^:]+)/.exec(url)![1];
    calls.push(model);
    if (model === 'main' || model === 'backup') return new Response('busy', { status: 503 });
    return answer({ items: [{ name: 'Jacket', price: 15000, category: 'Clothing' }] });
  }) as typeof fetch)!;
  const t = Date.now();
  const items = await llm.readCatalog!({ file: pdf });
  assert.deepEqual(items.map(i => i.name), ['Jacket']);
  assert.deepEqual(calls, ['main', 'backup', 'lite']);
  assert.ok(Date.now() - t < 2_000, 'no waiting on a model that already said no');
});

test('catalogue reading: when every model is busy, it says so instead of hanging', async () => {
  const llm = geminiProvider(cfg, (async () => new Response('busy', { status: 503 })) as typeof fetch)!;
  await assert.rejects(llm.readCatalog!({ file: pdf }), /GEMINI_FAILED: 503/);
});

test('photos from a PDF are matched in the background and added to the products', async () => {
  const businessId = 'biz-a';
  const store = new Map<string, Uint8Array>([['p/1.jpg', new Uint8Array([1, 2, 3])], ['p/2.jpg', new Uint8Array([4, 5, 6])]]);
  const images = { async get(key: string) { const b = store.get(key); return b ? { body: new Blob([b]).stream(), httpMetadata: { contentType: 'image/jpeg' } } : null; }, async put() {} } as never;
  const llm = { async chooseTool() { return null; }, async matchPhotos({ names, photos }: { names: string[]; photos: unknown[] }) { assert.equal(photos.length, 2); assert.deepEqual(names, ['Hoodie', 'Boots']); return [2, 1]; } };
  const at = new Date().toISOString();
  // Add all was already tapped: Boots exists without a photo; Hoodie already has one.
  await db.set(db.doc('products', 'p-boots'), { id: 'p-boots', businessId, name: 'Boots', priceKobo: 100, images: [], categoryId: null, available: true, stock: null, createdAt: at, updatedAt: at, deletedAt: null });
  await db.set(db.doc('products', 'p-hoodie'), { id: 'p-hoodie', businessId, name: 'Hoodie', priceKobo: 100, images: ['https://x/own.jpg'], categoryId: null, available: true, stock: null, createdAt: at, updatedAt: at, deletedAt: null });
  await db.set(db.doc('importPhotos', 'job1'), { id: 'job1', businessId, conversationId: 'admin_x', ownerPhone: '+2348030000001', names: ['Hoodie', 'Boots'], photoUrls: ['https://r/media/p/1.jpg', 'https://r/media/p/2.jpg'], status: 'pending', createdAt: at });
  const done = await matchImportPhotos(db, llm, images, 'job1');
  assert.equal(done!.text, '📷 Added the photos from your file to 1 product.');
  assert.deepEqual((await db.get(db.doc('products', 'p-boots')))!.images, ['https://r/media/p/1.jpg'], 'photo 1 shows the boots');
  assert.deepEqual((await db.get(db.doc('products', 'p-hoodie')))!.images, ['https://x/own.jpg'], 'an existing photo is kept');
  assert.equal(await matchImportPhotos(db, llm, images, 'job1'), null, 'only once');
});
