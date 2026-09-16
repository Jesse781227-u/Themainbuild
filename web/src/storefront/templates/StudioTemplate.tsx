import { CategoryTabs, ProductTile, Shell } from './TemplateBase';
import type { TemplateHomeData } from '@/storefront/template-library';

export default function StudioTemplate(data: TemplateHomeData) {
  return <Shell data={data}><CategoryTabs data={data} /><section className="columns-2 gap-3 sm:columns-3">{data.products.map(product => <div key={product.id} className="mb-3 break-inside-avoid"><ProductTile product={product} data={data} portrait /></div>)}</section></Shell>;
}