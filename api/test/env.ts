// Imported before anything in src/. Points the Admin SDK at the emulators under a demo project
// (so tests never touch real credentials or the dev project's emulator data) and sets the values
// dotenv must not override from api/.env.
export const projectId = 'demo-relay';
process.env.RELAY_ENV = 'development';
process.env.GCLOUD_PROJECT = projectId;
process.env.FIREBASE_ADMIN_PROJECT_ID = projectId;
process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE = '';
delete process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
delete process.env.FIREBASE_ADMIN_PRIVATE_KEY;
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9199';
process.env.RATE_LIMIT_MAX = '100000';
process.env.N8N_WEBHOOK_SECRET ??= '';
