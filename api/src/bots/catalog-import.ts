// Bulk setup from a whole menu or price list: a PDF, a photo of a printed menu, or a pasted list.
//   upload → "📄 Reading your menu…" → summary grouped by category → [Add all] [Cancel]
// Pasted lists are read by rules (no AI needed); files and photos need the LLM's readCatalog. Nothing
// is saved until the owner taps Add all. Existing products (same name) get the new price instead of
// a duplicate. Choice ids: imp:all, imp:cancel.
import { C } from '../db';
import { BUSINESS_TYPES, type BusinessCategory } from '../domain/business';
import { example, mismatch, TYPE_WORDS } from '../services/shop-type';
import type { Product } from '../domain/commerce';
import { log } from '../lib/logger';
import { randomId } from '../lib/crypto';
import { extractPdfImages, type PdfImage } from '../services/pdf-images';
import { productImageKey } from '../routes/media';
import { formatKobo, nairaToKobo } from '../lib/money';
import { CATALOG_MIME, MAX_CATALOG_BYTES, type CatalogItem } from '../services/ai';
import { createCategories, createProduct, findCategory, listCategories, listProducts, tidyCategoryName } from '../services/catalog';
import { buttons, fetchMedia, type Input } from './common';
import { slowJob } from '../services/presence';
import { attachMatched, type ImportPhotos } from '../services/import-photos';
import { suggestStatus } from '../services/status-tips';
import { parseProduct, type FlowCtx, type Out } from './products-flow';
import { pdfText } from '../services/pdf-text';

export interface ImportItem { name: string; priceKobo: number; category: string; stock: number | null; description: string; imageUrl?: string | null }
export interface ImportDraft {
  items: ImportItem[]; skippedNoPrice: string[]; source: string;
  photosId?: string | null; photoCount?: number;  // photos being matched in the background
  checked?: boolean; found?: BusinessCategory;    // the "is this the right file?" question was asked
}

const MAX_ITEMS = 200;
const MAX_PHOTOS = 40;

// Saves photos taken from an uploaded file in R2 as product images. Returns their public URLs, in order.
async function storePhotos(f: FlowCtx, photos: PdfImage[]): Promise<string[]> {
  if (!f.deps.images || !photos.length) return [];
  const urls: string[] = [];
  for (const p of photos) {
    const key = productImageKey(f.business.id, `imp-${randomId(9).replace(/[^A-Za-z0-9]/g, 'x')}.jpg`);
    try {
      await f.deps.images.put(key, p.bytes.slice().buffer as ArrayBuffer, { httpMetadata: { contentType: p.mimeType } });
      urls.push(`${f.cfg.API_BASE_URL}/media/${key}`);
    } catch (e) {
      log('warn', 'import_photo_store_failed', { businessId: f.business.id, error: String(e instanceof Error ? e.message : e).slice(0, 120) });
      break;
    }
  }
  return urls;
}
const looksLikeMenuWord = (t: string) => /^(menu|price ?list|prices|catalogue|catalog|inventory|stock list|my products)\b/i.test(t.trim());

