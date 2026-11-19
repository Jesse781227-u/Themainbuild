// What happens when an owner submits a WhatsApp Flow form (services/flows.ts): the same checks as
// the chat version, scoped to the shop the form was sent for.
import { C } from '../db';
import type { Business } from '../domain/business';
import { nairaToKobo, formatKobo } from '../lib/money';
import { randomId } from '../lib/crypto';
import type { Firestore } from '../lib/firestore';
import { createProduct, listCategories } from '../services/catalog';
import { saveZone } from '../services/delivery';
import { DAYS, describeHours, validHours, type Hours } from '../services/hours';
import type { FlowKind } from '../services/flows';
import { titleCase } from '../services/match';
import { card } from './products-flow';
import { buttons } from './common';
import { followUps, type Out } from './actions';

const str = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export async function handleFlowAnswer(db: Firestore, business: Business, kind: FlowKind, a: Record<string, unknown>): Promise<Out> {
  const at = new Date().toISOString();
  if (kind === 'add') {
    const name = titleCase(str(a.name, 120));
    const priceKobo = nairaToKobo(str(a.price, 20));
    const stock = a.stock === undefined || a.stock === '' || a.stock === null ? null : Number(a.stock);
    const cat = (await listCategories(db, business.id)).find(c => c.id === a.category);
    if (name.length < 2 || !priceKobo || priceKobo <= 0) return 'That product needs a name and a price. Please open the form again.';
    if (stock !== null && !(Number.isInteger(stock) && stock >= 0 && stock <= 1_000_000)) return 'The stock count should be a whole number. Please open the form again.';
    if (!cat) return 'That category no longer exists. Please open the form again.';
    const p = await createProduct(db, { businessId: business.id, name, priceKobo, stock, categoryId: cat.id, description: str(a.description, 300) });
    return card(p, cat.name, `Added new product *${p.name}* ${formatKobo(p.priceKobo)} in ${cat.name}.`);
  }
  if (kind === 'hours') {
    const hours = Object.fromEntries(DAYS.map(d => {
      const open = str(a[`${d}_open`], 5), close = str(a[`${d}_close`], 5);
      return [d, /^clos/i.test(open) || /^clos/i.test(close) || !open || !close ? null : { open, close }];
    })) as Hours;
    const ok = validHours(hours);
    if (!ok || DAYS.some(d => ok[d] && ok[d]!.open >= ok[d]!.close)) return 'Each open day needs a closing time after its opening time. Please open the form again.';
    await db.update(db.doc(C.businesses, business.id), { hours: ok, updatedAt: at });
    return buttons(`Saved ✅ ${describeHours(ok)}.`, followUps([['delivery', 'Delivery']]));
  }
  // delivery: up to three areas with their prices
  const saved: string[] = [];
  for (const n of [1, 2, 3]) {
    const area = str(a[`zone${n}_name`], 60), fee = nairaToKobo(str(a[`zone${n}_fee`], 20) || 'x');
    if (!area) continue;
    if (fee === null || fee < 0) return `The price for ${area} isn't a number. Please open the form again.`;
    await saveZone(db, { id: `${business.id}_${randomId(6).replace(/[^A-Za-z0-9]/g, 'x')}`, businessId: business.id, name: area, match: area, feeKobo: fee, timeframe: str(a[`zone${n}_time`], 40), active: true, priority: 1 });
    saved.push(`${area}: ${fee ? formatKobo(fee) : 'free'}`);
  }
  if (!saved.length) return 'No areas were filled in, so nothing changed.';
  return buttons(`Saved ✅ Delivery prices:\n${saved.map(s => `• ${s}`).join('\n')}`, followUps([['hours', 'Opening hours']]));
}
