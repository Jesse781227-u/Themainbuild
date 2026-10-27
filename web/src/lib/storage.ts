import { connectStorageEmulator, getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage';
import { app } from './firebase';
import { currentBusinessId } from './api';
import { compressImage } from './image';

const storage=app?getStorage(app):null;
if(storage&&import.meta.env.VITE_USE_FIREBASE_EMULATORS==='true')connectStorageEmulator(storage,'127.0.0.1',9199);

// Product images live in Firebase Storage under the business; Firestore only keeps the download URL.
export async function uploadProductImage(file:File){
  if(!storage)throw new Error('Firebase Storage is not configured.');
  const businessId=currentBusinessId();
  if(!businessId)throw new Error('Finish setting up your business before adding images.');
  const blob=await compressImage(file);
  const extension=blob.type==='image/webp'?'webp':file.name.split('.').pop()||'img';
  const target=ref(storage,`businesses/${businessId}/products/${crypto.randomUUID()}.${extension}`);
  await uploadBytes(target,blob,{contentType:blob.type||file.type,cacheControl:'public,max-age=31536000,immutable'});
  return getDownloadURL(target);
}
