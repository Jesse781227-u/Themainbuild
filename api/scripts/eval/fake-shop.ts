// An in-memory shop for the conversation eval (no database): two made-up example catalogues, a
// cart, past orders and a delivery list, behind the same ShopHelpers the real Shop Bot gives the
// agent. Everything the agent "does" is recorded so fixtures can check it.
import type { Business } from '../../src/domain/business';
import type { Product } from '../../src/domain/commerce';
import { hasStock, lineName, priceOf } from '../../src/domain/commerce';
import type { ShopHelpers } from '../../src/bots/shop-agent';

const P = (id: string, name: string, naira: number, cat: string, extra: Partial<Product> = {}): Product => ({
  id, businessId: 'eval', name, description: '', priceKobo: naira * 100, images: [`https://img.test/${id}.jpg`], categoryId: cat, available: true, stock: 10, lowStockThreshold: 2,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', deletedAt: null, ...extra,
} as Product);
const sizes = (labels: string[], stock: (l: string) => number | null = () => 5) => ({ stock: null, optionNames: ['Size'], variants: labels.map(l => ({ id: `s${l}`, label: l, options: { Size: l }, priceKobo: null, stock: stock(l) })) });

export const SHOPS = {
  fashion: {
    business: { id: 'eval-f', name: 'Kicks & Co', category: 'fashion_retail', status: 'active', fulfilment: 'both', hours: null, policies: { returns: '7 days, unworn, with receipt', refunds: 'Store credit only' }, messages: { welcome: 'Hey {customer_name}! 👋 Welcome to Kicks & Co.' } } as unknown as Business,
    categories: [{ id: 'sn', name: 'Sneakers' }, { id: 'sl', name: 'Slides' }, { id: 'ac', name: 'Accessories' }],
    products: [
      P('blk', 'Black Sneakers', 15000, 'sn', sizes(['40', '41', '42', '43'], l => (l === '43' ? 0 : 4))),
      P('wht', 'White Sneakers', 18000, 'sn', sizes(['41', '42', '44'])),
      P('j4', 'Jordan 4 Retro', 65000, 'sn', sizes(['42', '43'], () => 1)),
      P('rsl', 'Rubber Slides', 5000, 'sl'),
      P('lsl', 'Leather Slides', 12000, 'sl', { stock: 0 }),
      P('sox', 'Ankle Socks (3 pairs)', 2500, 'ac', { stock: 50 }),
      P('cln', 'Sneaker Cleaner', 4000, 'ac'),
    ],
    zones: { yaba: 2000, surulere: 2500, ikeja: 3000, lekki: 4500 } as Record<string, number>,
  },
  food: {
    business: { id: 'eval-k', name: "Mama T's Kitchen", category: 'food_beverage', status: 'active', fulfilment: 'both', prepTime: '30 minutes', hours: null, policies: { refunds: 'We remake wrong orders' }, messages: { welcome: 'Welcome to Mama T! What would you like today?' } } as unknown as Business,
    categories: [{ id: 'ri', name: 'Rice' }, { id: 'sw', name: 'Swallow' }, { id: 'dr', name: 'Drinks' }],
    products: [
      P('jol', 'Jollof Rice', 3500, 'ri'),
      P('fri', 'Fried Rice', 3500, 'ri', { stock: 0 }),
      P('egu', 'Egusi Soup + Pounded Yam', 5000, 'sw'),
      P('amala', 'Amala + Ewedu', 4000, 'sw'),
      P('zob', 'Zobo (50cl)', 1000, 'dr', { stock: 30 }),
      P('chap', 'Chapman', 1500, 'dr'),
    ],
    zones: { yaba: 1000, surulere: 1500, ikeja: 2000 } as Record<string, number>,
  },
};
export type ShopKey = keyof typeof SHOPS;

export interface Recorder { cart: Map<string, number>; checkout: null | { deliverTo?: string | null; pickup?: boolean }; owner: string | null; asked: string[]; updates: boolean | null; code: string | null }

