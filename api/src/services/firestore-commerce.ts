import admin from 'firebase-admin';import {adminDb} from './firebase-admin';import type {Transaction} from 'firebase-admin/firestore';import type {Product,Category,Cart,Order} from './commerce-types';
export const col={products:adminDb.collection('products'),categories:adminDb.collection('categories'),carts:adminDb.collection('carts'),orders:adminDb.collection('orders'),payments:adminDb.collection('payments'),customers:adminDb.collection('customers'),inventory:adminDb.collection('inventory'),storefronts:adminDb.collection('storefronts')};
export const iso=()=>new Date().toISOString();
export async function createProduct(value:Product){const normalized={...value,lowStockThreshold:value.lowStockThreshold??5,channels:value.channels??{web:true,whatsapp:true}};await col.products.doc(value.id).set(normalized);await col.inventory.doc(value.id).set({productId:value.id,businessId:value.businessId,quantity:value.inventoryQty,lowStockThreshold:normalized.lowStockThreshold,adjustmentHistory:[]});return normalized}
export async function listProducts(businessId:string,availability?:string,categoryId?:string,channel?:'web'|'whatsapp'){let query=col.products.where('businessId','==',businessId).where('deletedAt','==',null);if(availability!==undefined)query=query.where('availability','==',availability==='true');if(categoryId)query=query.where('categoryId','==',categoryId);const snap=await query.get();return snap.docs.map(d=>d.data() as Product).filter(p=>!channel||p.channels?.[channel]!==false)}
export async function getProduct(id:string){const snap=await col.products.doc(id).get();return snap.exists?snap.data() as Product:null}
export async function updateProduct(id:string,value:Partial<Product>){await col.products.doc(id).update(value);return (await getProduct(id))!}
export async function deleteProduct(id:string){await col.products.doc(id).update({deletedAt:iso(),availability:false})}
export async function adjustInventory(id:string,delta:number,reason:string,actor:string){return adminDb.runTransaction(async tx=>{const productRef=col.products.doc(id);const invRef=col.inventory.doc(id);const [productSnap,invSnap]=await Promise.all([tx.get(productRef),tx.get(invRef)]);if(!productSnap.exists||!invSnap.exists)throw new Error('NOT_FOUND');const current=Number(invSnap.get('quantity')??productSnap.get('inventoryQty')??0);if(current+delta<0)throw new Error('INSUFFICIENT_STOCK');const timestamp=iso();const history={delta,reason,actor,timestamp};tx.update(invRef,{quantity:current+delta,adjustmentHistory:admin.firestore.FieldValue.arrayUnion(history)});tx.update(productRef,{inventoryQty:current+delta});return current+delta})}
export async function createCategory(value:Category){await col.categories.doc(value.id).set(value);return value}
export async function listCategories(businessId:string){const snap=await col.categories.where('businessId','==',businessId).get();return snap.docs.map(d=>d.data() as Category)}
export async function getCart(id:string){const snap=await col.carts.doc(id).get();return snap.exists?snap.data() as Cart:null}
export async function getOrder(id:string){const snap=await col.orders.doc(id).get();return snap.exists?snap.data() as Order:null}
export async function createCart(value:Cart){await col.carts.doc(value.id).set(value);return value}
export async function checkout(cart:Cart,customer:unknown|undefined,channel:'web'|'whatsapp'='web'){return adminDb.runTransaction(async(tx:Transaction)=>{let subtotal=0;const productRefs=cart.items.map(item=>col.products.doc(item.productId));const snaps=await Promise.all(productRefs.map(ref=>tx.get(ref)));for(let i=0;i<cart.items.length;i++){const product=snaps[i];const item=cart.items[i];if(!product?.exists||Number(product.get('inventoryQty')??0)<item.qty)throw new Error('INSUFFICIENT_STOCK');subtotal+=item.priceAtAdd*item.qty}for(let i=0;i<cart.items.length;i++){const item=cart.items[i];const ref=productRefs[i];const product=snaps[i];const timestamp=iso();tx.update(ref,{inventoryQty:Number(product!.get('inventoryQty'))-item.qty});tx.update(col.inventory.doc(item.productId),{quantity:admin.firestore.FieldValue.increment(-item.qty),adjustmentHistory:admin.firestore.FieldValue.arrayUnion({delta:-item.qty,reason:'order_created',actor:'system',timestamp})})}const order:Order={id:crypto.randomUUID(),businessId:cart.businessId,customer,channel,items:cart.items,subtotal,currency:'NGN',paymentStatus:'pending',deliveryStatus:'pending',orderStatus:'pending',createdAt:iso(),updatedAt:iso()};tx.set(col.orders.doc(order.id),order);tx.delete(col.carts.doc(cart.id));return order})}
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
  logo?:string;
  banner?:string;
  fulfillment?:string[];
  updatedAt?:string;
};
export async function getStorefront(slug:string){const snap=await col.storefronts.doc(slug).get();return snap.exists?snap.data() as StorefrontRecord:null}
export async function getStorefrontForBusiness(businessId:string){const snap=await col.storefronts.where('businessId','==',businessId).limit(1).get();return snap.empty?null:snap.docs[0].data() as StorefrontRecord}
