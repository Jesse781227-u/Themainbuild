import { Bot, clearFirestore, db, seed } from './helpers';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

async function customer(id: string, phone: string, name: string | null, orderCount: number, spent: number, lastDaysAgo: number | null, sinceDaysAgo = 90) {
  await db.set(db.doc('customers', id), { id, businessId: fx.a.id, channel: 'whatsapp', phone, ...(name ? { name } : {}), marketingOptIn: false, orderCount, totalSpentKobo: spent, lastOrderAt: lastDaysAgo == null ? null : iso(lastDaysAgo), createdAt: iso(sinceDaysAgo), updatedAt: iso(0) });
}
async function order(id: string, customerId: string, daysAgo: number, items: [string, number, number][], o: { address?: string; status?: string; fulfilment?: string } = {}) {
  const sub = items.reduce((s, [, p, q]) => s + p * q, 0);
  await db.set(db.doc('orders', id), {
    id, ref: `RLY-${id.toUpperCase()}`, businessId: fx.a.id, customerId, channel: 'whatsapp',
    items: items.map(([name, priceKobo, qty]) => ({ productId: name, name, priceKobo, qty })),
    subtotalKobo: sub, deliveryFeeKobo: 0, feeKobo: 0, uniqueKobo: 0, payAmountKobo: sub, status: o.status ?? 'paid', fulfilment: o.fulfilment ?? 'delivered',
    delivery: o.address ? { method: 'self_arranged', feeKobo: 0, address: o.address } : { method: 'pickup', feeKobo: 0 },
    holdExpiresAt: iso(daysAgo), paidAt: o.status && o.status !== 'paid' ? null : iso(daysAgo), createdAt: iso(daysAgo), updatedAt: iso(daysAgo),
  });
}

before(async () => {
  await clearFirestore();
  fx = await seed();
  const kemi = 'biz-a_wa_2348091119001';
  await customer(kemi, '+2348091119001', 'Kemi Ade', 3, 4_500_000, 2);
  await order('k1', kemi, 40, [['Denim jacket', 1_500_000, 1]], { address: '12 Herbert Macaulay Way, Yaba' });
  await order('k2', kemi, 10, [['Denim jacket', 1_500_000, 1], ['Leather belt', 500_000, 1]], { address: '5 Admiralty Way, Lekki Phase 1' });
  await order('k3', kemi, 2, [['Linen shirt', 1_000_000, 1]], { address: '5 Admiralty Way, Lekki Phase 1', fulfilment: 'out_for_delivery' });
  await order('k4', kemi, 0, [['Denim jacket', 1_500_000, 1]], { status: 'awaiting_payment' });
  await customer('biz-a_wa_2348091119002', '+2348091119002', 'Tunde Ola', 1, 900_000, 45);
  await customer('biz-a_wa_2348091119003', '+2348091119003', null, 1, 200_000, 1, 3);
  await customer('biz-a_wa_2348091119004', '+2348091119004', 'Just Browsing', 0, 0, null);
});

const admin = (bot: Bot, text: string, choice?: string) => bot.send('admin', { from: fx.a.ownerPhone.slice(1), text, ...(choice ? { choice } : {}) });

test('customers: the list shows totals, and top spenders first', async () => {
  const [r] = await admin(new Bot(), 'customers');
  assert.match(r.text, /👥 \*Your customers: 3\*\n💰 ₦56,000 spent in total\n🆕 1 new this week\n😴 1 haven't ordered in 30\+ days\n💬 2 more chatted but haven't bought yet/);
  assert.deepEqual(r.options.slice(0, 3), ['cust:biz-a_wa_2348091119001', 'cust:biz-a_wa_2348091119002', 'cust:biz-a_wa_2348091119003']);
  assert.ok(r.options.includes('custs:recent:0') && r.options.includes('custs:quiet:0'));
  assert.match(r.text, /Kemi Ade[\s\S]*₦45,000 · 3 orders · last 2 days ago/);
  assert.match(r.text, /\+234 809 111 9003/, 'no name: shown by number');

  const [quiet] = await admin(new Bot(), 'Gone quiet', 'custs:quiet:0');
  assert.deepEqual(quiet.options.filter(o => o.startsWith('cust:')), ['cust:biz-a_wa_2348091119002']);
  const [recent] = await admin(new Bot(), 'customers recent');
  assert.deepEqual(recent.options.filter(o => o.startsWith('cust:')), ['cust:biz-a_wa_2348091119003', 'cust:biz-a_wa_2348091119001', 'cust:biz-a_wa_2348091119002']);
});

test('customers: a card has number, addresses, spending, favourites and last purchases', async () => {
  const [r] = await admin(new Bot(), 'Kemi Ade', 'cust:biz-a_wa_2348091119001');
  assert.match(r.text, /^👤 \*Kemi Ade\*\n📞 \+234 809 111 9001\n📍 5 Admiralty Way, Lekki Phase 1 \(latest\)\n📍 12 Herbert Macaulay Way, Yaba\n/);
  assert.match(r.text, /💰 Spent \*₦45,000\* over 3 orders \(about ₦15,000 each\)/);
  assert.match(r.text, /last order 2 days ago/);
  assert.match(r.text, /❤️ Favourites: Denim jacket \(2\), Linen shirt \(1\), Leather belt \(1\)/, 'ties: most recent first');
  assert.match(r.text, /🛍️ Last purchases:\n• [^\n]*: 1 × Linen shirt, ₦10,000 \(out for delivery\)\n• [^\n]*: 1 × Denim jacket, 1 × Leather belt, ₦20,000 \(delivered\)/);
  assert.match(r.text, /⏳ Unpaid: RLY-K4 ₦15,000/);
  const action = (r.content as unknown as { interactive: { type: string; action: { parameters: { url: string } } } }).interactive;
  assert.equal(action.type, 'cta_url');
  assert.equal(action.action.parameters.url, 'https://wa.me/2348091119001');
});

test('customers: search by name or number; other shops\' customers stay private', async () => {
  assert.match((await admin(new Bot(), 'customer tunde'))[0].text, /👤 \*Tunde Ola\*/);
  assert.match((await admin(new Bot(), 'customer 08091119001'))[0].text, /👤 \*Kemi Ade\*/, 'local 0-prefixed numbers work');
  const many = await admin(new Bot(), 'customer 0809111');
  assert.match(many[0].text, /4 customers match/);
  assert.match((await admin(new Bot(), 'customer nobody'))[0].text, /No customer matches "nobody"/);
  assert.match((await admin(new Bot(), 'x', `cust:${fx.b.customer}`))[0].text, /couldn't find that customer/);
});
