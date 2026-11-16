import { normalisePhone, maskPhone, toWaId } from '../src/lib/phone';
import { DEFAULT_FEE, feeKobo, formatKobo, nairaToKobo } from '../src/lib/money';
import { lagosDate, lagosDayBounds, lagosWeekBounds } from '../src/lib/time';
import { encodeValue, decodeValue } from '../src/lib/firestore';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('phone: normalises Nigerian numbers to E.164', () => {
  for (const input of ['08031234567', '0803 123 4567', '+2348031234567', '2348031234567', '+234 (0)803-123-4567', '8031234567', '002348031234567'])
    assert.equal(normalisePhone(input), '+2348031234567', input);
  assert.equal(normalisePhone('07061234567'), '+2347061234567');
  assert.equal(normalisePhone('09151234567'), '+2349151234567');
  assert.equal(normalisePhone('+447911123456'), '+447911123456');
  for (const bad of ['', 'abc', '0803123', '08031234567890', '+234123', '06031234567']) assert.equal(normalisePhone(bad), null, bad);
  assert.equal(toWaId('+2348031234567'), '2348031234567');
  assert.equal(maskPhone('+2348031234567'), '+234***4567');
  assert.ok(!maskPhone('+2348031234567').includes('803123'));
});

test('money: naira to kobo is exact', () => {
  assert.equal(nairaToKobo('1500'), 150_000);
  assert.equal(nairaToKobo('1,500.5'), 150_050);
  assert.equal(nairaToKobo('₦1,500.50'), 150_050);
  assert.equal(nairaToKobo('N 2000'), 200_000);
  assert.equal(nairaToKobo('0.29'), 29);       // 0.29 * 100 is 28.999… in floating point
  assert.equal(nairaToKobo(19.99), 1_999);
  assert.equal(nairaToKobo('1.234'), null);
  assert.equal(nairaToKobo('-5'), null);
  assert.equal(nairaToKobo('five'), null);
  assert.equal(formatKobo(150_050), '₦1,500.50');
  assert.equal(formatKobo(200_000), '₦2,000');
});

test('money: fee is 1% of goods capped at 2000 naira', () => {
  assert.deepEqual(DEFAULT_FEE, { bps: 100, capKobo: 200_000 });
  assert.equal(feeKobo(1_000_000), 10_000);         // ₦10,000 → ₦100
  assert.equal(feeKobo(150), 2);                    // 1.5 kobo rounds half up
  assert.equal(feeKobo(149), 1);
  assert.equal(feeKobo(20_000_000), 200_000);       // ₦200,000 → ₦2,000 (cap reached exactly)
  assert.equal(feeKobo(50_000_000), 200_000);       // ₦500,000 → still ₦2,000
  assert.equal(feeKobo(0), 0);
  assert.equal(feeKobo(1_000_000, { bps: 150, capKobo: 200_000 }), 15_000); // per-business override
});

test('time: today boundaries use Africa/Lagos', () => {
  // 23:30 UTC on 1 Dec is already 00:30 on 2 Dec in Lagos.
  const late = new Date('2026-12-01T23:30:00Z');
  assert.equal(lagosDate(late), '2026-12-02');
  const { start, end } = lagosDayBounds(late);
  assert.equal(start.toISOString(), '2026-12-01T23:00:00.000Z');
  assert.equal(end.toISOString(), '2026-12-02T23:00:00.000Z');
  assert.equal(lagosDate(new Date('2026-12-01T22:59:59Z')), '2026-12-01');
  // Wed 2 Dec 2026 → week starts Mon 30 Nov 00:00 Lagos.
  assert.equal(lagosWeekBounds(late).start.toISOString(), '2026-11-29T23:00:00.000Z');
});

test('firestore: values round-trip with exact integers', () => {
  const v = { kobo: 9_007_199_254_740_991, price: 1.5, name: 'x', ok: true, none: null, list: [1, 'a'], nested: { a: 1 } };
  assert.deepEqual(decodeValue(encodeValue(v)), v);
  assert.deepEqual(encodeValue(150_050), { integerValue: '150050' });
});
