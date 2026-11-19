import { closeDays, describeHours, openNow, parseHours } from '../src/services/hours';
import { inferBusinessType } from '../src/services/business-type';
import { defaultPolicies, policyText } from '../src/services/policies';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const read = (t: string) => { const p = parseHours(t); return p ? describeHours(p.hours) : null; };

test('hours: everyday ranges, 24-hour times, per-day strings and closed days', () => {
  assert.equal(read('8am-9pm'), 'Every day 8am–9pm');
  assert.equal(read('8am – 9pm'), 'Every day 8am–9pm');
  assert.equal(read('8 to 21'), 'Every day 8am–9pm');
  assert.equal(read('8-9'), 'Every day 8am–9pm', 'nobody opens for an hour');
  assert.equal(read('7:30am till 10pm'), 'Every day 7:30am–10pm');
  assert.equal(read('6pm - 2am'), 'Every day 6pm–2am');
  assert.equal(read('Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed'), 'Mon–Fri 8am–6pm · Sat 10am–4pm · Sun closed');
  assert.equal(read('Mon-Sat 8-6, Sunday closed'), 'Mon–Sat 8am–6pm · Sun closed');
  assert.equal(read('weekdays 9am-5pm, weekends closed'), 'Mon–Fri 9am–5pm · Sat–Sun closed');
  assert.equal(parseHours('8am-9pm')!.perDay, false);
  assert.equal(parseHours('Mon-Sat 8-6, Sun closed')!.perDay, true);
  assert.equal(read('whenever'), null);
  assert.equal(describeHours(closeDays(parseHours('8am-9pm')!.hours, 'Sat and Sunday')!), 'Mon–Fri 8am–9pm · Sat–Sun closed');
});

test('hours: open now, in Lagos time, and when it opens next', () => {
  const h = closeDays(parseHours('8am-9pm')!.hours, 'Sunday')!;
  // 2026-11-21 is a Saturday. Lagos is UTC+1.
  assert.deepEqual(openNow(h, new Date('2026-11-21T12:00:00Z')), { open: true });
  assert.deepEqual(openNow(h, new Date('2026-11-21T06:30:00Z')), { open: false, next: '8am' });
  assert.deepEqual(openNow(h, new Date('2026-11-21T20:30:00Z')), { open: false, next: '8am Monday' }, 'Sunday is closed');
  assert.deepEqual(openNow(h, new Date('2026-11-22T21:30:00Z')), { open: false, next: '8am tomorrow' });
  const late = parseHours('6pm-2am')!.hours;
  assert.equal(openNow(late, new Date('2026-11-21T00:30:00Z')).open, true, 'still open after midnight');
  assert.deepEqual(openNow(null), { open: true }, 'no hours set: always open');
});

test('business type: guessed from the menu when it is clear', () => {
  assert.deepEqual(inferBusinessType([{ name: 'Jollof rice' }, { name: 'Fried rice & chicken' }, { name: 'Zobo' }, { name: 'Small chops' }]), { type: 'food_beverage', confident: true });
  assert.deepEqual(inferBusinessType([{ name: 'Black AF1' }, { name: 'Leather bag' }, { name: 'Silver watch' }]), { type: 'fashion_retail', confident: true });
  assert.equal(inferBusinessType([{ name: 'Mystery box' }, { name: 'Gift set' }]).confident, false);
  assert.equal(inferBusinessType([{ name: 'Body butter' }, { name: 'Jollof rice' }]).confident, false, 'half and half: ask');
  assert.match(policyText(defaultPolicies('food_beverage'))!, /No returns on food/);
  assert.equal(policyText({ returns: 'x', issues: 'y', custom: 'Our own words' }), 'Our own words');
});
