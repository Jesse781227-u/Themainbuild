// Adding and correcting products by chat, shared by onboarding and the everyday Admin Bot.
//   product line → category (guessed, or asked with buttons) → confirmation card [Correct] [Edit]
// Choice ids: pcat:<categoryId> | pcat:new (category for a pending product), pok:<id>, pedit:<id>,
// setcat:<productId>:<categoryId>.
import { C } from '../db';
import type { Business } from '../domain/business';
import { stockLabel, type Category, type Product } from '../domain/commerce';
import type { Firestore, DocRef } from '../lib/firestore';
import { formatKobo, nairaToKobo } from '../lib/money';
import type { Config } from '../config';
import type { OutboundContent } from '../services/channel';
import { createCategories, createProduct, findCategory, listCategories, listProducts, moveProduct, tidyCategoryName } from '../services/catalog';
import { guessCategory } from './category-guess';
import { buttons, findProducts, list, type BotDeps } from './common';
import { parseProductLine } from './intent';

export interface ProductDraft { name: string; priceKobo: number; stock: number | null; imageUrl: string | null }
export interface ProductFlowState {
  productDraft?: ProductDraft | null;      // waiting for the owner to pick its category
  awaiting?: 'newCategory' | null;         // the next text is a new category's name
  editingProductId?: string | null;        // the next product line corrects this product
  importDraft?: import('./catalog-import').ImportDraft | null; // a menu read in bulk, waiting for Add all
}

export interface FlowCtx { db: Firestore; cfg: Config; deps: BotDeps; business: Business; convRef: DocRef; state: ProductFlowState }
export type Out = OutboundContent | string;

// Size/colour wording is handled with variants (phase B); until then it's dropped from the line.
export const stripVariantWords = (text: string) => text.replace(/\b(sizes?|colou?rs?)\b\s*:?\s*[A-Za-z0-9\-–/ ]*?(?=\s+(?:₦|n)?\d[\d,]*(?:\.\d+)?k?\b|$)/gi, ' ').replace(/\s+/g, ' ').trim();

export function parseProduct(text: string): { name: string; priceKobo: number; stock: number | null } | null {
  const p = parseProductLine(stripVariantWords(text.replace(/^add\s+/i, '')));
  if (!p || !p.name) return null;
  const priceKobo = nairaToKobo(p.price);
  if (priceKobo === null || priceKobo <= 0) return null;
  return { name: p.name.replace(/[,\s]+$/, '').slice(0, 120), priceKobo, stock: p.stock ?? null };
}

export function card(p: Product, categoryName: string): OutboundContent {
  const body = `*${p.name}*\n${formatKobo(p.priceKobo)} · ${categoryName}\nStock: ${p.stock === null ? 'not tracked (always available)' : stockLabel(p)}`;
  const content = buttons(body, [[`pok:${p.id}`, 'Correct'], [`pedit:${p.id}`, 'Edit']]);
  if (p.images[0]) (content.interactive as Record<string, unknown>).header = { type: 'image', image: { link: p.images[0] } };
  return content;
}

const categoryPicker = (body: string, cats: Category[], idFor: (c: Category) => string, withNew: boolean) =>
  list(body, 'Choose category', [...cats.slice(0, withNew ? 9 : 10).map(c => ({ id: idFor(c), title: c.name })), ...(withNew ? [{ id: 'pcat:new', title: '➕ New category' }] : [])], 'Your categories');

async function save(f: FlowCtx, patch: ProductFlowState) {
  Object.assign(f.state, patch);
  await f.db.set(f.convRef, patch as Record<string, unknown>, { merge: true });
}

async function ensureCategories(f: FlowCtx) {
  const cats = await listCategories(f.db, f.business.id);
  return cats.length ? cats : createCategories(f.db, f.business.id, ['General']);
}

async function create(f: FlowCtx, d: ProductDraft, cat: Category): Promise<Out[]> {
  const p = await createProduct(f.db, { businessId: f.business.id, name: d.name, priceKobo: d.priceKobo, stock: d.stock, categoryId: cat.id, images: d.imageUrl ? [d.imageUrl] : [] });
  await save(f, { productDraft: null, awaiting: null });
  return [card(p, cat.name)];
}

// A new product line (or a correction while editing). Returns the messages to send.
export async function addProduct(f: FlowCtx, d: ProductDraft): Promise<Out[]> {
  if (f.state.editingProductId) return correctProduct(f, f.state.editingProductId, d);
  const existing = (await findProducts(f.db, f.business.id, d.name)).find(p => p.name.toLowerCase() === d.name.toLowerCase());
  if (existing) return [await updateExisting(f, existing, d)];
  const cats = await ensureCategories(f);
  const guess = await guessCategory(d.name, cats, f.deps.llm ?? null, d.imageUrl);
  if (guess.confident && guess.category) return create(f, d, guess.category);
  await save(f, { productDraft: d });
  return [categoryPicker(`Which category is *${d.name}* in?`, cats, c => `pcat:${c.id}`, true)];
}

