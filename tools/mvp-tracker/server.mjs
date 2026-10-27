// Relay MVP tracker: a zero-dependency local server.
// Run from the repo root with `npm run tracker`, then open http://localhost:4700
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { plan, tasks } from './tasks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const STATE_FILE = path.join(HERE, 'state.json');
const PORT = Number(process.env.TRACKER_PORT || 4700);
const SCAN_EXT = /\.(ts|tsx|js|mjs|json|html|yaml|yml|rules)$/;

// ── state ────────────────────────────────────────────────────────────────
const emptyState = () => ({ manual: {}, notes: {}, settings: { stagingApiUrl: '', prodApiUrl: '' }, tests: null });
function readState() {
  try { return { ...emptyState(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { return emptyState(); }
}
function writeState(mutate) {
  const state = readState();
  mutate(state);
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
  return state;
}

// ── helpers ──────────────────────────────────────────────────────────────
const abs = p => path.join(ROOT, p);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
function listFiles(dir) {
  const out = [];
  const walk = d => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SCAN_EXT.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}
function filesFor(check) {
  const target = abs(check.file || check.path);
  if (!fs.existsSync(target)) return null;
  return fs.statSync(target).isDirectory() ? listFiles(target) : [target];
}
const run = (cmd, args, opts = {}) => new Promise(resolve => {
  execFile(cmd, args, { cwd: ROOT, timeout: 15000, shell: process.platform === 'win32', ...opts }, (error, stdout, stderr) =>
    resolve({ ok: !error, out: `${stdout}${stderr}`.trim() }));
});
const portOpen = (port, host = '127.0.0.1') => new Promise(resolve => {
  const socket = net.connect({ port, host });
  const done = ok => { socket.destroy(); resolve(ok); };
  socket.setTimeout(800, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});
function envValueSet(file, key) {
  try {
    const line = fs.readFileSync(abs(file), 'utf8').split(/\r?\n/).find(l => l.replace(/^\s*export\s+/, '').startsWith(`${key}=`));
    return Boolean(line && line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, ''));
  } catch { return false; }
}

// ── checks ───────────────────────────────────────────────────────────────
async function evaluate(check, state) {
  switch (check.kind) {
    case 'test': {
      const label = `test: ${check.name}`;
      const result = state.tests?.results?.[check.name];
      if (result === 'pass') return { label, ok: true };
      if (result === 'fail') return { label, ok: false, detail: 'failing' };
      return { label, ok: false, detail: state.tests ? 'not written yet' : 'tests have not run yet' };
    }
    case 'allTests': {
      const s = state.tests?.summary;
      const label = `all API tests pass (at least ${check.min})`;
      if (!s) return { label, ok: false, detail: 'tests have not run yet' };
      return { label, ok: s.failed === 0 && s.passed >= check.min, detail: `${s.passed} passing, ${s.failed} failing` };
    }
    case 'has':
    case 'lacks': {
      const where = check.file || check.path;
      const label = check.label || `${check.kind === 'has' ? 'contains' : 'free of'} /${check.re}/ in ${where}`;
      const files = await cached(`files:${where}`, 3000, () => filesFor(check));
      if (!files) return { label, ok: false, detail: `${where} not found` };
      const re = new RegExp(check.re);
      const hits = files.filter(f => re.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(ROOT, f).replaceAll('\\', '/'));
      return check.kind === 'has'
        ? { label, ok: hits.length > 0, detail: hits.length ? hits.slice(0, 3).join(', ') : 'not found yet' }
        : { label, ok: hits.length === 0, detail: hits.length ? `still in ${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ` +${hits.length - 3}` : ''}` : undefined };
    }
    case 'exists':
      return { label: `${check.path} exists`, ok: fs.existsSync(abs(check.path)) };
    case 'envKey': {
      const ok = envValueSet(check.file, check.key) || (check.alt ? envValueSet(check.alt, check.key) : false);
      return { label: `${check.key} set in ${check.file}`, ok };
    }
    case 'cmd': {
      const [cmd, ...args] = check.run.split(' ');
      const r = await cached(`cmd:${check.run}`, 60000, () => run(cmd, args));
      return { label: check.label || check.run, ok: r.ok, detail: r.ok ? r.out.split('\n')[0] : 'not found' };
    }
    case 'merged': {
      const r = await cached(`merged:${check.commit}:${check.into}`, 30000, () => run('git', ['merge-base', '--is-ancestor', check.commit, check.into]));
      return { label: `${check.commit} is in ${check.into}`, ok: r.ok };
    }
    case 'pushed': {
      const r = await cached(`pushed:${check.commit}`, 30000, () => run('git', ['branch', '-r', '--contains', check.commit]));
      return { label: `${check.commit} is on the remote`, ok: r.ok && r.out.length > 0, detail: r.ok && r.out ? r.out.split('\n')[0].trim() : undefined };
    }
    case 'http': {
      const base = (state.settings?.[check.setting] || '').replace(/\/$/, '');
      const label = `GET ${check.path} on ${check.setting === 'prodApiUrl' ? 'production' : 'staging'} API`;
      if (!base) return { label, ok: false, detail: 'set the URL in Settings' };
      return cached(`http:${base}${check.path}`, 30000, async () => {
        try {
          const res = await fetch(`${base}${check.path}`, { signal: AbortSignal.timeout(6000) });
          return { label, ok: res.ok, detail: `HTTP ${res.status}` };
        } catch (e) { return { label, ok: false, detail: e?.cause?.code || e?.name || 'unreachable' }; }
      });
    }
    default:
      return { label: `unknown check ${check.kind}`, ok: false };
  }
}

async function status() {
  const state = readState();
  const now = today();
  const out = [];
  for (const task of tasks) {
    const checks = await Promise.all(task.checks.map(c => evaluate(c, state)));
    const passed = checks.filter(c => c.ok).length;
    const autoDone = checks.length > 0 && passed === checks.length;
    const manual = state.manual[task.id];
    const done = task.owner === 'you' ? Boolean(manual?.done) || autoDone : autoDone;
    const doneBy = !done ? null : autoDone ? 'auto' : 'you';
    const note = state.notes[task.id] || null;
    out.push({ ...task, checks, passed, done, doneBy, manualAt: manual?.at || null, note, overdue: !done && task.due < now });
  }
  return { plan, today: now, tasks: out, settings: state.settings, tests: testsView(state), emulator: await portOpen(8080) };
}

// ── API test runner ──────────────────────────────────────────────────────
let running = false;
function testsView(state) { return { running, ...(state.tests || {}) }; }
function parseTap(text) {
  const results = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(not ok|ok) \d+ - (.+?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/i);
    if (!m || m[3]) continue;
    const name = m[2].replace(/\\#/g, '#').replace(/\\\\/g, '\\').trim();
    results[name] = m[1] === 'ok' && results[name] !== 'fail' ? 'pass' : 'fail';
  }
  return results;
}
async function runTests(reason) {
  if (running) return;
  const testDir = abs('api/test');
  if (!fs.existsSync(testDir)) {
    writeState(s => { s.tests = { ranAt: new Date().toISOString(), reason, skipped: 'api/test does not exist yet', results: {}, summary: { passed: 0, failed: 0 } }; });
    return;
  }
  if (!(await portOpen(8080))) {
    writeState(s => { s.tests = { ...(s.tests || { results: {} }), skipped: 'Firestore emulator is not running (start it with npm run dev)', checkedAt: new Date().toISOString() }; });
    return;
  }
  running = true;
  const pkg = JSON.parse(fs.readFileSync(abs('api/package.json'), 'utf8'));
  const [cmd, args] = pkg.scripts?.['test:tracker']
    ? ['npm', ['run', 'test:tracker', '--silent']]
    : ['node', ['--import', 'tsx', '--test', '--test-reporter=tap', 'test/**/*.test.ts']];
  const env = { ...process.env, RELAY_ENV: 'development', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199', GCLOUD_PROJECT: process.env.GCLOUD_PROJECT || 'demo-relay' };
  const started = Date.now();
  let output = '';
  await new Promise(resolve => {
    const child = spawn(cmd, args, { cwd: abs('api'), env, shell: process.platform === 'win32' });
    const timer = setTimeout(() => child.kill(), 5 * 60 * 1000);
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    child.on('close', () => { clearTimeout(timer); resolve(); });
  });
  const results = parseTap(output);
  const values = Object.values(results);
  writeState(s => {
    s.tests = { ranAt: new Date().toISOString(), reason, durationMs: Date.now() - started, results,
      summary: { passed: values.filter(v => v === 'pass').length, failed: values.filter(v => v === 'fail').length },
      outputTail: output.split(/\r?\n/).slice(-40).join('\n') };
  });
  running = false;
}

let debounce;
function scheduleTests(reason) { clearTimeout(debounce); debounce = setTimeout(() => runTests(reason), 6000); }
for (const target of ['api/src', 'api/test', 'firestore.rules', 'storage.rules']) {
  const full = abs(target);
  if (!fs.existsSync(full)) continue;
  try { fs.watch(full, { recursive: fs.statSync(full).isDirectory() }, () => scheduleTests(`${target} changed`)); } catch { /* watching is best-effort */ }
}
// api/test may not exist yet: notice when it appears.
setInterval(() => { if (fs.existsSync(abs('api/test')) && !readState().tests?.ranAt) scheduleTests('api/test appeared'); }, 15000);
// Re-run periodically so an emulator started later gets picked up.
setInterval(() => runTests('periodic'), 10 * 60 * 1000);

// ── HTTP ─────────────────────────────────────────────────────────────────
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const body = req => new Promise(resolve => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(HERE, 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await status());
    if (req.method === 'POST' && url.pathname === '/api/mark') {
      const { id, done } = await body(req);
      const task = tasks.find(x => x.id === id);
      if (!task || task.owner !== 'you') return json(res, 400, { error: 'Only your tasks can be marked by hand. Claude’s tasks are marked by their checks.' });
      writeState(s => { if (done) s.manual[id] = { done: true, at: new Date().toISOString() }; else delete s.manual[id]; });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const input = await body(req);
      writeState(s => { for (const k of ['stagingApiUrl', 'prodApiUrl']) if (typeof input[k] === 'string') s.settings[k] = input[k].trim(); });
      cache.clear();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/run-tests') { runTests('manual'); return json(res, 202, { ok: true }); }
    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 500, { error: String(e) }); }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Relay MVP tracker → http://localhost:${PORT}`);
  runTests('startup');
});
