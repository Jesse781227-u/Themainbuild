import { Search, ShoppingBag } from 'lucide-react';
import { formatStorefrontPrice, type StorefrontProduct } from '@/components/storefront/StorefrontRenderer';
import type { TemplateHomeData } from '@/storefront/template-library';
import { SocialLinks } from './DistinctTemplateHomes';

const runwayHero = 'https://images.pexels.com/photos/1536619/pexels-photo-1536619.jpeg?auto=compress&cs=tinysrgb&w=1600';

function runwayPrice(product: StorefrontProduct) {
  return formatStorefrontPrice(product.price, product.currency);
}

function RunwayProduct({ product, onOpen }: { product: StorefrontProduct; onOpen: () => void }) {
  const image = product.images?.[0] || product.image;

  return <button type="button" onClick={onOpen} className="group block w-full text-left">
    <div className="aspect-[3/4] overflow-hidden bg-[#e5e5e5]">
      {image && <img src={image} alt={product.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.025]"/>}
    </div>
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <h3 className="font-[var(--runway-heading)] text-xl uppercase leading-tight">{product.name}</h3>
        {product.category && <p className="mt-1 text-xs text-[#666]">{product.category}</p>}
      </div>
      <span className="shrink-0 text-sm font-bold">{runwayPrice(product)}</span>
    </div>
  </button>;
}

export default function RunwayTemplate(data: TemplateHomeData) {
  const { theme, businessName, headline, description, banner, categories, products, onCategory, onProduct, onShop } = data;
  const heroImage = banner || runwayHero;

  return <main data-template={theme.id} className="template-home-root min-h-full bg-[#f2f2f2] text-black" style={{
    '--runway-heading': theme.fonts.heading,
    '--runway-ink': theme.colors.ink,
    '--runway-accent': theme.colors.accent,
    fontFamily: theme.fonts.body,
  } as React.CSSProperties}>
    <header className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-5 py-5 sm:px-8">
      <button type="button" onClick={onShop} className="min-w-0 text-left">
        <span className="flex items-center gap-2">{data.logo && <img src={data.logo} alt="" className="h-8 w-8 object-cover"/>}<span className="block truncate font-[var(--runway-heading)] text-2xl uppercase leading-none">{businessName}</span></span>
        <span className="mt-1 block text-[11px] text-[#666]">{theme.tagline}</span>
      </button>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={onShop} aria-label="Search products" className="grid size-10 place-items-center border border-[#e5e5e5] bg-white"><Search size={18}/></button>
        <button type="button" onClick={data.onCart || onShop} aria-label="Open shopping bag" className="relative grid size-10 place-items-center border border-[#e5e5e5] bg-white"><ShoppingBag size={18}/>{data.cartCount ? <span className="absolute -right-2 -top-2 bg-black px-1.5 py-0.5 text-[10px] text-white">{data.cartCount}</span> : null}</button>
      </div>
    </header>

    <section className="relative mx-auto h-[380px] max-w-[1200px] overflow-hidden sm:h-[460px]">
      <img src={heroImage} alt="" className="absolute inset-0 h-full w-full object-cover"/>
      <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/65 via-black/10 to-transparent p-6 text-white sm:p-10">
        <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em]">{theme.name}</p>
        <h1 className="max-w-4xl font-[var(--runway-heading)] text-5xl uppercase leading-[0.9] sm:text-7xl">{headline || businessName}</h1>
        {description && <p className="mt-3 max-w-xl text-sm text-white/85 sm:text-base">{description}</p>}
        <button type="button" onClick={onShop} className="mt-5 w-fit bg-black px-6 py-3 text-xs font-bold uppercase tracking-[0.12em] text-white transition-colors hover:bg-[var(--runway-accent)]">Shop collection</button>
      </div>
    </section>

    <div className="mx-auto max-w-[1200px]">
      <nav aria-label="Product categories" className="flex gap-2 overflow-x-auto px-5 py-4 sm:px-8">
        <button type="button" onClick={() => onCategory('')} className="shrink-0 border border-black bg-black px-4 py-2 text-xs font-medium text-white">All</button>
        {categories.map(category => <button key={category} type="button" onClick={() => onCategory(category)} className="shrink-0 border border-[#e5e5e5] bg-white px-4 py-2 text-xs font-medium hover:border-black">{category}</button>)}
      </nav>

      <section className="px-5 pb-12 sm:px-8 sm:pb-16">
        <div className="flex items-baseline justify-between border-b border-[#d9d9d9] pb-2">
          <h2 className="font-[var(--runway-heading)] text-3xl uppercase">Featured</h2>
          <button type="button" onClick={onShop} className="text-xs text-[#666] underline underline-offset-4">See all</button>
        </div>
        {products.length === 0 ? <p className="py-12 text-center text-sm text-[#666]">Products will appear here soon.</p> : <div className="mt-5 grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {products.slice(0, 6).map(product => <RunwayProduct key={product.id} product={product} onOpen={() => onProduct(product)}/>)}
        </div>}
      </section>

    </div>
    <SocialLinks data={data}/>
  </main>;
}
