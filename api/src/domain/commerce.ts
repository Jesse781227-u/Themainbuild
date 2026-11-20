// Money is integer kobo everywhere (fields end in Kobo). Times are ISO-8601 UTC strings.

export type Channel = 'whatsapp' | 'instagram';

export interface Product {
  id: string; businessId: string; name: string; description: string;
  priceKobo: number; images: string[];
  categoryId: string | null;   // required for new products; null only on products created before categories
  available: boolean;
  stock: number | null;        // sellable now (reserved units already subtracted); null = not tracked, always available
                               // with options: the total of their stock, or null if any option isn't counted
  lowStockThreshold: number;
  optionNames?: string[] | null; // e.g. ['Size', 'Colour']
  variants?: Variant[] | null;   // one per size/colour combination, each with its own stock (and price, if different)
  createdAt: string; updatedAt: string; deletedAt?: string | null;
}

// One size/colour combination of a product: "42 / Black". priceKobo null = the product's price.
export interface Variant { id: string; label: string; options: Record<string, string>; priceKobo: number | null; stock: number | null }

type Stocked = Pick<Product, 'stock'> & { variants?: Variant[] | null };

// Stock helpers: a product (or option) without a stock count is never sold out and never reserved.
export const tracksStock = (p: Pick<Product, 'stock'>): p is Pick<Product, 'stock'> & { stock: number } => typeof p.stock === 'number';
export const variantOf = (p: { variants?: Variant[] | null }, variantId: string | null | undefined) => (variantId ? p.variants?.find(v => v.id === variantId) ?? null : null);
// With options: that option (or, with none given, any option) has enough.
export const hasStock = (p: Stocked, qty = 1, variantId?: string | null) => {
  if (p.variants?.length) {
    const ok = (v: Variant) => v.stock === null || v.stock >= qty;
    return variantId ? !!variantOf(p, variantId) && ok(variantOf(p, variantId)!) : p.variants.some(ok);
  }
  return !tracksStock(p) || p.stock >= qty;
};
export const stockLabel = (p: Stocked) => (p.variants?.length
  ? p.variants.map(v => `${v.label}${v.stock === null ? '' : v.stock ? ` (${v.stock})` : ' (sold out)'}`).join(', ')
  : tracksStock(p) ? `${p.stock} in stock` : 'no stock count');
export const priceOf = (p: Pick<Product, 'priceKobo'> & { variants?: Variant[] | null }, variantId?: string | null) => variantOf(p, variantId)?.priceKobo ?? p.priceKobo;
export const lineName = (p: Pick<Product, 'name'> & { variants?: Variant[] | null }, variantId?: string | null) => { const v = variantOf(p, variantId); return v ? `${p.name} (${v.label})` : p.name; };
// A product's stock total from its options: null when any option isn't counted.
export const totalStock = (variants: Variant[]) => (variants.every(v => v.stock !== null) ? variants.reduce((t, v) => t + (v.stock ?? 0), 0) : null);

// The update for several stock changes on one product (checkout holds, releases, late sales,
// restocks): options change one by one, plain products as a whole. Null when nothing is counted.
// Throws INSUFFICIENT_STOCK if any counted stock would go below 0.
export function stockPatch(p: Stocked, changes: { variantId?: string | null; delta: number }[]): { stock: number | null; variants?: Variant[] } | null {
  if (p.variants?.length) {
    const variants = p.variants.map(v => ({ ...v }));
    let touched = false;
    for (const c of changes) {
      const v = variants.find(x => x.id === c.variantId);
      if (!v || v.stock === null) continue;
      v.stock += c.delta;
      if (v.stock < 0) throw new Error('INSUFFICIENT_STOCK');
      touched = true;
    }
    return touched ? { variants, stock: totalStock(variants) } : null;
  }
  if (!tracksStock(p)) return null;
  const stock = p.stock + changes.reduce((t, c) => t + c.delta, 0);
  if (stock < 0) throw new Error('INSUFFICIENT_STOCK');
  return { stock };
}

// Turns "Size 40–44" × "Colour Black, Brown" into the combinations (at most 30).
export function makeVariants(options: { name: string; values: string[] }[], stock: number | null = null): Variant[] {
  const usable = options.filter(o => o.values.length).slice(0, 2);
  if (!usable.length) return [];
  let combos: Record<string, string>[] = [{}];
  for (const o of usable) combos = combos.flatMap(c => o.values.map(v => ({ ...c, [o.name]: v })));
  return combos.slice(0, 30).map((c, i) => ({ id: `v${i + 1}`, label: Object.values(c).join(' / '), options: c, priceKobo: null, stock }));
}

export interface Category {
  id: string; businessId: string; name: string; slug: string; sortOrder: number;
  productCount: number;        // live (not deleted) products; maintained in the same transaction as product writes
  coverImage?: string | null; active: boolean;
  createdAt: string; updatedAt: string;
}

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

export interface CartLine { productId: string; qty: number; variantId?: string | null }
// suggestedAt: a "Goes well with" message was sent for this cart; there's only ever one per cart.
export interface Cart { id: string; businessId: string; customerId: string; channel: Channel; items: CartLine[]; expiresAt: string; updatedAt: string; suggestedAt?: string | null }

export interface OrderLine { productId: string; name: string; priceKobo: number; qty: number; variantId?: string | null }
export interface OrderDelivery { method: 'self_arranged' | 'pickup'; feeKobo: number; zoneId?: string | null; batchId?: string | null; timeframe?: string | null; address?: string | null }

export type OrderStatus = 'awaiting_payment' | 'paid' | 'expired' | 'cancelled';
export type Fulfilment = 'pending' | 'ready' | 'out_for_delivery' | 'delivered' | 'picked_up';

export interface Order {
  id: string; ref: string; businessId: string; customerId: string; channel: Channel;
  items: OrderLine[];
  subtotalKobo: number;   // goods only
  deliveryFeeKobo: number;
  feeKobo: number;        // Relay's fee, on goods only
  feePaidBy?: 'customer' | 'owner'; // customer: added to payAmountKobo; owner: taken from what the shop receives
  uniqueKobo: number;     // small offset that makes payAmountKobo unique among this business's open orders
  discountKobo?: number;  // a personal offer code (Smart Reach), off the goods
  offerCode?: string | null;
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
