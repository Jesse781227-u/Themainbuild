// Tests run under Node against the Firestore emulator (project demo-relay), calling the Hono app and
// the Worker's queue/scheduled handlers directly with fake bindings. No real credentials are used.
import crypto from 'node:crypto';
import { createApp } from '../src/app';
import { getDb } from '../src/db';
import type { Env, QueueJob, QueueMessage } from '../src/env';
import type { BachsAdapter } from '../src/services/bachs';
import { optionIds, toText, type OutboundContent, type Transport } from '../src/services/channel';
import type { LLMProvider, ToolChoice } from '../src/services/ai';
import { handleQueueBatch } from '../src/services/queue';
import { buildPayload } from '../scripts/simulate-webhook';

export const projectId = 'demo-relay';
export const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
export const META_SECRET = 'test-app-secret';
export const VERIFY_TOKEN = 'v'.repeat(16);
export const ADMIN_PNID = 'pn-admin';

export class FakeQueue { sent: QueueJob[] = []; async send(job: QueueJob) { this.sent.push(job); } }

export function testEnv(overrides: Record<string, unknown> = {}): Env & { EVENTS: FakeQueue } {
  return {
    RELAY_ENV: 'development', FIREBASE_PROJECT_ID: projectId, FIRESTORE_EMULATOR_HOST: emulatorHost,
    META_APP_SECRET: META_SECRET, META_VERIFY_TOKEN: VERIFY_TOKEN, ADMIN_BOT_PHONE_NUMBER_ID: ADMIN_PNID, ADMIN_BOT_ACCESS_TOKEN: 'admin-token', MARKETING_MESSAGE_COST_KOBO: '2500',
    EVENTS: new FakeQueue(), ...overrides,
  } as Env & { EVENTS: FakeQueue };
}

export const env = testEnv();
export const db = getDb(env);

export async function clearFirestore() {
  const res = await fetch(`http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Could not clear the Firestore emulator: ${res.status}`);
}

export async function api(method: string, path: string, opts: { body?: unknown; raw?: string; headers?: Record<string, string>; env?: Env; bachs?: BachsAdapter; fetch?: typeof fetch } = {}) {
  const app = createApp({ bachs: opts.bachs, fetch: opts.fetch });
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', ...opts.headers }, body }, opts.env ?? env);
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

export const signMeta = (raw: string, secret = META_SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

export async function postMeta(payload: unknown, e: Env = env) {
  const raw = JSON.stringify(payload);
  return api('POST', '/api/v1/webhooks/meta', { raw, headers: { 'x-hub-signature-256': signMeta(raw) }, env: e });
}

export function waMessage(opts: { phoneNumberId: string; from: string; id: string; text?: string; timestamp?: number; name?: string }) {
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '000', phone_number_id: opts.phoneNumberId },
      contacts: [{ wa_id: opts.from, profile: { name: opts.name ?? 'Ada' } }],
      messages: [{ from: opts.from, id: opts.id, timestamp: ts, type: 'text', text: { body: opts.text ?? 'hi' } }],
    } }] }],
  };
}

export function queueMessage(body: QueueJob, attempts = 1) {
  const m = { id: crypto.randomUUID(), body, attempts, acked: false, retried: false, retryDelay: undefined as number | undefined,
    ack() { m.acked = true; }, retry(o?: { delaySeconds?: number }) { m.retried = true; m.retryDelay = o?.delaySeconds; } };
  return m satisfies QueueMessage<QueueJob>;
}

export class FakeTransport implements Transport {
  sent: { phoneNumberId: string; to: string; content: OutboundContent; channel: 'whatsapp' | 'instagram' }[] = [];
  async sendWhatsApp(sender: { phoneNumberId: string }, to: string, content: OutboundContent) { this.sent.push({ phoneNumberId: sender.phoneNumberId, to, content, channel: 'whatsapp' }); return { messageId: `wamid.${this.sent.length}` }; }
  async sendInstagram(sender: { igAccountId: string }, to: string, text: string) { this.sent.push({ phoneNumberId: sender.igAccountId, to, content: { type: 'text', text }, channel: 'instagram' }); return { messageId: `ig.${this.sent.length}` }; }
}

