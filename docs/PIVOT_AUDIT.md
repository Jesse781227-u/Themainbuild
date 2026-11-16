# Relay pivot audit: WhatsApp + Instagram native

Phase 0 (read-only). Audited at `cf76b82` (tagged `pre-pivot`, equal to `main` and `themainbuild/main`).
Branch: `pivot/whatsapp-native`. Date: 16 Nov 2026.

Nothing has been deleted or changed. This file is the only addition.

---

## 1. Security check: secrets in git history

`git log --all -- <path>` returned **no commits** for every path checked, on every local and remote-tracking ref:

| Path | Ever committed? | Ignored by |
|---|---|---|
| `relayafrica-fcc2a-firebase-adminsdk-fbsvc-37cb338ebb.json` | **No** | `.gitignore:9` (explicit) |
| `web/.env` | **No** | `.gitignore:3` (`.env`) |
| `web/.env.local` | **No** | `.gitignore:4` (`.env.*`) |
| `api/.env` | **No** | `.gitignore:3` |

Extra checks:
- Every path ever added to the repo was scanned for `.env*`, `*adminsdk*`, `service account`, `*.pem` and `*.key`. The only match is `.env.example`, which holds placeholders.
- The full patch history (`git log --all -p`) was grepped for `"private_key"`, `BEGIN PRIVATE`, Meta access tokens (`EAA…`) and Google API keys (`AIza…`). **No matches.**

**Verdict: no key rotation needed on account of git.** The service-account JSON still sits in plain text in the working-copy root. Consider moving it out of the repo folder, so a future `git add -f` or a zip-and-share can't leak it.

---

## 2. Verdicts, file by file

Legend: **Keep**, **Modify** (kept but changed for the pivot), **Remove**.

### Root

| Path | Verdict | Why |
|---|---|---|
| `package.json` | Modify | The `dev` and `build` scripts start and build `web/`. Repoint them to the API, emulators and the webhook simulator. |
| `package-lock.json` | Modify | Regenerate after the root deps change (only `concurrently` today). |
| `README.md` | Modify | Describes the dashboard, storefront, push and n8n. Rewrite for the bots. |
| `.env.example` | Modify | Drop the `VITE_*` (including `VITE_FIREBASE_VAPID_KEY`), `N8N_*`, `WEB_BASE_URL` and `CORS_ORIGIN` keys. Rename `BACKS_IO_*` per Q1. Add the Admin Bot number ID, LLM, transcriber and cron secret keys. |
| `.gitignore` | Keep | Covers the secrets correctly. Later, add the simulator's output files if any. |
| `render.yaml` | Modify | Remove `relay-web`. Add `envVars` (`sync:false`) for `relay-api`, plus cron or static services per Q9 and Q10. |
| `firebase.json` | Modify | Keep the Firestore and Storage emulators. Drop the Auth emulator once Firebase Auth is gone (see §4.6). |
| `firestore.rules` | Modify | Replace with deny-all: the backend uses the Admin SDK only. |
| `firestore.indexes.json` | Modify | Drop the `carts` index. Add indexes for the new queries (expiring orders, ledger by business+date, customers by tag/opt-in). |
| `storage.rules` | Modify | Uploads come from the API now, not browsers. Deny client writes. Public reads of product images stay only if carousels use Storage URLs (see §4.8). |
| `relayafrica-…-adminsdk-….json` | Keep (untracked) | Local credential, correctly ignored. See §1 about moving it. |
| `api-dev*.log`, `web-dev*.log`, `firestore-debug.log` | Remove (untracked) | Stale local logs, ignored. Only workspace clutter. |
| `.github/workflows/ci.yml` | Modify | Builds `web/` and caches on `web/package-lock.json`. Repoint to `api/` only. |
| `docs/production-context.md` | Modify | Says "n8n as orchestration", "web storefront" and "push advertising". All superseded. |
| `docs/PIVOT_AUDIT.md` | New | This file. |

### `api/src`

