// Adding and correcting products by chat, shared by onboarding and the everyday Admin Bot.
//   product line → category (guessed, or asked with buttons) → confirmation card [Correct] [Edit]
// Choice ids: pcat:<categoryId> | pcat:new (category for a pending product), pok:<id>, pedit:<id>,
// setcat:<productId>:<categoryId>.
import { C } from '../db';
import type { Business } from '../domain/business';
import { makeVariants, stockLabel, totalStock, type Category, type Product, type Variant } from '../domain/commerce';
import type { Firestore, DocRef } from '../lib/firestore';
import { formatKobo, nairaToKobo } from '../lib/money';
import type { Config } from '../config';
import type { OutboundContent } from '../services/channel';
import { createCategories, createProduct, findCategory, listCategories, listProducts, moveProduct, tidyCategoryName } from '../services/catalog';
import { guessCategory } from './category-guess';
import { buttons, list, type BotDeps } from './common';
import { parseProductLine } from './intent';
import { productCarousel } from './product-cards';
import { matchProduct, titleCase } from '../services/match';
import { extractOptions, optionSummary, type OptionList } from '../services/options';
import { suggestStatus } from '../services/status-tips';

// options: sizes/colours typed with it ("sizes 40-44 colours black, brown") → one product with variants.
export interface ProductDraft { name: string; priceKobo: number; stock: number | null; imageUrl: string | null; options?: OptionList[] | null }
export interface ProductFlowState {
  productDraft?: ProductDraft | null;      // waiting for the owner to pick its category
  awaiting?: string | null;                // 'newCategory' (a category name) or 'msg:<key>' (a shop message)
  editingProductId?: string | null;        // the next product line corrects this product
  matchIds?: string[] | null;              // "Did you mean …?": products the pending draft might be
  importDraft?: import('./catalog-import').ImportDraft | null; // a menu read in bulk, waiting for Add all
}

export interface FlowCtx { db: Firestore; cfg: Config; deps: BotDeps; business: Business; convRef: DocRef; state: ProductFlowState }
export type Out = OutboundContent | string;

export function parseProduct(text: string): { name: string; priceKobo: number; stock: number | null; options: OptionList[] | null } | null {
  const { rest, options } = extractOptions(text.replace(/^add\s+/i, ''));
  const p = parseProductLine(rest);
  if (!p || !p.name) return null;
  const priceKobo = nairaToKobo(p.price);
  if (priceKobo === null || priceKobo <= 0) return null;
  return { name: p.name.replace(/[,\s]+$/, '').slice(0, 120), priceKobo, stock: p.stock ?? null, options: options.length ? options : null };
}

// New options for a product, keeping the stock and price already set for a size/colour it had.
function variantsFrom(options: OptionList[], old: Variant[] | null | undefined): Variant[] {
  return makeVariants(options).map(v => { const was = old?.find(o => o.label.toLowerCase() === v.label.toLowerCase()); return was ? { ...v, stock: was.stock, priceKobo: was.priceKobo } : v; });
}
const optionsOf = (p: Pick<Product, 'variants' | 'optionNames'>): OptionList[] => (p.optionNames ?? []).map(name => ({ name, values: [...new Set((p.variants ?? []).map(v => v.options[name]).filter(Boolean))] }));

export function card(p: Product, categoryName: string, headline?: string): OutboundContent {
  const opts = p.variants?.length ? `\n${optionSummary(optionsOf(p))}${p.variants.some(v => v.stock !== null) ? `\nStock: ${stockLabel(p)}` : `\nTo count stock per option: *restock ${p.name} ${p.variants[0].label.split(' / ')[0]} 5*`}` : '';
  const stock = p.variants?.length ? opts : p.stock === null ? '' : `\nStock: ${stockLabel(p)}`;
  const body = headline ? `✅ ${headline}${stock}` : `*${p.name}*\n${formatKobo(p.priceKobo)} · ${categoryName}${stock}`;
  const content = buttons(body, [[`pok:${p.id}`, 'Looks right'], [`pedit:${p.id}`, 'Fix it']]);
  if (p.images[0]) (content.interactive as Record<string, unknown>).header = { type: 'image', image: { link: p.images[0] } };
  return content;
}

const categoryPicker = (body: string, cats: Category[], idFor: (c: Category) => string, withNew: boolean) =>
  list(body, 'Pick a category', [...cats.slice(0, withNew ? 9 : 10).map(c => ({ id: idFor(c), title: c.name })), ...(withNew ? [{ id: 'pcat:new', title: '➕ New category' }] : [])], 'Your categories');

async function save(f: FlowCtx, patch: ProductFlowState) {
  Object.assign(f.state, patch);
  await f.db.set(f.convRef, patch as Record<string, unknown>, { merge: true });
}

async function ensureCategories(f: FlowCtx) {
  const cats = await listCategories(f.db, f.business.id);
  return cats.length ? cats : createCategories(f.db, f.business.id, ['General']);
}

async function create(f: FlowCtx, d: ProductDraft, cat: Category, opts: { sayNew?: boolean } = {}): Promise<Out[]> {
  const variants = d.options?.length ? variantsFrom(d.options, null) : null;
  const p = await createProduct(f.db, { businessId: f.business.id, name: titleCase(d.name), priceKobo: d.priceKobo, stock: variants ? null : d.stock, categoryId: cat.id, images: d.imageUrl ? [d.imageUrl] : [], optionNames: variants ? d.options!.map(o => o.name) : null, variants });
  await save(f, { productDraft: null, awaiting: null, matchIds: null });
  await suggestStatus(f.db, f.deps, f.business, { kind: 'new', name: p.name }, { productId: p.id }).catch(() => false);
  return [card(p, cat.name, opts.sayNew ? `Added new product *${p.name}* ${formatKobo(p.priceKobo)} in ${cat.name}.` : undefined)];
}

