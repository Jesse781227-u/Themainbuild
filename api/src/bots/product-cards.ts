// What customers browse: products as swipeable carousel cards, one category at a time.
//   card: photo (or a neutral stand-in), *name*, price, "Sold out" when out of stock; [Buy] [Details]
//   more than 10 products: 9 product cards + a "See more ➡️" card that opens the next page.
// Sold-out products are shown, marked, never hidden (Buy then says it's sold out).
// Choice ids: buy:<productId>, det:<productId>, more:<categoryId|all>:<page>, menu.
import type { Config } from '../config';
import type { Business } from '../domain/business';
import { hasStock, type Category, type Product } from '../domain/commerce';
import { formatKobo } from '../lib/money';
import type { OutboundContent } from '../services/channel';
import { CAROUSEL, carousel, clip, type CarouselCard } from '../services/carousel';
import { buttons } from './common';

export const PLACEHOLDER_IMAGE = '/product-placeholder.png';
const PER_PAGE = CAROUSEL.maxCards - 1; // the 10th card is "See more"

export const imageFor = (cfg: Pick<Config, 'API_BASE_URL'>, p: Pick<Product, 'images'>) => p.images[0] ?? `${cfg.API_BASE_URL}${PLACEHOLDER_IMAGE}`;

// In-stock first, then sold out; alphabetical within each.
export const browseOrder = (ps: Product[]) => [...ps].sort((a, b) => Number(!hasStock(a)) - Number(!hasStock(b)) || a.name.localeCompare(b.name));

export function cardFor(cfg: Pick<Config, 'API_BASE_URL'>, p: Product): CarouselCard {
  const soldOut = !hasStock(p);
  const head = `*${p.name}*\n${formatKobo(p.priceKobo)}${soldOut ? ' · Sold out' : ''}`;
  const room = CAROUSEL.cardBodyMax - head.length - 1;
  const desc = p.description && room > 20 ? `\n${clip(p.description.replace(/\s+/g, ' '), room)}` : '';
  return { imageUrl: imageFor(cfg, p), body: `${head}${desc}`, buttons: [[`buy:${p.id}`, soldOut ? 'Sold out' : 'Buy'], [`det:${p.id}`, 'Details']] };
}

// One page of a category (or of search results). Returns the messages to send.
export function productCarousel(cfg: Pick<Config, 'API_BASE_URL'>, business: Pick<Business, 'name'>, products: Product[], opts: { title: string; key: string; page?: number; intro?: string }): OutboundContent[] {
  const all = browseOrder(products);
  const page = Math.max(0, opts.page ?? 0);
  const slice = all.slice(page * PER_PAGE, page * PER_PAGE + (all.length - page * PER_PAGE > CAROUSEL.maxCards ? PER_PAGE : CAROUSEL.maxCards));
  if (!slice.length) return [buttons('That\'s everything for now.', [['menu', 'Back to menu']])];
  if (slice.length === 1) return productDetails(cfg, slice[0], opts.intro);
  const shown = page * PER_PAGE + slice.length;
  const cards = slice.map(p => cardFor(cfg, p));
  if (shown < all.length) cards.push({ imageUrl: `${cfg.API_BASE_URL}${PLACEHOLDER_IMAGE}`, body: `*See more*\n${all.length - shown} more in ${opts.title}`, buttons: [[`more:${opts.key}:${page + 1}`, 'See more ➡️'], ['menu', 'Menu']] });
  const body = page ? `${opts.title} (more) 👇` : opts.intro ? `${opts.intro} Swipe to see what we have 👇` : `${opts.title} at ${business.name} 👇 Swipe to see more.`;
  return [carousel(body, cards)];
}

// One product on its own: big photo, description, and what the customer can do next.
export function productDetails(cfg: Pick<Config, 'API_BASE_URL'>, p: Product, intro?: string): OutboundContent[] {
  const soldOut = !hasStock(p);
  const body = `${intro ? `${intro}\n\n` : ''}*${p.name}*\n${formatKobo(p.priceKobo)}${p.description ? `\n\n${p.description}` : ''}${soldOut ? '\n\nSold out right now.' : ''}`;
  const content = buttons(clip(body, 1000), soldOut ? [['menu', 'Menu']] : [[`buy:${p.id}`, 'Buy'], ['menu', 'Menu'], ['cart', 'View cart']]);
  (content.interactive as Record<string, unknown>).header = { type: 'image', image: { link: imageFor(cfg, p) } };
  return [content];
}

// The shop's sections as swipeable cards: cover photo (the category's own, else its first product's),
// *name*, how many items and the lowest price; [View]. More than 10: 9 + a "More sections" card.
// Choice ids: cat:<categoryId>, cats:<page>.
export function categoryCarousel(cfg: Pick<Config, 'API_BASE_URL'>, categories: Category[], products: Product[], opts: { intro: string; page?: number }): OutboundContent {
  const page = Math.max(0, opts.page ?? 0);
  const rest = categories.length - page * PER_PAGE;
  const slice = categories.slice(page * PER_PAGE, page * PER_PAGE + (rest > CAROUSEL.maxCards ? PER_PAGE : CAROUSEL.maxCards));
  const cards: CarouselCard[] = slice.map(c => {
    const items = browseOrder(products.filter(p => p.categoryId === c.id));
    const inStock = items.filter(hasStock);
    const from = inStock.length ? Math.min(...inStock.map(p => p.priceKobo)) : null;
    const cover = c.coverImage || items.find(p => p.images[0])?.images[0] || `${cfg.API_BASE_URL}${PLACEHOLDER_IMAGE}`;
    const count = `${items.length} item${items.length === 1 ? '' : 's'}`;
    return { imageUrl: cover, body: `*${c.name}*\n${count}${from != null ? ` · from ${formatKobo(from)}` : ' · sold out'}`, buttons: [[`cat:${c.id}`, 'View']] };
  });
  const shown = page * PER_PAGE + slice.length;
  if (shown < categories.length) cards.push({ imageUrl: `${cfg.API_BASE_URL}${PLACEHOLDER_IMAGE}`, body: `*More sections*\n${categories.length - shown} more`, buttons: [[`cats:${page + 1}`, 'See more ➡️']] });
  return carousel(page ? 'More sections 👇' : `${opts.intro} Swipe to pick a section 👇`, cards);
}

// After "Added to cart": what goes with it, then (at the end) a slightly better version of it.
export function suggestionMessage(cfg: Pick<Config, 'API_BASE_URL'>, anchor: Pick<Product, 'name'>, s: { cross: Product[]; upsell: Product | null }): OutboundContent | null {
  const cards = s.cross.map(p => cardFor(cfg, p));
  if (s.upsell) {
    const up = cardFor(cfg, s.upsell);
    cards.push({ ...up, body: clip(`⬆️ Upgrade\n${up.body}`, CAROUSEL.cardBodyMax) });
  }
  if (!cards.length) return null;
  const intro = s.cross.length ? `Goes well with your ${anchor.name} 👇` : `Want to upgrade your ${anchor.name}?`;
  if (cards.length === 1) return productDetails(cfg, s.cross[0] ?? s.upsell!, intro)[0];
  return carousel(intro, cards);
}
