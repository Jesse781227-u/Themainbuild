import { z } from 'zod';
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { increment } from '../lib/firestore';
import { randomId } from '../lib/crypto';
import { tracksStock, type Category, type Product } from '../domain/commerce';

const iso = () => new Date().toISOString();

export const productInput = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  businessId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(''),
  priceKobo: z.number().int().min(0),
  images: z.array(z.string().url()).max(10).default([]),
  categoryId: z.string().min(1), // every product belongs to a category
  available: z.boolean().default(true),
  stock: z.number().int().min(0).nullable().default(null), // null = not tracked
  lowStockThreshold: z.number().int().min(0).default(5),
});

// A product id that already belongs to another business can never be taken over, and the category
// must belong to the same business. The category's productCount moves in the same transaction.
export async function createProduct(db: Firestore, input: z.input<typeof productInput>) {
  const v = productInput.parse(input);
  const id = v.id ?? randomId(9);
  const at = iso();
  const product: Product = { ...v, id, createdAt: at, updatedAt: at, deletedAt: null };
  return db.runTransaction(async tx => {
    const [existing, category] = await tx.getAll([db.doc(C.products, id), db.doc(C.categories, v.categoryId)]);
    if (existing && existing.businessId !== v.businessId) throw new Error('PRODUCT_ID_TAKEN');
    if (existing) throw new Error('PRODUCT_EXISTS');
    if (!category || category.businessId !== v.businessId) throw new Error('CATEGORY_NOT_FOUND');
    tx.create(db.doc(C.products, id), { ...product });
    tx.update(db.doc(C.categories, v.categoryId), { productCount: increment(1), updatedAt: at });
    if (v.stock) tx.create(db.doc(C.stockMovements, `${id}_initial`), { id: `${id}_initial`, businessId: v.businessId, productId: id, delta: v.stock, reason: 'restock', actor: 'owner', at });
    return product;
  });
}

export async function getProduct(db: Firestore, businessId: string, id: string) {
  const p = (await db.get(db.doc(C.products, id))) as Product | null;
  return p && p.businessId === businessId && !p.deletedAt ? p : null;
}

export async function listProducts(db: Firestore, businessId: string, opts: { availableOnly?: boolean } = {}) {
  const rows = (await db.query(C.products, [['businessId', '==', businessId]])) as unknown as Product[];
  return rows.filter(p => !p.deletedAt && (!opts.availableOnly || (p.available && (!tracksStock(p) || p.stock > 0)))).sort((a, b) => a.name.localeCompare(b.name));
}

// Restock (+) or correct (-) stock. Scoped: another business's product is NOT_FOUND. Restocking a
// product that has no stock count starts counting from that number.
export async function adjustInventory(db: Firestore, productId: string, businessId: string, delta: number, reason: 'restock' | 'adjustment', actor: string) {
  if (!Number.isSafeInteger(delta) || delta === 0) throw new Error('INVALID_DELTA');
  return db.runTransaction(async tx => {
    const ref = db.doc(C.products, productId);
    const p = (await tx.get(ref)) as Product | null;
    if (!p || p.businessId !== businessId || p.deletedAt) throw new Error('NOT_FOUND');
    if (!tracksStock(p) && delta < 0) throw new Error('STOCK_NOT_TRACKED');
    const next = (tracksStock(p) ? p.stock : 0) + delta;
    if (next < 0) throw new Error('INSUFFICIENT_STOCK');
    const at = iso();
    const movementId = `${productId}_${randomId(8)}`;
    tx.update(ref, { stock: tracksStock(p) ? increment(delta) : next, updatedAt: at });
    tx.create(db.doc(C.stockMovements, movementId), { id: movementId, businessId, productId, delta, reason, actor, at });
    return next;
  });
}

// Soft-deletes a product and takes it out of its category's count.
export async function deleteProduct(db: Firestore, businessId: string, productId: string) {
  return db.runTransaction(async tx => {
    const p = (await tx.get(db.doc(C.products, productId))) as Product | null;
    if (!p || p.businessId !== businessId || p.deletedAt) throw new Error('NOT_FOUND');
    const at = iso();
    tx.update(db.doc(C.products, productId), { deletedAt: at, available: false, updatedAt: at });
    if (p.categoryId) tx.update(db.doc(C.categories, p.categoryId), { productCount: increment(-1), updatedAt: at });
  });
}

// ── Categories ──

export const slugify = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'category';

// "sneakers" → "Sneakers"; text the owner already capitalised is kept as typed.
export const tidyCategoryName = (name: string) => {
  const t = name.trim().replace(/\s+/g, ' ').slice(0, 24);
  return t === t.toLowerCase() ? t.replace(/\b\p{L}/gu, ch => ch.toUpperCase()) : t;
};

