export type BusinessCategory = 'food_beverage' | 'fashion_retail' | 'beauty_wellness' | 'photography_events' | 'general_services' | 'other';

export interface Business {
  id: string; name: string; category: BusinessCategory;
  ownerPhone: string;                 // E.164; the owner talks to the Admin Bot from this number
  status: 'onboarding' | 'active' | 'suspended';
  timezone: 'Africa/Lagos';
  feeBps?: number | null;             // per-business override of Relay's fee rate
  holdMinutes?: number | null;        // per-business override of the unpaid-order stock hold
  bachsAccountId?: string | null;     // the merchant's Bachs account (payments are split at source)
  createdAt: string; updatedAt: string;
}

export interface ChannelAccount { id: string; businessId: string; channel: 'whatsapp' | 'instagram'; accountId: string }
