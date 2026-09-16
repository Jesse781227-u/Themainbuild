import type {ReactNode} from 'react';
import type {StorefrontProduct} from '@/components/storefront/StorefrontRenderer';
import type {StorefrontTheme} from './themes';
import MenuTemplate from './templates/MenuTemplate';
import BookTemplate from './templates/BookTemplate';
import MarketTemplate from './templates/MarketTemplate';
import DropTemplate from './templates/DropTemplate';
import StudioTemplate from './templates/StudioTemplate';
import EverydayTemplate from './templates/EverydayTemplate';

export type TemplateHomeData={
  theme:StorefrontTheme;
  businessName:string;
  headline:string;
  description:string;
  banner?:string;
  categories:string[];
  products:StorefrontProduct[];
  onCategory:(category:string)=>void;
  onProduct:(product:StorefrontProduct)=>void;
  onShop:()=>void;
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
    <nav className="mx-auto flex max-w-6xl justify-around border-t px-5 py-4 text-xs font-bold opacity-70" style={{borderColor:theme.colors.border}}><button onClick={()=>onShop()}>Shop</button><button onClick={()=>onShop()}>Search</button><button onClick={()=>onShop()}>Cart</button></nav>
  </div>;
}

function TemplateProductCard({product,theme,onOpen}:{product:StorefrontProduct;theme:StorefrontTheme;onOpen:()=>void}){const editorial=['lookbook','editorial-clean'].includes(theme.cardStyle);const image=product.images?.[0]||product.image;return <button onClick={onOpen} className="group relative overflow-hidden border text-left" style={{background:theme.colors.surface,borderColor:theme.colors.border,borderRadius:theme.radius.card}}><div className={`${editorial?'aspect-[4/5]':'aspect-square'} relative overflow-hidden`} style={{background:theme.colors.accent}}>{image&&<img src={image} alt={product.name} className="h-full w-full object-cover transition duration-300 group-hover:scale-105"/>}<div className={editorial?'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 p-3 text-white':'p-3'}><p className="font-bold">{product.name}</p><p className="mt-1 text-sm opacity-75">₦{Number(product.price).toLocaleString('en-NG')}</p></div></div></button>}

const KitchenTableTemplate:TemplateComponent=MenuTemplate;
const CornerBistroTemplate:TemplateComponent=MenuTemplate;
const FreshMenuTemplate:TemplateComponent=MenuTemplate;
const NightMarketTemplate:TemplateComponent=MenuTemplate;
const SunsetTemplate:TemplateComponent=DropTemplate;
const RunwayTemplate:TemplateComponent=MarketTemplate;
const UrbanRackTemplate:TemplateComponent=MarketTemplate;
const SoftPetalsTemplate:TemplateComponent=BookTemplate;
const GlowStudioTemplate:TemplateComponent=BookTemplate;
const VelvetTemplate:TemplateComponent=DropTemplate;
const BlossomTemplate:TemplateComponent=BookTemplate;
const CleanBrightTemplate:TemplateComponent=EverydayTemplate;
const BoldShelfTemplate:TemplateComponent=EverydayTemplate;
const WarehouseTemplate:TemplateComponent=EverydayTemplate;
const MarketplaceTemplate:TemplateComponent=MarketTemplate;
const SignatureTemplate:TemplateComponent=EverydayTemplate;
const HorizonTemplate:TemplateComponent=EverydayTemplate;
const ConciergeTemplate:TemplateComponent=BookTemplate;
const WorkshopTemplate:TemplateComponent=StudioTemplate;

export const storefrontTemplates:Record<string,TemplateComponent>={
  'kitchen-table':KitchenTableTemplate,'corner-bistro':CornerBistroTemplate,'fresh-menu':FreshMenuTemplate,'night-market':NightMarketTemplate,
  sunset:SunsetTemplate,studio:StudioTemplate,runway:RunwayTemplate,'urban-rack':UrbanRackTemplate,'soft-petals':SoftPetalsTemplate,
  'glow-studio':GlowStudioTemplate,velvet:VelvetTemplate,blossom:BlossomTemplate,'clean-bright':CleanBrightTemplate,'bold-shelf':BoldShelfTemplate,
  warehouse:WarehouseTemplate,marketplace:MarketplaceTemplate,signature:SignatureTemplate,horizon:HorizonTemplate,concierge:ConciergeTemplate,workshop:WorkshopTemplate,
};

export function SelectedTemplateHome(data:TemplateHomeData){return (storefrontTemplates[data.theme.id]||TemplateHome)(data)}
