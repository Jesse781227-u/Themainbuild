import { api, clearFirestore, seed, startApi, stopApi } from './helpers';
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
