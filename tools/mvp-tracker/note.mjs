// Attach a status note to a task. Notes never mark a task done.
//   node tools/mvp-tracker/note.mjs C2 working "Ownership check + test on branch fix/tenant"
//   node tools/mvp-tracker/note.mjs C16 blocked "Waiting for backs.io webhook docs (Y2)"
//   node tools/mvp-tracker/note.mjs C2 clear
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tasks } from './tasks.mjs';

const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'state.json');
const [id, kind, ...rest] = process.argv.slice(2);
if (!tasks.some(t => t.id === id) || !['working', 'blocked', 'info', 'clear'].includes(kind)) {
  console.error('usage: note.mjs <taskId> <working|blocked|info|clear> [text]');
  process.exit(1);
}
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
state.notes ||= {};
if (kind === 'clear') delete state.notes[id];
else state.notes[id] = { kind, text: rest.join(' '), at: new Date().toISOString() };
fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 2));
fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
console.log(kind === 'clear' ? `${id}: note cleared` : `${id}: ${kind} — ${rest.join(' ')}`);
