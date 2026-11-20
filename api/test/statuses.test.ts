import { clearFirestore, db, doc, env, postMeta, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { templateState } from '../src/services/templates';
import { getWallet } from '../src/services/wallet';
import { consented } from '../src/services/reach';
import { activeShops } from '../src/services/active-shops';
import { campaignResults, resultText } from '../src/services/reach-results';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

const cfg = getConfig(env);
let fx: Awaited<ReturnType<typeof seed>>;
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, cfg, { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
});

const now = () => Math.floor(Date.now() / 1000);
const statusHook = (statuses: Record<string, unknown>[]) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba-a', changes: [{ field: 'messages', value: { metadata: { phone_number_id: fx.a.pnid }, statuses } }] }] });

async function sentSend(id: string, extra: Record<string, unknown> = {}) {
  const customerId = `${fx.a.id}_wa_23480550${id.slice(-5).padStart(5, '0')}`;
  await db.set(db.doc('customers', customerId), { id: customerId, businessId: fx.a.id, channel: 'whatsapp', phone: '+2348055000000', name: 'Ada', marketingOptIn: true, marketingOptInAt: new Date(Date.now() - 86_400_000).toISOString() });
  await db.set(db.doc('sends', id), { id, businessId: fx.a.id, campaignId: 'camp-s', customerId, route: 'open', cost: 0, status: 'sent', text: 'Hi', sentAt: new Date().toISOString(), createdAt: new Date().toISOString(), ...extra });
  await db.set(db.doc('outbox', `reach_${id}`), { id: `reach_${id}`, businessId: fx.a.id, audience: 'customer', channel: 'whatsapp', to: '+2348055000000', kind: 'reach', text: 'Hi', status: 'sent', providerMessageId: `wamid.${id}`, attempts: 1, createdAt: new Date().toISOString() });
  return customerId;
}

test('statuses: delivered and read move a send forward, never back', async () => {
  await sentSend('s1');
  assert.equal((await postMeta(statusHook([{ id: 'wamid.s1', status: 'read', timestamp: now(), recipient_id: '2348055000000' }]))).status, 200);
  await postMeta(statusHook([{ id: 'wamid.s1', status: 'delivered', timestamp: now() }])); // late, out of order
  assert.equal((await doc('outbox', 'reach_s1')).deliveryStatus, 'read');
  assert.equal((await doc('sends', 's1')).status, 'read');
  const r = await campaignResults(db, 'camp-s');
  assert.equal(r.read, 1);
  assert.match(resultText('Test', r), /^📊 \*Test\*: sent 1 \(1 read\) → /);
  // Someone else's message id is ignored quietly.
  assert.equal((await postMeta(statusHook([{ id: 'wamid.unknown', status: 'read', timestamp: now() }]))).status, 200);
});

test('statuses: a failed paid send gives its cost back to the wallet, once', async () => {
  await db.set(db.doc('ledger', 'st-sale'), { id: 'st-sale', businessId: fx.a.id, type: 'sale', merchantNetKobo: 100_000, at: new Date().toISOString() });
  await db.delete(db.doc('wallets', fx.a.id));
  const start = (await getWallet(db, fx.a.id)).availableKobo;
  await sentSend('s2', { route: 'paid_template', cost: 8_256, campaignId: 'camp-paid' });
  const failed = statusHook([{ id: 'wamid.s2', status: 'failed', timestamp: now(), errors: [{ code: 131026, title: 'Message undeliverable' }] }]);
  await postMeta(failed);
  await postMeta(failed); // Meta retries
  assert.equal((await getWallet(db, fx.a.id)).availableKobo, start + 8_256);
  assert.equal((await doc('ledger', 'msgrefund_s2')).type, 'message_refund');
  assert.equal((await doc('sends', 's2')).status, 'failed');
  assert.equal((await campaignResults(db, 'camp-paid')).sent, 0, 'a failed send is not counted as reached');
  // The wallet worked out again from the ledger agrees.
  await db.delete(db.doc('wallets', fx.a.id));
  assert.equal((await getWallet(db, fx.a.id)).availableKobo, start + 8_256);
});

