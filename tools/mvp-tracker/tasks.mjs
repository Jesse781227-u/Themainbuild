// Relay pivot plan: WhatsApp + Instagram-native rebuild (decisions in docs/PIVOT_AUDIT.md §6).
//
// Phases are gated: the next one starts only when Jesse says go. The dates below are proposed
// targets, not commitments; edit them freely. The tracker groups by `weeks`, which here are phases.
//
// owner 'claude' tasks are only ever marked done by their checks passing. There is no
// manual checkbox for them, so "done" always means the evidence exists in the repo.
// owner 'you' tasks get a checkbox in the UI; some also have checks that tick them
// automatically when the thing is detectable (Java installed, env key set, staging up).
//
// Check kinds:
//   test        a test with this exact name passed in the last API test run
//   has / lacks a regex is present in / absent from a file or directory
//   exists      a file or directory exists
//   envKey      a key is set to a non-empty value in an env file (value is never read out)
//   cmd         a command exits 0
//   merged      a commit is reachable from a branch
//   pushed      a commit exists on some remote branch
//   http        GET <setting URL><path> returns 2xx (URL is set in the tracker's settings)
//   allTests    the last API test run passed, with at least `min` tests

export const plan = {
  title: 'Relay pivot: WhatsApp-native',
  start: '2026-11-16',
  end: '2026-12-18',
  weeks: [
    { n: 1, label: 'Phase 1 · Strip', from: '2026-11-16', to: '2026-11-16', goal: 'Web app, web push, n8n, storefronts and Firebase-auth tenancy are gone; config fails closed; the API builds and every test passes.' },
    { n: 2, label: 'Phase 2 · Foundation', from: '2026-11-17', to: '2026-11-27', goal: 'The API runs on Cloudflare Workers (Hono + Firestore REST, Queues, Cron Triggers); webhooks route to the right bot; channel layer, new data model, Bachs split payments, stock holds that expire, and an idempotent on-paid pipeline.' },
    { n: 3, label: 'Phase 3 · Bots', from: '2026-11-28', to: '2026-12-11', goal: 'An owner onboards and manages stock by chat; a customer browses, checks out and pays on WhatsApp; Instagram DMs get basic replies.' },
    { n: 4, label: 'Phase 4 · Reports & broadcasts', from: '2026-12-12', to: '2026-12-18', goal: 'Owners get the 20:00 daily summary and can broadcast templates to opted-in customers with the cost shown first.' },
  ],
};

const t = name => ({ kind: 'test', name });