| Path | Verdict | Why |
|---|---|---|
| `app.ts` | Modify | Remove the routes for storefront, push, dashboard, setup, business and CRM HTTP, plus CORS (no browser clients). Exempt webhooks from the general rate limiter (see §4.4). Mount the webhook, Bachs and internal job routes. |
| `index.ts` | Keep | |
| `config.ts` | Modify | It already rejects a missing or short `TOKEN_ENCRYPTION_KEY` outside development, but `RELAY_ENV` **defaults to `development`** (see §4.1). Move `META_APP_SECRET` and `META_VERIFY_TOKEN` into the schema, since they are read from `process.env` directly today. Remove `N8N_*`, `WEB_BASE_URL`, `CORS_ORIGIN` and `UBER_*` per Q5. Add the new keys. |
| `lib/errors.ts` | Keep | |
| `lib/logger.ts` | Modify | Add a phone/token redaction helper (`+234803****567`), so no caller can log a full number. |
| `middleware/requestContext.ts` | Keep | |
| `middleware/rateLimiter.ts` | Modify | Keep it, but don't apply it to `/webhooks/*` (Meta and Bachs IPs are shared and bursty). `authLimiter` is unused: remove it. |
| `middleware/auth.ts` | Remove → replace | Firebase ID-token tenancy for web users. Replace with (a) owner identity resolved from the verified WhatsApp sender on the Admin Bot number and (b) a shared-secret guard for internal job endpoints. |
| `routes/health.ts` | Keep | `/health`, `/health/live`, `/health/deep` are still needed for Render. |
| `routes/whatsapp.ts` | Modify | Keep GET verify (fix fail-open, see §4.2) and POST signature verification and idempotency. Remove `forwardToN8n`, `POST /whatsapp/orders` and the Firebase-auth connection routes. The connection is written by the Embedded Signup callback instead. |
| `routes/commerce.ts` | Remove | Every route is either the dashboard (Firebase auth) or the public storefront (`/storefronts/:slug/...`). Bots call the services directly. |
| `routes/crm.ts` | Remove | The dashboard CRM plus the public storefront event route. The customer and category logic moves into services used by the bots. |
| `routes/dashboard.ts` | Remove | Web-only aggregate. It also computes in server-local time (UTC on Render), not Lagos. |
| `routes/delivery.ts` | Remove | HTTP wrappers. Keep the services they call. |
| `routes/push.ts` | Remove | Web push consent. |
| `routes/campaigns.ts` | Remove | FCM web-push campaign routes. Broadcasts get rebuilt as WhatsApp templates in Phase 4. |
| `routes/setup.ts` | Remove | The web setup wizard's progress, plus a nested `businesses/{id}/auditLogs` subcollection, which conflicts with the flat-collections rule. |
| `routes/business.ts` | Remove | Business creation through Firebase auth. Moves to Admin Bot onboarding. |
| `services/firebase-admin.ts` | Modify | Keep Firestore and add a Storage bucket export. `adminAuth` goes once auth is removed. |
| `services/whatsapp.ts` | Modify | Keep `encrypt`/`decrypt` (remove the dev fallback key outside development, see §4.1), `verifyMetaSignature`, `recordWebhook` (change what it stores, see §4.3) and the connection store. Remove `forwardToN8n` and `verifyN8nSecret`. Split into `channels/whatsapp/*`. |
| `services/firestore-commerce.ts` | Modify | Keep products, inventory, categories and the transactional checkout. Remove `storefronts`, `claimStorefront`, `getStorefront*` and carts as a separate collection (the cart moves into `sessions`). Checkout needs reservation expiry and a kobo-safe price (see §3). |
| `services/commerce-types.ts` | Remove | Duplicates `shared/types/commerce.ts`, and the two have already drifted (`customer` vs `customerId`, different `orderStatus` unions). |
| `services/commerce-store.ts` | Remove | Dead in-memory `Map` repository. Nothing imports it. *(Not in the brief.)* |
| `services/payment-provider.ts` | Modify | Keep the interface and rename to Bachs. `CheckoutHandoff` is shaped like a redirect URL, so reshape it for bank-transfer details or a reference per Q1. |
| `services/delivery.ts` | Keep / Modify | Zones and quotes stay. `uber_direct` per Q5. |
| `services/delivery-batches.ts` | Keep | Served through the Admin Bot. Note: the MVP plan had cut batches. |
| `services/campaigns.ts` | Remove → rebuild | FCM multicast to `pushSubscriptions`. Re-purpose the audience segment logic (recent purchasers, inactive) for WhatsApp templates. |
| `services/push.ts` | Remove | FCM web push. |

### `api/test`