export function fakeHelpers(key: ShopKey, opts: { first?: boolean; pastOrder?: boolean; savedAddress?: string | null } = {}): { h: ShopHelpers; rec: Recorder; sent: string[] } {
  const shop = SHOPS[key];
  const rec: Recorder = { cart: new Map(), checkout: null, owner: null, asked: [], updates: null, code: null };
  const sent: string[] = [];
  const byId = new Map(shop.products.map(p => [p.id, p]));
  const lines = () => [...rec.cart].map(([k, qty]) => { const [id, v] = k.split('#'); const p = byId.get(id)!; return { name: lineName(p, v || null), qty, totalKobo: priceOf(p, v || null) * qty, productId: id, variantId: v || null }; });
  const cart = async () => { const l = lines(); return { cart: l.length ? ({ items: l.map(x => ({ productId: x.productId, qty: x.qty, ...(x.variantId ? { variantId: x.variantId } : {}) })) } as never) : null, lines: l, subtotalKobo: l.reduce((t, x) => t + x.totalKobo, 0) }; };
  const words = (q: string) => q.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3).map(w => w.replace(/s$/, ''));
  const last = opts.pastOrder ? { ref: 'RLY-EVAL1', items: key === 'food' ? ['2 × Jollof Rice', '1 × Zobo (50cl)'] : ['1 × Black Sneakers (42)'], status: 'paid, delivered' } : null;
  const h: ShopHelpers = {
    business: shop.business, customer: { name: 'Ada Obi', orderCount: opts.pastOrder ? 3 : 0 } as never, first: !!opts.first, welcome: opts.first ? 'Hey Ada! 👋 Welcome.' : null, pidgin: false,
    products: shop.products, categories: shop.categories, lastOrder: last, cart,
    search: async q => { const ws = words(q); const cat = new Map(shop.categories.map(c => [c.id, c.name.toLowerCase()])); return shop.products.filter(p => ws.some(w => p.name.toLowerCase().includes(w) || (cat.get(p.categoryId ?? '') ?? '').includes(w))); },
    put: async (id, qty, variantId, mode) => {
      const p = byId.get(id); if (!p) return { ok: false, reason: 'unavailable', name: '', left: null };
      const k = `${id}#${variantId ?? ''}`; const want = mode === 'set' ? qty : (rec.cart.get(k) ?? 0) + qty;
      const v = p.variants?.find(x => x.id === variantId); const left = v ? v.stock : p.stock;
      if (!hasStock(p, 1, variantId) || (left !== null && want > left)) return { ok: false, reason: 'stock', name: lineName(p, variantId), left };
      if (want > 0) rec.cart.set(k, want); else rec.cart.delete(k);
      return { ok: true, name: lineName(p, variantId), qty: want };
    },
    noteInterest: async () => {},
    sendText: async w => { sent.push(w); }, sendProducts: async (_l, w) => { sent.push(w); }, sendCart: async w => { sent.push(w); }, sendChoices: async (w, o) => { sent.push(`${w} [${o.join('|')}]`); },
    checkout: async w => { sent.push(w); rec.checkout = {}; },
    checkoutTo: async (w, how) => { sent.push(w); rec.checkout = how; },
    handToOwner: async (w, reason) => { sent.push(w); rec.owner = reason; },
    askOwner: async q => { rec.asked.push(q); },
    shopInfo: async t => (t === 'policy' ? Object.entries((shop.business.policies ?? {}) as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join('; ') : t === 'delivery' ? Object.entries(shop.zones).map(([z, n]) => `${z}: ₦${n.toLocaleString('en-NG')}`).join(', ') : t === 'location' ? '12 Herbert Macaulay Way, Yaba, Lagos' : t === 'hours' ? 'Mon–Sat 9am–8pm' : null),
    quote: async area => { const z = Object.keys(shop.zones).find(k => area.toLowerCase().includes(k)); return z ? { area: z, feeKobo: shop.zones[z] * 100, timeframe: 'same day', later: false } : null; },
    savedAddress: opts.savedAddress ?? null, canPickup: true,
    orders: async () => (last ? [{ ref: last.ref, status: last.status, total: key === 'food' ? '₦8,000' : '₦15,000', items: last.items, when: '2026-11-15' }] : []),
    orderAgain: async w => { sent.push(w); for (const it of key === 'food' ? [['jol', 2], ['zob', 1]] as const : [['blk#s42', 1]] as const) rec.cart.set(it[0].includes('#') ? it[0] : `${it[0]}#`, it[1]); },
    applyCode: async code => { rec.code = code; return /^ADA-7KX2$/i.test(code) ? { ok: true, code: 'ADA-7KX2', off: '10% off' } : { ok: false, reason: "That code doesn't exist." }; },
    setUpdates: async on => { rec.updates = on; },
    pairings: async id => (key === 'fashion' && ['blk', 'wht', 'j4'].includes(id) ? [byId.get('cln')!, byId.get('sox')!] : key === 'food' && ['jol', 'egu', 'amala'].includes(id) ? [byId.get('zob')!, byId.get('chap')!] : []),
  };
  return { h, rec, sent };
}
