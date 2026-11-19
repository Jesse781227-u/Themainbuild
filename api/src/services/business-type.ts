// Guesses the business type from the shop's products and categories, so owners who send a menu
// aren't asked "What kind of business is it?". Confident only when one type clearly wins.
import type { BusinessCategory } from '../domain/business';

const WORDS: [BusinessCategory, RegExp][] = [
  ['food_beverage', /\b(rice|jollof|fried|chicken|beef|goat|fish|turkey|meat|suya|shawarma|burger|pizza|pasta|spaghetti|noodles?|soup|stew|egusi|efo|okra|ogbono|amala|eba|semo|fufu|pounded|yam|plantain|dodo|beans|moi ?moi|akara|puff ?puff|chops|samosa|spring rolls?|small chops|meat ?pie|sausage|bread|cake|cupcakes?|cookies?|doughnuts?|donuts?|pastr(y|ies)|snacks?|meals?|drinks?|juice|smoothie|zobo|chapman|kunu|tigernut|parfait|yoghurt|coffee|tea|water|soda|coke|malt|wine|beer|cocktails?|mocktails?|catering|grills?|bbq|wings|sandwich|wraps?|salad|breakfast|lunch|dinner|combo|platter|pepper ?soup|asun|nkwobi|isi ?ewu|abacha|ofada|porridge|custard|pap|indomie|kitchen)\b/i],
  ['fashion_retail', /\b(shirts?|t-?shirts?|tees?|tops?|blouses?|dress(es)?|gowns?|skirts?|trousers?|jeans|shorts|joggers?|hoodies?|jackets?|suits?|blazers?|agbada|kaftans?|senators?|ankara|aso ?ebi|lace|abaya|jalabiya|bubu|kimono|two ?piece|corsets?|bodysuits?|lingerie|bras?|boxers?|socks|shoes?|sneakers?|trainers?|slides?|slippers?|sandals?|heels|loafers?|boots?|bags?|handbags?|totes?|backpacks?|purses?|wallets?|belts?|caps?|hats?|scarf|scarves|watch(es)?|jewel(le)?ry|necklaces?|earrings?|bracelets?|rings?|sunglasses|thrift|okrika|bale|wears?|outfits?|clothing|clothes|af1|jordans?|nike|adidas|gucci|zara)\b/i],
  ['beauty_wellness', /\b(creams?|lotions?|body ?butter|oils?|serums?|toners?|cleansers?|face ?wash|soaps?|scrubs?|masks?|sunscreen|spf|moisturi[sz]ers?|skin ?care|makeup|lipsticks?|lip ?gloss|foundation|concealer|powder|mascara|eyeliner|lashes|brows?|nails?|manicure|pedicure|wigs?|bundles?|frontals?|closures?|braids?|weave|hair|shampoo|conditioner|perfumes?|fragrances?|body ?mist|oud|spray|deodorant|massage|spa|facial|waxing|beauty)\b/i],
  ['electronics', /\b(phones?|iphone|samsung|tecno|infinix|itel|android|laptops?|macbook|computers?|tablets?|ipad|chargers?|cables?|power ?banks?|earbuds|earphones|headphones|airpods|speakers?|tv|television|smart ?watch|gadgets?|accessories|screen ?guards?|cases?|routers?|modems?|mifi|consoles?|playstation|ps5|xbox|cameras?|drones?|bulbs?|inverters?|solar|batter(y|ies)|ups|printers?|keyboards?|mouse|monitors?|ssd|hard ?drives?|flash ?drives?|memory ?cards?)\b/i],
  ['home', /\b(chairs?|tables?|sofas?|couch|beds?|mattress(es)?|bedsheets?|duvets?|pillows?|curtains?|rugs?|carpets?|towels?|pots?|pans?|cookware|plates?|cups?|mugs?|cutlery|spoons?|blenders?|kettles?|fridge|freezer|microwave|fans?|decor|vases?|frames?|mirrors?|lamps?|candles?|shelves|shelf|wardrobes?|storage|furniture|kitchenware|throw ?pillows?|bedding)\b/i],
  ['photography_events', /\b(photo ?shoots?|shoots?|photography|videography|portraits?|wedding|birthday|events?|decorations?|decor|ushers?|dj|mc|hall|venue|rentals?|backdrop|balloons?|bouquets?|flowers?|souvenirs?|packages?|sessions?)\b/i],
  ['general_services', /\b(cleaning|laundry|dry ?clean|repairs?|installation|plumbing|electrician|tutoring|lessons?|classes?|consultation|design|printing|branding|delivery service|errands?|training|coaching|haircut|barbing|tailoring|sewing|alterations?)\b/i],
];

// Each product counts once for each type its name or category matches.
export function inferBusinessType(items: { name: string; category?: string | null }[]): { type: BusinessCategory | null; confident: boolean } {
  if (!items.length) return { type: null, confident: false };
  const score = new Map<BusinessCategory, number>();
  for (const it of items) {
    const text = `${it.name} ${it.category ?? ''}`;
    for (const [type, re] of WORDS) if (re.test(text)) score.set(type, (score.get(type) ?? 0) + 1);
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { type: null, confident: false };
  const [[type, top], second] = ranked;
  const share = top / items.length;
  // Most products point one way, and clearly more than to any other type.
  const confident = share >= 0.5 && top >= 1 && (!second || top >= 2 * second[1]);
  return { type, confident };
}
