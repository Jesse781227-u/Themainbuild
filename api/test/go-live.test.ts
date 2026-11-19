import { api, Bot, clearFirestore, db, doc, env, seed, signUp } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { goLive } from '../src/services/go-live';
import { connectReminders, dayTwoNudges } from '../src/services/nudges';
import { createSignupSession } from '../src/services/signup';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

before(async () => { await clearFirestore(); await seed(); });
const cfg = getConfig(env);

test('go-live: after connecting, the kit (link, Status image, announcement) and the last questions', async () => {
  const bot = new Bot();
  const from = '2348037771111';
  const { businessId } = await signUp(bot, from, { shop: 'Ada Thrift', product: 'Vintage denim jacket 15000', name: 'Ada', until: 'linked' });
  // What the connect page does once Meta's signup succeeds.
  await saveWhatsAppConnection(db, cfg, { businessId, wabaId: 'waba-x', phoneNumberId: 'pn-ada', accessToken: 'tok' });
  await db.update(db.doc('businesses', businessId), { status: 'active', whatsappDisplayNumber: '+234 803 777 1111' });
  await goLive(db, cfg, { businessId, enqueue: async jobs => { env.EVENTS.sent.push(...jobs); } });
  const before = bot.transport.sent.length;
  await bot.drain();
  const sent = bot.transport.sent.slice(before).filter(m => m.to === `+${from}`).map(m => m.content as any);
  assert.match(sent[0].text, /🎉 Ada Thrift is live! Customers who message \+234 803 777 1111[\s\S]*Your shop link: https:\/\/wa\.me\/2348037771111/);
  assert.equal(sent[1].type, 'image');
  assert.ok(sent[1].link.endsWith(`/golive/${businessId}.png`));
  assert.match(sent[2].text, /Forward this to your customers/);
  assert.match(sent[3].text, /You can now order from Ada Thrift right here on WhatsApp[\s\S]*wa\.me\/2348037771111/);
  assert.match(sent[4].interactive.body.text, /no picture yet/, 'no profile photo: asked for one');

  const png = await api('GET', `/golive/${businessId}.png`);
  assert.equal(png.status, 200);
  assert.equal((await doc('ownerPhones', `+${from}`)).onboardingStage, 'live');

  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Ada' });
  assert.match((await say('products'))[0].text, /Vintage denim jacket/, 'anything else still works as usual');
  const contacts = await say('Skip for now', 'lp:skip');
  assert.deepEqual(contacts[0].options, ['lc:yes', 'lc:no']);
  const source = await say('Yes, add them', 'lc:yes');
  assert.match(source[0].text, /CUSTOMERS/);
  assert.ok(source[1].options.includes('src:friend'));
  assert.match((await say('A friend', 'src:friend'))[0].text, /Thank you!/);
  const biz = await doc('businesses', businessId);
  assert.deepEqual([biz.importContacts, biz.acquisitionSource], [true, 'friend']);
  assert.equal((await doc('conversations', `admin_${from}`)).onboarding, null);

  // A repeated callback doesn't send the kit twice.
  await goLive(db, cfg, { businessId, enqueue: async jobs => { env.EVENTS.sent.push(...jobs); } });
  assert.equal(env.EVENTS.sent.length, 0);
});

test('nudges: one connect reminder after an hour, one day-2 message, never more', async () => {
  const bot = new Bot();
  const from = '2348037772222';
  const { businessId } = await signUp(bot, from, { shop: 'Slow Shop', product: 'Ankara tote 8000', until: 'linked' });
  const later = new Date(Date.now() + 61 * 60_000);
  const ids = await connectReminders(db, cfg, later);
  assert.equal(ids.length, 1);
  const reminder = await doc('outbox', ids[0]);
  assert.match(reminder.text, /Slow Shop is all set up and waiting[\s\S]*\/connect\/[A-Za-z0-9]+[\s\S]*Reply \*CALL\*/);
  assert.deepEqual(await connectReminders(db, cfg, later), [], 'only once');
  // A link that was used gets no reminder.
  const link = await createSignupSession(db, cfg, businessId);
  await db.update(db.doc('signupSessions', link.split('/').pop()!), { usedAt: new Date().toISOString() });
  assert.deepEqual(await connectReminders(db, cfg, new Date(Date.now() + 2 * 3600_000)), []);

  await db.update(db.doc('businesses', businessId), { createdAt: new Date(Date.now() - 30 * 3600_000).toISOString() });
  const nudges = await dayTwoNudges(db);
  assert.equal(nudges.length, 1);
  const text = (await doc('outbox', nudges[0])).text;
  assert.match(text, /personalise the greeting[\s\S]*1 product still shows a coloured letter card/);
  assert.deepEqual(await dayTwoNudges(db), [], 'only once');
});
