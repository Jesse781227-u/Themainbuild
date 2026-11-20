import { Bot, clearFirestore, db, doc, env, seed, testEnv } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { quoteBroadcast, shopLink } from '../src/services/broadcasts';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
const cfg = getConfig(env);
const at = new Date().toISOString();
const customer = (id: string, businessId: string, phone: string, optIn: boolean, channel = 'whatsapp') =>
  db.set(db.doc('customers', id), { id, businessId, channel, phone, name: id, marketingOptIn: optIn, orderCount: 0, totalSpentKobo: 0, createdAt: at, updatedAt: at });

before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, cfg, { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
  await customer(`${fx.a.id}_wa_2348070000001`, fx.a.id, '+2348070000001', true);
  await customer(`${fx.a.id}_wa_2348070000002`, fx.a.id, '+2348070000002', true);
  await customer(`${fx.a.id}_wa_2348070000003`, fx.a.id, '+2348070000003', false);
  await customer(`${fx.a.id}_ig_igsid7`, fx.a.id, '', true, 'instagram');
  await customer(`${fx.b.id}_wa_2348070000004`, fx.b.id, '+2348070000004', true);
});

const owner = () => fx.a.ownerPhone.slice(1);
const broadcastOutbox = async () => (await db.query('outbox', [['businessId', '==', fx.a.id], ['kind', '==', 'broadcast']])) as any[];

test('broadcast: owner sees audience size and cost before sending', async () => {
  const bot = new Bot();
  const [ask] = await bot.send('admin', { from: owner(), text: 'broadcast Fresh jollof this Saturday! Order early.' });
  assert.match(ask.text, /^Send this to 2 customers who opted in\?/);
  assert.match(ask.text, /"Fresh jollof this Saturday! Order early\."/);
  assert.match(ask.text, /Estimated Meta cost: up to ₦50 \(₦25 per message\)/);
  assert.deepEqual(ask.options, ['yes', 'no']);
  assert.equal((await broadcastOutbox()).length, 0, 'nothing is queued before YES');

  assert.match((await bot.send('admin', { from: owner(), text: 'no' }))[0].text, /cancelled/i);
  assert.equal((await broadcastOutbox()).length, 0);

  await bot.send('admin', { from: owner(), text: 'broadcast Fresh jollof this Saturday! Order early.' });
  const [sent] = await bot.send('admin', { from: owner(), choice: 'yes', text: 'Yes' });
  assert.match(sent.text, /Sending to 2 customers/);
  // Delivered from the merchant's number; nobody messaged recently, so the template is used.
  const queued = await broadcastOutbox();
  assert.ok(queued.every(m => m.status === 'sent' && m.viaTemplate === true));
  const toCustomers = bot.transport.sent.filter(m => m.phoneNumberId === fx.a.pnid);
  assert.equal(toCustomers.length, 2);
  assert.ok(toCustomers.every(m => m.content.type === 'template' && (m.content as { name: string }).name === cfg.BROADCAST_TEMPLATE));
  assert.equal((await db.query('broadcasts', [['businessId', '==', fx.a.id]])).length, 1);

  // Without a configured price, broadcasts are refused rather than quoting a guess.
  assert.equal(await quoteBroadcast(db, getConfig(testEnv({ MARKETING_MESSAGE_COST_KOBO: undefined })), fx.a.id), null);
});

test('broadcast: only opted-in customers are targeted', async () => {
  const recipients = new Set((await broadcastOutbox()).map(m => m.to));
  assert.deepEqual([...recipients].sort(), ['+2348070000001', '+2348070000002']);
  assert.ok(!recipients.has('+2348070000003'), 'not opted in');
  assert.ok(!recipients.has('+2348070000004'), 'another business');

  // STOP opts out; SUBSCRIBE opts in.
  const bot = new Bot();
  const [stop] = await bot.send('shop', { from: '2348070000001', to: fx.a.pnid, text: 'STOP' });
  assert.match(stop.text, /No more updates from/);
  assert.equal((await doc('customers', `${fx.a.id}_wa_2348070000001`)).marketingOptIn, false);
  await bot.send('shop', { from: '2348070000003', to: fx.a.pnid, text: 'subscribe' });
  assert.equal((await doc('customers', `${fx.a.id}_wa_2348070000003`)).marketingOptIn, true);
  const q = await quoteBroadcast(db, cfg, fx.a.id);
  assert.equal(q?.audience, 2, '0002 and 0003 now; 0001 opted out; Instagram excluded');
});

test('broadcast: nobody opted in gets a helpful answer and a share link', async () => {
  await db.update(db.doc('businesses', fx.b.id), { whatsappDisplayNumber: '+234 809 000 0002' });
  await db.update(db.doc('customers', `${fx.b.id}_wa_2348070000004`), { marketingOptIn: false });
  const bot = new Bot();
  const b = fx.b.ownerPhone.slice(1);
  assert.match((await bot.send('admin', { from: b, text: 'broadcast New stock just landed' }))[0].text, /No customers have opted in/);
  const [link] = await bot.send('admin', { from: b, text: 'link' });
  assert.match(link.text, /https:\/\/wa\.me\/2348090000002\?text=Hi!%20I%20would%20like%20to%20order/);
  assert.equal(shopLink(null, 'x'), null);
});
