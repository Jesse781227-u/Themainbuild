import { projectId } from './env';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { app } from '../src/app';
import { adminAuth, adminDb } from '../src/services/firebase-admin';

export { adminDb, projectId };
export const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST!;

let server: Server | undefined;
let baseUrl = '';

export async function startApi() {
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
export async function stopApi() {
  await new Promise(resolve => server ? server.close(resolve) : resolve(undefined));
  await adminDb.terminate().catch(() => undefined);
}

// In emulator mode verifyIdToken also checks the user exists, so users are created on first use.
const users = new Set<string>();
async function ensureUser(uid: string) {
  if (users.has(uid)) return;
  await adminAuth.createUser({ uid }).catch(e => { if (e?.code !== 'auth/uid-already-exists') throw e; });
  users.add(uid);
}

export async function clearFirestore() {
  const res = await fetch(`http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Could not clear the Firestore emulator: ${res.status}`);
}

// The Admin SDK accepts unsigned ID tokens when FIREBASE_AUTH_EMULATOR_HOST is set, so tests can
// sign in as any uid without creating accounts.
export function idToken(uid: string) {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: `https://securetoken.google.com/${projectId}`, aud: projectId, auth_time: now, user_id: uid, sub: uid, iat: now, exp: now + 3600, firebase: { identities: {}, sign_in_provider: 'custom' } })}.`;
}

export async function api(method: string, path: string, opts: { as?: string; business?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.as) { await ensureUser(opts.as); headers.authorization = `Bearer ${idToken(opts.as)}`; }
  if (opts.business) headers['x-business-id'] = opts.business;
  const res = await fetch(baseUrl + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body };
}

const now = () => new Date().toISOString();

// Two businesses, each with an owner, a product, a published storefront, a customer and an order.
export async function seed() {
  const fixture = {
    a: { id: 'biz-a', owner: 'user-a', slug: 'shop-a', product: 'prod-a', customer: 'cust-a', order: 'order-a' },
    b: { id: 'biz-b', owner: 'user-b', slug: 'shop-b', product: 'prod-b', customer: 'cust-b', order: 'order-b' },
  };
  const batch = adminDb.batch();
  for (const f of [fixture.a, fixture.b]) {
    batch.set(adminDb.collection('businesses').doc(f.id), { id: f.id, name: `Business ${f.id}`, ownerId: f.owner, status: 'active', createdAt: now() });
    batch.set(adminDb.collection('businessMemberships').doc(`${f.owner}_${f.id}`), { id: `${f.owner}_${f.id}`, businessId: f.id, userId: f.owner, role: 'owner', joinedAt: now() });
    batch.set(adminDb.collection('products').doc(f.product), { id: f.product, businessId: f.id, name: `Product ${f.id}`, description: '', price: 1000, currency: 'NGN', images: [], availability: true, inventoryQty: 5, lowStockThreshold: 2, channels: { web: true, whatsapp: true }, deletedAt: null });
    batch.set(adminDb.collection('inventory').doc(f.product), { productId: f.product, businessId: f.id, quantity: 5, lowStockThreshold: 2, adjustmentHistory: [] });
    batch.set(adminDb.collection('storefronts').doc(f.slug), { businessId: f.id, slug: f.slug, published: true, name: `Shop ${f.id}`, templateId: 'kitchen-table', updatedAt: now() });
    batch.set(adminDb.collection('customers').doc(f.customer), { id: f.customer, businessId: f.id, name: `Customer ${f.id}`, phone: '08000000000', createdAt: now(), updatedAt: now() });
    batch.set(adminDb.collection('orders').doc(f.order), { id: f.order, businessId: f.id, channel: 'web', items: [{ productId: f.product, qty: 1, priceAtAdd: 1000 }], subtotal: 1000, currency: 'NGN', paymentStatus: 'pending', deliveryStatus: 'pending', orderStatus: 'pending', createdAt: now(), updatedAt: now() });
  }
  await batch.commit();
  return fixture;
}

export async function doc(collection: string, id: string) {
  const snap = await adminDb.collection(collection).doc(id).get();
  return snap.exists ? snap.data()! : null;
}
