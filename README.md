# Relay

Relay runs a small business's shop inside WhatsApp (and, next, Instagram DMs), for SMEs in Nigeria. There is no merchant dashboard.

- **Owners** manage their business by chatting with the Relay **Admin Bot** (a Relay-owned WhatsApp number): products, stock, orders, debts and reports, by text or voice note.
- **Customers** message the merchant's **own WhatsApp Business number**, which is connected through Meta Embedded Signup with coexistence. Relay's **Shop Bot** answers there: product carousels, checkout, Bachs payment details, payment confirmation and delivery. It hands over to the owner when it's unsure.

The pivot is in progress on `pivot/whatsapp-native`. The audit, decisions and phase plan are in [docs/PIVOT_AUDIT.md](docs/PIVOT_AUDIT.md). The pre-pivot web app is preserved at the tag `pre-pivot`.

## Architecture

- **API on Cloudflare Workers**: owns all data and all bot logic. Meta and Bachs webhooks are signature-verified, idempotent, saved, acknowledged, then processed from a Cloudflare Queue. *Migration in progress:* the code is still Express + `firebase-admin` until Phase 2 ports it to Hono + Firestore REST.
- **Firestore**: flat top-level collections, each document carrying a `businessId`. No client access (deny-all rules). Only the API reads and writes, using service-account credentials.
- **AI**: Gemini parses intents and picks typed tools. OpenAI transcribes voice notes. The model never writes to Firestore: tools validate with zod and write within the caller's business.
- **Payments**: Bachs, split at source. Each merchant has their own Bachs account; Relay takes 1% of the goods (capped at ₦2,000, never on delivery), paid by the customer on top. All money is integer kobo.
- **Scheduled jobs**: Cron Triggers on the same Worker (stock-hold release, the 20:00 Africa/Lagos daily summary).
- **Meta-required pages**: `api/public/` (Privacy, Terms, Data Deletion), served as static assets. These are drafts awaiting legal review.

## Local development

```text
cd api && npm install
cp ../.env.example .env        # RELAY_ENV is required
cd .. && npm run dev           # Firestore + Storage emulators and the API
```

The emulators need Java 21 and the Firebase CLI.

## Tests

```text
npm run test:emulators --prefix api
```

This runs the API tests against the Firestore emulator under the `demo-relay` project. CI runs the same command on every push.

## Deployment

Cloudflare Workers, set up in Phase 2 with `wrangler.toml`. Secrets are set with `wrangler secret put`, never committed. Outside development the API refuses to start without:
- Firebase service-account credentials;
- a 64-hex-character `TOKEN_ENCRYPTION_KEY`;
- `META_APP_SECRET`;
- a `META_VERIFY_TOKEN` of at least 16 characters.

Development, staging and production use separate Firebase projects, Workers environments and provider credentials.

## Tracker

`npm run tracker` serves the phase tracker at http://localhost:4700 ([tools/mvp-tracker/tasks.mjs](tools/mvp-tracker/tasks.mjs)).
