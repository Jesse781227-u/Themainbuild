import { describeLocation, expandAliases, parseLocation } from '../src/services/location';
import { matchProduct, titleCase } from '../src/services/match';
import { fitTitle } from '../src/bots/common';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('location: sentences become area, city, street and landmark', () => {
  assert.deepEqual(parseLocation('yaba'), { city: 'Lagos', area: 'Yaba', street: null, landmark: null }, 'a known area gives its city');
  assert.deepEqual(parseLocation("it's in Lagos, Yaba, near Tejuosho market"), { city: 'Lagos', area: 'Yaba', street: null, landmark: 'Tejuosho Market' });
  assert.deepEqual(parseLocation('12 Herbert Macaulay Way, Yaba, Lagos'), { city: 'Lagos', area: 'Yaba', street: '12 Herbert Macaulay Way', landmark: null });
  assert.deepEqual(parseLocation('Lagos'), { city: 'Lagos', area: null, street: null, landmark: null });
  assert.deepEqual(parseLocation('we are at Wuse 2 abuja'), { city: 'Abuja', area: 'Wuse 2', street: null, landmark: null });
  assert.deepEqual(parseLocation('Shop 14, Computer Village, Ikeja'), { city: 'Lagos', area: 'Ikeja', street: 'Shop 14, Computer Village', landmark: null });
  assert.equal(parseLocation('Bodija').city, 'Ibadan');
  assert.equal(parseLocation('VI').area, 'Victoria Island');
  assert.equal(describeLocation(parseLocation('12 herbert macaulay way, yaba lagos, near tejuosho market')), '12 Herbert Macaulay Way, Yaba, Lagos — near Tejuosho Market');
  assert.equal(expandAliases('5 Adeola Odeku, VI'), '5 Adeola Odeku, Victoria Island');
});

test('matching: a clear match, a maybe, or nothing', () => {
  const ps = [{ name: 'Pink Tie-Front Crop Top' }, { name: 'Black Crop Top' }, { name: 'Plaid Flannel Shirt' }, { name: 'Product biz-a' }];
  assert.deepEqual(matchProduct('pink crop top', ps), { kind: 'strong', product: ps[0] });
  assert.deepEqual(matchProduct('crop top', ps), { kind: 'ambiguous', products: [ps[0], ps[1]].sort((a, b) => a.name.length - b.name.length) });
  assert.deepEqual(matchProduct('flannel shirts', ps), { kind: 'strong', product: ps[2] });
  assert.deepEqual(matchProduct('ankara gown', ps), { kind: 'none' });
  assert.equal(titleCase('pink crop top'), 'Pink Crop Top');
  assert.equal(titleCase('iPhone 15 case'), 'iPhone 15 case', 'their own capitals are kept');
});

test('buttons: titles are cleaned and cut at a word, never mid-sentence', () => {
  assert.equal(fitTitle('  Only   Yaba ', 20), 'Only Yaba');
  assert.equal(fitTitle("Only it's in Lagos, Yaba, near Tejuosho", 20), "Only it's in Lagos…");
  assert.ok(fitTitle('Supercalifragilisticexpialidocious', 20).length <= 20);
});
