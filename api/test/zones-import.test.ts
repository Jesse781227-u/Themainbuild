// Delivery areas and prices from a list: pasted (your 66-area table), CSV, Excel, photo; tidy names;
// review then save; replace or add; from DELIVERY and from signup.
import { Bot, clearFirestore, db, doc, env, seed } from './helpers';
import { getConfig } from '../src/config';
import { csvToLines, parseZoneList, tidyArea, xlsxToLines } from '../src/services/zones-import';
import { listZones, quoteDelivery } from '../src/services/delivery';
import type { LLMProvider } from '../src/services/ai';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

const TABLE = fs.readFileSync(path.join(__dirname, 'fixtures/delivery-areas-table.txt'), 'utf8');

test('zones: the 66-area box table is read whole, with prices in naira', () => {
  const rows = parseZoneList(TABLE)!;
  assert.equal(rows.length, 66);
  const fee = (n: string) => rows.find(r => r.name === n)?.feeKobo;
  assert.equal(fee('Sangotedo'), 700_000);
  assert.equal(fee('Gbagada Phase 2'), 100_000);
  assert.equal(fee('Lekki Phase 1'), 400_000);
  assert.ok(!rows.some(r => /area|fee/i.test(r.name)), 'the header row is skipped');
});

test('zones: names customers see are tidied, and each fix is reported', () => {
  const fixes = Object.fromEntries(parseZoneList(TABLE)!.filter(r => r.was).map(r => [r.was, r.name]));
  assert.deepEqual(fixes, { 'Ebutte Metta': 'Ebute Metta', 'Ikeja Gra': 'Ikeja GRA', Illasamaja: 'Ilasamaja', Illupeju: 'Ilupeju', Oworoshoki: 'Oworonshoki', 'Palm Groove': 'Palm Grove', Vgc: 'VGC' });
  assert.deepEqual(tidyArea('yaba'), { name: 'Yaba', was: null }, 'just capitals is not worth a note');
  assert.equal(tidyArea('BANANA ISLAND').name, 'Banana Island');
});

test('zones: other ways owners write it', () => {
  const rows = parseZoneList(['Delivery prices', 'Yaba - 3,000', 'Lekki Phase 1: ₦4,000', 'Ajah 6k', 'Ikoyi | free', 'Surulere = N2500', '', 'Call 0803 000 0000'].join('\n'))!;
  assert.deepEqual(rows.map(r => [r.name, r.feeKobo]), [['Yaba', 300_000], ['Lekki Phase 1', 400_000], ['Ajah', 600_000], ['Ikoyi', 0], ['Surulere', 250_000]]);
  assert.equal(parseZoneList('Jollof rice'), null, 'not a list');
  assert.deepEqual(parseZoneList(csvToLines('Area,Fee\n"Ikeja GRA","3,000"\nOgba;4000'))!.map(r => [r.name, r.feeKobo]), [['Ikeja GRA', 300_000], ['Ogba', 400_000]]);
});

