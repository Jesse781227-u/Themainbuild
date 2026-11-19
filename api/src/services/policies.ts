// Shop policies: suggested per business type at signup, editable any time (POLICIES). The Shop Bot
// answers return/refund/complaint questions from these instead of guessing.
import type { BusinessCategory } from '../domain/business';

export interface Policies { returns: string; issues: string; custom?: string | null }

const DEFAULTS: Record<BusinessCategory, Policies> = {
  food_beverage: { returns: 'No returns on food.', issues: 'If something is wrong with your order, tell us within 1 hour of delivery or pickup and we\'ll make it right.' },
  fashion_retail: { returns: 'Exchange within 3 days if the item is unworn with tags on. No refunds.', issues: 'Wrong item or a fault? Tell us within 24 hours with a photo.' },
  beauty_wellness: { returns: 'No returns on opened products, for hygiene reasons.', issues: 'Damaged or wrong item? Tell us within 24 hours with a photo.' },
  electronics: { returns: 'Faulty items can be exchanged within 7 days with the receipt. No refunds for change of mind.', issues: 'Report any fault within 7 days, with a photo or video.' },
  home: { returns: 'Exchange within 3 days if unused and in the original packaging.', issues: 'Damaged on delivery? Tell us within 24 hours with a photo.' },
  photography_events: { returns: 'Deposits are non-refundable. Bookings can be moved once with 7 days\' notice.', issues: 'Any issue with your booking? Message us and we\'ll sort it out.' },
  general_services: { returns: 'Payments are non-refundable once the service has started.', issues: 'Not happy with the service? Tell us within 24 hours.' },
  other: { returns: 'Exchanges within 3 days if the item is unused. No refunds.', issues: 'Wrong or damaged item? Tell us within 24 hours with a photo.' },
};

export const defaultPolicies = (type: BusinessCategory | undefined): Policies => ({ ...DEFAULTS[type ?? 'other'] ?? DEFAULTS.other });

export function policyText(p: Policies | null | undefined) {
  if (!p) return null;
  if (p.custom) return p.custom;
  return [p.returns && `• ${p.returns}`, p.issues && `• ${p.issues}`].filter(Boolean).join('\n') || null;
}

export const POLICY_QUESTION = /\b(return|refund|exchange|policy|policies|money back|complain|complaint|damaged|faulty|wrong (item|order|size)|broken)\b/i;
