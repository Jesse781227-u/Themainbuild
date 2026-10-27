import { api, clearFirestore, seed, startApi, stopApi } from './helpers';
import { parseConfig } from '../src/config';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

before(async () => { await clearFirestore(); await seed(); await startApi(); });
after(stopApi);

const order = (headers: Record<string, string>) => api('POST', '/api/v1/whatsapp/orders', { headers, body: { cartId: 'none', businessId: 'biz-a' } });

test('whatsapp: orders endpoint rejects when secret unset', async () => {
  delete process.env.N8N_WEBHOOK_SECRET;
  for (const headers of [{}, { 'x-n8n-secret': '' }, { 'x-n8n-secret': 'anything' }] as Record<string, string>[]) assert.equal((await order(headers)).status, 401);
  process.env.N8N_WEBHOOK_SECRET = 's'.repeat(32);
  assert.equal((await order({ 'x-n8n-secret': 'wrong' })).status, 401);
  assert.equal((await order({ 'x-n8n-secret': 's'.repeat(32) })).status, 404);
  delete process.env.N8N_WEBHOOK_SECRET;
});

test('config: production requires N8N_WEBHOOK_SECRET', () => {
  const prod = { RELAY_ENV: 'production', FIREBASE_ADMIN_PROJECT_ID: 'p', FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE: 'sa.json', TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) };
  assert.throws(() => parseConfig(prod), /N8N_WEBHOOK_SECRET/);
  assert.throws(() => parseConfig({ ...prod, N8N_WEBHOOK_SECRET: 'short' }), /N8N_WEBHOOK_SECRET/);
  assert.doesNotThrow(() => parseConfig({ ...prod, N8N_WEBHOOK_SECRET: 'x'.repeat(32) }));
});
