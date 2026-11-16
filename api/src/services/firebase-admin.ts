import admin from 'firebase-admin';import fs from 'node:fs';import path from 'node:path';
if(!admin.apps.length){
  const projectId=process.env.FIREBASE_ADMIN_PROJECT_ID||process.env.GCLOUD_PROJECT;
  const serviceAccountPath=process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_FILE;
  const serviceAccount=serviceAccountPath?JSON.parse(fs.readFileSync(path.resolve(process.cwd(),serviceAccountPath),'utf8')):null;
  const clientEmail=serviceAccount?.client_email||process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey=serviceAccount?.private_key||process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g,'\n');
  if(projectId&&clientEmail&&privateKey)admin.initializeApp({credential:admin.credential.cert({projectId,clientEmail,privateKey})});
  else admin.initializeApp({projectId});
}
export const adminDb=admin.firestore();
