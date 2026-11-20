// npm run templates -- --dry-run                         → checks the Smart Reach template library and lists it
// npm run templates -- --business <id> --waba <WABA_ID>  → submits each template to that shop's WhatsApp
//   Business account (token from WABA_ACCESS_TOKEN or api/.dev.vars). Meta then reviews them. The token
//   is never printed.
import fs from 'node:fs';
import path from 'node:path';
import { templatePayloads } from '../src/services/templates';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
function devVars(): Record<string, string> {
  const file = path.join(__dirname, '..', '.dev.vars');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => /^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map(m => [m[1], m[2]]));
}

async function main() {
  const payloads = templatePayloads(); // fails here if the library itself is wrong
  if (process.argv.includes('--dry-run') || !arg('waba')) {
    console.log(`OK: ${payloads.length} marketing templates`);
    for (const p of payloads) console.log(`  ${p.name.padEnd(22)} ${(p.components.find(c => c.type === 'BODY') as { text: string }).text}`);
    if (!arg('waba')) console.log('\nTo submit: npm run templates -- --business <id> --waba <WABA_ID>');
    return;
  }
  const vars = { ...devVars(), ...process.env };
  const token = vars.WABA_ACCESS_TOKEN || vars.ADMIN_BOT_ACCESS_TOKEN;
  if (!token) throw new Error('Set WABA_ACCESS_TOKEN (environment or api/.dev.vars).');
  const base = `https://graph.facebook.com/${vars.META_GRAPH_VERSION || 'v21.0'}/${encodeURIComponent(arg('waba')!)}/message_templates`;
  for (const p of payloads) {
    const res = await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(p) });
    const body = (await res.json().catch(() => ({}))) as { id?: string; status?: string; error?: { message?: string } };
    console.log(`${p.name}: ${res.ok ? `submitted (${body.status ?? 'PENDING'})` : `failed: ${String(body.error?.message ?? res.status).slice(0, 160)}`}`);
  }
}

main().catch(e => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); });
