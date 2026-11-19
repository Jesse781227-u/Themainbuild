// One owner phone can run several shops (each branch is its own shop with its own number, products
// and wallet). ownerPhones/{E.164} = { businessIds[], activeBusinessId, businessId, onboardingStage, ownerName }.
// businessId mirrors activeBusinessId, so older readers (and older records) keep working.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';

export interface OwnerRecord { businessIds: string[]; activeBusinessId: string | null; businessId?: string | null; onboardingStage?: string | null; ownerName?: string | null }

export function readOwner(raw: Record<string, unknown> | null): OwnerRecord | null {
  if (!raw) return null;
  const legacy = typeof raw.businessId === 'string' ? raw.businessId : null;
  const ids = Array.isArray(raw.businessIds) ? (raw.businessIds as unknown[]).map(String) : legacy ? [legacy] : [];
  const active = typeof raw.activeBusinessId === 'string' ? raw.activeBusinessId : legacy ?? ids[0] ?? null;
  return { businessIds: ids, activeBusinessId: active, businessId: active, onboardingStage: (raw.onboardingStage as string) ?? null, ownerName: (raw.ownerName as string) ?? null };
}

export async function getOwner(db: Firestore, phone: string) {
  return readOwner(await db.get(db.doc(C.ownerPhones, phone)));
}

// Adds a shop to the owner's list and makes it the active one.
export async function addShop(db: Firestore, phone: string, businessId: string, extra: { ownerName?: string | null; onboardingStage?: string } = {}) {
  await db.runTransaction(async tx => {
    const owner = readOwner(await tx.get(db.doc(C.ownerPhones, phone)));
    const ids = [...new Set([...(owner?.businessIds ?? []), businessId])];
    tx.set(db.doc(C.ownerPhones, phone), {
      businessIds: ids, activeBusinessId: businessId, businessId,
      ownerName: extra.ownerName ?? owner?.ownerName ?? null,
      onboardingStage: extra.onboardingStage ?? owner?.onboardingStage ?? null,
    });
  });
}

export async function switchShop(db: Firestore, phone: string, businessId: string) {
  const owner = await getOwner(db, phone);
  if (!owner?.businessIds.includes(businessId)) return false;
  await db.set(db.doc(C.ownerPhones, phone), { activeBusinessId: businessId, businessId }, { merge: true });
  return true;
}

// Takes one shop off the owner's list; the record goes when no shops are left.
export async function removeShop(db: Firestore, phone: string, businessId: string) {
  const owner = await getOwner(db, phone);
  if (!owner) return;
  const ids = owner.businessIds.filter(id => id !== businessId);
  if (!ids.length) { await db.delete(db.doc(C.ownerPhones, phone)); return; }
  const active = owner.activeBusinessId === businessId ? ids[ids.length - 1] : owner.activeBusinessId;
  await db.set(db.doc(C.ownerPhones, phone), { businessIds: ids, activeBusinessId: active, businessId: active }, { merge: true });
}
