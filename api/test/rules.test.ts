import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

let env: RulesTestEnvironment;
before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  env = await initializeTestEnvironment({ projectId: 'demo-relay-rules', firestore: { rules: fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8'), host, port: Number(port) } });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await db.collection('products').doc('prod-a').set({ businessId: 'biz-a', name: 'A', availability: true });
    await db.collection('orders').doc('order-a').set({ businessId: 'biz-a', status: 'pending' });
  });
});
after(async () => { await env?.cleanup(); });

const clients = () => [env.unauthenticatedContext().firestore(), env.authenticatedContext('user-a').firestore()];

test('rules: clients cannot read any collection', async () => {
  for (const db of clients()) {
    await assertFails(db.collection('products').doc('prod-a').get());
    await assertFails(db.collection('orders').doc('order-a').get());
    await assertFails(db.collection('products').where('businessId', '==', 'biz-a').get());
    await assertFails(db.collection('owners').doc('+2348000000000').get());
  }
});

test('rules: clients cannot write any collection', async () => {
  for (const db of clients()) {
    await assertFails(db.collection('products').doc('prod-a').update({ name: 'Mine now' }));
    await assertFails(db.collection('orders').doc('order-new').set({ businessId: 'biz-a' }));
    await assertFails(db.collection('customers').doc('x').set({ businessId: 'biz-a' }));
  }
});
