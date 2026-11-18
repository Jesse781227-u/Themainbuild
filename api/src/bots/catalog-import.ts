// Bulk setup from a whole menu or price list: a PDF, a photo of a printed menu, or a pasted list.
//   upload → "📄 Reading your menu…" → summary grouped by category → [Add all] [Cancel]
// Pasted lists are read by rules (no AI needed); files and photos need the LLM's readCatalog. Nothing
// is saved until the owner taps Add all. Existing products (same name) get the new price instead of
// a duplicate. Choice ids: imp:all, imp:cancel.
import { C } from '../db';
import { BUSINESS_TYPES } from '../domain/business';
import type { Product } from '../domain/commerce';
import { log } from '../lib/logger';
import { randomId } from '../lib/crypto';
import { extractPdfImages, type PdfImage } from '../services/pdf-images';
import { productImageKey } from '../routes/media';
import { formatKobo, nairaToKobo } from '../lib/money';
import { CATALOG_MIME, MAX_CATALOG_BYTES, type CatalogItem } from '../services/ai';
import { createCategories, createProduct, findCategory, listCategories, listProducts, tidyCategoryName } from '../services/catalog';
import { buttons, fetchMedia, type Input } from './common';
import { parseProduct, type FlowCtx, type Out } from './products-flow';

export interface ImportItem { name: string; priceKobo: number; category: string; stock: number | null; description: string; imageUrl?: string | null }
export interface ImportDraft { items: ImportItem[]; skippedNoPrice: string[]; source: string }

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
  let text = `I found *${draft.items.length} product${draft.items.length === 1 ? '' : 's'}* in ${groups.size} categor${groups.size === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}`;
  const withPhotos = draft.items.filter(i => i.imageUrl).length;
  if (withPhotos) text += `\n\n📷 ${withPhotos === draft.items.length ? 'All' : withPhotos} come${withPhotos === 1 ? 's' : ''} with a photo from your file.`;
  if (updates) text += `\n\n${updates} already in your shop will get the new price${withPhotos ? ' and photo' : ''}.`;
  if (draft.skippedNoPrice.length) text += `\n\nNo price found for: ${draft.skippedNoPrice.slice(0, 10).join(', ')}${draft.skippedNoPrice.length > 10 ? '…' : ''}. Add those one by one.`;
  if (text.length > 1000) text = `${text.slice(0, 990)}…`; // WhatsApp button messages allow 1,024 characters
  return [buttons(text, [['imp:all', `Add all ${draft.items.length}`.slice(0, 20)], ['imp:cancel', 'Cancel']])];
}

// Saves the confirmed draft. Returns the messages and how many products were created.
async function apply(f: FlowCtx): Promise<{ out: Out[]; created: number }> {
  const draft = f.state.importDraft;
  if (!draft?.items.length) return { out: ['That list was already added or cancelled. Send it again if you need to.'], created: 0 };
  await saveDraft(f, null);
  await createCategories(f.db, f.business.id, [...new Set(draft.items.map(i => i.category))]);
  const cats = await listCategories(f.db, f.business.id);
  const byName = new Map((await listProducts(f.db, f.business.id)).map(p => [p.name.toLowerCase(), p] as [string, Product]));
  let created = 0, updated = 0;
  for (const it of draft.items) {
    const cat = findCategory(cats, it.category) ?? cats[0];
    const existing = byName.get(it.name.toLowerCase());
    try {
      if (existing) {
        await f.db.update(f.db.doc(C.products, existing.id), { priceKobo: it.priceKobo, ...(it.stock !== null ? { stock: it.stock } : {}), ...(it.imageUrl ? { images: [it.imageUrl, ...existing.images.filter(u => u !== it.imageUrl)].slice(0, 10) } : {}), updatedAt: new Date().toISOString() });
        updated++;
      } else {
        await createProduct(f.db, { businessId: f.business.id, name: it.name, priceKobo: it.priceKobo, stock: it.stock, categoryId: cat.id, description: it.description, images: it.imageUrl ? [it.imageUrl] : [] });
        created++;
      }
    } catch (e) { log('warn', 'import_item_failed', { businessId: f.business.id, error: String(e instanceof Error ? e.message : e).slice(0, 120) }); }
  }
  const usedCats = new Set(draft.items.map(i => i.category.toLowerCase())).size;
  return { out: [`Done ✅ Added ${created} product${created === 1 ? '' : 's'} in ${usedCats} categor${usedCats === 1 ? 'y' : 'ies'}${updated ? ` and updated ${updated}` : ''}. Send PRODUCTS to see them.`], created };
}

