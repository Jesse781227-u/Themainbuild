// Day 1 (MVP tracker M1, M2): the 7am morning brief, and the assistant saying it is AI when asked.
import { Bot, clearFirestore, db, doc, env, seed } from './helpers';
import { queueMorningBriefs } from '../src/services/morning-brief';
import { CRON_MORNING_BRIEF } from '../src/services/jobs';
import worker from '../src/worker';
import { lagosDate } from '../src/lib/time';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, getConfig(env), { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
});
const iso = () => new Date().toISOString();
const product = (id: string, name: string, stock: number) => db.set(db.doc('products', id), { id, businessId: fx.a.id, name, description: '', priceKobo: 100_000, images: [], categoryId: null, available: true, stock, lowStockThreshold: 2, createdAt: iso(), updatedAt: iso(), deletedAt: null });
const order = (id: string, ref: string, status: string, fulfilment: string, kobo: number) =>
  db.set(db.doc('orders', id), { id, ref, businessId: fx.a.id, customerId: fx.a.customer, channel: 'whatsapp', items: [{ productId: fx.a.product, name: 'x', priceKobo: kobo, qty: 1 }], subtotalKobo: kobo, deliveryFeeKobo: 0, feeKobo: 0, uniqueKobo: 0, payAmountKobo: kobo, status, fulfilment, delivery: null, holdExpiresAt: iso(), createdAt: iso(), updatedAt: iso() });

test('brief: the 7am morning brief lists what to deliver, who owes and what is low', async () => {
  await db.update(db.doc('orders', fx.a.order), { status: 'expired' });
  await order('br-1', 'RLY-BR001', 'paid', 'pending', 500_000);
  await order('br-2', 'RLY-BR002', 'paid', 'ready', 300_000);
  await order('br-3', 'RLY-BR003', 'paid', 'delivered', 100_000);
  await order('br-4', 'RLY-BR004', 'awaiting_payment', 'pending', 250_000);
  await product('br-zobo', 'Zobo', 1);
  await product('br-akara', 'Akara', 0);
  await db.update(db.doc('businesses', fx.a.id), { ownerName: 'Tee Ade' });
  // Through the real 7am cron (06:00 UTC).
  await worker.scheduled({ cron: CRON_MORNING_BRIEF, scheduledTime: Date.now() } as never, env as never);
  const brief = await doc('outbox', `${fx.a.id}_brief_${lagosDate()}`);
  assert.equal(brief.kind, 'morning_brief');
  assert.equal(brief.text, [
    '☀️ Good morning Tee! *Business biz-a* today:',
    '🚚 To deliver (2): RLY-BR001, RLY-BR002',
    '💸 Waiting for payment (1): ₦2,500 in all',
    '📦 Running low: Zobo (1)',
    '⛔ Sold out: Akara',
  ].join('\n'));
  assert.deepEqual(brief.buttons.map((b: { id: string }) => b.id), ['act:orders', 'act:soldout', 'act:menu']);
  assert.equal(brief.to, fx.a.ownerPhone);
});

test('brief: nothing to say, no message; once a day per shop', async () => {
  // Shop B: nothing to deliver, nothing owed, nothing low.
  await db.update(db.doc('products', fx.b.product), { stock: 50 });
  await db.update(db.doc('orders', fx.b.order), { status: 'expired' });
  const ids = await queueMorningBriefs(db);
  assert.ok(!ids.some(id => id.startsWith(fx.b.id)), 'no brief for a quiet shop');
  assert.equal(await doc('outbox', `${fx.b.id}_brief_${lagosDate()}`), null);
  assert.deepEqual(ids.filter(id => id.startsWith(fx.a.id)), [], "shop A already had today's");
});

test('disclosure: asked "are you a bot?" in English or Pidgin, the assistant says it is the shop\'s AI assistant', async () => {
  const bot = new Bot();
  const c = { from: '2348077100001', to: fx.a.pnid };
  await bot.send('shop', { ...c, text: 'hi' });
  const en = await bot.send('shop', { ...c, text: 'Are you a bot?' });
  assert.match(en[0].text, /^I'm \*Business biz-a\*'s AI assistant 🤖\. .* To talk to the owner, type \*talk to the owner\*\./);
  const pidgin = await bot.send('shop', { ...c, text: 'abeg na human dey reply me?' });
  assert.match(pidgin[0].text, /^Na \*Business biz-a\* AI assistant dey talk 🤖/);
  const human = await bot.send('shop', { ...c, text: 'is this a real person' });
  assert.match(human[0].text, /AI assistant/);
  assert.notEqual((await doc('conversations', `${fx.a.id}_wa_2348077100001`))?.mode, 'owner', 'asking is not a hand-over');
});
