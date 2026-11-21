// Acceptance run of signup v3 against the running test chat (npm run dev), as Mary of Mayschills:
// "hey" → name → MaysChills-Menu.pdf → Looks good → address + hours → location_prices.pdf → fee.
// Uses its own phone number (not the one in your /dev/owner tab). Prints every reply and checks the
// acceptance rules (≤ 7 owner messages, no step counter, no long messages, no Save/Cancel).
//   npx tsx scripts/eval-mayschills.ts [--url http://localhost:8787] [--menu path] [--zones path]
import fs from 'node:fs';
import path from 'node:path';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const URL_ = arg('url', 'http://localhost:8787');
const MENU = arg('menu', path.join(process.env.USERPROFILE ?? '', 'Downloads', 'MaysChills-Menu.pdf'));
const ZONES = arg('zones', path.join(process.env.USERPROFILE ?? '', 'Downloads', 'location_prices.pdf'));
const vars = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.dev.vars'), 'utf8').split(/\r?\n/).map(l => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map(m => [m![1], m![2].replace(/^"|"$/g, '')]));
const BOT = vars.ADMIN_BOT_PHONE_NUMBER_ID;
const PHONE = `23480999${String(Date.now()).slice(-5)}`; // a fresh owner every run

type Msg = { direction: 'in' | 'out'; content: { type: string; text?: string; interactive?: { type?: string; body?: { text: string }; action?: { buttons?: { reply: { id: string; title: string } }[]; parameters?: { display_text: string; url: string } } } } };
const textOf = (m: Msg) => m.content.text ?? m.content.interactive?.body?.text ?? `[${m.content.type}]`;
const buttonsOf = (m: Msg) => (m.content.interactive?.action?.buttons ?? []).map(b => `[${b.reply.title}]`).concat(m.content.interactive?.action?.parameters ? [`[${m.content.interactive.action.parameters.display_text} ↗]`] : []);
const post = (route: string, body: unknown) => fetch(`${URL_}/dev/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const messages = async (): Promise<Msg[]> => (await fetch(`${URL_}/dev/messages?phone=${PHONE}&bot=${BOT}`)).json() as Promise<Msg[]>;

// Waits until the bot has answered and gone quiet (files take a while to read).
async function replies(before: number, maxMs = 120_000): Promise<Msg[]> {
  const start = Date.now();
  let last = -1, quietSince = Date.now();
  for (;;) {
    const out = (await messages()).slice(before).filter(m => m.direction === 'out' && !['typing', 'reaction'].includes(m.content.type));
    if (out.length !== last) { last = out.length; quietSince = Date.now(); }
    const settled = out.length && !/^(Reading it now|Still reading)/.test(textOf(out[out.length - 1]));
    if ((settled && Date.now() - quietSince > 4000) || Date.now() - start > maxMs) return out;
    await new Promise(r => setTimeout(r, 700));
  }
}

let owner = 0;
const all: Msg[] = [];
async function step(label: string, act: () => Promise<unknown>) {
  owner++;
  const before = (await messages()).length;
  const t0 = Date.now();
  await act();
  const out = await replies(before + 1);
  all.push(...out);
  console.log(`\n👤 ${owner}. ${label}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  for (const m of out) console.log(`🤖 ${textOf(m).replace(/\n/g, '\n   ')}${buttonsOf(m).length ? `\n   ${buttonsOf(m).join(' ')}` : ''}  ⟨${textOf(m).split('\n').length} lines⟩`);
  return out;
}
const say = (text: string) => post('send', { botNumber: BOT, phone: PHONE, text, name: 'Mary' });
const tap = (id: string, title: string) => post('send', { botNumber: BOT, phone: PHONE, choice: { id, title }, name: 'Mary' });
const upload = (file: string) => post('upload', { botNumber: BOT, phone: PHONE, filename: path.basename(file), mimeType: 'application/pdf', data: fs.readFileSync(file).toString('base64'), name: 'Mary' });

async function main() {
  await post('clear', { botNumber: BOT, phone: PHONE });
  await step('hey', () => say('hey'));
  await step('Mayschills', () => say('Mayschills'));
  const menu = await step(path.basename(MENU), () => upload(MENU));
  const looks = menu.find(m => buttonsOf(m).includes('[Looks good]'));
  if (!looks) { console.log('\n⛔ no [Looks good] after the menu'); return; }
  await step('[Looks good]', () => tap('imp:all', 'Looks good'));
  await step('16 Atunrase Estate, Gbagada · Mon–Fri 8–7, Sat 10–7', () => say('16 Atunrase Estate, Gbagada · Mon–Fri 8–7, Sat 10–7'));
  await step(path.basename(ZONES), () => upload(ZONES));
  const ready = await step("[I'll pay]", () => tap('fee:owner', "I'll pay"));
  const connect = ready.some(m => m.content.interactive?.type === 'cta_url');
  const long = all.filter(m => textOf(m).split('\n').length > 8);
  console.log(`\n── Acceptance ──`);
  console.log(`${owner <= 7 && connect ? '✅' : '⛔'} ${owner} owner messages to the Connect button (${connect ? 'reached' : 'not reached'})`);
  console.log(`${all.every(m => !/Step \d+ of/.test(textOf(m))) ? '✅' : '⛔'} no "Step X of N"`);
  console.log(`${long.length ? '⛔' : '✅'} no message over 8 lines${long.length ? `: ${long.map(m => textOf(m).split('\n')[0]).join(' | ')}` : ''}`);
  console.log(`${all.some(m => /Save all|Cancel/.test(buttonsOf(m).join(' '))) ? '⛔' : '✅'} no Save/Cancel for the delivery list`);
  console.log(`${all.some(m => /matching them|couldn't match/i.test(textOf(m))) ? '⛔' : '✅'} no photo-matching messages`);
}
main().catch(e => { console.error(e); process.exit(1); });