export interface ImportResult { out: Out[]; created: number }

// Handles anything that looks like a whole menu, plus the Add all / Cancel taps. Returns null when the
// message isn't a bulk upload, so the caller carries on as usual.
export async function handleImport(f: FlowCtx, input: Input, text: string, accessToken: string | undefined, notify: (o: Out) => Promise<unknown>): Promise<ImportResult | null> {
  if (input.choiceId === 'imp:all') return apply(f);
  if (input.choiceId === 'imp:cancel') { await saveDraft(f, null); return { out: ['Cancelled. Nothing was added.'], created: 0 }; }
  if (input.choiceId) return null;

  // A pasted list: rules, no AI.
  if (!input.document && !input.imageId) {
    const items = parsePastedMenu(text);
    if (!items) return null;
    const fallback = defaultCategory(f);
    const draft = { items: items.slice(0, MAX_ITEMS).map(i => ({ ...i, category: i.category || fallback })), skippedNoPrice: [], source: 'text' };
    await saveDraft(f, draft);
    return { out: await preview(f, draft), created: 0 };
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
        const draft = { items: items.slice(0, MAX_ITEMS).map(i => ({ ...i, category: i.category || fallback })), skippedNoPrice: [], source: 'file' };
        await saveDraft(f, draft);
        return { out: await preview(f, draft), created: 0 };
      }
    } catch (e) { log('warn', 'catalog_read_failed', { businessId: f.business.id, error: String(e instanceof Error ? e.message : e).slice(0, 160) }); }
  }
  if (!f.deps.llm?.readCatalog || !accessToken) return { out: ["I can't read files or photos of menus right now. Paste your list as a message instead, one product per line, e.g.\nJollof rice 2500\nFried chicken 1800"], created: 0 };

  await notify(input.document ? `📄 Reading ${input.document.filename}… this can take a few seconds.` : '📷 Reading your menu… this can take a few seconds.');
  try {
    const media = await fetchMedia(f.cfg, f.deps, accessToken, file.id);
    if (media.bytes.byteLength > MAX_CATALOG_BYTES) return { out: ['That file is too big (over 15 MB). Send a smaller PDF or a photo of each page.'], created: 0 };
    const mimeType = input.document ? input.document.mimeType : media.mimeType;
    const cats = (await listCategories(f.db, f.business.id)).map(c => c.name);
    // Product photos inside a PDF are saved and offered to the model to match with items.
    const photos = mimeType === 'application/pdf' ? await extractPdfImages(media.bytes, MAX_PHOTOS).catch(() => []) : [];
    const photoUrls = await storePhotos(f, photos);
    const raw = await f.deps.llm.readCatalog({ file: { mimeType, bytes: media.bytes }, businessType: BUSINESS_TYPES.find(t => t.id === f.business.category)?.label, categories: cats, images: photos.slice(0, photoUrls.length) });
    const { items, skippedNoPrice } = cleanItems(raw, defaultCategory(f), photoUrls);
    if (!items.length) {
      return { out: [input.imageId && !input.document
        ? "I couldn't find products with prices in that photo. To add one product, send its photo with the name and price as the caption, e.g. *Black AF1 25k*."
        : "I couldn't find products with prices in that file. Try a clearer PDF or photo, or paste the list as a message."], created: 0 };
    }
    const draft = { items, skippedNoPrice, source: input.document ? 'file' : 'photo' };
    await saveDraft(f, draft);
    return { out: await preview(f, draft), created: 0 };
  } catch (e) {
    log('warn', 'catalog_read_failed', { businessId: f.business.id, error: String(e instanceof Error ? e.message : e).slice(0, 160) });
    return { out: ["Sorry, I couldn't read that. Try again, send a clearer PDF or photo, or paste the list as a message."], created: 0 };
  }
}
