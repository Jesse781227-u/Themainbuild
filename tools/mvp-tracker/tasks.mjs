// Relay: one-week MVP, set up end to end (20–26 Nov 2026), including Smart Reach.
//
// Each "week" below is one day. owner 'claude' tasks are only ever marked done by their checks
// passing (a named test passing, a file existing…), so "done" always means the evidence is in the
// repo. owner 'you' tasks get a checkbox; some also tick themselves when detectable (a key set, a
// placeholder gone, the production API answering).
//
// Smart Reach follows its brief: each phase is built only after "go" on the one before. The
// test names under each task are the ones that will prove it.
//
// Check kinds: test · allTests · has / lacks · exists · envKey · cmd · merged · pushed · http

export const plan = {
  title: 'Relay: 1-week MVP, end to end',
  start: '2026-11-16',
  end: '2026-11-26',
  weeks: [
    { n: 0, label: 'Day 0 · Already built', from: '2026-11-16', to: '2026-11-19', goal: 'Signup, shop bot, payments (test mode), wallet, menus and commands, Status posts, sizes and colours, hours: built and tested locally.' },
    { n: 1, label: 'Day 1 · Fri 20 Nov', from: '2026-11-20', to: '2026-11-20', goal: 'Smart Reach decisions made; customers\' consent and signals recorded; every marketing message logged.' },
    { n: 2, label: 'Day 2 · Sat 21 Nov', from: '2026-11-21', to: '2026-11-21', goal: 'Smart Reach Phase 1 done: the cheapest-route plan (open window + owner-sent links) and the first two triggers.' },
    { n: 3, label: 'Day 3 · Sun 22 Nov', from: '2026-11-22', to: '2026-11-22', goal: 'Phase 2: segments, plain-language campaigns, templates, paid sends approved from the wallet, attribution.' },
    { n: 4, label: 'Day 4 · Mon 23 Nov', from: '2026-11-23', to: '2026-11-23', goal: 'Phase 3: Relay suggests, the other triggers, Status uses Smart Reach audiences, reports.' },
    { n: 5, label: 'Day 5 · Tue 24 Nov', from: '2026-11-24', to: '2026-11-24', goal: 'Phase 4: personal carousels, free ad window, offer codes, Instagram route. Smart Reach complete.' },
    { n: 6, label: 'Day 6 · Wed 25 Nov', from: '2026-11-25', to: '2026-11-25', goal: 'Production set up: domain, secrets, indexes, the real Relay number, commands synced.' },
    { n: 7, label: 'Day 7 · Thu 26 Nov', from: '2026-11-26', to: '2026-11-26', goal: 'Full run-through, pilot shops lined up, branch merged. Ready to switch on as soon as Meta and Bachs allow.' },
  ],
};

const t = name => ({ kind: 'test', name });