// "Sneakers, slides and bags" / one per line → ["Sneakers", "Slides", "Bags"], de-duplicated.
export function parseCategoryList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,\n;]|\s+and\s+|\s*&\s*|\s*·\s*/i)) {
    const name = tidyCategoryName(raw.replace(/^[-•*\d.)\s]+/, ''));
    if (name.length < 2 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out.slice(0, 10);
}

export async function listCategories(db: Firestore, businessId: string) {
  const rows = (await db.query(C.categories, [['businessId', '==', businessId]])) as unknown as Category[];
  return rows.filter(c => c.active !== false).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export const findCategory = (cats: Category[], query: string) => {
  const q = query.trim().toLowerCase();
  return cats.find(c => c.name.toLowerCase() === q || c.slug === slugify(q)) ?? null;
};

// Creates the named categories that don't exist yet (case-insensitive), appended in order.
export async function createCategories(db: Firestore, businessId: string, names: string[]) {
  const existing = await listCategories(db, businessId);
  const at = iso();
  let order = existing.reduce((m, c) => Math.max(m, c.sortOrder), -1);
  const created: Category[] = [];
  const batch = db.batch();
  for (const name of names.map(tidyCategoryName)) {
    if (!name || findCategory([...existing, ...created], name)) continue;
    const c: Category = { id: `${businessId}_${randomId(6).replace(/[^A-Za-z0-9]/g, 'x')}`, businessId, name, slug: slugify(name), sortOrder: ++order, productCount: 0, coverImage: null, active: true, createdAt: at, updatedAt: at };
    batch.set(db.doc(C.categories, c.id), { ...c });
    created.push(c);
  }
  if (created.length) await batch.commit();
  return created;
}

export async function renameCategory(db: Firestore, businessId: string, categoryId: string, name: string) {
  const tidy = tidyCategoryName(name);
  const cats = await listCategories(db, businessId);
  const clash = findCategory(cats, tidy);
  if (clash && clash.id !== categoryId) throw new Error('CATEGORY_EXISTS');
  if (!cats.some(c => c.id === categoryId)) throw new Error('NOT_FOUND');
  await db.update(db.doc(C.categories, categoryId), { name: tidy, slug: slugify(tidy), updatedAt: iso() });
  return tidy;
}

// A category with products can't be deleted: move them first (moveCategoryProducts).
export async function deleteCategory(db: Firestore, businessId: string, categoryId: string) {
  return db.runTransaction(async tx => {
    const c = (await tx.get(db.doc(C.categories, categoryId))) as Category | null;
    if (!c || c.businessId !== businessId) throw new Error('NOT_FOUND');
    if (c.productCount > 0) throw new Error('CATEGORY_NOT_EMPTY');
    tx.delete(db.doc(C.categories, categoryId));
  });
}

// Moves one product to another category of the same business.
export async function moveProduct(db: Firestore, businessId: string, productId: string, toCategoryId: string) {
  return db.runTransaction(async tx => {
    const [p, to] = (await tx.getAll([db.doc(C.products, productId), db.doc(C.categories, toCategoryId)])) as [Product | null, Category | null];
    if (!p || p.businessId !== businessId || p.deletedAt) throw new Error('NOT_FOUND');
    if (!to || to.businessId !== businessId) throw new Error('CATEGORY_NOT_FOUND');
    if (p.categoryId === toCategoryId) return false;
    const at = iso();
    tx.update(db.doc(C.products, productId), { categoryId: toCategoryId, updatedAt: at });
    if (p.categoryId) tx.update(db.doc(C.categories, p.categoryId), { productCount: increment(-1), updatedAt: at });
    tx.update(db.doc(C.categories, toCategoryId), { productCount: increment(1), updatedAt: at });
    return true;
  });
}

// Moves every live product in one category to another (used before deleting a category).
export async function moveCategoryProducts(db: Firestore, businessId: string, fromCategoryId: string, toCategoryId: string) {
  const products = (await listProducts(db, businessId)).filter(p => p.categoryId === fromCategoryId);
  for (const p of products) await moveProduct(db, businessId, p.id, toCategoryId);
  return products.length;
}

// Puts a category at a 0-based position and renumbers the rest.
export async function reorderCategory(db: Firestore, businessId: string, categoryId: string, position: number) {
  const cats = await listCategories(db, businessId);
  const moving = cats.find(c => c.id === categoryId);
  if (!moving) throw new Error('NOT_FOUND');
  const rest = cats.filter(c => c.id !== categoryId);
  rest.splice(Math.max(0, Math.min(position, rest.length)), 0, moving);
  const batch = db.batch();
  const at = iso();
  let changed = 0;
  rest.forEach((c, i) => { if (c.sortOrder !== i) { batch.update(db.doc(C.categories, c.id), { sortOrder: i, updatedAt: at }); changed++; } });
  if (changed) await batch.commit();
  return rest.map(c => c.name);
}