| Path | Verdict | Why |
|---|---|---|
| `env.ts`, `helpers.ts` | Modify | Keep the emulator harness. Replace the Firebase-ID-token helper and the storefront seeding with seeding for owner, `waNumbers` and session. |
| `harness.test.ts` | Keep | |
| `checkout.test.ts` | Modify | Its invariants (no oversell on duplicate lines, cart consumed once, price snapshot) carry over. They are driven through storefront routes today, so re-drive them through the service. |
| `tenant.test.ts` | Modify | Inventory, delivery and batch tenant checks carry over at the service and tool level. The slug tests and the `/me/businesses` test go. |
| `crm.test.ts` | Remove | Tests the public storefront event route. |
| `rules.test.ts` | Modify | Rewrite to assert deny-all for authenticated and unauthenticated clients. |
| `whatsapp.test.ts` | Modify | The n8n tests go. Keep the config test shape for `TOKEN_ENCRYPTION_KEY` and `META_*`. |
| `api/package.json` | Modify | Add the LLM SDK per Q2. Remove `cors` and `@types/cors`. `firebase` (client SDK) stays only for rules tests. |
| `api/tsconfig.json` | Modify | `rootDir: src` stops the API importing `../shared` (see §4.7). |

### `shared/`

| Path | Verdict | Why |
|---|---|---|
| `shared/types/commerce.ts` | Modify | This becomes the single source of truth, and the new model (§5 of the brief) lands here. **Nothing imports `shared/` today**: neither api nor web. |
| `shared/types/business.ts` | Modify | Business stays. `BusinessMembership` changes per Q8. Its role union (`owner\|manager\|staff`) already disagrees with `auth.ts` (`owner\|admin\|staff`). |
| `shared/types/user.ts` | Remove | A Firebase-auth web user. Replaced by `Owner`. |
| `shared/types/api.ts` | Keep | Still the envelope for the remaining HTTP responses. |
| `shared/package.json` | Keep | |

### `web/` (239 tracked files in the repo; about 180 are in `web/`)

| Path | Verdict | Why |
|---|---|---|
| `web/src/pages/{Home,Shop,Customers,Marketing,More,StorefrontManagement,WhatsAppShopping*,Storefront}.tsx`, `pages/setup/*`, `pages/whatsapp-onboarding/*`, `sections/*`, `storefront/*`, `components/{storefront,layout,landing}/*` | Remove | Dashboard, onboarding wizard, storefront templates, marketing landing. |
| `web/src/components/ui/*` (shadcn), `hooks/*`, `lib/*`, `main.tsx`, `App.tsx`, `index.css`, `vite-env.d.ts` | Remove | Framework for the above. |
| `web/public/{sw.js,manifest.json,offline.html,icons,styles}` | Remove | PWA and push service worker. |
| `web/src/pages/{privacy,terms}.tsx` | Remove, salvage text | About 9 KB of policy copy each. Port the text into the minimal Meta pages (Q9) and update it: data is now processed in WhatsApp, and an LLM sees messages. |
| `web/public/{logo.png,favicon.*}` | Salvage | Reuse on the minimal pages. |
| `web/{package.json,package-lock.json,vite.config.ts,tsconfig.json,components.json,index.html}` | Remove | Vite build. |

### `tools/`

| Path | Verdict | Why |
|---|---|---|
| `tools/mvp-tracker/*` | Per Q12 | The plan inside runs 27 Oct to **16 Nov 2026 (today)** and is entirely web, storefront and push. Most of its checks reference tests and files this pivot deletes, so it will show red as-is. |

---

## 3. Where the brief doesn't match the code

