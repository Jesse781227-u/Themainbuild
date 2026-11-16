import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { randomId } from '../lib/crypto';
import type { Order, OrderDelivery } from '../domain/commerce';

const iso = () => new Date().toISOString();

export type DeliveryMethod = OrderDelivery['method'];
export interface DeliveryZone { id: string; businessId: string; name: string; match: string; feeKobo: number; timeframe: string; active: boolean }
export interface DeliveryBatch { id: string; businessId: string; zoneId: string; name: string; cutoffAt: string; dispatchAt: string; status: 'open' | 'closed' | 'dispatched' | 'complete'; createdAt: string }

export async function listZones(db: Firestore, businessId: string) {
  return (await db.query(C.deliveryZones, [['businessId', '==', businessId], ['active', '==', true]])) as unknown as DeliveryZone[];
}

export async function saveZone(db: Firestore, zone: DeliveryZone) { await db.set(db.doc(C.deliveryZones, zone.id), { ...zone }); return zone; }

export async function quoteDelivery(db: Firestore, businessId: string, location: string, method: DeliveryMethod): Promise<OrderDelivery | null> {
  if (method === 'pickup') return { method, feeKobo: 0, timeframe: 'Ready for pickup' };
  const zone = (await listZones(db, businessId)).find(z => location.toLowerCase().includes(z.match.toLowerCase()));
  return zone ? { method, feeKobo: zone.feeKobo, zoneId: zone.id, timeframe: zone.timeframe, address: location } : null;
}

async function loadOrder(db: Firestore, orderId: string, businessId: string) {
  const order = (await db.get(db.doc(C.orders, orderId))) as Order | null;
  if (!order || order.businessId !== businessId) throw new Error('ORDER_NOT_FOUND');
  return order;
}

// Delivery details on an existing order (e.g. owner arranges it after payment). The fee is the
// owner's own; Relay never takes a cut of delivery.
export async function setOrderDelivery(db: Firestore, orderId: string, businessId: string, delivery: OrderDelivery) {
  await loadOrder(db, orderId, businessId);
  await db.update(db.doc(C.orders, orderId), { delivery: { ...delivery }, updatedAt: iso() });
  return loadOrder(db, orderId, businessId);
}

export async function createBatch(db: Firestore, value: Omit<DeliveryBatch, 'id' | 'createdAt' | 'status'>) {
  const batch: DeliveryBatch = { ...value, id: randomId(9), status: 'open', createdAt: iso() };
  await db.create(db.doc(C.deliveryBatches, batch.id), { ...batch });
  return batch;
}

export async function assignBatch(db: Firestore, orderId: string, businessId: string, batchId: string) {
  const batch = (await db.get(db.doc(C.deliveryBatches, batchId))) as DeliveryBatch | null;
  if (!batch || batch.businessId !== businessId || batch.status !== 'open') throw new Error('BATCH_UNAVAILABLE');
  const order = await loadOrder(db, orderId, businessId);
  const delivery: OrderDelivery = { ...(order.delivery ?? { feeKobo: 0 }), method: 'self_arranged', batchId, zoneId: batch.zoneId };
  await db.update(db.doc(C.orders, orderId), { delivery, updatedAt: iso() });
  return loadOrder(db, orderId, businessId);
}
