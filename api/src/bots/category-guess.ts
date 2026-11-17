// Picks a product's category. Rules first (free, instant, predictable); the LLM only when the rules
// can't decide, and it may only choose one of the business's existing categories. "Confident"
// means the bot files the product without asking; otherwise it asks the owner with buttons.
import type { Category } from '../domain/commerce';
import type { LLMProvider } from '../services/ai';
import { log } from '../lib/logger';

// Words that point at a starter category (see BUSINESS_TYPES). Matched against the product name.
const KEYWORDS: Record<string, string[]> = {
  clothing: ['shirt', 'tshirt', 't-shirt', 'tee', 'dress', 'gown', 'top', 'blouse', 'jeans', 'trouser', 'trousers', 'pants', 'skirt', 'jacket', 'hoodie', 'sweater', 'polo', 'agbada', 'kaftan', 'ankara', 'jumpsuit', 'shorts', 'joggers', 'senator'],
  shoes: ['shoe', 'shoes', 'sneaker', 'sneakers', 'af1', 'airforce', 'jordan', 'jordans', 'slide', 'slides', 'heel', 'heels', 'sandal', 'sandals', 'boot', 'boots', 'loafer', 'loafers', 'slippers', 'palm', 'palms', 'crocs', 'yeezy'],
  bags: ['bag', 'bags', 'handbag', 'purse', 'backpack', 'tote', 'clutch', 'luggage', 'wallet'],
  accessories: ['watch', 'watches', 'belt', 'cap', 'hat', 'sunglasses', 'glasses', 'chain', 'necklace', 'bracelet', 'ring', 'earring', 'earrings', 'charger', 'case', 'cable', 'earbuds', 'airpods', 'powerbank'],
  meals: ['rice', 'jollof', 'fried', 'soup', 'stew', 'amala', 'eba', 'pounded', 'yam', 'pasta', 'spaghetti', 'noodles', 'burger', 'shawarma', 'pizza', 'beans', 'porridge', 'swallow', 'egusi', 'efo', 'ofada', 'asun', 'suya', 'chicken', 'turkey', 'fish'],
  snacks: ['chin', 'chinchin', 'puff', 'puffpuff', 'meatpie', 'pie', 'samosa', 'springroll', 'chips', 'plantain', 'doughnut', 'donut', 'cake', 'cookies', 'popcorn', 'buns'],
  drinks: ['zobo', 'juice', 'water', 'smoothie', 'chapman', 'drink', 'drinks', 'coke', 'malt', 'kunu', 'tigernut', 'yoghurt', 'yogurt', 'parfait', 'milkshake', 'soda', 'wine', 'beer'],
  phones: ['phone', 'phones', 'iphone', 'samsung', 'tecno', 'infinix', 'itel', 'pixel', 'redmi', 'xiaomi', 'oppo', 'vivo'],
  computers: ['laptop', 'laptops', 'macbook', 'pc', 'desktop', 'computer', 'monitor', 'keyboard', 'mouse', 'hp', 'dell', 'lenovo'],
  gadgets: ['speaker', 'headphones', 'smartwatch', 'console', 'playstation', 'ps5', 'xbox', 'camera', 'drone', 'tablet', 'ipad'],
  skincare: ['cream', 'serum', 'lotion', 'soap', 'cleanser', 'toner', 'sunscreen', 'moisturizer', 'moisturiser', 'scrub', 'oil'],
  makeup: ['lipstick', 'lip', 'gloss', 'foundation', 'powder', 'mascara', 'concealer', 'eyeliner', 'blush', 'palette', 'primer', 'lashes'],
  hair: ['wig', 'wigs', 'braid', 'braids', 'weave', 'bundle', 'bundles', 'shampoo', 'conditioner', 'frontal', 'closure', 'relaxer'],
  fragrances: ['perfume', 'spray', 'oud', 'cologne', 'mist', 'fragrance', 'scent'],
  furniture: ['chair', 'table', 'sofa', 'couch', 'bed', 'wardrobe', 'shelf', 'desk', 'stool', 'cabinet'],
  kitchen: ['pot', 'pots', 'pan', 'blender', 'plate', 'plates', 'cup', 'cups', 'spoon', 'knife', 'kettle', 'cooker', 'microwave', 'flask'],
  decor: ['vase', 'frame', 'mirror', 'rug', 'curtain', 'curtains', 'candle', 'lamp', 'art', 'clock', 'plant'],
  bedding: ['duvet', 'bedsheet', 'bedsheets', 'pillow', 'pillows', 'blanket', 'mattress', 'towel', 'towels'],
};

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
const stem = (w: string) => w.replace(/(es|s)$/, '');

export interface Guess { category: Category | null; confident: boolean }

// Keyword groups a category name belongs to: its own group ("Shoes" → shoes) or any group that lists
// the word ("Sneakers" is a kind of shoe, so it gets the shoe words).
const groupsFor = (word: string) => Object.entries(KEYWORDS).filter(([k, list]) => k === word || stem(k) === stem(word) || list.includes(word) || list.includes(stem(word))).flatMap(([, list]) => list);

export function ruleGuess(productName: string, cats: Category[]): Category | null {
  const name = words(productName);
  const nameStems = new Set(name.map(stem));
  // 1. The category's own name is in the product name: "Leather bag" → Bags.
  const direct = cats.filter(c => words(c.name).some(w => nameStems.has(stem(w))));
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return null;
  // 2. A related word: "Black AF1" → Shoes (or Sneakers).
  const related = cats.filter(c => words(c.name).flatMap(groupsFor).some(k => name.includes(k) || nameStems.has(stem(k))));
  return related.length === 1 ? related[0] : null;
}

export async function guessCategory(productName: string, cats: Category[], llm: LLMProvider | null, imageUrl?: string | null): Promise<Guess> {
  if (!cats.length) return { category: null, confident: false };
  if (cats.length === 1) return { category: cats[0], confident: true };
  const rule = ruleGuess(productName, cats);
  if (rule) return { category: rule, confident: true };
  if (!llm) return { category: null, confident: false };
  try {
    const choice = await llm.chooseTool({
      system: 'You file a product from a small shop in Nigeria into one of the shop\'s own categories. Use the product name and, if given, its photo. Say confidence "low" unless the category is clearly right.',
      message: `Product: ${productName.slice(0, 120)}`,
      imageUrl: imageUrl ?? undefined,
      tools: [{ name: 'pickCategory', description: 'The best category for this product.', params: { category: { type: 'string', description: 'One of the shop categories', enum: cats.map(c => c.name) }, confidence: { type: 'string', description: 'How sure', enum: ['high', 'low'] } }, required: ['category', 'confidence'] }],
    });
    const cat = cats.find(c => c.name === choice?.args.category) ?? null;
    return { category: cat, confident: !!cat && choice?.args.confidence === 'high' };
  } catch (e) {
    log('warn', 'llm_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) });
    return { category: null, confident: false };
  }
}
