import { clearFirestore, db, env, FakeTransport, seed } from './helpers';
import { getConfig } from '../src/config';
import { send, windowOpen, WindowClosedError } from '../src/services/channel';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
const cfg = getConfig(env);
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, cfg, { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-token' });
});

const hoursAgo = (h: number, from = new Date()) => new Date(from.getTime() - h * 3600_000).toISOString();
async function conversationLastSeen(at: string) {
  await db.set(db.doc('conversations', fx.a.customer), { id: fx.a.customer, businessId: fx.a.id, channel: 'whatsapp', customerId: fx.a.customer, lastInboundAt: at, mode: 'bot', updatedAt: at });
}
const sendText = (t: FakeTransport, now?: Date) => send(db, cfg, t, { from: { businessId: fx.a.id }, conversationId: fx.a.customer, to: fx.a.customerPhone, content: { type: 'text', text: 'Your order is ready' }, now });

test('window: free-form allowed within 24 hours', async () => {
  const now = new Date();
  assert.equal(windowOpen(hoursAgo(23.9, now), now), true);
  await conversationLastSeen(hoursAgo(23, now));
  const t = new FakeTransport();
  await sendText(t, now);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].phoneNumberId, fx.a.pnid, "sent from the merchant's own number");
  assert.equal(t.sent[0].to, fx.a.customerPhone);
});

test('window: free-form blocked after 24 hours', async () => {
  const now = new Date();
  assert.equal(windowOpen(hoursAgo(24, now), now), false);
  assert.equal(windowOpen(null, now), false);
  await conversationLastSeen(hoursAgo(25, now));
  const t = new FakeTransport();
  await assert.rejects(sendText(t, now), WindowClosedError);
  assert.equal(t.sent.length, 0);
  // A template is still allowed outside the window.
  await send(db, cfg, t, { from: { businessId: fx.a.id }, conversationId: fx.a.customer, to: fx.a.customerPhone, content: { type: 'template', name: 'order_update', language: 'en' }, now });
  assert.equal(t.sent.length, 1);
});

test('window: unconnected business cannot send', async () => {
  await db.set(db.doc('conversations', fx.b.customer), { id: fx.b.customer, businessId: fx.b.id, lastInboundAt: new Date().toISOString() });
  await assert.rejects(send(db, cfg, new FakeTransport(), { from: { businessId: fx.b.id }, conversationId: fx.b.customer, to: fx.b.customerPhone, content: { type: 'text', text: 'x' } }), /WHATSAPP_NOT_CONNECTED/);
});
