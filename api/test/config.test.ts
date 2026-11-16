import { api, clearFirestore, startApi, stopApi } from './helpers';
import { parseConfig } from '../src/config';
import { isWebhookPath } from '../src/middleware/rateLimiter';
import { decrypt, encrypt } from '../src/services/whatsapp';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

before(async () => { await clearFirestore(); await startApi(); });
after(stopApi);

const prod = {
  RELAY_ENV: 'production', FIREBASE_ADMIN_PROJECT_ID: 'p', FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE: 'sa.json',
  TOKEN_ENCRYPTION_KEY: 'a'.repeat(64), N8N_WEBHOOK_SECRET: 'x'.repeat(32), META_APP_SECRET: 'meta-secret', META_VERIFY_TOKEN: 'v'.repeat(16),
};

test('config: RELAY_ENV is required', () => {
  const { RELAY_ENV: _, ...rest } = prod;
  assert.throws(() => parseConfig(rest), /RELAY_ENV/);
  assert.throws(() => parseConfig({ ...prod, RELAY_ENV: 'prod' }));
  assert.doesNotThrow(() => parseConfig(prod));
});

test('config: production requires a 64-hex TOKEN_ENCRYPTION_KEY', () => {
  assert.throws(() => parseConfig({ ...prod, TOKEN_ENCRYPTION_KEY: undefined }), /TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => parseConfig({ ...prod, TOKEN_ENCRYPTION_KEY: 'z'.repeat(64) }), /TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => parseConfig({ ...prod, TOKEN_ENCRYPTION_KEY: 'a'.repeat(63) }), /TOKEN_ENCRYPTION_KEY/);
});

test('config: production requires Meta secrets', () => {
  assert.throws(() => parseConfig({ ...prod, META_APP_SECRET: undefined }), /META_APP_SECRET/);
  assert.throws(() => parseConfig({ ...prod, META_VERIFY_TOKEN: undefined }), /META_VERIFY_TOKEN/);
  assert.throws(() => parseConfig({ ...prod, META_VERIFY_TOKEN: 'short' }), /META_VERIFY_TOKEN/);
});

test('config: production requires N8N_WEBHOOK_SECRET', () => {
  assert.throws(() => parseConfig({ ...prod, N8N_WEBHOOK_SECRET: undefined }), /N8N_WEBHOOK_SECRET/);
  assert.throws(() => parseConfig({ ...prod, N8N_WEBHOOK_SECRET: 'short' }), /N8N_WEBHOOK_SECRET/);
});

test('crypto: no fallback key outside development', () => {
  const saved = { env: process.env.RELAY_ENV, key: process.env.TOKEN_ENCRYPTION_KEY };
  try {
    process.env.RELAY_ENV = 'production';
    delete process.env.TOKEN_ENCRYPTION_KEY;
    assert.throws(() => encrypt('token'), /TOKEN_ENCRYPTION_KEY/);
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    assert.equal(decrypt(encrypt('token')), 'token');
  } finally {
    process.env.RELAY_ENV = saved.env;
    if (saved.key === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = saved.key;
  }
});

test('meta: webhook verification fails closed', async () => {
  const verify = (q: string) => api('GET', `/api/v1/webhooks/meta?${q}`);
  const saved = process.env.META_VERIFY_TOKEN;
  try {
    delete process.env.META_VERIFY_TOKEN;
    assert.equal((await verify('hub.mode=subscribe&hub.challenge=123')).status, 403);
    process.env.META_VERIFY_TOKEN = 'v'.repeat(16);
    assert.equal((await verify('hub.mode=subscribe&hub.challenge=123')).status, 403);
    assert.equal((await verify('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123')).status, 403);
    const ok = await verify(`hub.mode=subscribe&hub.verify_token=${'v'.repeat(16)}&hub.challenge=123`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 123);
  } finally {
    if (saved === undefined) delete process.env.META_VERIFY_TOKEN; else process.env.META_VERIFY_TOKEN = saved;
  }
});

test('rate limit: webhooks are exempt', () => {
  assert.equal(isWebhookPath('/api/v1/webhooks/meta'), true);
  assert.equal(isWebhookPath('/api/v1/businesses/x/products'), false);
});
