import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Package, Plus, ShoppingBag } from 'lucide-react';
import { Link } from 'wouter';
import { apiFetch, currentBusinessId } from '@/lib/api';
import { readBusinessProfile } from '@/lib/business-profile';

type Store = { businessId: string; slug: string; published: boolean; name?: string; branding?: { logo?: string } };
type Product = { id: string; name: string; price: number; availability?: boolean; channels?: { web?: boolean } };
type Order = { id: string; customer?: { name?: string }; subtotal?: number; orderStatus?: string; createdAt?: string };

const money = (value: number) => `₦${value.toLocaleString('en-NG')}`;

export default function StoreOverview() {
  const businessId = currentBusinessId();
  const profile = readBusinessProfile();
  const [store, setStore] = useState<Store | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    async function load() {
      if (!businessId) { setLoading(false); return; }
      try {
        const storeResponse = await apiFetch(`/api/v1/businesses/${encodeURIComponent(businessId)}/storefront`);
        const storePayload = await storeResponse.json();
        if (!storeResponse.ok) throw new Error(storePayload?.error?.message || 'Could not load store.');
        const currentStore = storePayload.data?.storefront || null;
        const [productResponse, orderResponse] = await Promise.all([
          apiFetch(`/api/v1/businesses/${encodeURIComponent(businessId)}/products`),
          apiFetch(`/api/v1/businesses/${encodeURIComponent(businessId)}/orders`).catch(() => null),
        ]);
        if (!active) return;
        setStore(currentStore);
        setProducts(productResponse.ok ? ((await productResponse.json()).data || []) : []);
        setOrders(orderResponse?.ok ? ((await orderResponse.json()).data || []) : []);
      } catch (error) {
        if (active) setMessage(error instanceof Error ? error.message : 'Could not load store.');
      } finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [businessId]);

  const publicUrl = store ? `${window.location.origin}/store/${store.slug}` : '';
  const month = new Date();
  const monthOrders = orders.filter(order => order.createdAt && new Date(order.createdAt).getMonth() === month.getMonth());
  const revenue = monthOrders.reduce((sum, order) => sum + Number(order.subtotal || 0), 0);
  const copy = async () => { if (publicUrl) { await navigator.clipboard?.writeText(publicUrl); setMessage('Store link copied.'); } };

  if (loading) return <div className="h-full overflow-y-auto p-6 text-sm text-muted-foreground">Loading your store...</div>;
  if (!store) return <div className="h-full overflow-y-auto p-6"><div className="rounded-2xl border bg-card p-6"><h2 className="text-2xl font-extrabold">Create your store</h2><p className="mt-2 text-sm text-muted-foreground">{message || 'Complete setup to create a customer-facing storefront.'}</p><Link href="/ecommerce/storefront" className="mt-5 inline-flex rounded-xl bg-ink px-4 py-3 text-sm font-extrabold text-white">Open store setup</Link></div></div>;

  return <div className="h-full overflow-y-auto bg-surface-alt/30 p-4 pb-24 md:p-8"><div className="mx-auto max-w-7xl">
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-2xl font-extrabold">My Store</h2><p className="mt-1 text-sm text-muted-foreground">Manage your customer-facing storefront.</p></div><button onClick={() => window.open(publicUrl, '_blank', 'noopener,noreferrer')} className="inline-flex items-center gap-2 rounded-xl border bg-card px-4 py-2.5 text-sm font-extrabold"><ExternalLink size={16} /> Open store</button></div>
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-card p-5 md:px-6"><div><div className={`flex items-center gap-2 text-sm font-extrabold ${store.published ? 'text-green-700' : 'text-amber-700'}`}><span className={`h-2 w-2 rounded-full ${store.published ? 'bg-green-600' : 'bg-amber-500'}`} />{store.published ? 'Store is live' : 'Store is offline'}</div><p className="mt-2 break-all font-mono text-xs text-muted-foreground">{publicUrl}</p><button onClick={() => void copy()} className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-muted-foreground"><Copy size={14} /> Copy link</button></div><button onClick={() => window.open(publicUrl, '_blank', 'noopener,noreferrer')} className="rounded-xl bg-lime px-4 py-3 text-sm font-extrabold text-ink">{store.published ? 'Open store ↗' : 'Publish store'}</button></section>
    <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Store views" value="Coming soon" /><Stat label="Total orders" value={orders.length ? String(orders.length) : '—'} /><Stat label="Revenue this month" value={revenue ? money(revenue) : '—'} /><Stat label="Products listed" value={products.length ? String(products.length) : '—'} /></div>
    <div className="mt-5 flex flex-wrap gap-2"><Action href="/commerce/products/new" icon={<Plus size={15} />} label="Add product" /><Action href="/commerce/products" icon={<Package size={15} />} label="Manage products" /><Action href="/commerce/orders" icon={<ShoppingBag size={15} />} label="View orders" /><Action href="/commerce/templates" label="Change template" /></div>
    <section className="mt-5 rounded-2xl border bg-card p-5"><h3 className="font-extrabold">Store checklist</h3><div className="mt-4 grid gap-3 text-sm">{[['Store created', true], ['Store published', store.published], ['Logo uploaded', Boolean(store.branding?.logo || profile?.logo)], ['At least one product added', products.length > 0], ['Payment method connected (Paystack)', false]].map(([label, done]) => <div key={String(label)} className="flex items-center gap-3"><Check size={16} className={done ? 'text-green-600' : 'text-amber-500'} /><span className="flex-1">{label}</span>{!done && <Link href="/ecommerce/storefront" className="text-xs font-bold text-primary">Fix it →</Link>}</div>)}</div></section>
    {orders.length > 0 && <section className="mt-5 rounded-2xl border bg-card p-5"><div className="flex items-center justify-between"><h3 className="font-extrabold">Recent orders</h3><Link href="/commerce/orders" className="text-xs font-bold text-primary">View all →</Link></div><div className="mt-4 divide-y">{orders.slice(0, 5).map(order => <div key={order.id} className="flex items-center gap-3 py-3 text-sm"><span className="flex-1 font-bold">{order.customer?.name || 'Customer'}</span><span>{money(Number(order.subtotal || 0))}</span><span className="text-xs text-muted-foreground">{order.orderStatus || 'pending'}</span></div>)}</div></section>}
    {message && <p className="mt-4 text-sm font-bold text-green-700">{message}</p>}
  </div></div>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl border bg-card p-4"><p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-2 text-lg font-extrabold">{value}</p></div>; }
function Action({ href, label, icon }: { href: string; label: string; icon?: ReactNode }) { return <Link href={href} className="inline-flex items-center gap-1.5 rounded-xl border bg-card px-3 py-2 text-xs font-extrabold">{icon}{label}</Link>; }