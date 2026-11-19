// What kind of shop this is, from its name and from its products, and examples that fit it:
// a fashion shop is never told "e.g. *Jollof rice 3000*".
//   nameType("Mama Tee's Kitchen") → food · nameType("Tee's Place") → null (vague names say nothing)
//   catalogueType(products) → the type most products point to, with its share
//   example(…) → a real product from their catalogue when there is one, else one for their type
import type { BusinessCategory } from '../domain/business';
import { typesOf } from './business-type';

// Words in a shop's name that clearly say what it sells.
const NAME_WORDS: [BusinessCategory, RegExp][] = [
  ['food_beverage', /\b(kitchens?|foods?|eatery|eateries|restaurants?|bukka|buka|canteen|grills?|caf[eé]|bakery|bakes|bakers?|cakes?|pastr(y|ies)|chops|catering|caterers?|suya|shawarma|pizza|burgers?|juices?|drinks|smoothies?|cuisine|delicacies|treats|snacks|chef|cooks?|pot|spoon|meals?|bistro|lounge)\b/i],
  ['fashion_retail', /\b(fashions?|clothing|clothes|wears?|boutique|collections?|thrift|closet|wardrobe|kicks|sneakers|shoes|footwear|stitches|couture|apparel|styles?|fabrics?|textiles?|tailors?|bags|outfits?|threads|drip|vintage|okrika)\b/i],
  ['beauty_wellness', /\b(beauty|cosmetics?|skin ?care|skin|glow|hair|wigs?|spa|salon|scents?|perfumes?|fragrances?|nails?|lashes|makeup|organics?|essentials)\b/i],
  ['electronics', /\b(gadgets?|phones?|tech|electronics?|devices?|mobiles?|computers?|laptops?|accessories)\b/i],
  ['home', /\b(furniture|interiors?|decor|home ?ware|homes?|kitchenware|bedding)\b/i],
  ['photography_events', /\b(photography|photos?|studios?|events?|pictures|media|films?|weddings?|decorations?)\b/i],
];

export function nameType(name: string | null | undefined): BusinessCategory | null {
  const hits = NAME_WORDS.filter(([, re]) => re.test(name ?? '')).map(([t]) => t);
  return hits.length === 1 ? hits[0] : null; // "Glow Kitchen": two answers, so no answer
}

// The type most products clearly point to, and what share of the products that is.
export function catalogueType(items: { name: string; category?: string | null }[]): { type: BusinessCategory | null; share: number } {
  if (!items.length) return { type: null, share: 0 };
  const count = new Map<BusinessCategory, number>();
  for (const it of items) for (const t of typesOf(`${it.name} ${it.category ?? ''}`)) count.set(t, (count.get(t) ?? 0) + 1);
  const [top] = [...count.entries()].sort((a, b) => b[1] - a[1]);
  return top ? { type: top[0], share: top[1] / items.length } : { type: null, share: 0 };
}

// "Your shop is called X, but this file looks like Y": only when both are clear and they differ.
export function mismatch(shopName: string | null | undefined, items: { name: string; category?: string | null }[]) {
  const named = nameType(shopName);
  const found = catalogueType(items);
  if (!named || !found.type || found.share < 0.6 || found.type === named) return null;
  return { named, found: found.type };
}

// How each type's products are described in "this file looks like …".
export const TYPE_WORDS: Record<BusinessCategory, string> = {
  food_beverage: 'food and drinks', fashion_retail: 'clothing, shoes and bags', beauty_wellness: 'beauty products',
  electronics: 'phones and gadgets', home: 'home items', photography_events: 'photo and event services', general_services: 'services', other: 'other products',
};

// A product line for "e.g. …" when the catalogue has nothing to borrow from.
const FALLBACK: Record<BusinessCategory, { name: string; naira: number }> = {
  food_beverage: { name: 'Jollof rice & chicken', naira: 3500 },
  fashion_retail: { name: 'Plaid Flannel Shirt', naira: 6500 },
  beauty_wellness: { name: 'Shea body butter', naira: 4500 },
  electronics: { name: 'iPhone 15 charger', naira: 8000 },
  home: { name: 'Throw pillow', naira: 7000 },
  photography_events: { name: 'Birthday shoot', naira: 50000 },
  general_services: { name: 'Laundry (1 bag)', naira: 5000 },
  other: { name: 'Gift box', naira: 5000 },
};

// The type to write examples for: the shop's type once known, else what its name suggests.
export const exampleType = (b: { category?: BusinessCategory | null; name?: string | null }): BusinessCategory =>
  (b.category && b.category !== 'other' ? b.category : nameType(b.name === 'My shop' ? null : b.name) ?? b.category ?? 'other');

// "Plaid Flannel Shirt 6500" (with the price) or "Plaid Flannel Shirt" (name only). Prefers one of
// their own products with a short name.
export function example(b: { category?: BusinessCategory | null; name?: string | null }, products: { name: string; priceKobo: number }[] = [], opts: { price?: number; nameOnly?: boolean } = {}) {
  const own = [...products].filter(p => p.name.length <= 30).sort((a, x) => a.name.length - x.name.length)[Math.min(1, products.length - 1)] ?? products[0];
  const pick = own ? { name: own.name, naira: Math.round(own.priceKobo / 100) } : FALLBACK[exampleType(b)];
  if (opts.nameOnly) return pick.name;
  return `${pick.name} ${opts.price ?? pick.naira}`;
}
