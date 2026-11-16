import { projectId } from './env';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { app } from '../src/app';
import { adminDb } from '../src/services/firebase-admin';

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

export async function clearFirestore() {
  const res = await fetch(`http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Could not clear the Firestore emulator: ${res.status}`);
}

export async function api(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  const res = await fetch(baseUrl + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body };
}

const now = () => new Date().toISOString();

// Two businesses, each with an owner, a product, a customer and an order.
export async function seed() {
  const fixture = {
    a: { id: 'biz-a', owner: 'user-a', product: 'prod-a', customer: 'cust-a', order: 'order-a' },
    b: { id: 'biz-b', owner: 'user-b', product: 'prod-b', customer: 'cust-b', order: 'order-b' },
  };
  const batch = adminDb.batch();
  for (const f of [fixture.a, fixture.b]) {
    batch.set(adminDb.collection('businesses').doc(f.id), { id: f.id, name: `Business ${f.id}`, ownerId: f.owner, status: 'active', createdAt: now() });
    batch.set(adminDb.collection('businessMemberships').doc(`${f.owner}_${f.id}`), { id: `${f.owner}_${f.id}`, businessId: f.id, userId: f.owner, role: 'owner', joinedAt: now() });
    batch.set(adminDb.collection('products').doc(f.product), { id: f.product, businessId: f.id, name: `Product ${f.id}`, description: '', price: 1000, currency: 'NGN', images: [], availability: true, inventoryQty: 5, lowStockThreshold: 2, channels: { web: true, whatsapp: true }, deletedAt: null });
    batch.set(adminDb.collection('inventory').doc(f.product), { productId: f.product, businessId: f.id, quantity: 5, lowStockThreshold: 2, adjustmentHistory: [] });
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
