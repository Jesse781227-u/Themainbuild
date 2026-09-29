# Relay

Relay is a merchant operations platform for small and medium businesses in Nigeria: e-commerce (web storefront and automated WhatsApp commerce) plus CRM and push advertising. The codebase contains the web dashboard/storefront and an API that owns tenant authorization, catalogue, inventory, orders, customers, delivery, notifications, WhatsApp orchestration, and push campaigns.

## Current architecture decisions

- WhatsApp uses Meta Cloud API directly; n8n orchestrates workflows and is not a source of truth.
- Customer checkout is isolated behind the backs.io payment-provider interface.
- Delivery supports merchant-defined zones, prices, timeframes, scheduled batches, pickup, and optional Uber Direct express delivery.
- Firestore is the persistence layer and Admin SDK access stays server-side.
- Environment values are never committed. See [.env.example](.env.example) and [docs/production-context.md](docs/production-context.md).

## Local development

Install dependencies in both packages, copy `.env.example` to local environment files, start Firebase emulators, then run the web and API dev servers.

```text
cd web && npm install && npm run dev
cd api && npm install && npm run dev
firebase emulators:start
```

The API validates production environment requirements at startup. Development may use the Firebase Auth/Firestore emulator variables.

## Repository structure

- `web/` — React/Vite dashboard, onboarding, public storefront, PWA shell, push opt-in
- `api/` — Express API, Firebase Admin, commerce, delivery, CRM, WhatsApp, and push campaigns
- `shared/` — shared domain types
- `firestore.rules`, `storage.rules`, `firebase.json` — Firebase infrastructure configuration
- `render.yaml` — separate Render web/API service definitions

## Build and tests

```text
npm run build --prefix web
npm run build --prefix api
npm test --prefix api
```

The test command currently performs strict API type checking. Emulator-backed rules, concurrency, and provider contract tests should run in CI once the Firebase CLI is provisioned in the runner.

## Render deployment

The repository includes [render.yaml](render.yaml), which defines two services:

- `relay-web` — static Vite output from `web/dist`
- `relay-api` — Node API listening on Render’s `PORT`, with `/health` as its health check

To deploy:

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint**, connect the repository, and select `render.yaml`.
3. Create separate Render environment groups for Development, Staging, and Production.
4. Set the API variables from `.env.example` on `relay-api`. At minimum, production needs `RELAY_ENV`, `API_BASE_URL`, `WEB_BASE_URL`, `CORS_ORIGIN`, Firebase Admin credentials, and `TOKEN_ENCRYPTION_KEY`.
5. Set the client variables on `relay-web` before its build. At minimum, set `VITE_API_BASE_URL` to the public API URL and provide the `VITE_FIREBASE_*` client configuration. Vite embeds these values during the build.
6. Deploy the API first, confirm `/health` and `/health/deep`, then deploy the web service.
7. Update `CORS_ORIGIN` to the final web URL and redeploy the API if the web URL changes.

For `FIREBASE_ADMIN_PRIVATE_KEY`, paste the service-account key as a Render secret with escaped newlines (`\n`). The API converts those escaped newlines before initializing Firebase Admin. Never place production credentials in Git or in `web` variables unless they are explicitly `VITE_` client configuration values.

After deployment, configure Firebase Auth authorized domains, Meta/n8n webhook URLs, backs.io webhook URLs, and any Uber Direct callback URL with the deployed API hostname. Production should use separate Firebase, Render, and external-provider credentials from development and staging.
