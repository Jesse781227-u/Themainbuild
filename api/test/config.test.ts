import { api, testEnv, VERIFY_TOKEN } from './helpers';
import { parseConfig } from '../src/config';
import { isWebhookPath } from '../src/middleware/rateLimiter';
import { decrypt, encrypt } from '../src/lib/crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const prod = {
  RELAY_ENV: 'production', FIREBASE_PROJECT_ID: 'p', FIREBASE_CLIENT_EMAIL: 'sa@p.iam.gserviceaccount.com', FIREBASE_PRIVATE_KEY: 'key',
  TOKEN_ENCRYPTION_KEY: 'a'.repeat(64), META_APP_SECRET: 'meta-secret', META_VERIFY_TOKEN: 'v'.repeat(16),
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

test('config: production refuses the Firestore emulator and missing credentials', () => {
  assert.throws(() => parseConfig({ ...prod, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }), /FIRESTORE_EMULATOR_HOST/);
  assert.throws(() => parseConfig({ ...prod, FIREBASE_PRIVATE_KEY: '' }), /Firebase/);
});

test('crypto: no fallback key outside development', () => {
  assert.throws(() => encrypt('token', { RELAY_ENV: 'production', TOKEN_ENCRYPTION_KEY: undefined }), /TOKEN_ENCRYPTION_KEY/);
  const cfg = { RELAY_ENV: 'production' as const, TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) };
  assert.equal(decrypt(encrypt('token', cfg), cfg), 'token');
});

test('meta: webhook verification fails closed', async () => {
  const verify = (q: string, e = testEnv()) => api('GET', `/api/v1/webhooks/meta?${q}`, { env: e });
  assert.equal((await verify('hub.mode=subscribe&hub.challenge=123', testEnv({ META_VERIFY_TOKEN: undefined }))).status, 403);
  assert.equal((await verify('hub.mode=subscribe&hub.challenge=123')).status, 403);
  assert.equal((await verify('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123')).status, 403);
  const ok = await verify(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=123`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 123);
});

test('rate limit: webhooks are exempt', () => {
  assert.equal(isWebhookPath('/api/v1/webhooks/meta'), true);
  assert.equal(isWebhookPath('/api/v1/webhooks/bachs'), true);
  assert.equal(isWebhookPath('/health'), false);
});
