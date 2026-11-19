# WhatsApp Flows (forms) for the Admin Bot

Three forms replace a few chat messages each: **Add product**, **Opening hours** and **Delivery**.
They are off until you switch them on. The chat version always works, including in the local test chat.

To switch them on:
1. In Meta's WhatsApp Manager → Flows, create three Flows for the Relay (Admin Bot) number and paste
   `add-product.json`, `hours.json` and `delivery.json`. These Flows have no endpoint. Publish them.
2. Set these values on the Worker (wrangler secret or vars):
   `FLOWS_ENABLED=true`, `FLOW_ID_ADD_PRODUCT=<id>`, `FLOW_ID_HOURS=<id>`, `FLOW_ID_DELIVERY=<id>`.
   A Flow without an id stays on the chat version.

The answers come back to the Admin Bot (`bots/flow-answers.ts`). They get the same checks as the chat
version, and only the shop the form was sent for is changed.
