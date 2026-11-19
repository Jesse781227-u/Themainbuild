import { Bot, clearFirestore, db, env, fakeLLM, seed } from './helpers';
import { getConfig } from '../src/config';
import { saveWhatsAppConnection } from '../src/services/whatsapp';
import { slowJob } from '../src/services/presence';
import { handleImport } from '../src/bots/catalog-import';
import type { FlowCtx } from '../src/bots/products-flow';
import type { Business } from '../src/domain/business';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => {
  await clearFirestore();
  fx = await seed();
  await saveWhatsAppConnection(db, getConfig(env), { businessId: fx.a.id, wabaId: 'waba-a', phoneNumberId: fx.a.pnid, accessToken: 'merchant-a' });
});

test('typing: owners and customers see "typing…" as soon as their message is picked up', async () => {
  const bot = new Bot();
  await bot.send('admin', { from: fx.a.ownerPhone.slice(1), text: 'products' });
  await bot.send('shop', { from: '2348091113001', to: fx.a.pnid, text: 'hi' });
  assert.equal(bot.transport.typing.length, 2);
  assert.ok(bot.transport.typing.every(id => id.startsWith('wamid')));
});

test('slow jobs: ⏳ while working, ✅ when done, one "still working" message past the limit', async () => {
  const seen: string[] = [];
  const ui = { react: async (e: string) => { seen.push(e || '(removed)'); }, stillWorking: async () => { seen.push('still working'); } };
  assert.equal(await slowJob(async () => { await new Promise(r => setTimeout(r, 60)); return 'ok'; }, ui, 20), 'ok');
  assert.deepEqual(seen, ['⏳', 'still working', '✅']);
  seen.length = 0;
  await slowJob(async () => 'quick', ui, 1_000);
  assert.deepEqual(seen, ['⏳', '✅'], 'no "still working" when it was quick');
  seen.length = 0;
  await assert.rejects(slowJob(async () => { throw new Error('boom'); }, ui, 1_000));
  assert.deepEqual(seen, ['⏳', '(removed)'], 'a failure takes the ⏳ off');
  seen.length = 0;
  await slowJob(async () => [], { ...ui, ok: r => r.length > 0 }, 1_000);
  assert.deepEqual(seen, ['⏳', '(removed)'], 'nothing found: no ✅');
});

test('menu reading: ⏳ then ✅ on the owner\'s file', async () => {
  const reactions: string[] = [];
  const llm = { ...fakeLLM(() => null), async readCatalog() { return [{ name: 'Suya', price: 3000, category: 'Grills' }]; } };
  const business = (await db.get(db.doc('businesses', fx.b.id))) as unknown as Business;
  const f: FlowCtx = { db, cfg: getConfig(env), deps: { transport: new Bot().transport, llm, transcriber: null, fetch: (async () => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch, enqueue: async () => {} }, business, convRef: db.doc('conversations', 'admin_presence'), state: {} };
  // Meta's media lookup, then the file itself.
  let call = 0;
  f.deps.fetch = (async () => (call++ === 0 ? Response.json({ url: 'https://media/x', mime_type: 'application/pdf' }) : new Response(new Uint8Array([37, 80, 68, 70])))) as unknown as typeof fetch;
  const input = { text: '', choiceId: null, imageId: null, audioId: null, document: { id: 'doc1', mimeType: 'application/pdf', filename: 'menu.pdf' } };
  const out = await handleImport(f, input, '', 'token', async () => {}, async e => { reactions.push(e); });
  assert.match(JSON.stringify(out!.out[0]), /I found \*1 product\*/);
  assert.deepEqual(reactions, ['⏳', '✅']);
});