1. **Stock is deducted, not reserved.** `checkout()` decrements `inventoryQty` permanently at order creation. Nothing records `reservationExpiresAt`, and nothing ever releases stock. The 30-minute hold from the MVP plan was never built. "Reserve + auto-release" is new work, not a tweak.
2. **Money is integer naira, not kobo.** `productInput.price` is `z.number().int()`. The web renders `₦{price.toLocaleString()}` with no `/100`, and the setup wizard stores `Math.round(Number(input))`. Delivery zone `price` is the same. Every stored amount is whole naira. (Test data only, so converting is cheap.)
3. **Orders have three status fields** (`paymentStatus`, `deliveryStatus`, `orderStatus`) with overlapping meanings, against the brief's single lifecycle. `orderStatus` also has two different unions in the codebase.
4. **The `payments` collection** is in the rules and in `col`, but nothing ever writes to it.
5. **`TOKEN_ENCRYPTION_KEY` already fails at startup outside development.** The real gap is that `RELAY_ENV` defaults to `development` (see §4.1).
6. **VAPID is web-only.** The API has no VAPID config. Push goes through FCM (`admin.messaging()`) using `pushSubscriptions` and `pushAudiences`. Those two collections plus `campaigns` are the "push subscription collections" to drop.
7. **Collections the brief doesn't name:** `setupProgress`, `businesses/{id}/auditLogs` (nested), `pushAudiences`, `whatsappEvents`, `deliveryZones`, `deliveryBatches`, `customerCategories`, `crmEvents`, `_health`. Proposed handling: drop the first three. Keep `whatsappEvents` (renamed `webhookEvents`, also used for Bachs), the delivery collections, `customerCategories`, and `crmEvents` per Q7.
8. **Customer records today** have `email`, `location`, `walletBalance`, `loyaltyPoints`, `pinnedNote` and `categoryIds`. The new model has none of `email`, `walletBalance` or `loyaltyPoints`, and has `tags[]` where `categoryIds` was. Proposal: `customerCategories` become `tags`, and `walletBalance` becomes `balanceOwed` (with the sign flipped).
9. **`whatsappConnections` is keyed by `businessId`** (one number per business). That's fine. `waNumbers/{phoneNumberId}` gets added for reverse routing.
10. **`shared/` isn't used** anywhere, so "duplicate types" means the duplication is total. Wiring `shared/` into the API needs a tsconfig or workspace change (see §4.7).
11. **The MVP memory recorded "WhatsApp = wa.me handoff; n8n bot cut; push is the differentiator."** The brief reverses all three. No action needed. This is noted so the stale plan isn't mistaken for current scope.

---

## 4. Risks

### 4.1 `RELAY_ENV` defaults to `development` (high)
If `RELAY_ENV` is missing on Render, the API boots in development mode:
- the encryption key falls back to `sha256('relay-development-key')`, which is public in this repo;
- all production credential checks are skipped;
- `POST /storefronts/local-publish` (unauthenticated) is enabled;
- `/health/deep` reports healthy without Firestore.

**Fix:** make `RELAY_ENV` required with no default (or default to `production`), and have `key()` throw outside development instead of falling back.

### 4.2 Meta GET verify fails open (medium)
`req.query['hub.verify_token'] !== process.env.META_VERIFY_TOKEN`: if the env var is unset and the query omits the param, `undefined === undefined` and the challenge is echoed. **Fix:** require the env var in config and compare in constant time.

### 4.3 The webhook log stores raw PII forever (medium)
`recordWebhook` writes the **entire Meta payload** (customer phone numbers, names, message bodies) to `whatsappEvents` with no TTL. It also only de-duplicates `messages[]`; `statuses[]` (delivered/read) are ignored entirely. **Fix:** store an id, type, `phone_number_id`, a hash of the sender and a processing state. Put a Firestore TTL policy on the collection, and handle statuses.

### 4.4 The rate limiter will throttle Meta (medium)
`generalLimiter` applies 100 requests/min **per IP** to every route, including `/webhooks/meta`. Meta delivers from a small pool of IPs, so one busy merchant can trigger 429s. Meta then retries and eventually flags the webhook. **Fix:** skip the limiter for signature-verified webhook routes.

### 4.5 Synchronous webhook processing (medium, a design constraint)
Today the handler awaits Firestore plus an n8n fetch before replying 200. With an LLM call in the path (often 1–5 s), we risk Meta's timeout and duplicate deliveries. Render web services have no built-in queue. Options:
- (a) ack first, then process in-process with `setImmediate`. Simplest, but in-flight work is lost on deploy or restart.
- (b) record the event as `pending` in Firestore before acking, and drain pending events at startup and on a cron sweep.

Recommendation: **(b)**. It reuses the idempotency record we already write.

### 4.6 Firebase Auth removal
Removing `requireUser` and `requireTenant` removes all **HTTP** tenancy. After the strip, every remaining route must be either a signature-verified webhook, a secret-guarded internal job, or public static content. Tenancy then lives in the bot layer: the sender's phone resolves to an owner, and the owner's `activeBusinessId` scopes every tool call. This needs its own tests, which are listed in Phase 2.

### 4.7 `shared/` wiring
The API is CommonJS with `rootDir: src`. To import `shared/` it needs one of: tsconfig `paths` plus a widened `rootDir` (this changes the `dist/` layout, so the Render `start` command changes), npm workspaces, or moving `shared/` under `api/src/shared`. Since `web/` is going, **moving the types into `api/src/domain/` is the simplest single source of truth.** If you agree, `shared/` gets deleted too.