// One CSV row → fields, honouring quotes ("2,500" stays one field). Also accepts ; and tab.
function csvFields(row: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') { if (quoted && row[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (ch === ',' || ch === ';' || ch === '\t')) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// "RICE DISHES:" → "Rice Dishes".
const headingName = (line: string) => {
  const t = line.replace(/[:\-–—]+$/, '').trim();
  return tidyCategoryName(t === t.toUpperCase() ? t.toLowerCase() : t);
};

// A pasted list: product lines ("Jollof rice 2500") under optional headings ("DRINKS", "Rice:").
export function parsePastedMenu(text: string, opts: { csv?: boolean } = {}): ImportItem[] | null {
  let lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (opts.csv) {
    // "Zobo,500,30" → "Zobo 500 30"; a header row ("name,price,stock") is dropped.
    lines = lines.map(l => csvFields(l).map(f => (/^[₦N]?\s*[\d,]+(\.\d+)?k?$/i.test(f) ? f.replace(/,/g, '') : f)).filter(Boolean).join(' '));
    if (lines.length && /\b(name|item|product|price|amount|cost)\b/i.test(lines[0]) && !/\d/.test(lines[0])) lines = lines.slice(1);
  }
  lines = lines.map(l => l.replace(/^[-•*\d.)\s]+(?=\D)/, '').trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const items: ImportItem[] = [];
  let heading: string | null = null;
  for (const line of lines) {
    const p = parseProduct(line.replace(/\s*[-–—:]\s*(?=(₦|n)?\d)/i, ' '));
    if (p) { items.push({ name: p.name, priceKobo: p.priceKobo, stock: p.stock, category: heading ?? '', description: '' }); continue; }
    if (line.length <= 30 && !/\d/.test(line)) heading = headingName(line);
  }
  return items.length >= 2 ? items : null;
}

// LLM output → validated items (prices as kobo, trimmed names, deduplicated).
// photoUrls: stored photos from the file, in the order given to the model (item.image is 1-based).
export function cleanItems(raw: CatalogItem[], fallbackCategory: string, photoUrls: string[] = []): { items: ImportItem[]; skippedNoPrice: string[] } {
  const usedPhotos = new Set<number>();
  const seen = new Set<string>();
  const items: ImportItem[] = [];
  const skippedNoPrice: string[] = [];
  for (const r of raw) {
    const name = String(r.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (name.length < 2 || seen.has(name.toLowerCase())) continue;
    const priceKobo = r.price == null ? null : nairaToKobo(String(r.price));
    if (!priceKobo || priceKobo <= 0) { skippedNoPrice.push(name); continue; }
    seen.add(name.toLowerCase());
    const stock = Number.isInteger(r.stock) && (r.stock as number) >= 0 ? (r.stock as number) : null;
    const n = Number(r.image);
    const photo = Number.isInteger(n) && n >= 1 && n <= photoUrls.length && !usedPhotos.has(n) ? n : null;
    if (photo) usedPhotos.add(photo);
    items.push({ name, priceKobo, stock, category: tidyCategoryName(String(r.category ?? '')) || fallbackCategory, description: String(r.description ?? '').slice(0, 300), imageUrl: photo ? photoUrls[photo - 1] : null });
  }
  return { items: items.slice(0, MAX_ITEMS), skippedNoPrice };
}

async function saveDraft(f: FlowCtx, draft: ImportDraft | null) {
  f.state.importDraft = draft;
  await f.db.set(f.convRef, { importDraft: draft }, { merge: true });
}

const defaultCategory = (f: FlowCtx) => BUSINESS_TYPES.find(t => t.id === f.business.category)?.starters[0] ?? 'Products';

// The summary the owner confirms: grouped by category, existing names marked as updates.
async function preview(f: FlowCtx, draft: ImportDraft): Promise<Out[]> {
  const existing = new Set((await listProducts(f.db, f.business.id)).map(p => p.name.toLowerCase()));
  const groups = new Map<string, ImportItem[]>();
  for (const it of draft.items) groups.set(it.category, [...(groups.get(it.category) ?? []), it]);
  const updates = draft.items.filter(i => existing.has(i.name.toLowerCase())).length;
  const lines: string[] = [];
  for (const [cat, list] of groups) {
    lines.push(`\n*${cat}* (${list.length})`);
    for (const it of list.slice(0, 8)) lines.push(`• ${it.name}: ${formatKobo(it.priceKobo)}${it.stock !== null ? ` (${it.stock} in stock)` : ''}${existing.has(it.name.toLowerCase()) ? ' (update)' : ''}`);
    if (list.length > 8) lines.push(`…and ${list.length - 8} more`);
  }
  // The notes go first and the product list last, so cutting to WhatsApp's 1,024 characters only
  // ever shortens the list.
  const withPhotos = draft.items.filter(i => i.imageUrl).length;
  const notes = [
    withPhotos ? `📷 ${withPhotos === draft.items.length ? 'All' : withPhotos} come${withPhotos === 1 ? 's' : ''} with a photo from your file.` : '',
    updates ? `${updates === draft.items.length ? 'All' : updates} already in your shop: ${updates === 1 ? 'it gets' : 'they get'} the new price${withPhotos ? ' and photo' : ''}.` : '',
    draft.skippedNoPrice.length ? `No price found for: ${draft.skippedNoPrice.slice(0, 10).join(', ')}${draft.skippedNoPrice.length > 10 ? '…' : ''}. Add those one by one.` : '',
  ].filter(Boolean);
  const list = updates === draft.items.length ? lines.map(l => l.replace(/ \(update\)$/, '')) : lines;
  let text = `I found *${draft.items.length} product${draft.items.length === 1 ? '' : 's'}* in ${groups.size} categor${groups.size === 1 ? 'y' : 'ies'}.${notes.length ? `\n\n${notes.join('\n')}` : ''}\n${list.join('\n')}`;
  if (text.length > 1000) text = `${text.slice(0, 990).replace(/\n[^\n]*$/, '')}\n…`; // WhatsApp button messages allow 1,024 characters
  return [buttons(text, [['imp:all', `Add all ${draft.items.length}`.slice(0, 20)], ['imp:cancel', "Don't add these"]])];
}

const ADDING_NOTE_MS = 3_000;

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
  // A Status tip for what's new (live shops, once a day).
  const firstNew = draft.items.find(it => !byName.has(it.name.toLowerCase()));
  if (created && firstNew) await suggestStatus(f.db, f.deps, f.business, { kind: 'new', name: firstNew.name, count: created }, { categoryId: (findCategory(cats, firstNew.category) ?? cats[0]).id }).catch(() => false);
  // The photos finished matching while these were being added: put them on now.
  if (photosRef && photoJob?.status === 'pending') {
    const now = (await f.db.get(photosRef)) as ImportPhotos | null;
    if (now?.matches) await attachMatched(f.db, f.business.id, now.matches, createdIds);
  }
  const usedCats = new Set(draft.items.map(i => i.category.toLowerCase())).size;
  const plural = (n: number) => `${n} product${n === 1 ? '' : 's'}`;
  const what = created && updated ? `Added ${plural(created)} and updated ${updated}` : created ? `Added ${plural(created)} in ${usedCats} categor${usedCats === 1 ? 'y' : 'ies'}` : `Updated ${plural(updated)}`;
  return { out: [`Done ✅ ${what}. Send PRODUCTS to see them.`], created };
}

export interface ImportResult { out: Out[]; created: number }

// Right after a list is read: "Your shop is called Mama Tee's Kitchen, but this file looks like
// clothing" when the name and the products clearly disagree (once per upload, never blocking);
// otherwise the summary to confirm.
async function offer(f: FlowCtx, draft: ImportDraft): Promise<ImportResult> {
  const named = f.business.name && f.business.name !== 'My shop' ? f.business.name : null;
  const m = !draft.checked && named ? mismatch(named, draft.items) : null;
  if (m) {
    await saveDraft(f, { ...draft, checked: true, found: m.found });
    return { out: [buttons(`Quick check 👀 Your shop is called *${named}*, but this file looks like *${TYPE_WORDS[m.found]}*. Did you send the right file?`, [['imp:mine', "Yes, it's my stock"], ['imp:other', 'Send another file'], ['imp:rename', 'Change shop name']])], created: 0 };
  }
  await saveDraft(f, { ...draft, checked: true });
  const out = await preview(f, draft);
  const n = draft.photoCount ?? 0;
  return { out: draft.photosId && n ? [...out, `📷 Your file has ${n} product photo${n === 1 ? '' : 's'}. I'm matching them to your products now and will add them in about a minute. You don't need to wait: tap *Add all* whenever you're ready.`] : out, created: 0 };
}

async function answerCheck(f: FlowCtx, input: Input, text: string): Promise<ImportResult | null> {
  const draft = f.state.importDraft;
  if (input.choiceId === 'imp:mine') {
    if (!draft) return { out: ['That list was already added or cancelled. Send it again if you need to.'], created: 0 };
    if (draft.found) {
      await f.db.update(f.db.doc(C.businesses, f.business.id), { category: draft.found, businessTypeInferred: true, updatedAt: new Date().toISOString() });
      f.business.category = draft.found;
    }
    return offer(f, draft);
  }
  if (input.choiceId === 'imp:other') {
    await saveDraft(f, null);
    return { out: ['OK 👍 Send the right file: a PDF, a photo of your list, or paste the list as a message.'], created: 0 };
  }
  if (input.choiceId === 'imp:rename') {
    if (!draft) return { out: ['That list was already added or cancelled. Send it again if you need to.'], created: 0 };
    f.state.awaiting = 'shopName';
    await f.db.set(f.convRef, { awaiting: 'shopName' }, { merge: true });
    return { out: ["What's your shop called? I'll keep the products from your file."], created: 0 };
  }
  if (f.state.awaiting === 'shopName' && !input.choiceId && text.trim()) {
    const name = text.trim().replace(/^(it'?s|it is|my shop is|call it|change it to)\s+/i, '').replace(/[.!]+$/, '').slice(0, 80);
    if (name.length < 2) return { out: ["What's your shop called?"], created: 0 };
    f.state.awaiting = null;
    await f.db.set(f.convRef, { awaiting: null }, { merge: true });
    await f.db.update(f.db.doc(C.businesses, f.business.id), { name, updatedAt: new Date().toISOString() });
    f.business.name = name;
    if (!draft) return { out: [`Done ✅ Your shop is now *${name}*.`], created: 0 };
    const next = await offer(f, { ...draft, checked: true });
    return { out: [`Done ✅ Your shop is now *${name}*.`, ...next.out], created: 0 };
  }
  return null;
}

// Handles anything that looks like a whole menu, plus the Add all / Cancel taps. Returns null when the
// message isn't a bulk upload, so the caller carries on as usual.
export async function handleImport(f: FlowCtx, input: Input, text: string, accessToken: string | undefined, notify: (o: Out) => Promise<unknown>, react?: (emoji: string) => Promise<unknown>): Promise<ImportResult | null> {
  if (input.choiceId === 'imp:all') return apply(f, notify);
  if (input.choiceId === 'imp:cancel') { await saveDraft(f, null); return { out: ['Cancelled. Nothing was added.'], created: 0 }; }
  const checked = await answerCheck(f, input, text);
  if (checked) return checked;
  if (input.choiceId) return null;

  // A pasted list: rules, no AI.
  if (!input.document && !input.imageId) {
    const items = parsePastedMenu(text);
    if (!items) return null;
    const fallback = defaultCategory(f);
    return offer(f, { items: items.slice(0, MAX_ITEMS).map(i => ({ ...i, category: i.category || fallback })), skippedNoPrice: [], source: 'text' });
  }

  // A file, or a photo that isn't a single product ("Black AF1 25k" as the caption is one product).
  const file = input.document ?? (input.imageId && (!text || looksLikeMenuWord(text) || !parseProduct(text)) ? { id: input.imageId, mimeType: 'image/jpeg', filename: 'photo' } : null);
  if (!file) return null;
  if (input.document && !CATALOG_MIME.test(input.document.mimeType)) return { out: ['I can read menus and price lists as a PDF, a photo, or a text/CSV file. Please send it in one of those, or paste the list as a message.'], created: 0 };
  // Text and CSV files are read like a pasted list first (no AI needed).
  if (input.document && /^text\//.test(input.document.mimeType) && accessToken) {
    try {
      const media = await fetchMedia(f.cfg, f.deps, accessToken, input.document.id);
      const csv = /csv/.test(input.document.mimeType) || /\.csv$/i.test(input.document.filename);
      const items = parsePastedMenu(new TextDecoder().decode(media.bytes).slice(0, 100_000), { csv });
      if (items) {
        const fallback = defaultCategory(f);
        return offer(f, { items: items.slice(0, MAX_ITEMS).map(i => ({ ...i, category: i.category || fallback })), skippedNoPrice: [], source: 'file' });
      }
    } catch (e) { log('warn', 'catalog_read_failed', { businessId: f.business.id, error: String(e instanceof Error ? e.message : e).slice(0, 160) }); }
  }
  if (!f.deps.llm?.readCatalog || !accessToken) return { out: [`I can't read files or photos of lists right now. Paste your list as a message instead, one product per line, e.g.\n${example(f.business)}`], created: 0 };

  await notify(input.document ? `📄 Reading ${input.document.filename}… this can take a few seconds.` : '📷 Reading your menu… this can take a few seconds.');
  try {
    const media = await fetchMedia(f.cfg, f.deps, accessToken, file.id);
    if (media.bytes.byteLength > MAX_CATALOG_BYTES) return { out: ['That file is too big (over 15 MB). Send a smaller PDF or a photo of each page.'], created: 0 };
    const mimeType = input.document ? input.document.mimeType : media.mimeType;
    const cats = (await listCategories(f.db, f.business.id)).map(c => c.name);
    // Product photos inside a PDF are saved and offered to the model to match with items.
    const photos = mimeType === 'application/pdf' ? await extractPdfImages(media.bytes, MAX_PHOTOS).catch(() => []) : [];
    const photoUrls = await storePhotos(f, photos);
    // The products first (fast); the photos are matched to them in the background (slow).
    const llm = f.deps.llm;
    const businessType = BUSINESS_TYPES.find(t => t.id === f.business.category)?.label;
    let raw: Awaited<ReturnType<NonNullable<typeof llm.readCatalog>>>;
    try {
      raw = await slowJob(() => llm.readCatalog!({ file: { mimeType, bytes: media.bytes }, businessType, categories: cats }), {
        react,
        ok: r => r.length > 0,
        stillWorking: () => notify(`Still reading your ${input.document ? 'file' : 'photo'}… ${input.document ? 'it\'s a big one, ' : ''}almost there.`),
      });
    } catch (e) {
      // The file reader is busy or down: a PDF's own text, read by the rules or by a text-only model.
      const text = mimeType === 'application/pdf' ? await pdfText(media.bytes) : null;
      if (!text) throw e;
      log('info', 'catalog_read_from_pdf_text', { businessId: f.business.id, error: String(e instanceof Error ? e.message : e).slice(0, 120) });
      const typed = parsePastedMenu(text);
      if (typed) return await offer(f, { items: typed.slice(0, MAX_ITEMS).map(i => ({ ...i, category: i.category || defaultCategory(f) })), skippedNoPrice: [], source: 'file' });
      raw = await llm.readCatalog!({ text, businessType, categories: cats });
    }
    const { items, skippedNoPrice } = cleanItems(raw, defaultCategory(f));
    if (!items.length) {
      return { out: [input.imageId && !input.document
        ? `I couldn't find products with prices in that photo. To add one product, send its photo with the name and price as the caption, e.g. *${example(f.business)}*.`
        : "I couldn't find products with prices in that file. Try a clearer PDF or photo, or paste the list as a message."], created: 0 };
    }
    const photosId = photoUrls.length && f.deps.llm.matchPhotos ? randomId(12).replace(/[^A-Za-z0-9]/g, 'x') : null;
    const draft: ImportDraft = { items, skippedNoPrice, source: input.document ? 'file' : 'photo', photosId, photoCount: photoUrls.length };
    if (photosId) {
      await f.db.create(f.db.doc(C.importPhotos, photosId), { id: photosId, businessId: f.business.id, conversationId: f.convRef.id, ownerPhone: f.business.ownerPhone, names: items.map(i => i.name), photoUrls, status: 'pending', createdAt: new Date().toISOString() });
      await f.deps.enqueue([{ kind: 'matchPhotos', id: photosId }]);
    }
    return await offer(f, draft);
  } catch (e) {
    const error = String(e instanceof Error ? e.message : e);
    log('warn', 'catalog_read_failed', { businessId: f.business.id, error: error.slice(0, 160) });
    // Busy or slow AI service: not the owner's file, so say so.
    if (/GEMINI_FAILED: (429|500|503|timeout)/.test(error)) return { out: ['The reader is busy right now. Please send the same file again in a minute.'], created: 0 };
    return { out: ["Sorry, I couldn't read that. Try again, send a clearer PDF or photo, or paste the list as a message."], created: 0 };
  }
}
