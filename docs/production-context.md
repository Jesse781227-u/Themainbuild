# Relay production context

This note records the decisions that supersede older planning documents.

- WhatsApp commerce uses Meta Cloud API directly, with n8n as orchestration. Gupshup is not part of the implementation.
- Storefront customer payments use the `backs.io` provider boundary. Relay SaaS subscription billing remains separate.
- Delivery is optional per business. Businesses can define zones, prices, timeframes, and scheduled delivery batches with cutoffs and dispatch times.
- `uber_direct` is the optional express method for urgent orders. It is never required when self-arranged delivery, scheduled batches, or pickup are available.
- Relay's product scope is e-commerce (web storefront and automated WhatsApp commerce) plus CRM and push advertising.

Development, staging, and production use separate Firebase projects, Render services, external credentials, webhook secrets, and data. Repository configuration contains placeholders only.