export const tasks = [
  // ───────────── Phase 1 · Strip ─────────────
  { id: 'C1', week: 1, due: '2026-11-16', owner: 'claude', title: 'Config fails closed', detail: 'RELAY_ENV required; 64-hex encryption key and Meta secrets required outside development; no fallback key in production; Meta verify fails closed; webhooks exempt from the IP rate limiter.',
    checks: [t('config: RELAY_ENV is required'), t('config: production requires a 64-hex TOKEN_ENCRYPTION_KEY'), t('config: production requires Meta secrets'), t('crypto: no fallback key outside development'), t('meta: webhook verification fails closed'), t('rate limit: webhooks are exempt')] },
  { id: 'C2', week: 1, due: '2026-11-16', owner: 'claude', title: 'n8n, web push, storefront and dashboard code removed',
    checks: [{ kind: 'lacks', path: 'api/src', re: '[Nn]8[Nn]', label: 'no n8n in the API' }, { kind: 'lacks', path: 'api/src', re: 'pushSubscriptions|messaging\\(\\)', label: 'no web push' }, { kind: 'lacks', path: 'api/src', re: 'storefronts', label: 'no storefronts' }, { kind: 'lacks', path: 'api/src', re: 'verifyIdToken', label: 'no Firebase-auth tenancy' }] },
  { id: 'C3', week: 1, due: '2026-11-16', owner: 'claude', title: 'Web app removed; one source of domain types',
    checks: [{ kind: 'lacks', file: 'package.json', re: 'cd web', label: 'root scripts no longer build web' }, { kind: 'exists', path: 'api/src/domain/commerce.ts' }] },
  { id: 'C4', week: 1, due: '2026-11-16', owner: 'claude', title: 'Checkout integrity and tenant isolation still hold at the service level',
    checks: [t('checkout: duplicate lines cannot oversell'), t('checkout: expired cart is rejected'), t('checkout: order snapshots item name and price'), t('tenant: inventory adjust rejects another business product'), t('tenant: delivery method rejects another business order'), t('tenant: batch assignment rejects another business order'), t('tenant: product create cannot overwrite another business product')] },
  { id: 'C5', week: 1, due: '2026-11-16', owner: 'claude', title: 'Firestore denies all client access',
    checks: [t('rules: clients cannot read any collection'), t('rules: clients cannot write any collection')] },

  { id: 'Y1', week: 1, due: '2026-11-18', owner: 'you', title: 'Install Java 21 (and Firebase CLI)', detail: 'So the emulator tests run locally, not only in CI. `winget install EclipseAdoptium.Temurin.21.JDK` then `npm i -g firebase-tools`.',
    checks: [{ kind: 'cmd', run: 'java -version', label: 'java on PATH' }, { kind: 'cmd', run: 'firebase --version', label: 'firebase CLI on PATH' }] },
  { id: 'Y2', week: 1, due: '2026-11-18', owner: 'you', title: 'Shut down the Render services (relay-web and relay-api)', detail: 'Hosting moved to Cloudflare. Deleting render.yaml does not stop running services.', checks: [] },
  { id: 'Y3', week: 1, due: '2026-11-18', owner: 'you', title: 'Start Meta Business Verification and the Tech Provider application', detail: 'Launch blocker for Embedded Signup; Meta review takes weeks.', checks: [] },

  // ───────────── Phase 2 · Foundation ─────────────
  { id: 'Y4', week: 2, due: '2026-11-20', owner: 'you', title: 'Bachs: account, API keys, and docs for sub-accounts, splits and webhooks',
    checks: [{ kind: 'envKey', file: 'api/.env', key: 'BACHS_API_KEY' }, { kind: 'envKey', file: 'api/.env', key: 'BACHS_WEBHOOK_SECRET' }] },
  { id: 'Y5', week: 2, due: '2026-11-20', owner: 'you', title: 'Meta test number + app secrets in api/.env',
    checks: [{ kind: 'envKey', file: 'api/.env', key: 'META_APP_SECRET' }, { kind: 'envKey', file: 'api/.env', key: 'META_VERIFY_TOKEN' }, { kind: 'envKey', file: 'api/.env', key: 'ADMIN_BOT_PHONE_NUMBER_ID' }] },
  { id: 'Y6', week: 2, due: '2026-11-17', owner: 'you', title: 'Cloudflare account (Workers Paid plan for Queues) and a wrangler login', checks: [{ kind: 'cmd', run: 'npx wrangler --version', label: 'wrangler available' }] },
  { id: 'Y7', week: 2, due: '2026-11-27', owner: 'you', title: 'Legal review of the drafted Privacy, Terms and Data Deletion pages', detail: 'Drafts in api/public/. Fill every [bracketed] value, then remove the DRAFT banner.', checks: [{ kind: 'lacks', path: 'api/public', re: '\\[[A-Z]{2,}[A-Z ]*[\\],]', label: 'no [PLACEHOLDER] values left' }, { kind: 'lacks', path: 'api/public', re: 'class="draft"', label: 'draft banner removed' }] },

  { id: 'C0', week: 2, due: '2026-11-19', owner: 'claude', title: 'API runs on Cloudflare Workers', detail: 'Hono instead of Express; Firestore over REST (transactions via beginTransaction/commit) instead of firebase-admin; wrangler.toml with Queues and Cron Triggers.',
    checks: [{ kind: 'exists', path: 'api/wrangler.toml' }, { kind: 'lacks', file: 'api/package.json', re: '"express"', label: 'no Express' }, { kind: 'lacks', file: 'api/package.json', re: 'firebase-admin', label: 'no firebase-admin at runtime' }] },
  { id: 'C6', week: 2, due: '2026-11-19', owner: 'claude', title: 'Phone, money and Lagos-time helpers',
    checks: [t('phone: normalises Nigerian numbers to E.164'), t('money: naira to kobo is exact'), t('money: fee is 1% of goods capped at 2000 naira'), t('time: today boundaries use Africa/Lagos')] },
  { id: 'C7', week: 2, due: '2026-11-20', owner: 'claude', title: 'Webhook router: save pending, ack fast, route to the right bot',
    checks: [t('router: admin bot number routes to admin handler'), t('router: merchant number routes to shop handler'), t('router: unknown number is ignored'), t('webhook: duplicate message is processed once'), t('webhook: queued event is retried after a failure')] },
  { id: 'C8', week: 2, due: '2026-11-21', owner: 'claude', title: 'Channel layer with the 24-hour window guard',
    checks: [t('window: free-form allowed within 24 hours'), t('window: free-form blocked after 24 hours')] },
  { id: 'C9', week: 2, due: '2026-11-24', owner: 'claude', title: 'Stock hold reserves and auto-releases',
    checks: [t('hold: checkout reserves stock until timeout'), t('hold: expired unpaid order releases stock'), t('hold: release is idempotent')] },
  { id: 'C10', week: 2, due: '2026-11-26', owner: 'claude', title: 'Bachs: split payment, unique-amount matching, verified idempotent webhook',
    checks: [t('payments: pending orders get unique amounts per business'), t('payments: webhook rejects bad signature'), t('payments: webhook matches by amount and marks order paid'), t('payments: duplicate webhook is idempotent')] },
  { id: 'C11', week: 2, due: '2026-11-27', owner: 'claude', title: 'On-paid pipeline runs exactly once',
    checks: [t('paid: pipeline is idempotent'), t('paid: updates customer stats, ledger and daily stats')] },
  { id: 'C12', week: 2, due: '2026-11-27', owner: 'claude', title: 'Cron Triggers for hold release and the daily summary',
    checks: [{ kind: 'has', file: 'api/wrangler.toml', re: 'crons', label: 'cron triggers configured' }, t('jobs: scheduled handler releases expired holds')] },

  // ───────────── Phase 3 · Bots ─────────────
  { id: 'Y8', week: 3, due: '2026-11-28', owner: 'you', title: 'Gemini and OpenAI API keys in api/.env',
    checks: [{ kind: 'envKey', file: 'api/.env', key: 'GEMINI_API_KEY' }, { kind: 'envKey', file: 'api/.env', key: 'OPENAI_API_KEY' }] },
  { id: 'Y9', week: 3, due: '2026-12-05', owner: 'you', title: 'Request Instagram messaging permissions in Meta App Review', checks: [] },
  { id: 'Y10', week: 3, due: '2026-12-11', owner: 'you', title: 'Line up 3–5 pilot merchants', checks: [] },

  { id: 'C13', week: 3, due: '2026-12-02', owner: 'claude', title: 'Intent → tool mapping, scoped and confirmed',
    checks: [t('intent: add product maps to addProduct'), t('intent: tools are scoped to the caller business'), t('intent: destructive actions need confirmation'), t('intent: off-topic requests are redirected')] },
  { id: 'C14', week: 3, due: '2026-12-05', owner: 'claude', title: 'Admin Bot onboarding by chat', detail: 'Business info → first products → Embedded Signup link → connected.',
    checks: [t('admin: new owner is onboarded by chat'), t('admin: embedded signup writes waNumbers')] },
  { id: 'C15', week: 3, due: '2026-12-09', owner: 'claude', title: 'Shop Bot: browse → checkout Flow → pay',
    checks: [t('shop: greeting lists categories'), t('shop: checkout flow creates order awaiting payment'), t('shop: returning customer is recognised')] },
  { id: 'C16', week: 3, due: '2026-12-10', owner: 'claude', title: 'Owner takeover until handback',
    checks: [t('takeover: owner reply silences the bot'), t('takeover: handback resumes the bot')] },
  { id: 'C17', week: 3, due: '2026-12-11', owner: 'claude', title: 'Instagram DMs: basic receive and reply',
    checks: [t('instagram: DM routes to the shop handler')] },
  { id: 'C18', week: 3, due: '2026-12-11', owner: 'claude', title: 'Webhook simulator for both bots', checks: [{ kind: 'exists', path: 'api/scripts/simulate-webhook.ts' }] },

  // ───────────── Phase 4 · Reports & broadcasts ─────────────
  { id: 'Y11', week: 4, due: '2026-12-15', owner: 'you', title: 'Get the message templates approved by Meta', detail: 'Daily summary, receipt, broadcast templates.', checks: [] },
  { id: 'C19', week: 4, due: '2026-12-15', owner: 'claude', title: 'Daily summary at 20:00 Lagos',
    checks: [t('summary: daily summary uses Lagos day'), t('summary: uses a template outside the 24-hour window')] },
  { id: 'C20', week: 4, due: '2026-12-17', owner: 'claude', title: 'Broadcasts to opted-in customers with cost shown first',
    checks: [t('broadcast: only opted-in customers are targeted'), t('broadcast: owner sees audience size and cost before sending')] },
  { id: 'C21', week: 4, due: '2026-12-18', owner: 'claude', title: 'Full API test suite green', checks: [{ kind: 'allTests', min: 60 }] },
];
