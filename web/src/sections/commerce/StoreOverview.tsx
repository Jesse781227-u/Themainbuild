import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, ExternalLink, Package, Plus, ShoppingBag } from 'lucide-react';
import { Link } from 'wouter';
import { apiFetch, currentBusinessId } from '@/lib/api';
import { readBusinessProfile } from '@/lib/business-profile';

type Store = {
  businessId: string;
  slug: string;
  published: boolean;
  name?: string;
  branding?: { logo?: string };
};
type Product = {
  id: string;
  name: string;
  price: number;
  availability?: boolean;
  channels?: { web?: boolean };
};
type Order = {
  id: string;
  customer?: { name?: string } | string;
  items?: { productId: string; qty: number }[];
  subtotal?: number;
  orderStatus?: string;
  createdAt?: string;
};

const money = (value: number) => `₦${value.toLocaleString('en-NG')}`;

function isInCurrentMonth(value?: string) {
  if (!value) return false;
  const date = new Date(value);
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

function customerName(customer: Order['customer']) {
  if (typeof customer === 'string') return customer;
  return customer?.name || 'Customer';
}

export default function StoreOverview() {
  const businessId = currentBusinessId();
  const profile = readBusinessProfile();
  const [store, setStore] = useState<Store | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    async function load() {
      if (!businessId) {
        setLoading(false);
        return;
      }
      try {
        const response = await apiFetch(`/api/v1/businesses/${encodeURIComponent(businessId)}/storefront/overview`);
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error?.message || 'Could not load store.');
        if (!active) return;
        setStore(payload.data?.storefront || null);
        setProducts(payload.data?.products || []);
        setOrders(payload.data?.orders || []);
      } catch (error) {
        if (active) setMessage(error instanceof Error ? error.message : 'Could not load store.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [businessId]);

  const publicUrl = store ? `${window.location.origin}/store/${store.slug}` : '';
  const monthRevenue = orders
    .filter(order => isInCurrentMonth(order.createdAt) && order.orderStatus === 'completed')
    .reduce((sum, order) => sum + Number(order.subtotal || 0), 0);
  const productById = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const topProducts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const order of orders) {
      for (const item of order.items || []) counts.set(item.productId, (counts.get(item.productId) || 0) + Number(item.qty || 0));
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, count]) => ({ product: productById.get(id), count }))
      .filter(item => item.product);
  }, [orders, productById]);

  const openStore = () => {
    if (publicUrl) window.open(publicUrl, '_blank', 'noopener,noreferrer');
  };
  const publishStore = async () => {
    if (!store || !businessId) return;
    setSaving(true);
    setMessage('');
    try {
      const response = await apiFetch(`/api/v1/businesses/${encodeURIComponent(businessId)}/storefront`, {
        method: 'PATCH',
        body: JSON.stringify({ published: true }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || 'Store could not be published.');
      setStore(current => current ? { ...current, published: true } : current);
      setMessage('Store published.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Store could not be published.');
    } finally {
      setSaving(false);
    }
  };
  const copy = async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setMessage('Store link copied.');
    } catch {
      setMessage('Copy failed. Select the store URL to copy it.');
    }
  };

  if (loading) return <div className="h-full overflow-y-auto p-6 text-sm text-muted-foreground">Loading your store...</div>;
  if (!store) return <div className="h-full overflow-y-auto p-6"><div className="rounded-2xl border bg-card p-6"><h2 className="text-2xl font-extrabold">Create your store</h2><p className="mt-2 text-sm text-muted-foreground">{message || 'Complete setup to create a customer-facing storefront.'}</p><Link href="/ecommerce/storefront" className="mt-5 inline-flex rounded-xl bg-ink px-4 py-3 text-sm font-extrabold text-white">Open store setup</Link></div></div>;

  return <div className="h-full overflow-y-auto bg-surface-alt/30 p-4 pb-24 md:p-8"><div className="mx-auto max-w-7xl">
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-2xl font-extrabold">My Store</h2><p className="mt-1 text-sm text-muted-foreground">Manage your customer-facing storefront.</p></div><button onClick={openStore} className="inline-flex items-center gap-2 rounded-xl border bg-card px-4 py-2.5 text-sm font-extrabold"><ExternalLink size={16} /> Open store ↗</button></div>
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-card p-5 md:px-6"><div><div className={`flex items-center gap-2 text-sm font-extrabold ${store.published ? 'text-green-700' : 'text-amber-700'}`}><span className={`h-2 w-2 rounded-full ${store.published ? 'bg-green-600' : 'bg-amber-500'}`} />{store.published ? 'Store is live' : 'Store is offline'}</div><p className="mt-2 break-all font-mono text-xs text-muted-foreground">{publicUrl}</p><button onClick={() => void copy()} className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-muted-foreground"><Copy size={14} /> Copy link</button></div>{store.published ? <button onClick={openStore} className="rounded-xl bg-lime px-4 py-3 text-sm font-extrabold text-ink">Open store ↗</button> : <button onClick={() => void publishStore()} disabled={saving} className="rounded-xl bg-lime px-4 py-3 text-sm font-extrabold text-ink disabled:opacity-50">{saving ? 'Publishing…' : 'Publish store'}</button>}</section>
    <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Store views" value="Coming soon" /><Stat label="Total orders" value={orders.length ? String(orders.length) : '—'} /><Stat label="Revenue this month" value={monthRevenue ? money(monthRevenue) : '—'} /><Stat label="Products listed" value={products.length ? String(products.length) : '—'} /></div>
    <div className="mt-5 flex flex-wrap gap-2"><Action href="/commerce/products/new" icon={<Plus size={15} />} label="Add product" /><Action href="/commerce/products" icon={<Package size={15} />} label="Manage products" /><Action href="/commerce/orders" icon={<ShoppingBag size={15} />} label="View orders" /><Action href="/ecommerce/storefront" label="Change template" /></div>
    <section className="mt-5 rounded-2xl border bg-card p-5"><h3 className="font-extrabold">Store checklist</h3><div className="mt-4 grid gap-3 text-sm">{[['Store created', true], ['Store published', store.published], ['Logo uploaded', Boolean(store.branding?.logo || profile?.logo)], ['At least one product added', products.length > 0], ['Payment method connected (Paystack)', false]].map(([label, done]) => <div key={String(label)} className="flex items-center gap-3"><Check size={16} className={done ? 'text-green-600' : 'text-amber-500'} /><span className="flex-1">{label}</span>{!done && <Link href={label === 'At least one product added' ? '/commerce/products/new' : '/ecommerce/storefront'} className="text-xs font-bold text-primary">{label === 'Payment method connected (Paystack)' ? 'Connect →' : 'Fix it →'}</Link>}</div>)}</div></section>
    {orders.length > 0 && <section className="mt-5 rounded-2xl border bg-card p-5"><div className="flex items-center justify-between"><h3 className="font-extrabold">Recent orders</h3><Link href="/commerce/orders" className="text-xs font-bold text-primary">View all →</Link></div><div className="mt-4 divide-y"><div className="grid grid-cols-[1fr_auto_auto] gap-3 pb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground"><span>Customer</span><span>Amount</span><span>Status</span></div>{orders.slice(0, 5).map(order => <div key={order.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 py-3 text-sm"><span className="truncate font-bold">{customerName(order.customer)}</span><span>{money(Number(order.subtotal || 0))}</span><span className="text-xs text-muted-foreground">{order.orderStatus || 'pending'}</span></div>)}</div></section>}
    {products.length > 0 && <section className="mt-5 rounded-2xl border bg-card p-5"><div className="flex items-center justify-between"><h3 className="font-extrabold">Top products</h3><Link href="/commerce/products" className="text-xs font-bold text-primary">View all →</Link></div>{topProducts.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">Add products to your store to start selling.</p> : <div className="mt-4 divide-y">{topProducts.map(({ product, count }) => <div key={product!.id} className="flex items-center gap-3 py-3 text-sm"><span className="flex-1 font-bold">{product!.name}</span><span className="text-muted-foreground">{count} sold</span></div>)}</div>}</section>}
    {message && <p className="mt-4 text-sm font-bold text-green-700">{message}</p>}
  </div></div>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl border bg-card p-4"><p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-2 text-lg font-extrabold">{value}</p></div>; }
function Action({ href, label, icon }: { href: string; label: string; icon?: ReactNode }) { return <Link href={href} className="inline-flex items-center gap-1.5 rounded-xl border bg-card px-3 py-2 text-xs font-extrabold">{icon}{label}</Link>; }