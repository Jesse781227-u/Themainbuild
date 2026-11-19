import { Bot, clearFirestore, db, doc, seed } from './helpers';
import { addShop, getOwner, readOwner, removeShop, switchShop } from '../src/services/owners';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });

test('owners: old single-shop records still read; shops can be added, switched and removed', async () => {
  assert.deepEqual(readOwner({ businessId: 'x' }), { businessIds: ['x'], activeBusinessId: 'x', businessId: 'x', onboardingStage: null, ownerName: null });
  const phone = '+2348039990001';
  await db.set(db.doc('ownerPhones', phone), { businessId: 'shop-1', onboardingStage: 'connect' }); // a record from before branches
  await addShop(db, phone, 'shop-2');
  let o = await getOwner(db, phone);
  assert.deepEqual([o!.businessIds, o!.activeBusinessId, o!.businessId, o!.onboardingStage], [['shop-1', 'shop-2'], 'shop-2', 'shop-2', 'connect']);
  assert.equal(await switchShop(db, phone, 'shop-1'), true);
  assert.equal(await switchShop(db, phone, 'someone-elses'), false, 'only your own shops');
  assert.equal((await getOwner(db, phone))!.activeBusinessId, 'shop-1');
  await removeShop(db, phone, 'shop-1');
  o = await getOwner(db, phone);
  assert.deepEqual([o!.businessIds, o!.activeBusinessId], [['shop-2'], 'shop-2']);
  await removeShop(db, phone, 'shop-2');
  assert.equal(await doc('ownerPhones', phone), null);
});

test('support: CALL saves a ticket and alerts Relay\'s support number', async () => {
  const bot = new Bot();
  const owner = fx.a.ownerPhone.slice(1);
  const res = await bot.send('admin', { from: owner, text: 'CALL' });
  assert.match(res[0].text, /A real person from Relay will call or WhatsApp you shortly/);
  const [ticket] = await db.query('supportTickets', [['ownerPhone', '==', fx.a.ownerPhone]]);
  assert.equal(ticket.businessId, fx.a.id);
  assert.equal(ticket.status, 'open');
  const alert = await doc('outbox', `${fx.a.id}_support_${ticket.id}`);
  assert.equal(alert.to, '+2349013406288');
  assert.ok(alert.text.includes(`Support ${ticket.id}: +${owner} (Business biz-a) replied CALL.`) && alert.text.includes(`wa.me/${owner}`), alert.text);
});
