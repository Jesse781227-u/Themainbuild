// "what smoothies do you have?": the Smoothies section, not only products with "smoothie" in the name
// (a real test: Mayschills' menu has a Smoothies section and "Smoothie Only 3 Days" detox plans).
import { clearFirestore, db, seed } from './helpers';
import { createCategories, createProduct } from '../src/services/catalog';
import { rankProducts } from '../src/bots/shop';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let biz: string;
before(async () => {
  await clearFirestore();
  biz = (await seed()).a.id;
  const [smoothies, plans, juices] = await createCategories(db, biz, ['Smoothies', 'Intense Detox Plans', 'Cold-Pressed Juices']);
  for (const [name, cat, price] of [['Green Goddess', smoothies, 4500], ['Berry Blast', smoothies, 5000], ['Tropical Sunrise', smoothies, 4800], ['Smoothie Only 1 Day', plans, 18_500], ['Smoothie Only 3 Days', plans, 54_000], ['Fresh Fried Rice Juice', juices, 3000], ['Fried rice & turkey', juices, 4000]] as const) {
    await createProduct(db, { businessId: biz, name, priceKobo: price * 100, categoryId: cat.id, stock: 10 });
  }
});

test('search: a section asked for by name comes first, then products named that way', async () => {
  const r = await rankProducts(db, biz, 'smoothie');
  assert.deepEqual(r.list.map(p => p.name).slice(0, 3).sort(), ['Berry Blast', 'Green Goddess', 'Tropical Sunrise'], 'the Smoothies section first');
  assert.deepEqual(r.list.slice(3).map(p => p.name).sort(), ['Smoothie Only 1 Day', 'Smoothie Only 3 Days'], 'then the plans with the word in their name');
  assert.equal(r.clear, false);
  assert.equal((await rankProducts(db, biz, 'smoothies')).list.length, 5);
  assert.equal((await rankProducts(db, biz, 'juice')).list[0].name.length > 0, true);
  // A product named in full still wins ("how much is the fried rice?").
  const rice = await rankProducts(db, biz, 'fried rice');
  assert.equal(rice.list[0].name, 'Fried rice & turkey');
  assert.equal((await rankProducts(db, biz, 'green goddess')).clear, true);
});
