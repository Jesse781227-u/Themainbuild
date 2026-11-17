// Development only: a demo merchant so the Shop Bot can be tried without a real WhatsApp number.
// Used by scripts/seed-local.ts and the /dev chat page.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { encrypt } from '../lib/crypto';
import type { Config } from '../config';

export const DEMO = { businessId: 'biz-demo', phoneNumberId: 'pn-demo', owner: '+2348030000009', name: 'Mama Put Kitchen' };

export async function seedDemoShop(db: Firestore, cfg: Pick<Config, 'RELAY_ENV' | 'TOKEN_ENCRYPTION_KEY'>) {
  const now = new Date().toISOString();
  const batch = db.batch();
  batch.set(db.doc(C.businesses, DEMO.businessId), { id: DEMO.businessId, name: DEMO.name, category: 'food_beverage', ownerPhone: DEMO.owner, status: 'active', timezone: 'Africa/Lagos', bachsAccountId: null, createdAt: now, updatedAt: now });
  batch.set(db.doc(C.ownerPhones, DEMO.owner), { businessId: DEMO.businessId });
  batch.set(db.doc(C.channelAccounts, `whatsapp_${DEMO.phoneNumberId}`), { id: `whatsapp_${DEMO.phoneNumberId}`, businessId: DEMO.businessId, channel: 'whatsapp', accountId: DEMO.phoneNumberId });
  batch.set(db.doc(C.whatsappConnections, DEMO.businessId), { businessId: DEMO.businessId, status: 'connected', phoneNumberId: DEMO.phoneNumberId, wabaId: 'waba-demo', accessTokenEncrypted: encrypt('local-log-mode-placeholder', cfg), createdAt: now, updatedAt: now });
  const categories = [
    { id: 'demo-cat-meals', name: 'Meals', slug: 'meals', sortOrder: 0 },
    { id: 'demo-cat-drinks', name: 'Drinks', slug: 'drinks', sortOrder: 1 },
  ];
  const products = [
    { id: 'demo-jollof', name: 'Jollof rice', priceKobo: 250_000, stock: 20, categoryId: 'demo-cat-meals' },
    { id: 'demo-chicken', name: 'Fried chicken', priceKobo: 180_000, stock: 15, categoryId: 'demo-cat-meals' },
    { id: 'demo-zobo', name: 'Zobo (50cl)', priceKobo: 50_000, stock: 40, categoryId: 'demo-cat-drinks' },
  ];
  for (const c of categories) {
    batch.set(db.doc(C.categories, c.id), { ...c, businessId: DEMO.businessId, productCount: products.filter(p => p.categoryId === c.id).length, coverImage: null, active: true, createdAt: now, updatedAt: now });
  }
  for (const p of products) {
    batch.set(db.doc(C.products, p.id), { ...p, businessId: DEMO.businessId, description: '', images: [], available: true, lowStockThreshold: 3, createdAt: now, updatedAt: now, deletedAt: null });
  }
  await batch.commit();
  return { ...DEMO, products: products.length };
}