### 4.8 Product images and Meta media
- Images from owners arrive as WhatsApp media IDs. They must be downloaded with the business token and re-hosted. Meta media URLs are short-lived and need auth.
- Carousel and catalog headers need a publicly fetchable URL, or a media ID uploaded per number.
- Storage stays, with API-only writes. Reads stay public, or move to signed URLs.

### 4.9 Coexistence constraints (to verify against Meta docs, not assumed)
With coexistence, messages the owner sends from the WhatsApp Business app echo to the webhook. The bot must not answer a customer while the owner is mid-conversation (a takeover or handback state in `sessions`). Not every Cloud API feature works on coexistence numbers. I'll mark each one `TODO(jesse): verify` rather than assume.

### 4.10 Local test environment
**Java isn't installed on this machine**, so the emulator-backed tests can't run locally. Only `tsc` runs here, and the full suite runs in CI. Phase 1's rule ("each commit leaves tests passing") would be verified by pushing the branch and watching CI, unless you install a JDK 21.

### 4.11 Uncommitted work on `fix/ci-case-sensitive-ui-paths`
`web/src/App.tsx` and `web/src/pages/Storefront.tsx` have uncommitted route fixes. They were carried onto this branch as working-tree changes and are **not** committed. Since `web/` is being removed, they will be discarded (see Q16).

### 4.12 Smaller items
- `checkout` trusts `price` as a number with no integer check. That's fine once we standardise on kobo.
- `crypto.randomUUID()` is used as a global in route files but imported in `whatsapp.ts`. That works on Node 22 only. Pin `engines.node`.
- `README.md` says the tests are only type checks. Out of date.
- The `delivery` zone match is a substring match on free text. It is fragile for chat addresses, so pair it with the Flow's location pin later.

---

## 5. Proposed Phase 1 strip, as separate commits

Each commit is checked with `tsc` locally; the tests are checked in CI (see §4.10).

1. `chore: harden config` — `RELAY_ENV` required, no fallback key outside dev, `META_*` in config, GET verify fails closed, webhooks exempt from the limiter. *(A safety fix that comes before deletion.)*
2. `chore: remove n8n` — `forwardToN8n`, `verifyN8nSecret`, `/whatsapp/orders`, `N8N_*`, n8n tests.
3. `chore: remove web push` — routes and services for push and campaigns, FCM, `pushSubscriptions`/`pushAudiences`.
4. `chore: remove storefront + dashboard HTTP` — the commerce, crm, dashboard, setup, business and delivery routes; storefront service functions; `commerce-store.ts`; storefront and CRM-event tests. Re-target the checkout and tenant tests at services.
5. `chore: remove Firebase-auth tenancy` — `auth.ts`, `adminAuth`, the Auth emulator, `cors`.
6. `chore: single source of types` — per §4.7.
7. `chore: remove web/` — salvage the policy text and logo first. Update the root `package.json` and CI.
8. `chore: deny-all rules` — `firestore.rules`, `storage.rules`, rules test.
9. `docs: pivot reality` — README, `.env.example`, `render.yaml`, `production-context.md`, tracker per Q12.

---

## 6. Decisions (answered 16 Nov 2026)

