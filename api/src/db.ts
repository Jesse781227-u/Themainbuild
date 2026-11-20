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
  ownerPhones: 'ownerPhones',           // id: owner E.164 → { businessIds[], activeBusinessId, businessId (= active) }
  channelAccounts: 'channelAccounts',   // id: `${channel}_${accountId}` → which business a number/IG account belongs to
  whatsappConnections: 'whatsappConnections',
  instagramConnections: 'instagramConnections',
  signupSessions: 'signupSessions',
  deletionRequests: 'deletionRequests',
  broadcasts: 'broadcasts',
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
  payLinks: 'payLinks',                 // simulated payment links (PAYMENTS_MODE=simulated)
  devMessages: 'devMessages',           // development only: replies captured in log mode for the /dev chat page
  inboundEvents: 'inboundEvents',
  deliveryZones: 'deliveryZones',
  deliveryBatches: 'deliveryBatches',
  supportTickets: 'supportTickets',     // CALL from an owner
  onboardingEvents: 'onboardingEvents', // step entered/completed, for drop-off analytics
  testReceipts: 'testReceipts',
  importPhotos: 'importPhotos',         // photos from an uploaded PDF, matched to products in the background         // TEST mode: pretend orders, never real ones
  statusPosts: 'statusPosts',
  customerSignals: 'customerSignals',   // Smart Reach: what customers viewed, asked about, carted, bought, replied to (ids only)
  campaigns: 'campaigns',               // Smart Reach: a message to a group, with its route plan
  sends: 'sends',                       // Smart Reach: one per customer per campaign; cost and results
  serviceUsage: 'serviceUsage',
  segments: 'segments',                 // Smart Reach: customer groups (built-in and the owner's)
  templateStatus: 'templateStatus',
  offerCodes: 'offerCodes',             // Smart Reach: personal single-use codes     // Smart Reach: each marketing template's approval, per shop         // free service messages sent per shop number per month
  wallets: 'wallets',                   // each shop's balance (Relay holds it until withdrawn)
  payouts: 'payouts',                   // withdrawals to the owner's bank account
  kyc: 'kyc',                           // bank details + BVN (encrypted), verified once before the first withdrawal           // Status posts Relay prepared for an owner: picture, caption, who to mention, results
} as const;