async function updateExisting(f: FlowCtx, existing: Product, d: ProductDraft): Promise<Out> {
  const changes: string[] = [];
  const at = new Date().toISOString();
  const patch: Record<string, unknown> = {};
  if (d.priceKobo !== existing.priceKobo) { patch.priceKobo = d.priceKobo; changes.push(`price ${formatKobo(existing.priceKobo)} → ${formatKobo(d.priceKobo)}`); }
  if (d.stock !== null && d.stock !== existing.stock) { patch.stock = d.stock; changes.push(`stock ${existing.stock ?? 'not tracked'} → ${d.stock}`); }
  if (d.imageUrl) { patch.images = [d.imageUrl, ...existing.images].slice(0, 10); changes.push('new photo'); }
  if (!changes.length) return `You already have ${existing.name}: ${formatKobo(existing.priceKobo)}, ${stockLabel(existing)}. Nothing changed.`;
  await f.db.update(f.db.doc(C.products, existing.id), { ...patch, updatedAt: at });
  return `Updated ${existing.name}: ${changes.join(', ')}.`;
}

async function correctProduct(f: FlowCtx, productId: string, d: ProductDraft): Promise<Out[]> {
  const p = (await f.db.get(f.db.doc(C.products, productId))) as Product | null;
  await save(f, { editingProductId: null });
  if (!p || p.businessId !== f.business.id || p.deletedAt) return ['That product is gone. Send it again as a new product.'];
  const next = { ...p, name: d.name, priceKobo: d.priceKobo, stock: d.stock ?? p.stock, images: d.imageUrl ? [d.imageUrl, ...p.images].slice(0, 10) : p.images };
  await f.db.update(f.db.doc(C.products, p.id), { name: next.name, priceKobo: next.priceKobo, stock: next.stock, images: next.images, updatedAt: new Date().toISOString() });
  const cat = p.categoryId ? (await f.db.get(f.db.doc(C.categories, p.categoryId))) as Category | null : null;
  return [card(next, cat?.name ?? 'No category')];
}

// Button taps and the "new category name" text. Returns null when the input isn't for this flow.
export async function handleProductInput(f: FlowCtx, choiceId: string | null, text: string): Promise<Out[] | null> {
  if (f.state.awaiting === 'newCategory' && !choiceId && text.trim()) {
    const [cat] = await createCategories(f.db, f.business.id, [tidyCategoryName(text)]);
    const target = cat ?? findCategory(await listCategories(f.db, f.business.id), text);
    if (!target) return ['Please send a short category name, e.g. Sneakers.'];
    const d = f.state.productDraft;
    await save(f, { awaiting: null });
    return d ? create(f, d, target) : [`Created category ${target.name}.`];
  }
  if (!choiceId) return null;
  const [kind, a, b] = choiceId.split(':');
  if (kind === 'pcat') {
    const d = f.state.productDraft;
    if (!d) return ['That product was already saved. Send PRODUCTS to see your list.'];
    if (a === 'new') { await save(f, { awaiting: 'newCategory' }); return ['What should the new category be called?']; }
    const cat = (await listCategories(f.db, f.business.id)).find(c => c.id === a);
    if (!cat) return ['That category no longer exists. Please pick another.'];
    return create(f, d, cat);
  }
  if (kind === 'pok') return null; // the caller decides what "Correct" leads to
  if (kind === 'pedit') {
    const p = (await f.db.get(f.db.doc(C.products, a))) as Product | null;
    if (!p || p.businessId !== f.business.id || p.deletedAt) return ['That product is gone.'];
    await save(f, { editingProductId: p.id });
    const cats = await listCategories(f.db, f.business.id);
    return [
      categoryPicker(`Editing *${p.name}*. Send the corrected name and price (e.g. "${p.name} ${Math.round(p.priceKobo / 100)}"), or pick a different category:`, cats.filter(c => c.id !== p.categoryId), c => `setcat:${p.id}:${c.id}`, false),
    ];
  }
  if (kind === 'setcat') {
    await save(f, { editingProductId: null });
    try { await moveProduct(f.db, f.business.id, a, b); } catch { return ['I couldn\'t move that product. Send PRODUCTS to check it.']; }
    const [p, cat] = await Promise.all([f.db.get(f.db.doc(C.products, a)), f.db.get(f.db.doc(C.categories, b))]) as [Product | null, Category | null];
    return p && cat ? [card(p, cat.name)] : ['Moved.'];
  }
  return null;
}

// What customers will see for the first category with products (a carousel in phase C).
export async function customerPreview(f: FlowCtx): Promise<OutboundContent | null> {
  const [cats, products] = await Promise.all([listCategories(f.db, f.business.id), listProducts(f.db, f.business.id, { availableOnly: true })]);
  const cat = cats.find(c => products.some(p => p.categoryId === c.id));
  if (!cat) return null;
  const items = products.filter(p => p.categoryId === cat.id);
  return list(`${cat.name} at ${f.business.name}:`, 'See products', items.slice(0, 10).map(p => ({ id: `preview:${p.id}`, title: p.name, description: formatKobo(p.priceKobo) })), cat.name);
}