// Drives the real bots end to end: a signed Meta webhook (built by the simulator script) goes
// through the route, the queue and the handlers; replies are captured instead of sent.
export class Bot {
  transport = new FakeTransport();
  constructor(public llm: LLMProvider | null = null) {}
  async send(kind: 'admin' | 'shop' | 'echo' | 'instagram', o: { from: string; to?: string; text?: string; choice?: string; name?: string }) {
    const before = this.transport.sent.length;
    const res = await postMeta(buildPayload(kind, { from: o.from, to: o.to ?? ADMIN_PNID, text: o.text ?? '', choice: o.choice, name: o.name }));
    if (res.status !== 200) throw new Error(`webhook returned ${res.status}`);
    await this.drain();
    return this.transport.sent.slice(before).map(m => ({ ...m, text: toText(m.content), options: optionIds(m.content) }));
  }
  async drain() {
    for (let i = 0; i < 10 && env.EVENTS.sent.length; i++) {
      const msgs = env.EVENTS.sent.splice(0).map(job => queueMessage(job));
      await handleQueueBatch({ queue: 'test', messages: msgs }, env, { transport: this.transport, llm: this.llm, transcriber: null });
    }
  }
}

export const fakeLLM = (pick: (message: string) => ToolChoice | null): LLMProvider & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, async chooseTool({ message }) { calls.push(message); return pick(message); } };
};

const now = () => new Date().toISOString();

// Two businesses, each with an owner, a connected WhatsApp number, a product (₦1,000, 5 in stock),
// a customer and an order.
export async function seed() {
  const fixture = {
    a: { id: 'biz-a', ownerPhone: '+2348030000001', pnid: 'pn-a', bachs: 'bachs-a', product: 'prod-a', customer: 'biz-a_wa_2348090000001', customerPhone: '+2348090000001', order: 'order-a' },
    b: { id: 'biz-b', ownerPhone: '+2348030000002', pnid: 'pn-b', bachs: 'bachs-b', product: 'prod-b', customer: 'biz-b_wa_2348090000002', customerPhone: '+2348090000002', order: 'order-b' },
  };
  const batch = db.batch();
  for (const f of [fixture.a, fixture.b]) {
    batch.set(db.doc('businesses', f.id), { id: f.id, name: `Business ${f.id}`, category: 'other', ownerPhone: f.ownerPhone, status: 'active', timezone: 'Africa/Lagos', bachsAccountId: f.bachs, createdAt: now(), updatedAt: now() });
    batch.set(db.doc('ownerPhones', f.ownerPhone), { businessId: f.id });
    batch.set(db.doc('channelAccounts', `whatsapp_${f.pnid}`), { id: `whatsapp_${f.pnid}`, businessId: f.id, channel: 'whatsapp', accountId: f.pnid });
    batch.set(db.doc('products', f.product), { id: f.product, businessId: f.id, name: `Product ${f.id}`, description: '', priceKobo: 100_000, images: [], categoryId: null, available: true, stock: 5, lowStockThreshold: 2, createdAt: now(), updatedAt: now(), deletedAt: null });
    batch.set(db.doc('customers', f.customer), { id: f.customer, businessId: f.id, channel: 'whatsapp', phone: f.customerPhone, name: 'Ada', marketingOptIn: false, orderCount: 0, totalSpentKobo: 0, createdAt: now(), updatedAt: now() });
    batch.set(db.doc('orders', f.order), { id: f.order, ref: 'RLY-TEST', businessId: f.id, customerId: f.customer, channel: 'whatsapp', items: [{ productId: f.product, name: 'x', priceKobo: 100_000, qty: 1 }], subtotalKobo: 100_000, deliveryFeeKobo: 0, feeKobo: 1_000, uniqueKobo: 0, payAmountKobo: 101_000, status: 'expired', fulfilment: 'pending', delivery: null, holdExpiresAt: now(), createdAt: now(), updatedAt: now() });
  }
  await batch.commit();
  return fixture;
}

export async function doc(collection: string, id: string) { return (await db.get(db.doc(collection, id))) as any; }

export async function seedCart(id: string, businessId: string, customerId: string, items: { productId: string; qty: number }[], expiresAt = new Date(Date.now() + 3600_000).toISOString()) {
  await db.set(db.doc('carts', id), { id, businessId, customerId, channel: 'whatsapp', items, expiresAt, updatedAt: now() });
}
