import { clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { flowId, flowMessage, readFlowReply } from '../src/services/flows';
import { handleFlowAnswer } from '../src/bots/flow-answers';
import { listProducts } from '../src/services/catalog';
import type { Business } from '../src/domain/business';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });
const biz = async () => (await doc('businesses', fx.a.id)) as unknown as Business;
const reply = (answers: Record<string, unknown>) => ({ response_json: JSON.stringify(answers) });

test('flows: off by default and in the test chat; on when switched on with a published id', () => {
  const base = getConfig(env);
  assert.equal(flowId(base, 'add'), null, 'off by default');
  assert.equal(flowId({ ...base, FLOWS_ENABLED: 'true', FLOW_ID_ADD_PRODUCT: '777', META_SEND_MODE: 'log' }, 'add'), null, 'the test chat uses the chat version');
  assert.equal(flowId({ ...base, FLOWS_ENABLED: 'true', FLOW_ID_ADD_PRODUCT: '777', META_SEND_MODE: 'live' }, 'add'), '777');
  assert.equal(flowId({ ...base, FLOWS_ENABLED: 'true', META_SEND_MODE: 'live' }, 'hours'), null, 'no id: chat version');
  const m = flowMessage('add', '777', fx.a.id, 'Add one', { categories: [{ id: 'c1', title: 'Food' }] }) as any;
  assert.equal(m.interactive.type, 'flow');
  assert.match(m.interactive.action.parameters.flow_token, new RegExp(`^add:${fx.a.id}:`));
  assert.deepEqual(m.interactive.action.parameters.flow_action_payload, { screen: 'PRODUCT', data: { categories: [{ id: 'c1', title: 'Food' }] } });
});

test('flows: answers are checked like the chat and only change the shop they were sent for', async () => {
  assert.equal(readFlowReply(reply({ flow_token: 'nope', name: 'x' })), null);
  assert.equal(readFlowReply({ response_json: 'not json' }), null);
  const r = readFlowReply(reply({ flow_token: `add:${fx.a.id}:abc`, name: 'pink crop top', price: '4500', category: `cat-${fx.a.id}` }))!;
  assert.deepEqual([r.kind, r.businessId], ['add', fx.a.id]);
  const out = await handleFlowAnswer(db, await biz(), r.kind, r.answers) as any;
  assert.match(out.interactive.body.text, /Added new product \*Pink Crop Top\* ₦4,500 in General/);
  assert.ok((await listProducts(db, fx.a.id)).some(p => p.name === 'Pink Crop Top'));
  assert.match(await handleFlowAnswer(db, await biz(), 'add', { name: 'X', price: 'abc', category: `cat-${fx.a.id}` }) as string, /needs a name and a price/);
  assert.match(await handleFlowAnswer(db, await biz(), 'add', { name: 'Thing', price: '100', category: 'someone-elses' }) as string, /category no longer exists/);

  const hours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].flatMap(d => [[`${d}_open`, d === 'sun' ? 'closed' : '08:00'], [`${d}_close`, d === 'sun' ? 'closed' : '21:00']]));
  const h = await handleFlowAnswer(db, await biz(), 'hours', hours) as any;
  assert.match(h.interactive.body.text, /Saved ✅ Mon–Sat 8am–9pm · Sun closed/);
  assert.deepEqual((await doc('businesses', fx.a.id)).hours.mon, { open: '08:00', close: '21:00' });
  assert.match(await handleFlowAnswer(db, await biz(), 'hours', { ...hours, mon_open: '22:00' }) as string, /closing time after its opening time/);

  const d = await handleFlowAnswer(db, await biz(), 'delivery', { zone1_name: 'Yaba', zone1_fee: '1500', zone2_name: 'Ikeja', zone2_fee: '0' }) as any;
  assert.match(d.interactive.body.text, /• Yaba: ₦1,500\n• Ikeja: free/);
  assert.equal((await db.query('deliveryZones', [['businessId', '==', fx.a.id]])).length, 2);
});
