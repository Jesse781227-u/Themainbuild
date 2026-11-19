// For the people at Relay who pay out by hand until the Bachs payouts API exists, and who check KYC.
// Off (404) unless OPS_API_KEY is set; every call needs "Authorization: Bearer <OPS_API_KEY>".
//   GET  /api/v1/internal/payouts/:id        the payout and the full bank details to pay it
//   POST /api/v1/internal/payouts/:id        { "status": "paid", "reference": "..." } or { "status": "failed", "reason": "..." }
//   POST /api/v1/internal/kyc/:businessId    { "status": "verified" } or { "status": "rejected", "reason": "..." }
// The owner is told on WhatsApp either way. A failed payout goes back into the wallet.
import { Hono } from 'hono';
import { z } from 'zod';
import { getConfig } from '../config';
import { C, getDb } from '../db';
import type { Env } from '../env';
import { safeEqual } from '../lib/crypto';
import { log } from '../lib/logger';
import { formatKobo } from '../lib/money';
import type { Business } from '../domain/business';
import { adminConversationId } from '../services/conversations';
import { enqueue } from '../services/queue';
import { bankLine, getKyc, kycDetails, settlePayout, type Payout } from '../services/wallet';

const payoutBody = z.union([
  z.object({ status: z.literal('paid'), reference: z.string().trim().max(120).optional() }),
  z.object({ status: z.literal('failed'), reason: z.string().trim().max(200).optional() }),
]);
const kycBody = z.union([z.object({ status: z.literal('verified') }), z.object({ status: z.literal('rejected'), reason: z.string().trim().max(200).optional() })]);

export function internalRoutes() {
  const r = new Hono<{ Bindings: Env }>();

  r.use('*', async (c, next) => {
    const key = getConfig(c.env).OPS_API_KEY;
    if (!key) return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
    const sent = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!sent || !safeEqual(sent, key)) return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Wrong or missing key.' } }, 401);
    await next();
  });

  // Tells the owner, through the outbox (sent inside their 24-hour window).
  const tellOwner = async (env: Env, business: Business, kind: string, key: string, text: string, buttons?: { id: string; title: string }[]) => {
    if (!business.ownerPhone) return;
    const db = getDb(env);
    const id = `${business.id}_${kind}_${key}`.replace(/[^A-Za-z0-9_-]/g, '_');
    const created = await db.create(db.doc(C.outbox, id), { id, businessId: business.id, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone, conversationId: adminConversationId(business.ownerPhone), kind, text, status: 'pending', attempts: 0, createdAt: new Date().toISOString(), ...(buttons ? { buttons } : {}) });
    if (created) await enqueue(env, [{ kind: 'outbox', messageId: id }]);
  };

  r.get('/payouts/:id', async c => {
    const db = getDb(c.env);
    const p = (await db.get(db.doc(C.payouts, c.req.param('id')))) as Payout | null;
    if (!p) return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'No such payout.' } }, 404);
    const kyc = await getKyc(db, p.businessId);
    return c.json({ success: true, payout: p, bank: kyc ? kycDetails(getConfig(c.env), kyc) : null });
  });

  r.post('/payouts/:id', async c => {
    const body = payoutBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Send {"status":"paid"} or {"status":"failed"}.' } }, 400);
    const db = getDb(c.env);
    const id = c.req.param('id');
    const existing = (await db.get(db.doc(C.payouts, id))) as Payout | null;
    if (!existing) return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'No such payout.' } }, 404);
    const res = await settlePayout(db, existing.businessId, id, body.data.status === 'paid' ? { status: 'paid', reference: body.data.reference ?? null } : { status: 'failed', reason: body.data.reason ?? null });
    if (!res.ok) return c.json({ success: false, error: { code: res.reason.toUpperCase(), message: res.reason === 'already_settled' ? `Already ${res.payout?.status}.` : 'No such payout.' } }, 409);
    const business = (await db.get(db.doc(C.businesses, existing.businessId))) as Business | null;
    const p = res.payout;
    if (business) {
      if (p.status === 'paid') await tellOwner(c.env, business, 'payout_paid', id, `✅ ${formatKobo(p.amountKobo)} has been sent to ${p.bank.name} ••${p.bank.last4} (withdrawal ${p.id}).`, [{ id: 'act:wallet', title: 'My wallet' }, { id: 'act:menu', title: 'Menu' }]);
      else await tellOwner(c.env, business, 'payout_failed', id, `⚠️ Withdrawal ${p.id} of ${formatKobo(p.amountKobo)} didn't go through${p.reason ? ` (${p.reason})` : ''}. The money is back in your wallet. Reply *CALL* if you need help.`, [{ id: 'act:wallet', title: 'My wallet' }, { id: 'act:call', title: 'Talk to a person' }]);
    }
    log('info', 'payout_settled', { businessId: existing.businessId, payoutId: id, status: p.status });
    return c.json({ success: true, payout: p });
  });

  r.post('/kyc/:businessId', async c => {
    const body = kycBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Send {"status":"verified"} or {"status":"rejected","reason":"..."}.' } }, 400);
    const db = getDb(c.env);
    const businessId = c.req.param('businessId');
    const kyc = await getKyc(db, businessId);
    if (!kyc) return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'No details submitted for that shop.' } }, 404);
    const reason = body.data.status === 'rejected' ? body.data.reason ?? null : null;
    await db.update(db.doc(C.kyc, businessId), { status: body.data.status, reason, reviewedAt: new Date().toISOString() });
    const business = (await db.get(db.doc(C.businesses, businessId))) as Business | null;
    if (business) {
      if (body.data.status === 'verified') await tellOwner(c.env, business, 'kyc_verified', kyc.submittedAt, `You're verified ✅ You can now withdraw to ${bankLine(kyc)}.`, [{ id: 'act:withdraw', title: 'Withdraw now' }, { id: 'act:menu', title: 'Menu' }]);
      else await tellOwner(c.env, business, 'kyc_rejected', kyc.submittedAt, `We couldn't confirm your bank details${reason ? `: ${reason}` : ''}. Please verify again with the details exactly as your bank has them.`, [{ id: 'act:verify', title: 'Verify again' }, { id: 'act:call', title: 'Talk to a person' }]);
    }
    log('info', 'kyc_reviewed', { businessId, status: body.data.status });
    return c.json({ success: true, status: body.data.status });
  });

  return r;
}
