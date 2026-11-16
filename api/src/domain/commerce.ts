// Money is integer kobo everywhere (fields end in Kobo). Times are ISO-8601 UTC strings.

export type Channel = 'whatsapp' | 'instagram';

export interface Product {
  id: string; businessId: string; name: string; description: string;
  priceKobo: number; images: string[]; categoryId?: string | null;
  available: boolean;
  stock: number;               // sellable now; reserved units are already subtracted
  lowStockThreshold: number;
  createdAt: string; updatedAt: string; deletedAt?: string | null;
}

export interface Category { id: string; businessId: string; name: string; sortOrder: number }

export interface StockMovement { id: string; businessId: string; productId: string; delta: number; reason: 'restock' | 'adjustment' | 'hold' | 'release' | 'sale'; orderId?: string; actor: string; at: string }

export interface Customer {
  id: string; businessId: string; phone: string; name?: string;
  marketingOptIn: boolean; orderCount: number; totalSpentKobo: number;
  lastOrderAt?: string | null; createdAt: string; updatedAt: string;
}

export interface Conversation {
  id: string; businessId: string; channel: Channel; customerId: string;
  lastInboundAt: string | null; // drives the 24-hour free-form window
  mode: 'bot' | 'owner';         // owner takeover keeps the bot silent until handback
  updatedAt: string;
}

export interface CartLine { productId: string; qty: number }
export interface Cart { id: string; businessId: string; customerId: string; channel: Channel; items: CartLine[]; expiresAt: string; updatedAt: string }

export interface OrderLine { productId: string; name: string; priceKobo: number; qty: number }
export interface OrderDelivery { method: 'self_arranged' | 'pickup'; feeKobo: number; zoneId?: string | null; batchId?: string | null; timeframe?: string | null; address?: string | null }

export type OrderStatus = 'awaiting_payment' | 'paid' | 'expired' | 'cancelled';
export type Fulfilment = 'pending' | 'ready' | 'out_for_delivery' | 'delivered' | 'picked_up';

export interface Order {
  id: string; ref: string; businessId: string; customerId: string; channel: Channel;
  items: OrderLine[];
  subtotalKobo: number;   // goods only
  deliveryFeeKobo: number;
  feeKobo: number;        // Relay's fee, on goods only, paid by the customer
  uniqueKobo: number;     // small offset that makes payAmountKobo unique among this business's open orders
  payAmountKobo: number;  // exactly what the customer must transfer
  status: OrderStatus;    // the one payment/lifecycle status
  fulfilment: Fulfilment;
  delivery: OrderDelivery | null;
  holdExpiresAt: string;
  paidAt?: string | null; paymentId?: string | null;
  needsAttention?: string | null;
  createdAt: string; updatedAt: string;
}

export interface Payment {
  id: string; businessId: string | null; provider: 'bachs'; providerRef: string;
  amountKobo: number; orderId: string | null; status: 'matched' | 'unmatched' | 'late';
  receivedAt: string;
}
