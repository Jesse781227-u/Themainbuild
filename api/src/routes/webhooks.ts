import { Hono } from 'hono';
import { getConfig } from '../config';
import { getDb } from '../db';
import type { Env } from '../env';
import { safeEqual, verifyMetaSignature } from '../lib/crypto';
import { log } from '../lib/logger';
import { failedStatuses, parseMetaWebhook, saveInbound } from '../services/inbound';
import { recordBachsPayment } from '../services/payments';
import { enqueue } from '../services/queue';
import { applyStatuses, applyTemplateUpdates, parseStatuses, parseTemplateUpdates } from '../services/statuses';
import { bachsAdapter, type BachsAdapter } from '../services/bachs';

export function webhooks(deps: { bachs?: BachsAdapter } = {}) {
  const r = new Hono<{ Bindings: Env }>();
  const bachs = deps.bachs ?? bachsAdapter;

  // Meta's subscription check. Fails closed: with no verify token configured, or a missing/wrong one
  // in the request, it is refused.
  r.get('/meta', c => {
    const expected = getConfig(c.env).META_VERIFY_TOKEN;
    const received = c.req.query('hub.verify_token');
    if (!expected || c.req.query('hub.mode') !== 'subscribe' || typeof received !== 'string' || !safeEqual(received, expected)) return c.body(null, 403);
    return c.text(c.req.query('hub.challenge') ?? '', 200);
  });

  // WhatsApp and Instagram messages. Verify, save each message once, enqueue, ack. All the work
  // happens in the queue consumer so Meta gets its 200 fast.
  r.post('/meta', async c => {
    const cfg = getConfig(c.env);
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (!verifyMetaSignature(raw, c.req.header('x-hub-signature-256'), cfg.META_APP_SECRET)) return c.body(null, 401);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.body(null, 400); }
    for (const s of failedStatuses(body)) log('warn', 'whatsapp_delivery_failed', s);
    const db = getDb(c.env);
    // Delivery receipts and template reviews: small updates, done here (never blocks the 200).
    try {
      await applyStatuses(db, parseStatuses(body));
      await applyTemplateUpdates(db, parseTemplateUpdates(body));
    } catch (e) { log('warn', 'meta_status_update_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 160) }); }
    const ids: string[] = [];
    for (const item of parseMetaWebhook(body)) {
      const id = await saveInbound(db, item);
      if (id) ids.push(id);
    }
    await enqueue(c.env, ids.map(eventId => ({ kind: 'inbound' as const, eventId })));
    return c.body(null, 200);
  });

  // Bachs payment notifications. Idempotent by Bachs's transaction reference.
  r.post('/bachs', async c => {
    const cfg = getConfig(c.env);
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (!bachs.verify(raw, c.req.raw.headers, cfg)) return c.body(null, 401);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.body(null, 400); }
    const event = bachs.parse(body);
    if (!event) { log('warn', 'bachs_webhook_ignored', {}); return c.body(null, 200); }
    const outcome = await recordBachsPayment(getDb(c.env), event);
    log('info', 'bachs_payment', { status: outcome.status, ...('orderId' in outcome ? { orderId: outcome.orderId } : {}) });
    if ('outboxIds' in outcome) await enqueue(c.env, outcome.outboxIds.map(messageId => ({ kind: 'outbox' as const, messageId })));
    return c.body(null, 200);
  });

  return r;
}
