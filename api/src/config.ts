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
  // WhatsApp Flows (forms) for Add product, Hours and Delivery: off unless "true" and published in Meta.
  // Smart Reach: message rules and prices (services/messaging-costs.ts). Prices in US dollars per message.
  FREE_ENTRY_WINDOW_HOURS: z.coerce.number().int().min(24).max(168).default(72),
  SERVICE_FREE_PER_MONTH: z.coerce.number().int().min(0).default(1000),
  OWNER_SENT_FREE: optionalString,                 // 'false' if Meta starts billing app-sent messages
  REACH_WEEKLY_CAP: z.coerce.number().int().min(1).max(7).default(1),
  REACH_QUIET_FROM: z.coerce.number().int().min(0).max(23).default(21), // Lagos hour; the same from/to = no quiet hours
  REACH_QUIET_TO: z.coerce.number().int().min(0).max(23).default(8),
  REACH_CONSENT_FROM: z.string().default('2026-11-20T00:00:00.000Z'), // customers before this are opted in unless they said stop
  NGN_PER_USD: z.coerce.number().positive().default(1600),             // PLACEHOLDER rate: set the real one
  MARKETING_USD: z.coerce.number().min(0).default(0.0516),
  UTILITY_USD: z.coerce.number().min(0).default(0.0067),               // PLACEHOLDER
  SERVICE_USD: z.coerce.number().min(0).default(0.004),                // PLACEHOLDER (over the free allowance)
  UTILITY_USD_IS_PLACEHOLDER: optionalString,
  SERVICE_USD_IS_PLACEHOLDER: optionalString,
  FLOWS_ENABLED: optionalString,
  // The internal payout/KYC endpoints (routes/internal.ts) are off unless this is set (24+ characters).
  OPS_API_KEY: z.string().min(24).optional().or(z.literal('').transform(() => undefined)),
  FLOW_ID_ADD_PRODUCT: optionalString,
  FLOW_ID_HOURS: optionalString,
  FLOW_ID_DELIVERY: optionalString,
  // Embedded Signup (the merchant connects their own number).
  META_APP_ID: optionalString,
  META_ES_CONFIG_ID: optionalString,
  // "log" prints outgoing messages instead of calling Meta (local development and the simulator).
  META_SEND_MODE: z.enum(['live', 'log']).default('live'),
  // TODO(jesse): confirm the Instagram messaging API variant (Instagram Login → graph.instagram.com,
  // or Facebook Login → graph.facebook.com) once the Instagram permission is approved (Y9).
  INSTAGRAM_GRAPH_HOST: z.string().default('graph.instagram.com'),
  GEMINI_API_KEY: optionalString,
  // Groq's free tier (services/ai-openai.ts): when set, conversations and quick choices try Groq
  // first and Gemini after; menus, PDFs and photos stay with Gemini.
  GROQ_API_KEY: optionalString,
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  GROQ_FALLBACK_MODEL: z.string().default('llama-3.3-70b-versatile'),
  // TODO(jesse): confirm the Gemini model to use in production.
  GEMINI_MODEL: z.string().default('gemini-3.7-flash'),
  // Tried in order when the main model is busy or too slow (comma separated).
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-flash-latest,gemini-3.1-flash-lite'),
  // The conversation agent (bots/agent.ts): on unless "false"; time and step limits per message.
  AGENT_ENABLED: optionalString,
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(8000),
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(8).default(4),
  // The signup assistant (bots/signup-agent.ts) may take longer: "typing…" shows meanwhile.
  SIGNUP_AGENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(12_000),
  AGENT_FALLBACK_ALERT: z.coerce.number().int().min(1).default(10),   // tell the owner after this many fallbacks in a day
  // Gemini prices for the cost line (USD per million tokens). TODO(jesse): confirm for the model in use.
  GEMINI_IN_USD_PER_M: z.coerce.number().min(0).default(0.3),
  GEMINI_OUT_USD_PER_M: z.coerce.number().min(0).default(2.5),
  OPENAI_API_KEY: optionalString,
  OPENAI_TRANSCRIBE_MODEL: z.string().default('gpt-4o-transcribe'),
  // Message templates (created and approved in Meta, Y11). Used outside the 24-hour window.
  TEMPLATE_LANGUAGE: z.string().default('en'),
  DAILY_SUMMARY_TEMPLATE: z.string().default('relay_daily_summary'),
  BROADCAST_TEMPLATE: z.string().default('relay_shop_update'),
  RECEIPT_TEMPLATE: z.string().default('relay_payment_receipt'),
  // TODO(jesse): Meta's per-message price for marketing templates to Nigerian numbers, in kobo,
  // and who pays it (Terms placeholder). Broadcasts are refused until this is set.
  MARKETING_MESSAGE_COST_KOBO: z.coerce.number().int().positive().optional().or(z.literal('').transform(() => undefined)),
  BROADCAST_MAX_RECIPIENTS: z.coerce.number().int().positive().default(1000),
  BACHS_API_BASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  BACHS_API_KEY: optionalString,
  BACHS_WEBHOOK_SECRET: optionalString,
  FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(300),        // Relay's fee: 3% of the goods
  FEE_CAP_KOBO: z.coerce.number().int().min(0).default(200_000),            // at most ₦2,000
  PROCESSOR_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(150), // Bachs: 1.5% of every transfer (shown to owners only as part of one total)
  PROCESSOR_FEE_CAP_KOBO: z.coerce.number().int().min(0).default(200_000),  // at most ₦2,000
  HOLD_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(30),
  // Relay's own support line: CALL from an owner alerts this number on the Admin Bot.
  SUPPORT_PHONE: z.string().regex(/^\+\d{8,15}$/).default('+2349013406288'),
  // The Terms version owners accept at signup (bump when /terms changes).
  TERMS_VERSION: z.string().default('2026-11-19'),
  // How customers pay. "simulated": a test payment page (no real money) until Bachs is wired in;
  // "transfer": bank details in the chat. Never "simulated" in production.
  PAYMENTS_MODE: z.enum(['simulated', 'transfer']).optional(), // default: simulated, except transfer in production
});

export type Config = z.infer<typeof schema>;

export function parseConfig(env: Record<string, unknown>): Config {
  // Workers pass bindings alongside vars; only string values are config.
  const strings = Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string' || v === undefined));
  const parsed = schema.parse(strings);
  parsed.PAYMENTS_MODE ??= parsed.RELAY_ENV === 'production' ? 'transfer' : 'simulated';
  if (parsed.RELAY_ENV !== 'development') {
    if (!parsed.FIREBASE_PROJECT_ID || !parsed.FIREBASE_CLIENT_EMAIL || !parsed.FIREBASE_PRIVATE_KEY) throw new Error('Missing Firebase service-account credentials for non-development environment.');
    if (!parsed.TOKEN_ENCRYPTION_KEY || !hexKey.test(parsed.TOKEN_ENCRYPTION_KEY)) throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters outside development.');
    if (!parsed.META_APP_SECRET) throw new Error('META_APP_SECRET is required outside development.');
    if (!parsed.META_VERIFY_TOKEN || parsed.META_VERIFY_TOKEN.length < 16) throw new Error('META_VERIFY_TOKEN must be at least 16 characters outside development.');
    if (parsed.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST must not be set outside development.');
    if (parsed.META_SEND_MODE !== 'live') throw new Error('META_SEND_MODE must be "live" outside development.');
    if (parsed.RELAY_ENV === 'production' && parsed.PAYMENTS_MODE === 'simulated') throw new Error('PAYMENTS_MODE must not be "simulated" in production.');
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
