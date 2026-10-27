import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
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
    for (const b of ['a', 'b']) await db.collection('businessMemberships').doc(`user-${b}_biz-${b}`).set({ businessId: `biz-${b}`, userId: `user-${b}`, role: 'owner' });
    await db.collection('products').doc('prod-a').set({ businessId: 'biz-a', name: 'A', availability: true });
    await db.collection('orders').doc('order-a').set({ businessId: 'biz-a', orderStatus: 'pending' });
  });
});
after(async () => { await env?.cleanup(); });

const as = (uid: string) => env.authenticatedContext(uid).firestore();

test('rules: member cannot reassign another business product', async () => {
  await assertFails(as('user-b').collection('products').doc('prod-a').update({ businessId: 'biz-b', name: 'Mine now' }));
  await assertFails(as('user-b').collection('products').doc('prod-a').set({ businessId: 'biz-b', name: 'Mine now' }));
  await assertFails(as('user-a').collection('products').doc('prod-a').update({ businessId: 'biz-b' }));
  await assertSucceeds(as('user-a').collection('products').doc('prod-a').update({ name: 'Renamed' }));
});

test('rules: member cannot reassign another business order', async () => {
  await assertFails(as('user-b').collection('orders').doc('order-a').update({ businessId: 'biz-b' }));
  await assertFails(as('user-b').collection('orders').doc('order-a').set({ businessId: 'biz-b', orderStatus: 'cancelled' }));
  await assertSucceeds(as('user-a').collection('orders').doc('order-a').update({ orderStatus: 'confirmed' }));
});
