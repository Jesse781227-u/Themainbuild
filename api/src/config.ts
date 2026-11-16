import 'dotenv/config';
import {z} from 'zod';

const optionalUrl = z.string().url().optional();
const hexKey = /^[0-9a-fA-F]{64}$/;

const schema = z.object({
  // Required with no default: a missing value must never silently boot in development mode.
  RELAY_ENV: z.enum(['development', 'staging', 'production'], {required_error: 'RELAY_ENV is required (development, staging or production).'}),
  API_BASE_URL: z.string().url().default('http://localhost:4000'),
  WEB_BASE_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  PORT: z.coerce.number().int().positive().default(4000),
  FIREBASE_ADMIN_PROJECT_ID: z.string().optional(),
  FIREBASE_ADMIN_CLIENT_EMAIL: z.string().email().optional(),
  FIREBASE_ADMIN_PRIVATE_KEY: z.string().optional(),
  FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  BACKS_IO_API_BASE_URL: optionalUrl,
});

export function parseConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(env);
  if (parsed.RELAY_ENV !== 'development') {
    if (!parsed.FIREBASE_ADMIN_PROJECT_ID || (!parsed.FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE && (!parsed.FIREBASE_ADMIN_CLIENT_EMAIL || !parsed.FIREBASE_ADMIN_PRIVATE_KEY))) throw new Error('Missing Firebase Admin credentials for non-development environment.');
    if (!parsed.TOKEN_ENCRYPTION_KEY || !hexKey.test(parsed.TOKEN_ENCRYPTION_KEY)) throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters outside development.');
    if (!parsed.META_APP_SECRET) throw new Error('META_APP_SECRET is required outside development.');
    if (!parsed.META_VERIFY_TOKEN || parsed.META_VERIFY_TOKEN.length < 16) throw new Error('META_VERIFY_TOKEN must be at least 16 characters outside development.');
  }
  return parsed;
}

export const config = parseConfig();
