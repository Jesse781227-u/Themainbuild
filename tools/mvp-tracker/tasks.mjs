// Relay MVP plan: Tue 27 Oct 2026 -> Mon 16 Nov 2026.
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

export const plan = {
  title: 'Relay MVP',
  start: '2026-10-27',
  end: '2026-11-16',
  weeks: [
    { n: 1, label: 'Safe and deployable', from: '2026-10-27', to: '2026-11-02', goal: 'Staging is live, shared store links open, and no business can touch another business’s data.' },
    { n: 2, label: 'Orders end to end', from: '2026-11-03', to: '2026-11-09', goal: 'On staging an order goes cart → 30-minute stock hold → delivery or pickup → status updates → customer record, with payments still stubbed. Push opt-in works.' },
    { n: 3, label: 'Payments, marketing and launch', from: '2026-11-10', to: '2026-11-16', goal: 'backs.io and the domain go live; sellers run push campaigns in a few taps; real merchants take real paid orders in production.' },
  ],
};

const t = name => ({ kind: 'test', name });

export const tasks = [
  // ───────────── Week 1 ─────────────
  { id: 'Y1', week: 1, due: '2026-10-28', owner: 'you', title: 'Install Java 21 and Firebase CLI', detail: 'Needed for the Firestore emulator that the API tests run against. `winget install EclipseAdoptium.Temurin.21.JDK` then `npm i -g firebase-tools`.',
    checks: [{ kind: 'cmd', run: 'java -version', label: 'java on PATH' }, { kind: 'cmd', run: 'firebase --version', label: 'firebase CLI on PATH' }] },
  { id: 'Y2', week: 3, due: '2026-11-10', owner: 'you', title: 'backs.io: merchant account, API keys and API docs shared with Claude', detail: 'Keys go in api/.env (BACKS_IO_API_KEY, BACKS_IO_WEBHOOK_SECRET, BACKS_IO_API_BASE_URL). Share the checkout + webhook docs so the integration is built against the real contract, not guesses. This is the critical path for week 2.',
    checks: [{ kind: 'envKey', file: 'api/.env', key: 'BACKS_IO_API_KEY' }, { kind: 'envKey', file: 'api/.env', key: 'BACKS_IO_WEBHOOK_SECRET' }] },
  { id: 'Y3', week: 1, due: '2026-10-30', owner: 'you', title: 'Start Meta Business verification', detail: 'Takes days to weeks. Needed for WhatsApp merchant alerts later; start now so it is not the blocker.', checks: [] },
  { id: 'Y4', week: 1, due: '2026-10-31', owner: 'you', title: 'Create staging: Firebase project + Render services', detail: 'Separate Firebase project from production. Put the staging API URL into this tracker’s settings so the health check below goes green.', checks: [] },

  { id: 'C1', week: 1, due: '2026-10-28', owner: 'claude', title: 'API test harness against the Firestore emulator', detail: 'node:test + tsx, seeded two-business fixture, wired into npm test and CI.',
    checks: [{ kind: 'exists', path: 'api/test' }, t('harness: emulator reachable')] },
  { id: 'C2', week: 1, due: '2026-10-28', owner: 'claude', title: 'Inventory adjust only touches your own products', detail: 'POST /products/:id/inventory/adjust verifies the product belongs to the caller’s business.',
    checks: [t('tenant: inventory adjust rejects another business product')] },
  { id: 'C3', week: 1, due: '2026-10-28', owner: 'claude', title: 'Delivery method and batch assignment only touch your own orders',
    checks: [t('tenant: delivery method rejects another business order'), t('tenant: batch assignment rejects another business order')] },
  { id: 'C4', week: 1, due: '2026-10-29', owner: 'claude', title: 'Storefront slugs cannot be taken over', detail: 'Publishing or renaming to a slug owned by another business fails.',
    checks: [t('tenant: cannot publish over another business slug'), t('tenant: cannot rename onto another business slug')] },
  { id: 'C5', week: 1, due: '2026-10-29', owner: 'claude', title: 'Product create cannot overwrite another business’s product',
    checks: [t('tenant: product create cannot overwrite another business product')] },
  { id: 'C6', week: 1, due: '2026-10-29', owner: 'claude', title: 'Firestore rules check the existing owner on update',
    checks: [t('rules: member cannot reassign another business product'), t('rules: member cannot reassign another business order')] },
  { id: 'C7', week: 1, due: '2026-10-29', owner: 'claude', title: 'WhatsApp/n8n order endpoint fails closed', detail: 'Rejects when N8N_WEBHOOK_SECRET is unset; constant-time compare; required outside development.',
    checks: [t('whatsapp: orders endpoint rejects when secret unset'), t('config: production requires N8N_WEBHOOK_SECRET')] },
  { id: 'C8', week: 1, due: '2026-10-30', owner: 'claude', title: 'Public CRM events cannot create or reassign customers',
    checks: [t('crm: public event cannot create or reassign customer')] },
  { id: 'C9', week: 1, due: '2026-10-30', owner: 'claude', title: 'Checkout integrity: no oversell, no expired carts, prices snapshotted',
    checks: [t('checkout: duplicate lines cannot oversell'), t('checkout: expired cart is rejected'), t('checkout: order snapshots item name and price')] },
  { id: 'C10', week: 1, due: '2026-10-30', owner: 'claude', title: 'One API base URL everywhere in the web app', detail: 'Storefront, dashboard and Marketing stop reading VITE_API_URL and falling back to localhost.',
    checks: [{ kind: 'lacks', path: 'web/src', re: 'VITE_API_URL', label: 'no VITE_API_URL reads' }, { kind: 'lacks', path: 'web/src/pages', re: 'localhost:4000', label: 'no hardcoded localhost in pages' }, { kind: 'lacks', path: 'web/src/storefront', re: 'localhost:4000', label: 'no hardcoded localhost in storefront' }] },
  { id: 'C11', week: 1, due: '2026-10-30', owner: 'claude', title: 'Render serves the SPA for deep links', detail: 'A shared /store/your-shop link opens instead of 404ing.',
    checks: [{ kind: 'has', file: 'render.yaml', re: 'type:\\s*rewrite', label: 'rewrite route in render.yaml' }, { kind: 'has', file: 'render.yaml', re: '/index\\.html', label: 'rewrites to /index.html' }] },
  { id: 'C12', week: 1, due: '2026-10-31', owner: 'claude', title: 'Merchants get their business back on any device', detail: 'GET /api/v1/me/businesses; the app restores the business after sign-in instead of creating a new one.',
    checks: [t('business: lists memberships for signed-in user'), { kind: 'has', path: 'web/src', re: '/api/v1/me/businesses', label: 'web restores business after sign-in' }] },
  { id: 'C13', week: 1, due: '2026-11-01', owner: 'claude', title: 'Product images go to Firebase Storage, compressed', detail: 'No more base64 in Firestore or request bodies. Video dropped for MVP.',
    checks: [{ kind: 'lacks', file: 'web/src/pages/Shop.tsx', re: 'readAsDataURL', label: 'no raw data-URL uploads' }, { kind: 'has', path: 'web/src', re: 'uploadBytes', label: 'uploads to Storage' }, { kind: 'has', file: 'storage.rules', re: 'businesses/', label: 'storage rules allow business uploads' }] },
  { id: 'C14', week: 1, due: '2026-11-02', owner: 'claude', title: 'Storefront work merged into main and pushed', detail: 'The 14 commits on fix/ci-case-sensitive-ui-paths.',
    checks: [{ kind: 'merged', commit: '00a0481', into: 'main' }, { kind: 'pushed', commit: '00a0481' }] },
  { id: 'C15', week: 1, due: '2026-11-02', owner: 'claude', title: 'Staging API is up and healthy',
    checks: [{ kind: 'http', setting: 'stagingApiUrl', path: '/health/deep' }] },

  // ───────────── Week 2 ─────────────
  { id: 'Y5', week: 3, due: '2026-11-11', owner: 'you', title: 'Register the backs.io webhook URL (staging)', detail: 'Point it at <staging API>/api/v1/webhooks/backs-io once C17 lands.', checks: [] },
  { id: 'Y6', week: 2, due: '2026-11-05', owner: 'you', title: 'Create the Web Push (VAPID) key', detail: 'Firebase console → Project settings → Cloud Messaging → Web Push certificates. Put it in web/.env as VITE_FIREBASE_VAPID_KEY.',
    checks: [{ kind: 'envKey', file: 'web/.env', key: 'VITE_FIREBASE_VAPID_KEY', alt: 'web/.env.local' }] },
  { id: 'Y7', week: 2, due: '2026-11-06', owner: 'you', title: 'Pick the 3–4 launch templates', detail: 'The rest get hidden for launch, not deleted.', checks: [] },
  { id: 'Y8', week: 2, due: '2026-11-08', owner: 'you', title: 'Line up 3–5 pilot merchants', detail: 'Real sellers who will take real orders in week 3. Ideally at least one food seller and one fashion seller.', checks: [] },
  { id: 'Y9', week: 3, due: '2026-11-13', owner: 'you', title: 'Place a real ₦100 order on staging and confirm you got paid', detail: 'The payments exit test, done by a human with a real card.', checks: [] },

  { id: 'C16', week: 3, due: '2026-11-11', owner: 'claude', title: 'backs.io checkout returns a real payment link', detail: 'Built against the docs from Y2.',
    checks: [{ kind: 'lacks', file: 'api/src/services/payment-provider.ts', re: 'checkoutUrl:null', label: 'stub removed' }, t('payments: checkout returns backs.io redirect url')] },
  { id: 'C17', week: 3, due: '2026-11-12', owner: 'claude', title: 'backs.io webhook: verified, idempotent, marks orders paid',
    checks: [t('payments: webhook rejects bad signature'), t('payments: duplicate webhook is idempotent'), t('payments: paid webhook marks order paid')] },
  { id: 'C18', week: 2, due: '2026-11-05', owner: 'claude', title: '30-minute stock hold', detail: 'Checkout reserves stock; unpaid orders release it after 30 minutes; payment turns the hold into a sale.',
    checks: [t('hold: checkout reserves stock for 30 minutes'), t('hold: expired unpaid order releases stock'), t('hold: payment converts hold to sale')] },
  { id: 'C19', week: 3, due: '2026-11-12', owner: 'claude', title: 'Storefront sends customers to pay; confirmation only after payment', detail: 'No more clearing the cart and showing “confirmed” for an unpaid order.',
    checks: [{ kind: 'has', file: 'web/src/pages/Storefront.tsx', re: 'checkoutUrl', label: 'storefront follows the payment link' }, t('payments: public order view reports payment status')] },
  { id: 'C20', week: 2, due: '2026-11-06', owner: 'claude', title: 'Delivery or pickup is part of the order, with zone fee in the total',
    checks: [t('delivery: checkout stores method and zone fee'), t('delivery: pickup has no fee and needs no address')] },
  { id: 'C21', week: 2, due: '2026-11-07', owner: 'claude', title: 'Delivery zones screen for merchants',
    checks: [{ kind: 'has', path: 'web/src', re: 'delivery-zones', label: 'web manages delivery zones' }] },
  { id: 'C22', week: 2, due: '2026-11-07', owner: 'claude', title: 'Order status changes are saved', detail: 'Status API wired to the Orders screen; Completed no longer advances to Cancelled.',
    checks: [t('orders: merchant can advance order status'), t('orders: cannot change another business order'), t('orders: completed order cannot advance to cancelled'), { kind: 'has', file: 'web/src/pages/Shop.tsx', re: '/status', label: 'Orders screen calls the status API' }] },
  { id: 'C23', week: 2, due: '2026-11-08', owner: 'claude', title: 'Paid orders create the customer record and purchase event', detail: 'Feeds Customers, dashboard revenue, and the “recent purchasers / inactive” push audiences.',
    checks: [t('crm: paid order upserts customer'), t('crm: paid order records order_completed event')] },
  { id: 'C24', week: 2, due: '2026-11-09', owner: 'claude', title: 'Push foundation: service worker + customer opt-in', detail: 'Service worker actually registered; FCM payloads displayed; storefront asks to opt in after an order and on return visits.',
    checks: [{ kind: 'has', path: 'web/src', re: 'serviceWorker\\.register', label: 'service worker registered' }, { kind: 'has', path: 'web/src', re: 'push-consent', label: 'storefront saves push consent' }, { kind: 'exists', path: 'web/public/firebase-messaging-sw.js' }] },

  // ───────────── Week 3 ─────────────
  { id: 'Y15', week: 3, due: '2026-11-10', owner: 'you', title: 'Buy the domain and point it at Render', detail: 'Bought in week 3 together with the backs.io account. Until then staging and pilots use the Render URLs.', checks: [] },
  { id: 'Y10', week: 3, due: '2026-11-11', owner: 'you', title: 'Create production: Firebase project, Render services, Sentry project', checks: [] },
  { id: 'Y11', week: 3, due: '2026-11-12', owner: 'you', title: 'Review the seller marketing flow on your phone', detail: 'Can a seller send a promo in under a minute without help? Note anything confusing.', checks: [] },
  { id: 'Y12', week: 3, due: '2026-11-14', owner: 'you', title: 'Onboard the pilot merchants', checks: [] },
  { id: 'Y13', week: 3, due: '2026-11-16', owner: 'you', title: 'First real paid order in production', checks: [] },
  { id: 'Y14', week: 3, due: '2026-11-16', owner: 'you', title: 'Launch go / no-go', checks: [] },

  { id: 'C25', week: 3, due: '2026-11-10', owner: 'claude', title: 'Customers page runs on the CRM API', detail: 'Replaces browser-only storage; real customers from real orders.',
    checks: [{ kind: 'lacks', file: 'web/src/pages/Customers.tsx', re: 'relay_customers_v1', label: 'no localStorage customer store' }, { kind: 'has', file: 'web/src/pages/Customers.tsx', re: 'apiFetch', label: 'loads from the API' }] },
  { id: 'C26', week: 3, due: '2026-11-11', owner: 'claude', title: 'Campaigns send reliably at any size', detail: 'Batches of 500, dead tokens deactivated, CRM events written in chunks.',
    checks: [t('push: campaign sends in batches of 500'), t('push: dead tokens deactivated after campaign')] },
  { id: 'C27', week: 3, due: '2026-11-11', owner: 'claude', title: '“Send test” goes only to the seller’s own device',
    checks: [t('push: test send targets only the sender device')] },
  { id: 'C28', week: 3, due: '2026-11-12', owner: 'claude', title: 'One-tap campaign templates', detail: 'New arrival, Promo / discount, Back in stock, “We miss you”. Pick a product, the copy and deep link fill in.',
    checks: [{ kind: 'has', file: 'web/src/pages/Marketing.tsx', re: 'campaignTemplates', label: 'templates in Marketing' }, t('push: campaign deep link opens product page')] },
  { id: 'C29', week: 3, due: '2026-11-12', owner: 'claude', title: 'Pick an audience from your customers, not by typing IDs',
    checks: [{ kind: 'lacks', file: 'web/src/pages/Marketing.tsx', re: 'Customer IDs, comma-separated', label: 'no manual ID entry' }] },
  { id: 'C30', week: 3, due: '2026-11-13', owner: 'claude', title: 'Campaign results: delivered, opened, ordered', detail: 'So sellers can see marketing working.',
    checks: [t('push: open is attributed to campaign'), t('push: order is attributed to campaign')] },
  { id: 'C31', week: 3, due: '2026-11-13', owner: 'claude', title: '“Order on WhatsApp” button with the cart prefilled',
    checks: [{ kind: 'has', path: 'web/src/storefront', re: 'wa\\.me', label: 'wa.me handoff in storefront' }] },
  { id: 'C32', week: 3, due: '2026-11-13', owner: 'claude', title: 'Storefront fixes: About/Contact links, ₦ sign',
    checks: [{ kind: 'lacks', file: 'web/src/storefront/templates/TemplateInternalPages.tsx', re: "\\['About', undefined\\]", label: 'About link works' }, { kind: 'lacks', path: 'web/src', re: 'Ã', label: 'no mojibake (₦ renders)' }] },
  { id: 'C33', week: 3, due: '2026-11-14', owner: 'claude', title: 'Password reset', checks: [{ kind: 'has', file: 'web/src/pages/login.tsx', re: 'sendPasswordResetEmail', label: 'reset flow in login' }] },
  { id: 'C34', week: 3, due: '2026-11-14', owner: 'claude', title: 'Dashboard cards show real data', detail: 'Weekly activity, busiest day, customer mix, audience base.',
    checks: [{ kind: 'lacks', file: 'web/src/pages/Home.tsx', re: '<ChartFrame message="No weekly orders yet', label: 'weekly activity wired' }, { kind: 'lacks', file: 'web/src/pages/Home.tsx', re: '<NoData message="No weekly activity yet."/>', label: 'busiest day wired' }] },
  { id: 'C35', week: 3, due: '2026-11-14', owner: 'claude', title: 'Storefront loads without the dashboard bundle', detail: 'Faster on mobile data.',
    checks: [{ kind: 'has', file: 'web/src/App.tsx', re: 'lazy\\(', label: 'routes code-split' }] },
  { id: 'C36', week: 3, due: '2026-11-15', owner: 'claude', title: 'Error monitoring in API and web',
    checks: [{ kind: 'has', file: 'api/package.json', re: '@sentry/node', label: 'API Sentry' }, { kind: 'has', file: 'web/package.json', re: '@sentry/react', label: 'web Sentry' }] },
  { id: 'C37', week: 3, due: '2026-11-15', owner: 'claude', title: 'Full API test suite green', checks: [{ kind: 'allTests', min: 40 }] },
  { id: 'C38', week: 3, due: '2026-11-16', owner: 'claude', title: 'Production API is up and healthy', checks: [{ kind: 'http', setting: 'prodApiUrl', path: '/health/deep' }] },
  { id: 'S1', week: 3, due: '2026-11-16', owner: 'claude', stretch: true, title: 'Stretch: automatic pushes — “your order is ready”, back in stock', detail: 'Marketing that runs itself. Only if everything above is green.',
    checks: [t('push: order ready notifies customer'), t('push: back in stock notifies waiting customers')] },
];
