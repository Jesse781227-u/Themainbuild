// Seeds a demo merchant into the local Firestore emulator so the Shop Bot can be tried with
// scripts/simulate-webhook.ts or the /dev chat page. Development only.
//
//   npx tsx scripts/seed-local.ts
//   npx tsx scripts/simulate-webhook.ts shop --url http://127.0.0.1:8787 --to pn-demo --from 2348090000001 "hi"
//
// The owner is +2348030000009, so Admin Bot commands for this shop use --from 2348030000009.
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/db';
import { seedDemoShop } from '../src/dev/seed';

const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const file = path.join(__dirname, '..', '.dev.vars');
const devVars = Object.fromEntries(
  (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const env = { RELAY_ENV: 'development' as const, FIREBASE_PROJECT_ID: 'demo-relay', FIRESTORE_EMULATOR_HOST: host, TOKEN_ENCRYPTION_KEY: devVars.TOKEN_ENCRYPTION_KEY || undefined };

seedDemoShop(getDb(env), env)
  .then(s => console.log(`Seeded "${s.name}" (${s.businessId}) on ${host}: phone_number_id ${s.phoneNumberId}, owner ${s.owner}, ${s.products} products.`))
  .catch(e => { console.error(e); process.exit(1); });