// A new product line (or a correction while editing). Returns the messages to send.
//   prefer 'update': the owner is fixing their list ("pink crop top 5000" updates Pink Tie-Front Crop
//   Top when that's the one clear match); 'ask': they're adding, so a near match is only suggested.
export async function addProduct(f: FlowCtx, d: ProductDraft, opts: { prefer?: 'update' | 'ask' } = {}): Promise<Out[]> {
  if (f.state.editingProductId) return correctProduct(f, f.state.editingProductId, d);
  const all = await listProducts(f.db, f.business.id);
  const exact = all.find(p => p.name.toLowerCase() === d.name.toLowerCase());
  if (exact) return [await updateExisting(f, exact, d)];
  const m = matchProduct(d.name, all);
  if (m.kind === 'strong' && opts.prefer === 'update') return [await updateExisting(f, m.product, d)];
  if (m.kind !== 'none') {
    const near = m.kind === 'strong' ? [m.product] : m.products;
    await save(f, { productDraft: d, matchIds: near.map(p => p.id) });
    if (near.length === 1) return [buttons(`Did you mean *${near[0].name}* (${formatKobo(near[0].priceKobo)})?`, [[`pmatch:${near[0].id}`, 'Yes, update it'], ['pmatch:new', 'No, add new']])];
    return [list(`Did you mean one of these? Or is *${titleCase(d.name)}* a new product?`, 'Pick one', [...near.map(p => ({ id: `pmatch:${p.id}`, title: p.name, description: `Update to ${formatKobo(d.priceKobo)} (now ${formatKobo(p.priceKobo)})` })), { id: 'pmatch:new', title: 'No, add new' }], 'Your products')];
  }
  return createNew(f, d, { sayNew: opts.prefer === 'update' });
}

async function createNew(f: FlowCtx, d: ProductDraft, opts: { sayNew?: boolean } = {}): Promise<Out[]> {
  const cats = await ensureCategories(f);
  const guess = await guessCategory(d.name, cats, f.deps.llm ?? null, d.imageUrl);
  if (guess.confident && guess.category) return create(f, d, guess.category, opts);
  await save(f, { productDraft: d, matchIds: null });
  return [categoryPicker(`Which category is *${d.name}* in?`, cats, c => `pcat:${c.id}`, true)];
}

async function updateExisting(f: FlowCtx, existing: Product, d: ProductDraft): Promise<Out> {
  const changes: string[] = [];
  const at = new Date().toISOString();
  const patch: Record<string, unknown> = {};
  if (d.priceKobo !== existing.priceKobo) { patch.priceKobo = d.priceKobo; changes.push(`${formatKobo(existing.priceKobo)} → ${formatKobo(d.priceKobo)}`); }
  if (d.options?.length) {
    const variants = variantsFrom(d.options, existing.variants);
    Object.assign(patch, { variants, optionNames: d.options.map(o => o.name), stock: totalStock(variants) });
    changes.push(optionSummary(d.options));
  } else if (d.stock !== null && d.stock !== existing.stock && !existing.variants?.length) { patch.stock = d.stock; changes.push(`stock ${existing.stock ?? 'not tracked'} → ${d.stock}`); }
  if (d.imageUrl) { patch.images = [d.imageUrl, ...existing.images].slice(0, 10); changes.push('new photo'); }
  await save(f, { productDraft: null, matchIds: null });
  if (!changes.length) return `You already have *${existing.name}* at ${formatKobo(existing.priceKobo)}. Nothing changed.`;
  await f.db.update(f.db.doc(C.products, existing.id), { ...patch, updatedAt: at });
  return `Updated *${existing.name}*: ${changes.join(', ')}`;
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
  if (kind === 'pmatch') {
    const d = f.state.productDraft;
    if (!d) return ['That was already saved. Send PRODUCTS to see your list.'];
    if (a === 'new') return createNew(f, d, { sayNew: true });
    const p = (await f.db.get(f.db.doc(C.products, a))) as Product | null;
    if (!p || p.businessId !== f.business.id || p.deletedAt) return createNew(f, d, { sayNew: true });
    return [await updateExisting(f, p, d)];
  }
  if (kind === 'pcat') {
    const d = f.state.productDraft;
    if (!d) return ['That product was already saved. Send PRODUCTS to see your list.'];
    if (a === 'new') { await save(f, { awaiting: 'newCategory' }); return ['What should the new category be called?']; }
    const cat = (await listCategories(f.db, f.business.id)).find(c => c.id === a);
    if (!cat) return ['That category no longer exists. Please pick another.'];
    return create(f, d, cat, { sayNew: true });
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
  // The fullest category, so the preview is a real swipeable carousel when there's more than one product.
  const cat = [...cats].sort((a, b) => products.filter(p => p.categoryId === b.id).length - products.filter(p => p.categoryId === a.id).length)[0];
  const items = cat ? products.filter(p => p.categoryId === cat.id) : [];
  if (!cat || !items.length) return null;
  // Every category has one product so far: show them all together, so it's still a carousel.
  if (items.length === 1 && products.length > 1) return productCarousel(f.cfg, f.business, products, { title: 'Your products', key: 'all' })[0];
  return productCarousel(f.cfg, f.business, items, { title: cat.name, key: cat.id })[0];
}
