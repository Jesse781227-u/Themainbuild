// Bachs payment provider. Payments are split at source: each merchant has their own Bachs account
// and Relay's fee is split off by Bachs, so Relay never holds merchant money.
//
// Nothing below guesses at the Bachs API. Every provider-specific detail is a TODO(jesse) and the
// default adapter fails closed (rejects every webhook) until those are filled in from the Bachs docs.
import type { Config } from '../config';
import type { Business } from '../domain/business';
import type { Order } from '../domain/commerce';
import { formatKobo } from '../lib/money';

export interface BachsPaymentEvent {
  providerRef: string;   // Bachs's unique transaction reference (idempotency key)
  accountId: string;     // the merchant's Bachs account that received the money
  amountKobo: number;    // integer kobo
  paidAt: string;        // ISO-8601
}

export interface BachsAdapter {
  verify(raw: Uint8Array, headers: Headers, cfg: Config): boolean;
  parse(body: unknown): BachsPaymentEvent | null;
}

export const bachsAdapter: BachsAdapter = {
  // TODO(jesse): Bachs webhook authentication: header name, algorithm (HMAC-SHA256?), exactly what
  // is signed (raw body? timestamp + body?), encoding (hex/base64), and replay window. Use
  // cfg.BACHS_WEBHOOK_SECRET and safeEqual() from lib/crypto. Until then every webhook is rejected.
  verify() { return false; },
  // TODO(jesse): Bachs webhook payload: event type for a successful incoming transfer, field names
  // for reference, amount (kobo or naira? string or number?), receiving account id, timestamp, and
  // which events to ignore (reversals, failed). Amounts must be converted with nairaToKobo if naira.
  parse() { return null; },
};

// TODO(jesse): how a merchant's Bachs account is created/linked during onboarding (API call or
// manual), and how Relay's fee split is configured on it (per account or per transaction).
export async function linkMerchantAccount(_business: Business, _cfg: Config): Promise<never> {
  throw new Error('Bachs account linking is not implemented: waiting on the Bachs API docs.');
}

// What the Shop Bot tells the customer to pay. The exact amount matters: it's how the transfer is
// matched to the order.
// TODO(jesse): where the customer pays: the merchant's Bachs account number and bank, a per-order
// virtual account, or a payment link. Replace `payTo` once known.
export function paymentInstructions(order: Pick<Order, 'ref' | 'payAmountKobo' | 'holdExpiresAt'>, payTo: string | null) {
  return [
    `Order ${order.ref}: please transfer exactly ${formatKobo(order.payAmountKobo)}.`,
    payTo ? `Pay to: ${payTo}` : 'Payment details will follow.',
    'The exact amount (including the kobo) is how we match your payment, so please don\'t round it.',
  ].join('\n');
}
