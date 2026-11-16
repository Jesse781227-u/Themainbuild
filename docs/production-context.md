# Relay production context

This note records the decisions that supersede older planning documents. The full list of answers is in [PIVOT_AUDIT.md §6](PIVOT_AUDIT.md).

- Relay is WhatsApp-native (pivot of 16 Nov 2026). There is no web dashboard, web storefront, PWA or web push. Owners use the Admin Bot; customers use the Shop Bot on the merchant's own number.
- WhatsApp uses the Meta Cloud API directly, with Embedded Signup and coexistence. No unofficial WhatsApp libraries. n8n is not used.
- Bots must stay business-specific (Meta has banned general-purpose AI assistants on the WhatsApp Business API since 15 Jan 2026). Off-topic requests get a short, polite redirect.
- Hosting: Cloudflare only. The API is a Worker (Hono) using Firestore over REST, with Queues for webhook processing and Cron Triggers for scheduled jobs. Render is not used.
- Instagram: basic DMs are built in this rebuild. Carousels, Story publishing and comment-to-DM come later.
- Payments: Bachs only, split at source to each merchant's Bachs account. Orders are matched by a unique amount. Relay's fee is 1% of the goods subtotal, capped at ₦2,000, paid by the customer on top and never charged on delivery. Relay does not bill subscriptions.
- Stock is reserved when the order is created and released automatically if the order isn't paid within the hold (default 30 minutes, configurable per business).
- Delivery is optional per business: merchant-defined zones, fees, timeframes and scheduled batches, plus pickup. There is no third-party courier integration.
- Money is integer kobo. Phone numbers are E.164. "Today" and "this week" mean Africa/Lagos.
- WhatsApp Status can't be posted through the API. The bot prepares Status images and captions; the owner posts them by hand.

Development, staging and production use separate Firebase projects, Cloudflare Workers environments, external credentials, webhook secrets and data. Repository configuration contains placeholders only.
