import type {ReactNode} from 'react';
import type {StorefrontProduct} from '@/components/storefront/StorefrontRenderer';
import type {StorefrontCategory,StorefrontTheme} from './themes';
import RunwayTemplate from './templates/RunwayTemplate';
import {
  BlossomTemplate,
  BoldShelfTemplate,
  CleanBrightTemplate,
  ConciergeTemplate,
  CornerBistroTemplate,
  FreshMenuTemplate,
  GlowStudioTemplate,
  HorizonTemplate,
  KitchenTableTemplate,
  MarketplaceTemplate,
  NightMarketTemplate,
  SignatureTemplate,
  SoftPetalsTemplate,
  StudioTemplate,
  SunsetTemplate,
  UrbanRackTemplate,
  VelvetTemplate,
  WarehouseTemplate,
  WorkshopTemplate,
} from './templates/DistinctTemplateHomes';

export type TemplateHomeData={
  theme:StorefrontTheme;
  businessName:string;
  headline:string;
  description:string;
  logo?:string;
  cartCount?:number;
  banner?:string;
  categories:string[];
  products:StorefrontProduct[];
  onCategory:(category:string)=>void;
  onProduct:(product:StorefrontProduct)=>void;
  onShop:()=>void;
  onCart?:()=>void;
  socialLinks?:Record<string,string>;
  contactEmail?:string;
  contactPhone?:string;
};

type TemplateComponent=(data:TemplateHomeData)=>ReactNode;

function TemplateHome({theme,businessName,headline,description,banner,categories,products,onCategory,onProduct,onShop}:TemplateHomeData){
  const editorial=['edge-to-edge-photo','minimal-luxury','oversized-bold'].includes(theme.hero);
  const dark=['dark-glow','dark-gold'].includes(theme.hero);
  const columns=theme.grid===3?'grid-cols-2 sm:grid-cols-3':theme.grid===1?'grid-cols-1 sm:grid-cols-2':'grid-cols-2';
  return <div className="template-home">
    <section className={`relative mx-auto max-w-6xl overflow-hidden px-5 pb-10 ${editorial?'pt-0':'pt-10 sm:pt-16'}`}>
      <div className={`relative flex min-h-[16rem] flex-col justify-end overflow-hidden p-6 sm:min-h-[22rem] sm:p-10 ${editorial?'sm:min-h-[30rem]':''}`} style={{background:dark?`linear-gradient(135deg,${theme.colors.surface},${theme.colors.bg})`:theme.colors.surface,borderRadius:theme.radius.card}}>
        {banner&&theme.hero.includes('photo')?<img src={banner} alt="" className="absolute inset-0 h-full w-full object-cover"/>:null}
        <div className={banner&&theme.hero.includes('photo')?'relative text-white drop-shadow-lg':''}>
          <h1 className="mt-3 max-w-3xl text-4xl font-extrabold leading-tight sm:text-6xl" style={{fontFamily:theme.fonts.heading}}>{headline||businessName}</h1>
          {description&&<p className="mt-4 max-w-2xl leading-7 opacity-75">{description}</p>}
          <button onClick={onShop} className="mt-6 px-5 py-3 text-sm font-extrabold" style={{background:theme.colors.accent,color:theme.colors.accentInk,borderRadius:theme.radius.button}}>Shop now</button>
        </div>
      </div>
    </section>
    {categories.length>0&&<section className="mx-auto max-w-6xl px-5 pb-8">
      <div className="flex gap-2 overflow-x-auto pb-1">{categories.map(category=><button key={category} onClick={()=>onCategory(category)} className="shrink-0 border px-4 py-2 text-sm font-bold" style={{borderColor:theme.colors.border,borderRadius:theme.radius.button}}>{category}</button>)}</div>
    </section>}
    {products.length>0&&<section className="mx-auto max-w-6xl px-5 pb-16">
      <div className="mb-4 flex items-center justify-between"><h2 className="text-xl font-extrabold" style={{fontFamily:theme.fonts.heading}}>{editorial?'Collection':'Featured products'}</h2><button onClick={onShop} className="text-sm font-bold opacity-60">View all</button></div>
      <div className={`grid gap-4 ${columns}`}>{products.slice(0,editorial?6:4).map(product=><TemplateProductCard key={product.id} product={product} theme={theme} onOpen={()=>onProduct(product)}/>)}</div>
    </section>}
  </div>;
}

function TemplateProductCard({product,theme,onOpen}:{product:StorefrontProduct;theme:StorefrontTheme;onOpen:()=>void}){const editorial=['lookbook','editorial-clean'].includes(theme.cardStyle);const image=product.images?.[0]||product.image;return <button onClick={onOpen} className="group relative overflow-hidden border text-left" style={{background:theme.colors.surface,borderColor:theme.colors.border,borderRadius:theme.radius.card}}><div className={`${editorial?'aspect-[4/5]':'aspect-square'} relative overflow-hidden`} style={{background:theme.colors.accent}}>{image&&<img src={image} alt={product.name} className="h-full w-full object-cover transition duration-300 group-hover:scale-105"/>}<div className={editorial?'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 p-3 text-white':'p-3'}><p className="font-bold">{product.name}</p><p className="mt-1 text-sm opacity-75">₦{Number(product.price).toLocaleString('en-NG')}</p></div></div></button>}

export const storefrontTemplates:Record<string,TemplateComponent>={
  'kitchen-table':KitchenTableTemplate,'corner-bistro':CornerBistroTemplate,'fresh-menu':FreshMenuTemplate,'night-market':NightMarketTemplate,
  sunset:SunsetTemplate,studio:StudioTemplate,runway:RunwayTemplate,'urban-rack':UrbanRackTemplate,'soft-petals':SoftPetalsTemplate,
  'glow-studio':GlowStudioTemplate,velvet:VelvetTemplate,blossom:BlossomTemplate,'clean-bright':CleanBrightTemplate,'bold-shelf':BoldShelfTemplate,
  warehouse:WarehouseTemplate,marketplace:MarketplaceTemplate,signature:SignatureTemplate,horizon:HorizonTemplate,concierge:ConciergeTemplate,workshop:WorkshopTemplate,
};

export const storefrontTemplateSourceFiles:Record<string,string>=Object.fromEntries(
  Object.keys(storefrontTemplates).map(id=>[id,`/styles/${id}.html`]),
);

const categoryHero:Record<StorefrontCategory,string>={
  'Restaurant & Café':'https://images.pexels.com/photos/8178762/pexels-photo-8178762.jpeg?auto=compress&cs=tinysrgb&w=1400',
  Fashion:'https://images.pexels.com/photos/1536619/pexels-photo-1536619.jpeg?auto=compress&cs=tinysrgb&w=1400',
  Beauty:'https://images.pexels.com/photos/3762878/pexels-photo-3762878.jpeg?auto=compress&cs=tinysrgb&w=1400',
  Retail:'https://images.pexels.com/photos/1649771/pexels-photo-1649771.jpeg?auto=compress&cs=tinysrgb&w=1400',
  Services:'https://images.pexels.com/photos/3184465/pexels-photo-3184465.jpeg?auto=compress&cs=tinysrgb&w=1400',
};

export function SelectedTemplateHome(data:TemplateHomeData){
  const Template=storefrontTemplates[data.theme.id];
  const resolved={...data,banner:data.banner||categoryHero[data.theme.category]};
  if(!Template){
    if(import.meta.env.DEV)console.warn(`Unknown storefront template "${data.theme.id}"; using the default template.`);
    return TemplateHome(resolved);
  }
  return Template(resolved);
}
