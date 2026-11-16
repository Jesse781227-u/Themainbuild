// Sends a signed, Meta-shaped webhook to a running Relay API (normally `npm run dev`, with
// META_SEND_MODE=log in api/.dev.vars so the bot's replies are printed in the wrangler console).
//
//   npx tsx scripts/simulate-webhook.ts admin "add Jollof rice, 2500, 10"
//   npx tsx scripts/simulate-webhook.ts admin --from 2348030000001 "products"
//   npx tsx scripts/simulate-webhook.ts shop --to <merchant phone_number_id> --from 2348090000001 "hi"
//   npx tsx scripts/simulate-webhook.ts shop --to <id> --choice add:<productId> "Add to cart"
//   npx tsx scripts/simulate-webhook.ts echo --to <id> --from 2348090000001 "I'll handle this"
//   npx tsx scripts/simulate-webhook.ts instagram --to <ig account id> --from <igsid> "price?"
//
// Options: --url (default http://localhost:8787), --from, --to (default ADMIN_BOT_PHONE_NUMBER_ID
// for admin), --choice <option id> (a tapped list/button option), --name <contact name>.
// The app secret comes from META_APP_SECRET in the environment or api/.dev.vars.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function devVars(): Record<string, string> {
  const file = path.join(__dirname, '..', '.dev.vars');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
}

export function buildPayload(kind: string, o: { from: string; to: string; text: string; choice?: string; name?: string; id?: string; now?: number }) {
  const id = o.id ?? `wamid.sim.${crypto.randomUUID()}`;
  const ts = Math.floor((o.now ?? Date.now()) / 1000);
  if (kind === 'instagram') {
    return { object: 'instagram', entry: [{ id: o.to, time: ts * 1000, messaging: [{ sender: { id: o.from }, recipient: { id: o.to }, timestamp: ts * 1000, message: { mid: `m_${id}`, text: o.text } }] }] };
  }
  const metadata = { display_phone_number: '15550000000', phone_number_id: o.to };
  if (kind === 'echo') {
    return { object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'smb_message_echoes', value: { messaging_product: 'whatsapp', metadata, message_echoes: [{ from: metadata.display_phone_number, to: o.from, id, timestamp: String(ts), type: 'text', text: { body: o.text } }] } }] }] };
  }
  const message = o.choice
    ? { from: o.from, id, timestamp: String(ts), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: o.choice, title: o.text || o.choice } } }
    : { from: o.from, id, timestamp: String(ts), type: 'text', text: { body: o.text } };
  return { object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata, contacts: [{ wa_id: o.from, profile: { name: o.name ?? 'Test Customer' } }], messages: [message] } }] }] };
}

export const sign = (raw: string, secret: string) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

async function main() {
  const args = process.argv.slice(2);
  const kind = args.shift();
  if (!kind || !['admin', 'shop', 'echo', 'instagram'].includes(kind)) {
    console.error('Usage: simulate-webhook.ts <admin|shop|echo|instagram> [--from N] [--to ID] [--choice ID] [--name NAME] [--url URL] "message"');
    process.exit(2);
  }
  const opt = (name: string) => { const i = args.indexOf(`--${name}`); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const vars = { ...devVars(), ...process.env } as Record<string, string | undefined>;
  const url = opt('url') ?? 'http://localhost:8787';
  const from = opt('from') ?? (kind === 'admin' ? '2348030000001' : kind === 'instagram' ? 'igsid-sim' : '2348090000001');
  const to = opt('to') ?? (kind === 'admin' ? vars.ADMIN_BOT_PHONE_NUMBER_ID : undefined);
  const choice = opt('choice');
  const name = opt('name');
  const text = args.join(' ');
  const secret = vars.META_APP_SECRET;
  if (!to) { console.error('--to is required (the receiving phone_number_id or Instagram account id).'); process.exit(2); }
  if (!secret) { console.error('META_APP_SECRET is not set (api/.dev.vars or the environment).'); process.exit(2); }
  const raw = JSON.stringify(buildPayload(kind, { from, to, text, choice, name }));
  const res = await fetch(`${url}/api/v1/webhooks/meta`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw, secret) }, body: raw });
  console.log(`${kind} → ${res.status}${res.ok ? ' (queued; replies appear in the wrangler console with META_SEND_MODE=log)' : ''}`);
  if (!res.ok) process.exit(1);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
