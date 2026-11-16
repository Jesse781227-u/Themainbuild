import { z } from 'zod';

const hexKey = /^[0-9a-fA-F]{64}$/;
const optionalString = z.string().optional().transform(v => (v === '' ? undefined : v));

const schema = z.object({
  // Required with no default: a missing value must never silently boot in development mode.
  RELAY_ENV: z.enum(['development', 'staging', 'production'], { required_error: 'RELAY_ENV is required (development, staging or production).' }),
  API_BASE_URL: z.string().url().default('http://localhost:8787'),
  FIREBASE_PROJECT_ID: optionalString,
  FIREBASE_CLIENT_EMAIL: optionalString,
  FIREBASE_PRIVATE_KEY: optionalString,
  FIRESTORE_EMULATOR_HOST: optionalString,
  TOKEN_ENCRYPTION_KEY: optionalString,
  META_APP_SECRET: optionalString,
  META_VERIFY_TOKEN: optionalString,
  // TODO(jesse): confirm the Graph API version the Meta app is pinned to.
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v21.0'),
  ADMIN_BOT_PHONE_NUMBER_ID: optionalString,
  ADMIN_BOT_ACCESS_TOKEN: optionalString,
  BACHS_API_BASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  BACHS_API_KEY: optionalString,
  BACHS_WEBHOOK_SECRET: optionalString,
  FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(100),
  FEE_CAP_KOBO: z.coerce.number().int().min(0).default(200_000),
  HOLD_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(30),
});

export type Config = z.infer<typeof schema>;

export function parseConfig(env: Record<string, unknown>): Config {
  // Workers pass bindings alongside vars; only string values are config.
  const strings = Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string' || v === undefined));
  const parsed = schema.parse(strings);
  if (parsed.RELAY_ENV !== 'development') {
    if (!parsed.FIREBASE_PROJECT_ID || !parsed.FIREBASE_CLIENT_EMAIL || !parsed.FIREBASE_PRIVATE_KEY) throw new Error('Missing Firebase service-account credentials for non-development environment.');
    if (!parsed.TOKEN_ENCRYPTION_KEY || !hexKey.test(parsed.TOKEN_ENCRYPTION_KEY)) throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters outside development.');
    if (!parsed.META_APP_SECRET) throw new Error('META_APP_SECRET is required outside development.');
    if (!parsed.META_VERIFY_TOKEN || parsed.META_VERIFY_TOKEN.length < 16) throw new Error('META_VERIFY_TOKEN must be at least 16 characters outside development.');
    if (parsed.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST must not be set outside development.');
  }
  return parsed;
}

// Each isolate parses its env once.
const cache = new WeakMap<object, Config>();
export function getConfig(env: Record<string, unknown>): Config {
  let cfg = cache.get(env);
  if (!cfg) { cfg = parseConfig(env); cache.set(env, cfg); }
  return cfg;
}
