import { CategoryTabs, ProductTile, Shell } from './TemplateBase';
import type { TemplateHomeData } from '@/storefront/template-library';

export default function DropTemplate(data: TemplateHomeData) {
  return <Shell data={data} className="max-w-5xl"><CategoryTabs data={data} /><section className="grid grid-cols-2 gap-3 sm:grid-cols-3">{data.products.map(product => <ProductTile key={product.id} product={product} data={data} portrait dark />)}</section></Shell>;
}