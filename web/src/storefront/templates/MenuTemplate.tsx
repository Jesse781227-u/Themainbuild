import { CategoryTabs, ProductTile, Shell } from './TemplateBase';
import type { TemplateHomeData } from '@/storefront/template-library';

export default function MenuTemplate(data: TemplateHomeData) {
  return <Shell data={data}><CategoryTabs data={data} /><section className="grid grid-cols-2 gap-3 sm:grid-cols-3">{data.products.map(product => <ProductTile key={product.id} product={product} data={data} />)}</section></Shell>;
}