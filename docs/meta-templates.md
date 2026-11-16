# WhatsApp message templates to submit (tracker Y11)

Relay sends free-form text inside the 24-hour customer service window. Outside it, Meta only allows approved templates, so these three need to be created and approved in WhatsApp Manager. The names and the order of the `{{n}}` variables must match what the code sends (`api/src/services/summary.ts`, `broadcasts.ts`, `on-paid.ts`). Names can be changed with the env vars shown; the variable order cannot.

Language: English (`en`, env `TEMPLATE_LANGUAGE`). Add other languages under the same names later if needed.

## 1. Daily summary: `relay_daily_summary` (env `DAILY_SUMMARY_TEMPLATE`)
Category: **Utility**. Sent by the Relay Admin Bot number to owners at 20:00 Lagos time.

```text
📊 Daily summary for {{1}}, {{2}}
Paid orders: {{3}}
Sales: {{4}}
Awaiting payment: {{5}}
Low stock: {{6}}
Reply ORDERS or PRODUCTS for details.
```
Sample values: `Mama Tee's Kitchen`, `Wed 2 Dec`, `14`, `₦86,500`, `3`, `Jollof rice (2), Zobo (0)`.

## 2. Payment receipt: `relay_payment_receipt` (env `RECEIPT_TEMPLATE`)
Category: **Utility**. Sent from the merchant's own number when a payment is matched after the customer's window has closed.

```text
Payment received for order {{1}}: {{2}}. Thank you! We'll update you on delivery or pickup.
```
Sample values: `RLY-7K3QX`, `₦3,030.37`.

## 3. Broadcast: `relay_shop_update` (env `BROADCAST_TEMPLATE`)
Category: **Marketing**. Sent from the merchant's own number, only to customers who opted in (sent SUBSCRIBE).

```text
Update from {{1}}:
{{2}}
```
Footer: `Reply STOP to stop these messages.`
Sample values: `Mama Tee's Kitchen`, `Fresh jollof this Saturday! Order early.`

Notes:
- Templates live on each WhatsApp Business Account. Templates 2 and 3 must exist on **every merchant's WABA**, not only Relay's. **TODO(jesse):** confirm with Meta whether a Tech Provider can create them for connected WABAs through the API at signup (`POST /{waba-id}/message_templates`). If it can, Relay creates them automatically during Embedded Signup.
- Meta may reject a template that is only variables (`{{2}}` carrying the whole message). If it rejects template 3, a fixed opening line plus `{{2}}` usually passes.
- Broadcast pricing: set `MARKETING_MESSAGE_COST_KOBO` to Meta's current marketing rate for Nigerian numbers. Until it is set, broadcasts are refused and the owner is offered a wa.me share link instead. Who pays this charge is still a placeholder in the Terms.
