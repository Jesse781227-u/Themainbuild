// Seeds a demo merchant into the local Firestore emulator so the Shop Bot can be tried with
// scripts/simulate-webhook.ts. Development only: refuses to run without FIRESTORE_EMULATOR_HOST.
//
//   npx tsx scripts/seed-local.ts
//   npx tsx scripts/simulate-webhook.ts shop --url http://127.0.0.1:8787 --to pn-demo --from 2348090000001 "hi"
//
// The owner is +2348030000009, so Admin Bot commands for this shop use --from 2348030000009.
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/db';
import { encrypt } from '../src/lib/crypto';

const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const devVars = Object.fromEntries(
  (fs.existsSync(path.join(__dirname, '..', '.dev.vars')) ? fs.readFileSync(path.join(__dirname, '..', '.dev.vars'), 'utf8') : '')
    .split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const env = { RELAY_ENV: 'development', FIREBASE_PROJECT_ID: 'demo-relay', FIRESTORE_EMULATOR_HOST: host, TOKEN_ENCRYPTION_KEY: devVars.TOKEN_ENCRYPTION_KEY ?? '' };

const BIZ = 'biz-demo';
const PNID = 'pn-demo';
const OWNER = '+2348030000009';
const now = () => new Date().toISOString();

async function main() {
  const db = getDb(env);
  const batch = db.batch();
  batch.set(db.doc('businesses', BIZ), { id: BIZ, name: 'Mama Put Kitchen', category: 'food', ownerPhone: OWNER, status: 'active', timezone: 'Africa/Lagos', bachsAccountId: null, createdAt: now(), updatedAt: now() });
  batch.set(db.doc('ownerPhones', OWNER), { businessId: BIZ });
  batch.set(db.doc('channelAccounts', `whatsapp_${PNID}`), { id: `whatsapp_${PNID}`, businessId: BIZ, channel: 'whatsapp', accountId: PNID });
  batch.set(db.doc('whatsappConnections', BIZ), { businessId: BIZ, status: 'connected', phoneNumberId: PNID, wabaId: 'waba-demo', accessTokenEncrypted: encrypt('local-log-mode-placeholder', env as never), createdAt: now(), updatedAt: now() });
  const products = [
    { id: 'demo-jollof', name: 'Jollof rice', priceKobo: 250_000, stock: 20 },
    { id: 'demo-chicken', name: 'Fried chicken', priceKobo: 180_000, stock: 15 },
    { id: 'demo-zobo', name: 'Zobo (50cl)', priceKobo: 50_000, stock: 40 },
  ];
  for (const p of products) {
    batch.set(db.doc('products', p.id), { ...p, businessId: BIZ, description: '', images: [], categoryId: null, available: true, lowStockThreshold: 3, createdAt: now(), updatedAt: now(), deletedAt: null });
  }
  await batch.commit();
  console.log(`Seeded "Mama Put Kitchen" (${BIZ}) on ${host}: phone_number_id ${PNID}, owner ${OWNER}, ${products.length} products.`);
}

main().catch(e => { console.error(e); process.exit(1); });
