// One row per onboarding step entered or completed, so drop-off and time per step can be measured.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { randomId } from '../lib/crypto';
import { log } from '../lib/logger';

export async function trackStep(db: Firestore, e: { ownerPhone: string; businessId: string | null; step: string; event: 'entered' | 'completed' | 'skipped'; extra?: Record<string, unknown> }) {
  const at = new Date().toISOString();
  try {
    await db.set(db.doc(C.onboardingEvents, `${at}_${randomId(6).replace(/[^A-Za-z0-9]/g, 'x')}`), { ownerPhone: e.ownerPhone, businessId: e.businessId, step: e.step, event: e.event, at, ...(e.extra ?? {}) });
  } catch (err) { log('warn', 'onboarding_event_failed', { error: String(err instanceof Error ? err.message : err).slice(0, 120) }); }
}
