import { CategoryTabs, ProductTile, Shell } from './TemplateBase';
import type { TemplateHomeData } from '@/storefront/template-library';

export default function EverydayTemplate(data: TemplateHomeData) {
  return <Shell data={data}><CategoryTabs data={data} /><section className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{data.products.map(product => <ProductTile key={product.id} product={product} data={data} />)}</section></Shell>;
}