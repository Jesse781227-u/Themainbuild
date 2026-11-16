import { getConfig } from './config';
import { Firestore } from './lib/firestore';
import { tokenProvider } from './lib/google-auth';

// One client per isolate (and per env object, so tests with different envs stay separate).
const clients = new WeakMap<object, Firestore>();

export function getDb(env: Record<string, unknown>): Firestore {
  let db = clients.get(env);
  if (db) return db;
  const cfg = getConfig(env);
  if (cfg.FIRESTORE_EMULATOR_HOST) {
    db = new Firestore({ projectId: cfg.FIREBASE_PROJECT_ID ?? 'demo-relay', emulatorHost: cfg.FIRESTORE_EMULATOR_HOST });
  } else {
    if (!cfg.FIREBASE_PROJECT_ID || !cfg.FIREBASE_CLIENT_EMAIL || !cfg.FIREBASE_PRIVATE_KEY) throw new Error('Firestore is not configured: set FIRESTORE_EMULATOR_HOST or the Firebase service-account secrets.');
    const credentials = { clientEmail: cfg.FIREBASE_CLIENT_EMAIL, privateKey: cfg.FIREBASE_PRIVATE_KEY };
    db = new Firestore({ projectId: cfg.FIREBASE_PROJECT_ID, credentials, getToken: tokenProvider(credentials) });
  }
  clients.set(env, db);
  return db;
}

// Collection names in one place. All collections are flat and every document carries businessId.
export const C = {
  businesses: 'businesses',
  ownerPhones: 'ownerPhones',           // id: owner E.164 → { businessId }
  channelAccounts: 'channelAccounts',   // id: `${channel}_${accountId}` → which business a number/IG account belongs to
  whatsappConnections: 'whatsappConnections',
  customers: 'customers',
  conversations: 'conversations',
  products: 'products',
  categories: 'categories',
  stockMovements: 'stockMovements',
  carts: 'carts',
  orders: 'orders',
  amountClaims: 'amountClaims',
  payments: 'payments',
  ledger: 'ledger',
  dailyStats: 'dailyStats',
  outbox: 'outbox',
  inboundEvents: 'inboundEvents',
  deliveryZones: 'deliveryZones',
  deliveryBatches: 'deliveryBatches',
} as const;
