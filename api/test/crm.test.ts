import { adminDb, api, clearFirestore, doc, seed, startApi, stopApi } from './helpers';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); await startApi(); });
after(stopApi);

const event = (body: object) => api('POST', `/api/v1/storefronts/${fx.a.slug}/events`, { body: { channel: 'web', type: 'page_view', ...body } });

test('crm: public event cannot create or reassign customer', async () => {
  const foreign = await event({ customerId: fx.b.customer, sessionId: 'session-test' });
  assert.equal(foreign.status, 202);
  assert.equal(foreign.body.data.customerId, undefined);
  const customer = (await doc('customers', fx.b.customer))!;
  assert.equal(customer.businessId, fx.b.id);
  assert.equal(customer.lastActivityAt, undefined);

  assert.equal((await event({ customerId: 'made-up', sessionId: 'session-test' })).status, 202);
  assert.equal(await doc('customers', 'made-up'), null);
  assert.equal((await event({ customerId: 'made-up' })).status, 400);

  assert.equal((await event({ customerId: fx.a.customer })).status, 202);
  assert.ok((await doc('customers', fx.a.customer))!.lastActivityAt);
  assert.equal((await adminDb.collection('crmEvents').where('businessId', '==', fx.a.id).get()).size, 3);
});