| # | Topic | Decision |
|---|---|---|
| 1 | Payments | Bachs has **payment webhooks but one shared collection account**. Orders are matched by **unique amount** (a few extra kobo per pending order). `TODO(jesse)`: exact provider name and API docs. |
| 2 | AI | **Gemini** for intent parsing and tool selection. **OpenAI (Whisper / gpt-4o-transcribe)** for voice notes. Both behind interfaces. |
| 3 | Meta | The Meta app exists. **No Admin Bot number yet**, so development uses Meta's test number. **Business Verification and Tech Provider are not started: this is a launch blocker for Embedded Signup.** |
| 4 | Money | **Integer kobo** everywhere. Test data is converted or dropped. |
| 5 | Delivery | **Self-arranged + pickup only.** `uber_direct` is removed. Zones and batches stay. |
| 6 | Broadcasts | WhatsApp template broadcasts to opted-in customers, showing audience size and cost first, plus the `wa.me` prefilled-link fallback. All web push is deleted. |
| 7 | crmEvents | **Dropped.** |
| 8 | Staff | **Owners only** in v1. The model leaves room for members later. |
| 9 | Meta pages | Served by the API Worker as static assets: `api/public/{privacy,terms,data-deletion}.html`, drafted 16 Nov and **awaiting legal review** (the bracketed values must be filled in). |
| 10 | Scheduled jobs | **Cron Triggers on the API Worker itself** (see Hosting). There is no separate scheduler service. |
| 11 | Relay revenue | **No subscriptions.** Relay takes a **percentage fee on each processed transaction**, **split at source by Bachs**: each merchant has their own Bachs (sub-)account and Bachs routes Relay's share automatically. The **customer pays the fee on top** as a visible service fee in the payment message. The rate is config (basis points: global default, per-business override). Default rate **1% (100 bps) of the goods subtotal, capped at ₦2,000 (200,000 kobo)**. **Delivery fees are never charged.** Fee = min(round(subtotal × 1%), 200,000 kobo); the customer pays subtotal + delivery + fee. Split at source **confirmed available** (16 Nov). `TODO(jesse)`: Bachs API docs for the split, sub-account and webhook payloads. Unique-amount matching (Q1) then runs per merchant account. |
| 12 | Tracker | **Rewritten** for the pivot phases. |
| 13 | Instagram | **Basic DMs get built** in this rebuild (receive and reply). Carousels, Story publishing and comment-to-DM come later. Needs the Instagram permissions in Meta App Review. |
| 14 | Types | Moved into `api/src/domain/`. `shared/` is deleted. |
| 15 | Test verification | Local runs (once JDK 21 is installed) **and** CI. |
| 16 | Uncommitted web edits | Discarded. |
| H | Hosting (changed 16 Nov, after Phase 1) | **Render is dropped; everything runs on Cloudflare.** The API becomes a **Cloudflare Worker (Hono)** that talks to **Firestore over its REST API** with a service-account token, because `firebase-admin` can't run on Workers. Webhook processing uses **Cloudflare Queues** (save → ack → enqueue). This **supersedes the locked "Express API on Render" decision** and Q19's sweep (a Queue gives retries). The migration happens at the start of Phase 2. |
| I | Product images (16 Nov) | **Cloudflare R2**, not Firebase Storage. Images are served publicly at `/media/businesses/{id}/products/{file}` by the Worker (Meta fetches carousel images by URL). Firebase Storage and `storage.rules` are removed. |
| 17 | Remote | Push the branch and tag to **`themainbuild`**. |
| 18 | `RELAY_ENV` | **Required, no default.** |
| 19 | Webhooks | Save as `pending`, ack, process. A sweep runs on startup and via the Cloudflare cron. |
| 20 | Owner takeover | The bot stays silent in a chat **until the owner hands back** through the Admin Bot. |
| 21 | Webhook log retention | **30 days** via a Firestore TTL policy on `inboundEvents.expireAt`. Message text and the raw message are kept only until the event is processed, then cleared; only metadata remains until the TTL. |

### Changes to the strip plan (§5) from these answers
- Commit 2 also removes `uber_direct` (Q5). Commit 3 also removes the `crmEvents` writers (Q7).
- Commit 6 moves the types into `api/src/domain/` and deletes `shared/` (Q14).
- Commit 7 salvages the Privacy/Terms text into `api/public/` (Q9).
- `render.yaml` is deleted (Hosting). Phase 2 starts by porting the API to a Worker with `wrangler.toml`, Queues and Cron Triggers.

## Phase 2 status (16 Nov 2026)
The API runs on Cloudflare Workers (Hono, Firestore REST, Queues, Cron Triggers, R2). Details and the outstanding `TODO(jesse)` items are in the Phase 2 summary; grep `TODO(jesse)` in `api/src` for the live list.

## Phase 3 status (16 Nov 2026)
Both bots are built. The Admin Bot covers onboarding by chat, Embedded Signup, catalogue, stock, orders, delivery zones, payment details, handback and "delete my data". The Shop Bot covers browse, cart, delivery or pickup, order and payment instructions, order status, handover to a person and "delete my data". Instagram DMs get the same shop flow as numbered text. The Meta data-deletion callback is also in. Checkout is conversational (lists and buttons), not a WhatsApp Flow: Flows need a published Flow and an encrypted endpoint, which can come later. Until the Bachs API is known, customers are told to pay to the bank details the owner sets with "payment details …".
