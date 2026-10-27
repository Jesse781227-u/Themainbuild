import 'dotenv/config';import {z} from 'zod';
const optionalUrl=z.string().url().optional();
const schema=z.object({
  RELAY_ENV:z.enum(['development','staging','production']).default('development'),
  API_BASE_URL:z.string().url().default('http://localhost:4000'),
  WEB_BASE_URL:z.string().url().default('http://localhost:5173'),
  CORS_ORIGIN:z.string().default('http://localhost:5173'),
  PORT:z.coerce.number().int().positive().default(4000),
  FIREBASE_ADMIN_PROJECT_ID:z.string().optional(),FIREBASE_ADMIN_CLIENT_EMAIL:z.string().email().optional(),FIREBASE_ADMIN_PRIVATE_KEY:z.string().optional(),FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE:z.string().optional(),
  TOKEN_ENCRYPTION_KEY:z.string().optional(),
  FIRESTORE_EMULATOR_HOST:z.string().optional(),FIREBASE_AUTH_EMULATOR_HOST:z.string().optional(),
  RATE_LIMIT_WINDOW_MS:z.coerce.number().int().positive().default(60000),RATE_LIMIT_MAX:z.coerce.number().int().positive().default(100),
  BACKS_IO_API_BASE_URL:optionalUrl,UBER_DIRECT_CLIENT_ID:z.string().optional(),N8N_WEBHOOK_SECRET:z.string().optional()
});
export function parseConfig(env:NodeJS.ProcessEnv=process.env){
const parsed=schema.parse(env);
if(parsed.RELAY_ENV!=='development'){
  if(!parsed.FIREBASE_ADMIN_PROJECT_ID||(!parsed.FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE&&(!parsed.FIREBASE_ADMIN_CLIENT_EMAIL||!parsed.FIREBASE_ADMIN_PRIVATE_KEY)))throw new Error('Missing Firebase Admin credentials for non-development environment.');
  if(!parsed.TOKEN_ENCRYPTION_KEY||parsed.TOKEN_ENCRYPTION_KEY.length<64)throw new Error('TOKEN_ENCRYPTION_KEY must be at least 64 hex characters outside development.');
  if(!parsed.N8N_WEBHOOK_SECRET||parsed.N8N_WEBHOOK_SECRET.length<32)throw new Error('N8N_WEBHOOK_SECRET must be at least 32 characters outside development.');
}
return parsed;
}
export const config=parseConfig();
