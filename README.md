# Relay

Relay runs a small business's shop inside WhatsApp (and, next, Instagram DMs), for SMEs in Nigeria. There is no merchant dashboard.

- **Owners** manage their business by chatting with the Relay **Admin Bot** (a Relay-owned WhatsApp number): products, stock, orders, debts and reports, by text or voice note.
- **Customers** message the merchant's **own WhatsApp Business number**, which is connected through Meta Embedded Signup with coexistence. Relay's **Shop Bot** answers there: product carousels, checkout, Bachs payment details, payment confirmation and delivery. It hands over to the owner when it's unsure.

The pivot is in progress on `pivot/whatsapp-native`. The audit, decisions and phase plan are in [docs/PIVOT_AUDIT.md](docs/PIVOT_AUDIT.md). The pre-pivot web app is preserved at the tag `pre-pivot`.

## Architecture

- **`relay-api`**: Express + Firebase Admin + zod on Render. It owns all data and all bot logic. Meta and Bachs webhooks are signature-verified, idempotent, and saved before they are acknowledged.
- **Firestore**: flat top-level collections, each document carrying a `businessId`. No client access (deny-all rules). Only the API reads and writes, through the Admin SDK.
- **AI**: Gemini parses intents and picks typed tools. OpenAI transcribes voice notes. The model never writes to Firestore: tools validate with zod and write within the caller's business.
- **Payments**: Bachs, split at source. Each merchant has their own Bachs account; Relay takes 1% of the goods (capped at ₦2,000, never on delivery), paid by the customer on top. All money is integer kobo.
- **Scheduled jobs**: a Cloudflare Worker cron calls secret-protected internal API endpoints (stock-hold release, the 20:00 Africa/Lagos daily summary).

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

[render.yaml](render.yaml) defines one service, `relay-api`, with `/health` as its health check. Set the variables from [.env.example](.env.example) on Render. Outside development the API refuses to start without:
- Firebase Admin credentials;
- a 64-hex-character `TOKEN_ENCRYPTION_KEY`;
- `META_APP_SECRET`;
- a `META_VERIFY_TOKEN` of at least 16 characters.

Paste `FIREBASE_ADMIN_PRIVATE_KEY` with escaped newlines (`\n`). Development, staging and production use separate Firebase projects, Render services and provider credentials. Never commit any of them.

## Tracker

`npm run tracker` serves the phase tracker at http://localhost:4700 ([tools/mvp-tracker/tasks.mjs](tools/mvp-tracker/tasks.mjs)).
