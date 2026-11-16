# Relay

Relay runs a small business's shop inside WhatsApp (and, next, Instagram DMs), for SMEs in Nigeria. There is no merchant dashboard.

- **Owners** manage their business by chatting with the Relay **Admin Bot** (a Relay-owned WhatsApp number): products, stock, orders, debts and reports, by text or voice note.
- **Customers** message the merchant's **own WhatsApp Business number**, which is connected through Meta Embedded Signup with coexistence. Relay's **Shop Bot** answers there: product carousels, checkout, Bachs payment details, payment confirmation and delivery. It hands over to the owner when it's unsure.

The pivot is in progress on `pivot/whatsapp-native`. The audit, decisions and phase plan are in [docs/PIVOT_AUDIT.md](docs/PIVOT_AUDIT.md). The pre-pivot web app is preserved at the tag `pre-pivot`.

## Architecture

- **API on Cloudflare Workers**: owns all data and all bot logic. Meta and Bachs webhooks are signature-verified, idempotent, saved, acknowledged, then processed from a Cloudflare Queue. Hono on Workers, talking to Firestore over REST (`api/src/lib/firestore.ts`), with Workers Assets for the legal pages and R2 for product images.
- **Firestore**: flat top-level collections, each document carrying a `businessId`. No client access (deny-all rules). Only the API reads and writes, using service-account credentials.
- **AI**: Gemini parses intents and picks typed tools. OpenAI transcribes voice notes. The model never writes to Firestore: tools validate with zod and write within the caller's business.
- **Payments**: Bachs, split at source. Each merchant has their own Bachs account; Relay takes 1% of the goods (capped at ₦2,000, never on delivery), paid by the customer on top. All money is integer kobo.
- **Scheduled jobs**: Cron Triggers on the same Worker (stock-hold release, the 20:00 Africa/Lagos daily summary).
- **Meta-required pages**: `api/public/` (Privacy, Terms, Data Deletion), served as static assets. These are drafts awaiting legal review.

## Local development

```text
cd api && npm install
cp .dev.vars.example .dev.vars   # secrets for `wrangler dev`; RELAY_ENV etc. come from wrangler.toml
cd .. && npm run dev             # Firestore emulator + `wrangler dev` (http://localhost:8787)
```

The emulator needs Java 21 and the Firebase CLI. `wrangler dev` runs the Worker locally with a local queue, R2 bucket and rate limiter. To fire the cron handler locally, run `npx wrangler dev --test-scheduled` and open `/__scheduled?cron=*+*+*+*+*`.

## Trying the bots locally

With `META_SEND_MODE=log` in `api/.dev.vars`, replies are printed in the `wrangler dev` console instead of being sent to Meta. Send signed, Meta-shaped webhooks with the simulator:

```text
cd api
npm run simulate -- admin "hi"                                   # onboarding starts
npm run simulate -- admin "add Jollof rice, 2500, 10"
npm run simulate -- shop --to <merchant phone_number_id> "hi"
npm run simulate -- shop --to <id> --choice add:<productId> "Add to cart"
npm run simulate -- echo --to <id> --from 2348090000001 "I'll take it from here"   # owner takeover
npm run simulate -- instagram --to <ig account id> --from igsid-1 "price?"
```

The bots work without AI keys: plain commands ("products", "restock rice 5", "RLY-ABCDE paid") are matched by rules. With `GEMINI_API_KEY` set, other messages go to Gemini, which can only pick one of the bot's typed tools. With `OPENAI_API_KEY` set, voice notes are transcribed.

## Tests

```text
npm run test:emulators --prefix api
```

This runs the API tests against the Firestore emulator under the `demo-relay` project. CI runs the same command on every push.

## Deployment

```text
npm run deploy:staging --prefix api      # or deploy:production
```

`wrangler.toml` defines the development, staging and production environments: one queue (plus dead-letter queue) and one R2 bucket each, and the cron triggers. Create those resources once per environment with `npx wrangler queues create` and `npx wrangler r2 bucket create`, and deploy `firestore.indexes.json` (including the TTL policy on `inboundEvents.expireAt`) with `firebase deploy --only firestore`.

Secrets are set with `npx wrangler secret put <NAME> --env <env>`, never committed. Outside development the Worker refuses to serve without:
- the Firebase service account (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`);
- a 64-hex-character `TOKEN_ENCRYPTION_KEY`;
- `META_APP_SECRET`;
- a `META_VERIFY_TOKEN` of at least 16 characters.

It also refuses `FIRESTORE_EMULATOR_HOST` outside development. Development, staging and production use separate Firebase projects, Workers environments and provider credentials.

## Tracker

`npm run tracker` serves the phase tracker at http://localhost:4700 ([tools/mvp-tracker/tasks.mjs](tools/mvp-tracker/tasks.mjs)).