export const tasks = [
  // ───────────── Day 0 · Already built (proof only) ─────────────
  { id: 'B1', week: 0, due: '2026-11-19', owner: 'claude', title: 'Signup by chat: menu upload, preview, location, hours, delivery, policies, messages, TEST, connect',
    checks: [t('onboarding v2: hi → shop name → menu → preview → location → hours → delivery → policies → ready → connect link'), t('location: sentences become area, city, street and landmark'), t('hours: whole weeks in different words go straight to the check')] },
  { id: 'B2', week: 0, due: '2026-11-19', owner: 'claude', title: 'Shop bot: welcome first, browse, sizes and colours, cart, checkout, delivery prices',
    checks: [t('first message: "hi" gets the welcome and three options, no carousel'), t('shop: checkout flow creates order awaiting payment'), t('customer: Add to cart asks which size; the cart, the order and the stock hold go by size'), t('delivery: a Yaba address gets the Yaba price, not the Lagos one')] },
  { id: 'B3', week: 0, due: '2026-11-19', owner: 'claude', title: 'Payments (test mode), receipts, wallet, verify and withdraw',
    checks: [t('shop: checkout flow creates order awaiting payment'), t('wallet: older sales are counted from the ledger; a new payment is added at once'), t('withdraw: minimum, daily limit, confirm once, paid at once in test mode')] },
  { id: 'B4', week: 0, due: '2026-11-19', owner: 'claude', title: 'Owner menus and / commands, follow-up buttons, targeted Status posts',
    checks: [t('commands: the registry makes a valid WhatsApp command list, and a bad entry stops the sync'), t('follow-ups: at most 3 buttons, and with three the last is Menu'), t('status: /status → picture + caption + 5 to mention → change people → posted → a day later, who ordered')] },

  // ───────────── Day 1 ─────────────
  { id: 'Y1', week: 1, due: '2026-11-20', owner: 'you', title: 'Answer the 10 Smart Reach questions', detail: 'Phase order, who pays service/utility message costs, what counts as a "regular", frequency cap and quiet hours, default triggers for food vs fashion, opt-in wording, message rates, Instagram, keep or replace broadcasts. Asked one at a time in the chat.', checks: [] },
  { id: 'Y2', week: 1, due: '2026-11-20', owner: 'you', title: 'Rotate the credentials pasted in chat earlier', detail: 'Meta system-user access token, Meta app secret, the number PIN, and the Firebase key file. Put the new values in api/.dev.vars and the staging secrets.', checks: [] },
  { id: 'R1', week: 1, due: '2026-11-20', owner: 'claude', title: 'Message costs in one config module', detail: 'Service allowance (1,000/month), marketing and utility rates, free entry window hours, owner-sent = free (flag). Rates as config, not hard-coded.',
    checks: [{ kind: 'exists', path: 'api/src/services/messaging-costs.ts' }, { kind: 'has', file: 'api/src/config.ts', re: 'FREE_ENTRY_WINDOW_HOURS', label: 'free entry window is config' }] },
  { id: 'R2', week: 1, due: '2026-11-20', owner: 'claude', title: 'Customer signals and consent', detail: 'Views, questions, carts, orders and replies recorded (ids only). Opt-in at checkout unticked; "Stop updates" stops everything at once; "Start updates" turns it back on.',
    checks: [t('reach: signals are recorded for views, questions, carts, orders and replies'), t('reach: checkout opt-in is unticked by default'), t('reach: stop updates opts out at once and every send respects it')] },
  { id: 'R3', week: 1, due: '2026-11-20', owner: 'claude', title: 'Sends log: the source of truth for cost and results', detail: 'Every marketing message is one record: route, cost, status, and later the reply or order it led to. Service messages counted per month.',
    checks: [t('reach: sends log is the source of truth for cost')] },

  // ───────────── Day 2 ─────────────
  { id: 'Y3', week: 2, due: '2026-11-21', owner: 'you', title: 'Submit Meta Business Verification (portfolio Relayng01)', detail: 'The one blocker for real WhatsApp: until it is approved, Meta refuses messages ("Business Account locked") and no templates can be approved. Review can take days to weeks, so it needs to start now.', checks: [] },
  { id: 'R4', week: 2, due: '2026-11-21', owner: 'claude', title: 'Delivery router: open window first, then owner-sent links', detail: 'Skips opted-out, capped (2/week) and reported customers; queues during quiet hours (21:00–08:00 Lagos); falls through when the free allowance is used up.',
    checks: [t('router: open window is free and used first'), t('router: service allowance used up falls through'), t('router: opted out, capped and quiet hours are skipped or queued'), t('router: owner-sent links are encoded, capped at 30, and mark-sent updates sends')] },
  { id: 'R5', week: 2, due: '2026-11-21', owner: 'claude', title: 'Route plan shown before anything is sent', detail: '"18 free in their chat · 9 from your phone · ₦0" [Send all] [Free ones only] [Edit message] [Cancel].',
    checks: [t('route plan: counts and cost per route before sending')] },
  { id: 'R6', week: 2, due: '2026-11-21', owner: 'claude', title: 'First triggers: back in stock, abandoned cart', detail: 'Fire once per event, only to people who wanted it, inside the caps. Smart Reach Phase 1 complete: summary, then wait for "go".',
    checks: [t('trigger: back in stock fires once per restock for people who wanted it'), t('trigger: abandoned cart after an hour, once')] },

  // ───────────── Day 3 ─────────────
  { id: 'Y4', week: 3, due: '2026-11-22', owner: 'you', title: 'Bachs: sandbox account, API keys and docs', detail: 'Docs needed for: payment collection and its webhook, payouts to a bank account, and account-name check. Until then real payouts stay manual (fail closed).',
    checks: [{ kind: 'envKey', file: 'api/.dev.vars', key: 'BACHS_API_KEY' }, { kind: 'envKey', file: 'api/.dev.vars', key: 'BACHS_WEBHOOK_SECRET' }] },
  { id: 'R7', week: 3, due: '2026-11-22', owner: 'claude', title: 'Segments: built-in groups and plain-language ones', detail: 'Top 10%, 3+ orders, one-time, active, cooling, lapsed, "bought X" per category. "My sneaker buyers" → a checked rule with a count. Refreshed on every paid order and nightly.',
    checks: [t('segments: each rule type selects the right customers'), t('segments: plain language becomes a validated rule with a count'), t('segments: refresh on a paid order')] },
  { id: 'R8', week: 3, due: '2026-11-22', owner: 'claude', title: 'Templates and personal messages', detail: 'Marketing template library (text + image, product carousel) with a submit script; every variable checked per customer; broken messages skipped, never sent.',
    checks: [t('templates: library validates variables and submit script lists them'), t('personal: a message with a missing variable is skipped, not sent broken')] },
  { id: 'R9', week: 3, due: '2026-11-22', owner: 'claude', title: 'Paid sends from the wallet, attribution and campaign reports', detail: 'Paid templates need the owner\'s OK and enough wallet balance. A reply or order within 48h counts for the last send. Sent → replied → ordered → revenue, cost, revenue per ₦1.',
    checks: [t('route plan: paid sends need approval and enough wallet balance'), t('attribution: reply or order within 48h links to the last send'), t('report: campaign numbers match the sends log')] },

  // ───────────── Day 4 ─────────────
  { id: 'Y5', week: 4, due: '2026-11-23', owner: 'you', title: 'Update the Terms and Privacy pages', detail: 'They still say Relay does not hold money and customers always pay the fee. Add: Relay holds the wallet, who pays the fee, BVN/bank details for withdrawals, marketing consent and Stop updates, Status mentions.',
    checks: [{ kind: 'lacks', path: 'api/public', re: 'does not hold merchant funds', label: '"Relay does not hold merchant funds" removed' }] },
  { id: 'Y6', week: 4, due: '2026-11-23', owner: 'you', title: 'Ask a lawyer or Bachs about holding shops\' money', detail: 'Holding funds for merchants in Nigeria usually needs a CBN licence or a licensed partner holding them. Needed before real money goes into wallets.', checks: [] },
  { id: 'R10', week: 4, due: '2026-11-23', owner: 'claude', title: 'Relay suggests (max once a day) and the remaining triggers', detail: 'Price drop, after delivery, first-order thanks with the opt-in ask (on); usual order due and win back (off until turned on). Toggles in /reach.',
    checks: [t('suggest: Relay suggests at most once a day per shop'), t('trigger: price drop, after delivery and first order thanks'), t('trigger: usual order due and win back stay off until turned on')] },
  { id: 'R11', week: 4, due: '2026-11-23', owner: 'claude', title: 'Status posts use Smart Reach audiences; weekly report', detail: 'Captions say "Reply *KEYWORD* to order" so replies open free windows. Weekly summary names the best trigger; monthly message-cost line.',
    checks: [t('status: reach segments pick the mentions and captions use a reply keyword'), t('report: weekly summary names the best trigger')] },

  // ───────────── Day 5 ─────────────
  { id: 'Y7', week: 5, due: '2026-11-24', owner: 'you', title: 'Nigerian message rates, and templates submitted once verified', detail: 'Marketing / utility / service rates into config (or confirm the placeholders). After Business Verification: submit the templates in docs/meta-templates.md and the Smart Reach library.', checks: [] },
  { id: 'R12', week: 5, due: '2026-11-24', owner: 'claude', title: 'Personal carousels, free ad window, offer codes, Instagram route', detail: '"Picked for you" product carousels; the 72h free window when a customer came from a click-to-WhatsApp ad; single-use personal codes checked at checkout; free Instagram DMs inside 24h.',
    checks: [t('carousel: picked-for-you products per customer'), t('router: free entry window from ad referral is detected and used'), t('offer codes: single use, per customer, expiry checked at checkout'), t('router: instagram route inside the 24h window')] },
  { id: 'R13', week: 5, due: '2026-11-24', owner: 'claude', title: 'Indexes for the Smart Reach queries', checks: [{ kind: 'has', file: 'firestore.indexes.json', re: 'customerSignals', label: 'customerSignals index' }, { kind: 'has', file: 'firestore.indexes.json', re: '"sends"', label: 'sends index' }] },

  // ───────────── Day 6 ─────────────
  { id: 'Y8', week: 6, due: '2026-11-25', owner: 'you', title: 'Production address and secrets', detail: 'A real domain for the API (wrangler.toml still has a placeholder), Cloudflare production queues and R2 bucket, and production secrets: TOKEN_ENCRYPTION_KEY, Meta, Firebase, Gemini, OPS_API_KEY.',
    checks: [{ kind: 'lacks', file: 'api/wrangler.toml', re: 'relay-api-production\\.example\\.workers\\.dev', label: 'production address is real' }, { kind: 'http', setting: 'prodApiUrl', path: '/health' }] },
  { id: 'Y9', week: 6, due: '2026-11-25', owner: 'you', title: 'Firebase: Blaze plan and production indexes', detail: 'Blaze is needed for the webhook-log TTL. Then deploy firestore.indexes.json to relayafrica-fcc2a.', checks: [] },
  { id: 'Y10', week: 6, due: '2026-11-25', owner: 'you', title: 'Register the real Relay (Admin Bot) number and sync its commands', detail: 'Once it can receive the code: add it in Production setup, set ADMIN_BOT_PHONE_NUMBER_ID, then run npm run sync:commands (try -- --dry-run first).', checks: [] },
  { id: 'C1', week: 6, due: '2026-11-25', owner: 'claude', title: 'Staging matches the branch, every check green', checks: [{ kind: 'http', setting: 'stagingApiUrl', path: '/health' }, { kind: 'allTests', min: 200 }] },

  // ───────────── Day 7 ─────────────
  { id: 'Y11', week: 7, due: '2026-11-26', owner: 'you', title: 'Line up 3–5 pilot shops', detail: 'Run each through signup in the test chat (or for real once Meta allows): menu, hours, delivery, TEST, wallet verify.', checks: [] },
  { id: 'Y12', week: 7, due: '2026-11-26', owner: 'you', title: 'Full run-through yourself', detail: 'In the test chat: sign up a shop, order as a customer, pay (test), withdraw (test), make a Status, send a Smart Reach campaign, stop updates as a customer.', checks: [] },
  { id: 'C2', week: 7, due: '2026-11-26', owner: 'claude', title: 'pivot/whatsapp-native merged into main', detail: 'After your go.', checks: [{ kind: 'merged', commit: 'pivot/whatsapp-native', into: 'main' }] },
  { id: 'C3', week: 7, due: '2026-11-26', owner: 'claude', title: 'Full API test suite green with Smart Reach', checks: [{ kind: 'allTests', min: 230 }] },
];
