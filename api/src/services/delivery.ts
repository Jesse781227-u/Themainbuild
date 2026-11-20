import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { randomId } from '../lib/crypto';
import type { Order, OrderDelivery } from '../domain/commerce';
import { expandAliases } from './location';

const iso = () => new Date().toISOString();

export type DeliveryMethod = OrderDelivery['method'];
// priority: which zone wins when an address matches several (signup sets area 2, city 1, other states 0).
export interface DeliveryZone { id: string; businessId: string; name: string; match: string; feeKobo: number; timeframe: string; active: boolean; priority?: number }

// Most specific first: higher priority, then the longer match; an empty match (any address) comes last.
export const byPriority = (a: DeliveryZone, b: DeliveryZone) => (b.match ? 1 : 0) - (a.match ? 1 : 0) || (b.priority ?? 1) - (a.priority ?? 1) || b.match.length - a.match.length;
export interface DeliveryBatch { id: string; businessId: string; zoneId: string; name: string; cutoffAt: string; dispatchAt: string; status: 'open' | 'closed' | 'dispatched' | 'complete'; createdAt: string }

export async function listZones(db: Firestore, businessId: string) {
  return (await db.query(C.deliveryZones, [['businessId', '==', businessId], ['active', '==', true]])) as unknown as DeliveryZone[];
}

export async function saveZone(db: Firestore, zone: DeliveryZone) { await db.set(db.doc(C.deliveryZones, zone.id), { ...zone }); return zone; }

// Words in an address that never name an area ("12 Olawale Street, off Diya Road" → olawale, diya).
const NOT_A_PLACE = /^(street|str|road|close|crescent|avenue|estate|phase|lagos|state|nigeria|off|near|opposite|beside|behind|junction|bus|stop|lane|drive|house|flat|plot|block|area|side|by|the|and|new|old|along|inside|axis|express|expressway|way)$/;

// Where a customer's address falls: the zone it names in full; else the one zone a word of it
// names ("gbagada" → Gbagada Phase 2); else, when several do, the choices; else the shop's
// "anywhere else" price; else nothing.
export type Resolved = { quote: OrderDelivery } | { choices: DeliveryZone[] } | null;
export async function resolveDelivery(db: Firestore, businessId: string, location: string): Promise<Resolved> {
  const zones = (await listZones(db, businessId)).sort(byPriority);
  const where = expandAliases(location).toLowerCase();
  const quote = (z: DeliveryZone): { quote: OrderDelivery } => ({ quote: { method: 'self_arranged', feeKobo: z.feeKobo, zoneId: z.id, timeframe: z.timeframe, address: location } });
  const specific = zones.filter(z => z.match);
  const exact = specific.find(z => where.includes(z.match.toLowerCase()));
  if (exact) return quote(exact);
  const words = where.split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !/^\d+$/.test(w) && !NOT_A_PLACE.test(w));
  const partial = words.length ? specific.filter(z => `${z.match} ${z.name}`.toLowerCase().split(/[^a-z0-9]+/).some(zw => words.includes(zw))) : [];
  const seen = new Set<string>();
  const unique = partial.filter(z => !seen.has(z.id) && !!seen.add(z.id)).sort((a, b) => a.name.localeCompare(b.name));
  if (unique.length === 1) return quote(unique[0]);
  if (unique.length > 1) return { choices: unique.slice(0, 10) };
  const anywhere = zones.find(z => !z.match);
  return anywhere ? quote(anywhere) : null;
}

// "gbagada" alone names the area but not the door: a rider needs a street, house number or landmark.
export function needsStreet(address: string | null | undefined, zone: Pick<DeliveryZone, 'name' | 'match'> | null): boolean {
  if (!address || !zone) return false;
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2);
  const known = new Set([...words(zone.name), ...words(zone.match)]);
  return !words(address).some(w => !known.has(w) && (!NOT_A_PLACE.test(w) || /\d/.test(w)));
}

export async function quoteDelivery(db: Firestore, businessId: string, location: string, method: DeliveryMethod): Promise<OrderDelivery | null> {
  if (method === 'pickup') return { method, feeKobo: 0, timeframe: 'Ready for pickup' };
  const r = await resolveDelivery(db, businessId, location);
  return r && 'quote' in r ? { ...r.quote, method } : null;
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
