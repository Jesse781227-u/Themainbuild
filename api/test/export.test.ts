// Day 2 (MVP tracker M3): EXPORT gives the owner an Excel file and live Google Sheets links.
import { Bot, clearFirestore, db, seed } from './helpers';
import { createApp } from '../src/app';
import { env } from './helpers';
import { xlsxRows } from '../src/lib/xlsx';
import { csv } from '../src/lib/xlsx-write';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
let owner: string;
const iso = (s: string) => new Date(s).toISOString();
before(async () => {
  await clearFirestore();
  fx = await seed();
  owner = fx.a.ownerPhone.slice(1);
  await db.update(db.doc('orders', fx.a.order), { status: 'expired' });
  await db.set(db.doc('customers', fx.a.customer), { id: fx.a.customer, businessId: fx.a.id, phone: '2348090000001', name: 'Tolu, "Mama" B', marketingOptIn: true, orderCount: 1, totalSpentKobo: 650_000, lastOrderAt: iso('2026-11-19T17:05:00Z'), createdAt: iso('2026-10-01T09:00:00Z'), updatedAt: iso('2026-11-19T17:05:00Z') });
  await db.set(db.doc('orders', 'ex-1'), { id: 'ex-1', ref: 'RLY-EX001', businessId: fx.a.id, customerId: fx.a.customer, channel: 'whatsapp', items: [{ productId: 'p1', name: 'Egusi + Assorted', priceKobo: 650_000, qty: 1 }, { productId: 'p2', name: 'Zobo', priceKobo: 50_000, qty: 2 }], subtotalKobo: 750_000, deliveryFeeKobo: 150_000, feeKobo: 7_500, feePaidBy: 'owner', uniqueKobo: 0, payAmountKobo: 900_000, status: 'paid', fulfilment: 'out_for_delivery', delivery: { method: 'self_arranged', feeKobo: 150_000, address: 'Surulere, Lagos' }, holdExpiresAt: iso('2026-11-19T17:35:00Z'), createdAt: iso('2026-11-19T17:05:00Z'), updatedAt: iso('2026-11-19T17:06:00Z') });
});
const get = async (url: string) => {
  const path = new URL(url).pathname;
  const res = await createApp().request(path, {}, env);
  return { status: res.status, type: res.headers.get('content-type') ?? '', bytes: await res.arrayBuffer() };
};
const linksIn = (text: string) => [...text.matchAll(/=IMPORTDATA\("([^"]+)"\)/g)].map(m => m[1]);

test('export: orders and customers as CSV, and a private link Google Sheets can import', async () => {
  const bot = new Bot();
  const out = await bot.send('admin', { from: owner, text: 'export' });
  assert.equal(out.length, 2);
  const doc = out[0].content as { type: string; link: string; filename: string; caption: string };
  assert.equal(doc.type, 'document');
  assert.match(doc.filename, /^Business-biz-a-orders-\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.match(out[1].text, /Live in Google Sheets/);
  assert.deepEqual(out[1].options, ['act:exportnew', 'act:menu']);
  const [ordersUrl, customersUrl] = linksIn(out[1].text);
  assert.match(ordersUrl, /\/export\/[A-Za-z0-9]{24,48}\/orders\.csv$/);

  // The Excel file opens, first sheet = Orders.
  const xl = await get(doc.link);
  assert.equal(xl.status, 200);
  assert.match(xl.type, /spreadsheetml/);
  const rows = await xlsxRows(xl.bytes);
  assert.deepEqual(rows[0].slice(0, 6), ['Order', 'Date', 'Time', 'Customer', 'Phone', 'Items']);
  const ex = rows.find(r => r[0] === 'RLY-EX001')!;
  assert.deepEqual(ex, ['RLY-EX001', '2026-11-19', '18:05', 'Tolu, "Mama" B', '+234 809 000 0001', '1 × Egusi + Assorted; 2 × Zobo', '7500', '1500', '9000', '8925', 'Paid', 'Out for delivery', 'Surulere, Lagos']);
  const expired = rows.find(r => r[0] !== 'Order' && r[0] !== 'RLY-EX001')!;
  assert.equal(expired[10], 'Expired');
  assert.equal(expired[8], '', 'nothing paid on an expired order');

  // Google Sheets CSVs: same rows, quoted where needed.
  const oc = await get(ordersUrl);
  assert.equal(oc.status, 200);
  assert.match(oc.type, /^text\/csv/);
  const text = new TextDecoder().decode(oc.bytes);
  assert.ok(text.startsWith('Order,Date,Time,Customer,Phone,Items,'));
  assert.ok(text.includes('RLY-EX001,2026-11-19,18:05,"Tolu, ""Mama"" B",+234 809 000 0001,1 × Egusi + Assorted; 2 × Zobo,7500,1500,9000,8925,Paid,Out for delivery,"Surulere, Lagos"\r\n'));
  const cc = new TextDecoder().decode((await get(customersUrl)).bytes);
  assert.equal(cc.split('\r\n')[0], 'Name,Phone,Paid orders,Total spent (₦),Last order,Gets updates,Customer since');
  assert.ok(cc.includes('"Tolu, ""Mama"" B",+234 809 000 0001,1,6500,2026-11-19,Yes,2026-10-01'));
  assert.equal(csv([['a', 'b\nc']]), 'a,"b\nc"\r\n');

  // The same link again: the token stays the same until the owner asks for a new one.
  const again = await bot.send('admin', { from: owner, text: 'google sheets' });
  assert.deepEqual(linksIn(again[1].text), [ordersUrl, customersUrl]);
});

test('export: the link only works with its token, and a new link retires the old one', async () => {
  const bot = new Bot();
  const first = linksIn((await bot.send('admin', { from: owner, text: 'export' }))[1].text)[0];
  assert.equal((await get(first.replace(/\/export\/[A-Za-z0-9]+\//, '/export/notTheRealTokenAtAll1234567/'))).status, 404, 'a guessed token');
  assert.equal((await get(first.replace('orders.csv', 'secrets.json'))).status, 404, 'only the export files');
  const out = await bot.send('admin', { from: owner, choice: 'act:exportnew', text: 'New private link' });
  assert.match((out[0].content as { caption: string }).caption, /old ones no longer work/);
  const fresh = linksIn(out[1].text)[0];
  assert.notEqual(fresh, first);
  assert.equal((await get(first)).status, 404, 'the old link is retired');
  assert.equal((await get(fresh)).status, 200);
  // Another shop's owner gets their own token, never shop A's rows.
  const b = await bot.send('admin', { from: fx.b.ownerPhone.slice(1), text: 'export' });
  const bRows = new TextDecoder().decode((await get(linksIn(b[1].text)[0])).bytes);
  assert.ok(!bRows.includes('RLY-EX001'));
});
