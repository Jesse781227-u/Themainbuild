import admin from 'firebase-admin';import {adminDb} from './firebase-admin';import type {Transaction} from 'firebase-admin/firestore';import type {Product,Category,Cart,Order} from './commerce-types';
export const col={products:adminDb.collection('products'),categories:adminDb.collection('categories'),carts:adminDb.collection('carts'),orders:adminDb.collection('orders'),payments:adminDb.collection('payments'),customers:adminDb.collection('customers'),inventory:adminDb.collection('inventory'),storefronts:adminDb.collection('storefronts')};
export const iso=()=>new Date().toISOString();
export async function createProduct(value:Product){const normalized={...value,lowStockThreshold:value.lowStockThreshold??5,channels:value.channels??{web:true,whatsapp:true}};return adminDb.runTransaction(async tx=>{const existing=await tx.get(col.products.doc(value.id));if(existing.exists&&existing.get('businessId')!==value.businessId)throw new Error('PRODUCT_ID_TAKEN');tx.set(col.products.doc(value.id),normalized);tx.set(col.inventory.doc(value.id),{productId:value.id,businessId:value.businessId,quantity:value.inventoryQty,lowStockThreshold:normalized.lowStockThreshold,adjustmentHistory:[]});return normalized})}
export async function listProducts(businessId:string,availability?:string,categoryId?:string,channel?:'web'|'whatsapp'){const snap=await col.products.where('businessId','==',businessId).get();return snap.docs.map(d=>d.data() as Product).filter(p=>!p.deletedAt&&(availability===undefined||p.availability===(availability==='true'))&&(!categoryId||p.categoryId===categoryId)&&(!channel||p.channels?.[channel]!==false))}
export async function listOrders(businessId:string){const snap=await col.orders.where('businessId','==',businessId).get();return snap.docs.map(d=>d.data() as Order).sort((a,b)=>new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime())}
export async function getProduct(id:string){const snap=await col.products.doc(id).get();return snap.exists?snap.data() as Product:null}
export async function updateProduct(id:string,value:Partial<Product>){await col.products.doc(id).update(value);return (await getProduct(id))!}
export async function deleteProduct(id:string){await col.products.doc(id).update({deletedAt:iso(),availability:false})}
export async function adjustInventory(id:string,businessId:string,delta:number,reason:string,actor:string){return adminDb.runTransaction(async tx=>{const productRef=col.products.doc(id);const invRef=col.inventory.doc(id);const [productSnap,invSnap]=await Promise.all([tx.get(productRef),tx.get(invRef)]);if(!productSnap.exists||!invSnap.exists||productSnap.get('businessId')!==businessId)throw new Error('NOT_FOUND');const current=Number(invSnap.get('quantity')??productSnap.get('inventoryQty')??0);if(current+delta<0)throw new Error('INSUFFICIENT_STOCK');const timestamp=iso();const history={delta,reason,actor,timestamp};tx.update(invRef,{quantity:current+delta,adjustmentHistory:admin.firestore.FieldValue.arrayUnion(history)});tx.update(productRef,{inventoryQty:current+delta});return current+delta})}
export async function createCategory(value:Category){await col.categories.doc(value.id).set(value);return value}
export async function listCategories(businessId:string){const snap=await col.categories.where('businessId','==',businessId).get();return snap.docs.map(d=>d.data() as Category)}
export async function getCart(id:string){const snap=await col.carts.doc(id).get();return snap.exists?snap.data() as Cart:null}
export async function getOrder(id:string){const snap=await col.orders.doc(id).get();return snap.exists?snap.data() as Order:null}
export async function createCart(value:Cart){await col.carts.doc(value.id).set(value);return value}
export const mergeCartLines=(items:{productId:string;qty:number}[])=>{const qty=new Map<string,number>();for(const item of items)qty.set(item.productId,(qty.get(item.productId)??0)+item.qty);return qty};
// The cart is re-read inside the transaction so it can only be checked out once. Lines for the same product
// are merged before the stock check, and each line snapshots the product name and the price charged.
export async function checkout(cart:Cart,customer:unknown|undefined,channel:'web'|'whatsapp'='web'){return adminDb.runTransaction(async(tx:Transaction)=>{const cartSnap=await tx.get(col.carts.doc(cart.id));if(!cartSnap.exists)throw new Error('CART_NOT_FOUND');const current=cartSnap.data() as Cart;if(!(new Date(current.expiresAt).getTime()>Date.now()))throw new Error('CART_EXPIRED');const qty=mergeCartLines(current.items);const ids=[...qty.keys()];if(!ids.length)throw new Error('CART_EMPTY');const productRefs=ids.map(id=>col.products.doc(id));const snaps=await Promise.all(productRefs.map(ref=>tx.get(ref)));let subtotal=0;const items:Order['items']=[];for(let i=0;i<ids.length;i++){const product=snaps[i];const wanted=qty.get(ids[i])!;if(!product.exists||product.get('businessId')!==current.businessId||product.get('deletedAt')||product.get('availability')===false||product.get(`channels.${channel}`)===false)throw new Error('PRODUCT_UNAVAILABLE');if(Number(product.get('inventoryQty')??0)<wanted)throw new Error('INSUFFICIENT_STOCK');const price=Number(product.get('price')??0);items.push({productId:ids[i],qty:wanted,priceAtAdd:price,price,name:String(product.get('name')??'')});subtotal+=price*wanted}const timestamp=iso();for(let i=0;i<ids.length;i++){const wanted=qty.get(ids[i])!;tx.update(productRefs[i],{inventoryQty:Number(snaps[i].get('inventoryQty'))-wanted});tx.update(col.inventory.doc(ids[i]),{quantity:admin.firestore.FieldValue.increment(-wanted),adjustmentHistory:admin.firestore.FieldValue.arrayUnion({delta:-wanted,reason:'order_created',actor:'system',timestamp})})}const order:Order={id:crypto.randomUUID(),businessId:current.businessId,...(customer!==undefined?{customer}:{}),channel,items,subtotal,currency:'NGN',paymentStatus:'pending',deliveryStatus:'pending',orderStatus:'pending',createdAt:timestamp,updatedAt:timestamp};tx.set(col.orders.doc(order.id),order);tx.delete(col.carts.doc(cart.id));return order})}
export type StorefrontRecord={
  businessId:string;
  slug:string;
  published:boolean;
  template?:string;
  templateId?:string;
  name?:string;
  headline?:string;
  description?:string;
  branding?:{logo?:string;banner?:string;primaryColor?:string;accentColor?:string};
  socialLinks?:{instagram?:string;facebook?:string;tiktok?:string;x?:string;youtube?:string;telegram?:string};
  logo?:string;
  banner?:string;
  fulfillment?:string[];
  pages?:{about?:boolean;contact?:boolean;policies?:boolean};
  navigation?:Array<'home'|'shop'|'about'|'contact'|'policies'>;
  contactEmail?:string;
  contactPhone?:string;
  policies?:string;
  updatedAt?:string;
};
export async function getStorefront(slug:string){const snap=await col.storefronts.doc(slug).get();return snap.exists?snap.data() as StorefrontRecord:null}
// Writes a storefront under its slug, refusing slugs another business already owns. When renaming,
// the old slug document is removed in the same transaction.
export async function claimStorefront(slug:string,value:Partial<StorefrontRecord>&{businessId:string},previousSlug?:string){return adminDb.runTransaction(async tx=>{const existing=await tx.get(col.storefronts.doc(slug));if(existing.exists&&existing.get('businessId')!==value.businessId)throw new Error('SLUG_TAKEN');tx.set(col.storefronts.doc(slug),value,{merge:true});if(previousSlug&&previousSlug!==slug)tx.delete(col.storefronts.doc(previousSlug));return value})}
export async function getStorefrontForBusiness(businessId:string){const snap=await col.storefronts.where('businessId','==',businessId).limit(1).get();return snap.empty?null:snap.docs[0].data() as StorefrontRecord}
