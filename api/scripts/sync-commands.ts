// npm run sync:commands            → sends the owner commands and ice breakers to the Admin Bot number
// npm run sync:commands -- --dry-run → checks them against WhatsApp's limits and prints them, sends nothing
// Reads META_GRAPH_VERSION, ADMIN_BOT_PHONE_NUMBER_ID and ADMIN_BOT_ACCESS_TOKEN from the
// environment, else from api/.dev.vars. The token is never printed.
import fs from 'node:fs';
import path from 'node:path';
import { commandsPayload } from '../src/bots/actions';
import { syncCommands } from '../src/services/automation';

function devVars(): Record<string, string> {
  const file = path.join(__dirname, '..', '.dev.vars');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => /^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map(m => [m[1], m[2]]));
}

async function main() {
  const payload = commandsPayload(); // fails here, with every problem listed, if a limit is broken
  if (process.argv.includes('--dry-run')) {
    console.log(`OK: ${payload.commands.length} commands, ${payload.prompts.length} ice breakers`);
    for (const c of payload.commands) console.log(`  /${c.command_name.padEnd(10)} ${c.command_description}`);
    for (const p of payload.prompts) console.log(`  ice breaker: ${p}`);
    return;
  }
  const vars = { ...devVars(), ...process.env };
  const phoneNumberId = vars.ADMIN_BOT_PHONE_NUMBER_ID, accessToken = vars.ADMIN_BOT_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) throw new Error('Set ADMIN_BOT_PHONE_NUMBER_ID and ADMIN_BOT_ACCESS_TOKEN (environment or api/.dev.vars).');
  const done = await syncCommands({ graphVersion: vars.META_GRAPH_VERSION || 'v21.0', phoneNumberId, accessToken });
  console.log(`Synced ${done.commands} commands and ${done.prompts} ice breakers to the Admin Bot number.`);
}

main().catch(e => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); });
