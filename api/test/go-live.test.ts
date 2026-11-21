import { api, Bot, clearFirestore, db, doc, env, seed, signUp } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { goLive } from '../src/services/go-live';
import { afterLiveNudges, connectReminders } from '../src/services/nudges';
import { createSignupSession } from '../src/services/signup';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

before(async () => { await clearFirestore(); await seed(); });
const cfg = getConfig(env);

test('go-live: three short messages and nothing else; then the follow-ups one at a time, each once', async () => {
  const bot = new Bot();
  const from = '2348037771111';
  const { businessId } = await signUp(bot, from, { shop: 'Ada Thrift', product: 'Vintage denim jacket 15000', name: 'Ada' });
  // What the connect page does once Meta's signup succeeds.
  await saveWhatsAppConnection(db, cfg, { businessId, wabaId: 'waba-x', phoneNumberId: 'pn-ada', accessToken: 'tok' });
  await db.update(db.doc('businesses', businessId), { status: 'active', whatsappDisplayNumber: '+234 803 777 1111' });
  await goLive(db, cfg, { businessId, enqueue: async jobs => { env.EVENTS.sent.push(...jobs); } });
  let before = bot.transport.sent.length;
  await bot.drain();
  const sent = bot.transport.sent.slice(before).filter(m => m.to === `+${from}`).map(m => m.content as any);
  assert.equal(sent.length, 3, 'the live message, the one to forward, the Status line: nothing else in this session');
  assert.equal(sent[0].text, "🎉 Ada Thrift is live on +234 803 777 1111!\nYour shop link: https://wa.me/2348037771111\nIf you reply to a customer yourself, I'll step back in that chat.");
  assert.equal(sent[1].text, 'Hi! 👋 You can now order from Ada Thrift here on WhatsApp, any time. https://wa.me/2348037771111');
  assert.equal(sent[2].text, 'Post that on your Status and send it to your customers 👆');
  assert.equal((await doc('ownerPhones', `+${from}`)).onboardingStage, 'live');
  assert.equal((await doc('conversations', `admin_${from}`)).onboarding, null, 'signup is over');
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Ada' });
  assert.match((await say('products'))[0].text, /Vintage denim jacket/, 'everything works as usual');

  // The follow-ups: one per run, ~a day apart, each only once.
  const live = new Date((await doc('businesses', businessId)).wentLiveAt).getTime();
  const at = (ms: number) => new Date(live + ms);
  const H = 3_600_000;
  const nudge = async (ms: number) => {
    const ids = await afterLiveNudges(db, at(ms));
    if (!ids.length) return null;
    env.EVENTS.sent.push(...ids.map(messageId => ({ kind: 'outbox' as const, messageId })));
    before = bot.transport.sent.length;
    await bot.drain();
    return bot.transport.sent.slice(before).filter(m => m.to === `+${from}`).map(m => m.content as any)[0];
  };
  assert.equal(await nudge(10_000), null, 'not in the first minute');
  const picture = await nudge(2 * 60_000);
  assert.equal(picture.interactive.body.text, "Send a logo or a nice photo of your shop and I'll make it your WhatsApp picture.");
  assert.equal(await nudge(3 * 60_000), null, 'once');
  assert.match((await say('Skip', 'lp:skip'))[0].text, /PICTURE/);
  assert.equal(await nudge(10 * H), null, 'about a day apart');
  const contacts = await nudge(25 * H);
  assert.match(contacts.interactive.body.text, /WhatsApp can share the contacts already on your number/);
  assert.match((await say('yes, add them'))[0].text, /CUSTOMERS/, 'words for the button work here too');
  const photos = await nudge(50 * H);
  assert.match(photos.text, /Want photos on your best sellers\?/);
  const source = await nudge(75 * H);
  assert.equal(source.interactive.body.text, 'Quick one: how did you hear about Relay?');
  assert.match((await say('A friend', 'src:friend'))[0].text, /Thank you!/);
  assert.equal(await nudge(100 * H), null, 'nothing more after these');
  const biz = await doc('businesses', businessId);
  assert.deepEqual([biz.importContacts, biz.acquisitionSource], [true, 'friend']);

  // PICTURE and CONTACTS ask the same questions any time.
  assert.match(JSON.stringify((await say('picture'))[0].content), /make it your WhatsApp picture/);
  // A repeated callback doesn't send the kit twice.
  env.EVENTS.sent.length = 0;
  await goLive(db, cfg, { businessId, enqueue: async jobs => { env.EVENTS.sent.push(...jobs); } });
  assert.equal(env.EVENTS.sent.length, 0);
});

test('nudges: one connect reminder after an hour, never more', async () => {
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

});
