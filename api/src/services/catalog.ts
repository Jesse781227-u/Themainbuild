import { z } from 'zod';
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { increment } from '../lib/firestore';
import { randomId } from '../lib/crypto';
import type { Product } from '../domain/commerce';

const iso = () => new Date().toISOString();

export const productInput = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  businessId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(''),
  priceKobo: z.number().int().min(0),
  images: z.array(z.string().url()).max(10).default([]),
  categoryId: z.string().nullable().optional(),
  available: z.boolean().default(true),
  stock: z.number().int().min(0).default(0),
  lowStockThreshold: z.number().int().min(0).default(5),
});

// A product id that already belongs to another business can never be taken over.
export async function createProduct(db: Firestore, input: z.input<typeof productInput>) {
  const v = productInput.parse(input);
  const id = v.id ?? randomId(9);
  const at = iso();
  const product: Product = { ...v, id, categoryId: v.categoryId ?? null, createdAt: at, updatedAt: at, deletedAt: null };
  return db.runTransaction(async tx => {
    const existing = await tx.get(db.doc(C.products, id));
    if (existing && existing.businessId !== v.businessId) throw new Error('PRODUCT_ID_TAKEN');
    if (existing) throw new Error('PRODUCT_EXISTS');
    tx.create(db.doc(C.products, id), { ...product });
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
  return rows.filter(p => !p.deletedAt && (!opts.availableOnly || (p.available && p.stock > 0))).sort((a, b) => a.name.localeCompare(b.name));
}

// Restock (+) or correct (-) stock. Scoped: another business's product is NOT_FOUND.
export async function adjustInventory(db: Firestore, productId: string, businessId: string, delta: number, reason: 'restock' | 'adjustment', actor: string) {
  if (!Number.isSafeInteger(delta) || delta === 0) throw new Error('INVALID_DELTA');
  return db.runTransaction(async tx => {
    const ref = db.doc(C.products, productId);
    const p = (await tx.get(ref)) as Product | null;
    if (!p || p.businessId !== businessId || p.deletedAt) throw new Error('NOT_FOUND');
    const next = p.stock + delta;
    if (next < 0) throw new Error('INSUFFICIENT_STOCK');
    const at = iso();
    const movementId = `${productId}_${randomId(8)}`;
    tx.update(ref, { stock: increment(delta), updatedAt: at });
    tx.create(db.doc(C.stockMovements, movementId), { id: movementId, businessId, productId, delta, reason, actor, at });
    return next;
  });
}
