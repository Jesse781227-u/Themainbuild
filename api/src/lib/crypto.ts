// node:crypto is available on Workers through the nodejs_compat flag.
import crypto from 'node:crypto';
import type { Config } from '../config';

// Outside development the key must be 64 hex characters (config enforces this at startup too); the
// derived fallback key is only ever used in development, never with real tokens.
function key(cfg: Pick<Config, 'RELAY_ENV' | 'TOKEN_ENCRYPTION_KEY'>) {
  const raw = cfg.TOKEN_ENCRYPTION_KEY ?? '';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (cfg.RELAY_ENV !== 'development') throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters outside development.');
  return crypto.createHash('sha256').update(raw || 'relay-development-key').digest();
}

export function encrypt(value: string, cfg: Pick<Config, 'RELAY_ENV' | 'TOKEN_ENCRYPTION_KEY'>) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(cfg), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

export function decrypt(value: string, cfg: Pick<Config, 'RELAY_ENV' | 'TOKEN_ENCRYPTION_KEY'>) {
  const [iv, tag, payload] = value.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(cfg), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8');
}

// Constant-time comparison of two strings of any length.
export function safeEqual(received: string, expected: string) {
  const a = crypto.createHash('sha256').update(received).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export const hmacSha256Hex = (secret: string, body: string | Uint8Array) => crypto.createHmac('sha256', secret).update(body).digest('hex');

// Meta signs the raw body with the app secret: "x-hub-signature-256: sha256=<hex>".
export function verifyMetaSignature(raw: Uint8Array, signature: string | undefined | null, appSecret: string | undefined) {
  if (!appSecret || !signature?.startsWith('sha256=')) return false;
  return safeEqual(signature.slice(7).toLowerCase(), hmacSha256Hex(appSecret, raw));
}

export const randomId = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');

// Short, unambiguous order reference for chat ("RLY-7K3QX"): no 0/O/1/I/L.
export function orderRef() {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(5);
  return 'RLY-' + Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}
