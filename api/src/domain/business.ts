export type BusinessCategory = 'fashion_retail' | 'food_beverage' | 'beauty_wellness' | 'electronics' | 'home' | 'photography_events' | 'general_services' | 'other';

// The business types offered at signup, in order, with their starter product categories.
export const BUSINESS_TYPES: { id: BusinessCategory; label: string; starters: string[] }[] = [
  { id: 'fashion_retail', label: 'Fashion', starters: ['Clothing', 'Shoes', 'Bags', 'Accessories'] },
  { id: 'food_beverage', label: 'Food', starters: ['Meals', 'Snacks', 'Drinks'] },
  { id: 'beauty_wellness', label: 'Beauty', starters: ['Skincare', 'Makeup', 'Hair', 'Fragrances'] },
  { id: 'electronics', label: 'Electronics', starters: ['Phones', 'Computers', 'Accessories', 'Gadgets'] },
  { id: 'home', label: 'Home', starters: ['Furniture', 'Kitchen', 'Decor', 'Bedding'] },
  { id: 'photography_events', label: 'Photography & events', starters: ['Photo shoots', 'Events', 'Packages'] },
  { id: 'general_services', label: 'Services', starters: ['Services', 'Packages'] },
  { id: 'other', label: 'Other', starters: ['Products'] },
];

export interface Business {
  id: string; name: string; category: BusinessCategory;
  ownerName?: string | null; city?: string | null; area?: string | null;
  statusTips?: boolean; lastStatusTipDate?: string | null; // "Make a Status?" tips (on unless false), at most one a day
  pausedUntil?: string | null;                       // PAUSE: no orders until then (ISO), or 'open' until they reopen
  address?: string | null; landmark?: string | null; // street/building and a landmark: where pickup customers go
  profilePhotoUrl?: string | null;    // the shop's logo/photo (R2); pushed to the WhatsApp profile once connected
  suggestions?: boolean;              // "goes well with" suggestions after add-to-cart; on unless false (SUGGESTIONS OFF)
  messages?: import('../services/shop-messages').ShopMessages | null; // the shop's own wording for welcome, receipts, …
  ownerPhone: string;                 // E.164; the owner talks to the Admin Bot from this number
  status: 'onboarding' | 'active' | 'suspended' | 'deleted';
  paymentDetails?: string | null;      // bank details shown to customers until Bachs payment links exist
  timezone: 'Africa/Lagos';
  feeBps?: number | null;             // per-business override of Relay's fee rate
  holdMinutes?: number | null;        // per-business override of the unpaid-order stock hold
  bachsAccountId?: string | null;     // the merchant's Bachs account (payments are split at source)
  // Signup (onboarding v2).
  termsAcceptedAt?: string | null; termsVersion?: string | null;
  businessTypeInferred?: boolean;     // category guessed from the products, not chosen
  hours?: import('../services/hours').Hours | null; // Africa/Lagos; null = open any time
  afterHours?: 'orders' | 'menu';     // when closed: take orders for later (default) or menu only
  prepTime?: string | null;           // food: how long an order takes, e.g. "30–60 min"
  fulfilment?: 'pickup' | 'delivery' | 'both' | null;
  shipsInterstate?: boolean; interstatePricing?: 'flat' | 'quote' | null;
  policies?: import('../services/policies').Policies | null;
  feePayer?: 'customer' | 'owner';    // who pays Relay's 1% (capped); the customer unless the owner chose to
  acquisitionSource?: string | null;  // "How did you hear about Relay?"
  importContacts?: boolean | null;    // owner agreed to add the number's synced contacts to CUSTOMERS
  whatsappDisplayNumber?: string | null;
  messagesEdited?: boolean;           // owner changed a drafted customer message (day-2 nudge)
  firstSaleAt?: string | null; nudgedAt?: string | null;
  createdAt: string; updatedAt: string;
}

export interface ChannelAccount { id: string; businessId: string; channel: 'whatsapp' | 'instagram'; accountId: string }
