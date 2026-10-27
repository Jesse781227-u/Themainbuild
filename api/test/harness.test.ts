import { adminDb, api, clearFirestore, startApi, stopApi } from './helpers';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

before(async () => { await clearFirestore(); await startApi(); });
after(stopApi);

test('harness: emulator reachable', async () => {
  await adminDb.collection('_harness').doc('probe').set({ ok: true });
  assert.equal((await adminDb.collection('_harness').doc('probe').get()).get('ok'), true);
  const res = await api('GET', '/health/deep');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.checks.firestore, 'ok');
});