test('statuses: a customer who turned off marketing in WhatsApp is opted out', async () => {
  const customerId = await sentSend('s3');
  await postMeta(statusHook([{ id: 'wamid.s3', status: 'failed', timestamp: now(), errors: [{ code: 131050, title: 'User stopped marketing messages' }] }]));
  const c = await doc('customers', customerId);
  assert.ok(c.marketingOptOutAt);
  assert.equal(consented({ ...c, id: customerId }, cfg), false);
});

test("templates: Meta's review result updates the shop's template status", async () => {
  const hook = (event: string, reason = 'NONE') => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba-a', changes: [{ field: 'message_template_status_update', value: { event, message_template_name: 'relay_update', message_template_id: 1, message_template_language: 'en', reason } }] }] });
  await postMeta(hook('APPROVED'));
  assert.equal(await templateState(db, fx.a.id, 'relay_update'), 'approved');
  await postMeta(hook('REJECTED', 'INCORRECT_CATEGORY'));
  assert.equal(await templateState(db, fx.a.id, 'relay_update'), 'rejected');
  assert.equal((await doc('templateStatus', `${fx.a.id}_relay_update`)).reason, 'INCORRECT_CATEGORY');
  assert.equal(await templateState(db, fx.b.id, 'relay_update'), 'not_submitted', "another shop's account isn't touched");
});

test('jobs: every live shop is reached, page by page', async () => {
  for (let i = 0; i < 5; i++) await db.set(db.doc('businesses', `page-shop-${i}`), { id: `page-shop-${i}`, name: `Shop ${i}`, status: 'active' });
  await db.set(db.doc('businesses', 'page-shop-off'), { id: 'page-shop-off', name: 'Off', status: 'onboarding' });
  const seen: string[] = [];
  for await (const b of activeShops(db, 2)) seen.push(b.id);
  assert.equal(new Set(seen).size, seen.length, 'no shop twice');
  for (let i = 0; i < 5; i++) assert.ok(seen.includes(`page-shop-${i}`));
  assert.ok(!seen.includes('page-shop-off'));
});

test('templates: a shop going live submits its marketing templates for review, once', async () => {
  const { submitTemplates, templateState: state } = await import('../src/services/templates');
  const calls: { url: string; body?: string; auth?: string }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined, auth: h.authorization });
    if (url.startsWith('https://img.test/')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    if (url.includes('/uploads?')) return Response.json({ id: 'upload:abc' });
    if (url.endsWith('/upload:abc')) return Response.json({ h: 'HANDLE123' });
    if (url.includes('/message_templates')) return Response.json({ id: 'tpl-1', status: 'PENDING' });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const shop = { businessId: 'tpl-shop', wabaId: 'waba-t', token: 'secret-token', sampleImageUrl: 'https://img.test/a.jpg' };
  const first = await submitTemplates(db, { META_GRAPH_VERSION: 'v21.0', META_APP_ID: 'app-1' }, shop, fakeFetch);
  assert.ok(first.length >= 6 && first.every(r => r.ok));
  const sent = calls.filter(c => c.url.includes('/waba-t/message_templates')).map(c => JSON.parse(c.body!));
  assert.ok(sent.every(p => p.category === 'MARKETING'));
  assert.equal(sent.find(p => p.name === 'relay_back_in_stock').components[0].example.header_handle[0], 'HANDLE123', 'the uploaded sample picture');
  assert.equal(await state(db, 'tpl-shop', 'relay_update'), 'pending');
  assert.deepEqual(await submitTemplates(db, { META_GRAPH_VERSION: 'v21.0', META_APP_ID: 'app-1' }, shop, fakeFetch), [], 'already submitted: nothing sent again');
  // Without a sample picture (no app id), the image templates wait; the text ones still go.
  const plain = await submitTemplates(db, { META_GRAPH_VERSION: 'v21.0' }, { ...shop, businessId: 'tpl-shop-2' }, fakeFetch);
  assert.ok(plain.some(r => r.name === 'relay_update') && !plain.some(r => r.name === 'relay_back_in_stock'));
});