// A minimal .xlsx (zip of XML), built the way Excel stores it.
function xlsx(rows: (string | number)[][]) {
  const strings: string[] = [];
  const si = (s: string) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const sheet = `<worksheet><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => { const ref = `${String.fromCharCode(65 + ci)}${ri + 1}`; return typeof c === 'number' ? `<c r="${ref}"><v>${c}</v></c>` : `<c r="${ref}" t="s"><v>${si(c)}</v></c>`; }).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const shared = `<sst>${strings.map(s => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`;
  const files = [['xl/sharedStrings.xml', shared], ['xl/worksheets/sheet1.xml', sheet], ['[Content_Types].xml', '<Types/>']] as const;
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of files) {
    const raw = Buffer.from(body), data = zlib.deflateRawSync(raw), n = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(h, n, data); central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...locals, cd, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
}

test('zones: an Excel (.xlsx) spreadsheet is read without any extra library', async () => {
  const lines = await xlsxToLines(xlsx([['Area', 'Fee'], ['Yaba', 3000], ['Lekki Phase 1', '4,000'], ['Victoria Island', 3500]]));
  assert.deepEqual(parseZoneList(lines)!.map(r => [r.name, r.feeKobo]), [['Yaba', 300_000], ['Lekki Phase 1', 400_000], ['Victoria Island', 350_000]]);
});

let fx: Awaited<ReturnType<typeof seed>>;
before(async () => { await clearFirestore(); fx = await seed(); });

test('owner: DELIVERY → Send my price list → paste → the full list, the fixes, then Save all', async () => {
  const bot = new Bot();
  const o = fx.a.ownerPhone.slice(1);
  const view = await bot.send('admin', { from: o, text: 'delivery' });
  assert.ok(view.some(m => m.options.includes('act:zonesupload')));
  assert.match((await bot.send('admin', { from: o, choice: 'act:zonesupload', text: 'Send my price list' }))[0].text, /^Send your delivery areas and prices/);
  const review = await bot.send('admin', { from: o, text: TABLE });
  assert.match(review[0].text, /^📍 \*66 delivery areas\*, ₦1,000 to ₦7,000:\n• Abule Egba: ₦5,000\n/);
  assert.match(review[1].text, /^✏️ I tidied 7 names customers will see:[\s\S]*Vgc → VGC/);
  assert.deepEqual(review[2].options, ['zimp:add', 'zimp:cancel']);
  assert.equal((await listZones(db, fx.a.id)).length, 0, 'nothing saved before the tap');
  const saved = await bot.send('admin', { from: o, choice: 'zimp:add', text: 'Save all' });
  assert.match(saved[0].text, /^✅ Saved 66 delivery areas/);
  assert.equal((await listZones(db, fx.a.id)).length, 66);
  // Customers get the specific price: "Lekki Phase 1" isn't priced as "Lekki Phase 2".
  assert.equal((await quoteDelivery(db, fx.a.id, '5 Admiralty Way, Lekki Phase 1', 'self_arranged'))?.feeKobo, 400_000);
  assert.equal((await quoteDelivery(db, fx.a.id, 'Herbert Macaulay, Yaba', 'self_arranged'))?.feeKobo, 300_000);
});

test('owner: a second list can replace the areas (old ones switched off) or be added to them', async () => {
  const bot = new Bot();
  const o = fx.a.ownerPhone.slice(1);
  const review = await bot.send('admin', { from: o, text: 'My delivery prices:\nYaba 3500\nSurulere 3000\nIkeja 4000' });
  assert.deepEqual(review.at(-1)!.options, ['zimp:replace', 'zimp:add', 'zimp:cancel']);
  await bot.send('admin', { from: o, choice: 'zimp:replace', text: 'Replace my areas' });
  const zones = await listZones(db, fx.a.id);
  assert.deepEqual(zones.map(z => z.name).sort(), ['Ikeja', 'Surulere', 'Yaba']);
  assert.equal(zones.find(z => z.name === 'Yaba')!.feeKobo, 350_000);
});

test('owner: a photo of the list is read by the AI (delivery mode), names tidied, unpriced lines dropped', async () => {
  const { startZoneImport } = await import('../src/bots/zones-flow');
  const purposes: (string | undefined)[] = [];
  const llm: LLMProvider = {
    async chooseTool() { return null; },
    async readCatalog(input) { purposes.push(input.purpose); return [{ name: 'Yaba', price: 3000, category: null }, { name: 'ikeja gra', price: 3500, category: null }, { name: 'Ajah', price: null, category: null }]; },
  };
  const media = (async (url: string) => (String(url).includes('img-zones') ? Response.json({ url: 'https://media.test/z.jpg', mime_type: 'image/jpeg' }) : new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } }))) as typeof fetch;
  const business = (await doc('businesses', fx.a.id)) as never;
  const z = { db, cfg: getConfig(env), deps: { transport: new Bot().transport, llm, transcriber: null, fetch: media, enqueue: async () => {} }, business, convRef: db.doc('conversations', 'zones-photo-test') };
  const notes: unknown[] = [];
  const out = (await startZoneImport(z, { text: '', choiceId: null, imageId: 'img-zones', audioId: null, document: null } as never, '', async o => { notes.push(o); }))!;
  assert.deepEqual(purposes, ['delivery']);
  assert.equal(String(notes[0]), 'Reading it now…');
  assert.match(String(out[0]), /^📍 \*2 delivery areas\*, ₦3,000 to ₦3,500:\n• Ikeja GRA: ₦3,500\n• Yaba: ₦3,000$/);
  assert.equal((await doc('conversations', 'zones-photo-test')).zoneDraft.zones.length, 2);
});

// Signup (v3) up to "Do you deliver?", with the shop in Ikeja.
async function toDelivery(bot: Bot, from: string, shop: string) {
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Tayo' });
  await say('hi'); await say(shop);
  const card = await say('Gift box 5000');
  const pick = card.flatMap(m => m.options).find(id => id.startsWith('pcat:') && id !== 'pcat:new');
  if (pick) await say('Category', pick);
  await say("That's all", 'prod:done');
  return say('Ikeja, Lagos · 8am-9pm');
}

test('signup: the whole list at "Do you deliver?" is saved straight away (no Save/Cancel), then the fee', async () => {
  const bot = new Bot();
  const from = '2348036660001';
  const ask = await toDelivery(bot, from, 'Zones Shop');
  assert.match(ask.at(-1)!.text, /Do you deliver\? Send your area price list/);
  const next = await bot.send('admin', { from, text: TABLE, name: 'Tayo' });
  assert.equal(next.length, 1);
  assert.match(next[0].text, /^Saved 66 areas, ₦1,000–₦7,000\. I fixed \d+ spellings \(like [^)]+\)\. Send \*DELIVERY\* anytime to check or edit them\.\n\nLast thing:/);
  assert.doesNotMatch(next[0].text, /Abule Egba/, 'no full list here (DELIVERY shows it)');
  const owner = await doc('ownerPhones', `+${from}`);
  assert.equal((await listZones(db, owner.businessId)).length, 66);
  const biz = await doc('businesses', owner.businessId);
  assert.deepEqual([biz.fulfilment, biz.shipsInterstate], ['both', false]);
  const delivery = await bot.send('admin', { from, text: 'delivery', name: 'Tayo' });
  assert.match(delivery.map(m => m.text).join('\n'), /Ebute Metta/, 'DELIVERY shows the areas, spellings fixed');
});

test('zones: a list pasted with its line breaks lost is split back into lines', () => {
  const squashed = TABLE.split('\n').filter(l => l.startsWith('│') && !/Area/.test(l)).map(l => l.split('│').map(x => x.trim()).filter(Boolean)).map(([a, f]) => `${a}: ₦${f}`).join(' ');
  assert.match(squashed, /^Abule Egba: ₦5,000 Ago Palace: ₦4,500 Ajah: ₦6,000 /);
  const rows = parseZoneList(squashed)!;
  assert.equal(rows.length, 66);
  assert.equal(rows.find(r => r.name === 'Gbagada Phase 2')?.feeKobo, 100_000, '"Phase 2" stays in the name');
  assert.deepEqual(parseZoneList('Yaba: 3000 Ikeja - 2500 Ajah: 6k')!.map(r => [r.name, r.feeKobo]), [['Yaba', 300_000], ['Ikeja', 250_000], ['Ajah', 600_000]]);
});

test('signup: a list squashed into one line is saved; the shop\'s own area missing from it is asked once', async () => {
  const bot = new Bot();
  const from = '2348036660002';
  await toDelivery(bot, from, 'City Zones Shop');
  const say = (text: string, choice?: string) => bot.send('admin', { from, text, choice, name: 'Tayo' });
  const own = await say('Abule Egba: ₦5,000 Ago Palace: ₦4,500 Ajah: ₦6,000 Yaba: ₦3,000');
  assert.equal(own[0].text, 'Saved 4 areas, ₦3,000–₦6,000. Send *DELIVERY* anytime to check or edit them.\n\nHow much is delivery around Ikeja? Type 0 if it\'s free.');
  const fee = await say('1500');
  assert.match(fee[0].text, /^✅ ₦1,500 around Ikeja\.\n\nLast thing:/);
  const owner = await doc('ownerPhones', `+${from}`);
  assert.equal((await listZones(db, owner.businessId)).length, 5);
});

test('zones: a PDF list is read from its own text, without the AI; two columns on a line split', async () => {
  const { pdfText } = await import('../src/services/pdf-text');
  const text = await pdfText(fs.readFileSync(path.join(__dirname, 'fixtures/delivery-areas.pdf')));
  assert.ok(text && /Abule Egba/.test(text));
  const rows = parseZoneList(text!)!;
  assert.equal(rows.length, 66, 'every area of the two-column table');
  const fee = (name: string) => rows.find(r => r.name === name)?.feeKobo;
  assert.deepEqual([fee('Abule Egba'), fee('Ketu'), fee('Sangotedo'), fee('Gbagada Phase 2')], [500_000, 300_000, 700_000, 100_000]);
  assert.deepEqual(parseZoneList('Yaba ₦3,000 Ikeja ₦3,000\nAjah ₦6,000 Lekki Phase 1 ₦4,000')!.map(r => r.name), ['Yaba', 'Ikeja', 'Ajah', 'Lekki Phase 1']);
  assert.equal(await pdfText(new Uint8Array([1, 2, 3])), null, 'not a PDF: nothing');
});
