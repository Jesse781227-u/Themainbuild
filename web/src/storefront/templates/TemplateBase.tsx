import type { ReactNode } from 'react';
import type { TemplateHomeData } from '@/storefront/template-library';
import type { StorefrontProduct } from '@/components/storefront/StorefrontRenderer';

export function Shell({ data, children, className = '' }: { data: TemplateHomeData; children: ReactNode; className?: string }) {
  const { theme, businessName, headline, description, onShop } = data;
  return <main className={`mx-auto max-w-6xl px-5 py-8 sm:py-12 ${className}`} style={{ color: theme.colors.ink }}>
    <header className="mb-8 flex items-end justify-between gap-4">
      <div><p className="text-xs font-bold uppercase tracking-[.18em] opacity-60">{theme.name}</p><h1 className="mt-2 text-4xl font-extrabold" style={{ fontFamily: theme.fonts.heading }}>{headline || businessName}</h1>{description && <p className="mt-3 max-w-2xl leading-7 opacity-70">{description}</p>}</div>
      <button onClick={onShop} className="shrink-0 px-4 py-2 text-sm font-bold" style={{ background: theme.colors.accent, color: theme.colors.accentInk, borderRadius: theme.radius.button }}>Shop</button>
    </header>{children}
  </main>;
}

export function ProductTile({ product, data, portrait = false, dark = false }: { product: StorefrontProduct; data: TemplateHomeData; portrait?: boolean; dark?: boolean }) {
  const image = product.images?.[0] || product.image;
  return <button onClick={() => data.onProduct(product)} className="group overflow-hidden text-left" style={{ background: dark ? data.theme.colors.surface : data.theme.colors.surface, borderRadius: data.theme.radius.card }}>
    <div className={`relative overflow-hidden ${portrait ? 'aspect-[3/4]' : 'aspect-square'}`} style={{ background: data.theme.colors.accent }}>{image && <img src={image} alt={product.name} className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />}<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 p-3 text-white"><p className="font-bold">{product.name}</p><p className="mt-1 text-sm">₦{Number(product.price).toLocaleString('en-NG')}</p></div></div>
  </button>;
}

export function CategoryTabs({ data }: { data: TemplateHomeData }) {
  return data.categories.length > 0 ? <div className="mb-6 flex gap-2 overflow-x-auto pb-1">{data.categories.map(category => <button key={category} onClick={() => data.onCategory(category)} className="shrink-0 border px-3 py-2 text-xs font-bold" style={{ borderColor: data.theme.colors.border, borderRadius: data.theme.radius.button }}>{category}</button>)}</div> : null;
}
