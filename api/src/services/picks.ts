// "Picked for you": a few products for one customer, as a swipeable carousel (free inside a chat
// window; the relay_picked_for_you template outside it). What they bought, viewed, asked about or
// carted points to sections; products they already bought, hidden or sold out are left out.
import type { Product } from '../domain/commerce';
import { hasStock } from '../domain/commerce';
import { formatKobo } from '../lib/money';
import { carousel, clip, CAROUSEL, type CarouselCard } from './carousel';
import type { OutboundContent } from './channel';

export interface PickSignal { type: string; productId: string | null; categoryId: string | null; at: string }

export function pickedForYou(products: Product[], signals: PickSignal[], bought: string[], max = 5, now = new Date()): Product[] {
  const catOf = new Map(products.map(p => [p.id, p.categoryId ?? null]));
  const weight: Record<string, number> = { bought: 3, carted: 2, asked: 1.5, viewed: 1 };
  const catScore = new Map<string, number>(), prodScore = new Map<string, number>();
  for (const s of signals) {
    const w = (weight[s.type] ?? 0) * Math.exp(-((now.getTime() - new Date(s.at).getTime()) / 86_400_000) / 30);
    const cat = s.categoryId ?? (s.productId ? catOf.get(s.productId) : null);
    if (cat) catScore.set(cat, (catScore.get(cat) ?? 0) + w);
    if (s.productId && s.type !== 'bought') prodScore.set(s.productId, (prodScore.get(s.productId) ?? 0) + w);
  }
  const owned = new Set(bought);
  return products
    .filter(p => p.available && !p.deletedAt && hasStock(p) && p.images?.[0] && !owned.has(p.id))
    .map(p => ({ p, score: (prodScore.get(p.id) ?? 0) * 2 + (catScore.get(p.categoryId ?? '') ?? 0) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .slice(0, Math.min(max, CAROUSEL.maxCards))
    .map(x => x.p);
}

// The carousel itself, or null with fewer than two picks (WhatsApp needs 2–10 cards).
export function picksMessage(body: string, picks: Product[]): OutboundContent | null {
  if (picks.length < CAROUSEL.minCards) return null;
  const cards: CarouselCard[] = picks.map(p => ({ imageUrl: p.images[0], body: clip(`${p.name}\n${formatKobo(p.priceKobo)}`, CAROUSEL.cardBodyMax), buttons: [[`buy:${p.id}`, 'Add to cart']] }));
  return carousel(clip(body, CAROUSEL.bodyMax), cards);
}
