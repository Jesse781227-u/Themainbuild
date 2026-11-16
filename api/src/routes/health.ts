import { Hono } from 'hono';
import { getConfig } from '../config';
import { getDb } from '../db';
import type { Env } from '../env';

export const health = new Hono<{ Bindings: Env }>();
const ok = (env: Env) => ({ success: true, data: { status: 'ok', service: 'relay-api', environment: getConfig(env).RELAY_ENV } });
health.get('/', c => c.json(ok(c.env)));
health.get('/live', c => c.json(ok(c.env)));
health.get('/deep', async c => {
  let firestore = 'ok';
  try { await getDb(c.env).get({ collection: '_health', id: 'probe' }); } catch { firestore = 'unavailable'; }
  const ready = firestore === 'ok';
  return c.json({ success: ready, data: { status: ready ? 'ok' : 'degraded', checks: { api: 'ok', firestore } } }, ready ? 200 : 503);
});
