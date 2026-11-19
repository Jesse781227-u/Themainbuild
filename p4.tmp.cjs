const fs=require('fs');
let f, s;
const rep=(a,b)=>{if(!s.includes(a))throw new Error(f+' missing: '+a.slice(0,70));s=s.replace(a,b);};
f='src/bots/shop.ts';s=fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n');
rep("    delivery.method === 'pickup' ? `Pickup: free${business.prepTime ? `, ready in about ${business.prepTime}` : ''}` : `Delivery (${delivery.address ?? ''}): ${formatKobo(delivery.feeKobo)}${delivery.timeframe ? `, ${delivery.timeframe}` : ''}`,",
"    delivery.method === 'pickup' ? `Pickup: free${business.prepTime ? `, ready in about ${business.prepTime}` : ''}${shopAddress(business) ? `\\n📍 Pick up from: ${shopAddress(business)}` : ''}` : `Delivery (${delivery.address ?? ''}): ${delivery.feeKobo || !quoteLater(delivery) ? formatKobo(delivery.feeKobo) : 'to be confirmed'}${delivery.timeframe ? `, ${delivery.timeframe}` : ''}`,");
rep("    `Total: about ${formatKobo(subtotal + delivery.feeKobo + fee)} (the exact amount comes next)`,",
"    quoteLater(delivery) ? `Total: about ${formatKobo(subtotal + fee)} plus delivery (${business.name} confirms the delivery price)` : `Total: ${formatKobo(subtotal + delivery.feeKobo + fee)}`,");
rep(`// Pickup, with the shop's preparation time when it has one (food).
const pickup = (business: Business): OrderDelivery => ({ method: 'pickup', feeKobo: 0, timeframe: business.prepTime ? \`Ready for pickup in about \${business.prepTime}\` : 'Ready for pickup' });`,`// Pickup, with the shop's preparation time when it has one (food), at the shop's address.
const pickup = (business: Business): OrderDelivery => ({ method: 'pickup', feeKobo: 0, timeframe: business.prepTime ? \`Ready for pickup in about \${business.prepTime}\` : 'Ready for pickup', ...(shopAddress(business) ? { address: shopAddress(business)! } : {}) });
// Where pickup customers go: "12 Herbert Macaulay Way, Yaba, Lagos — near Tejuosho Market".
export const shopAddress = (b: Pick<Business, 'address' | 'area' | 'city' | 'landmark'>) => (b.area || b.city || b.address ? describeLocation({ street: b.address ?? null, area: b.area ?? null, city: b.city ?? null, landmark: b.landmark ?? null }) : null);
// Other states with "I quote per order": the delivery price isn't known yet.
const quoteLater = (d: OrderDelivery) => d.method !== 'pickup' && !d.feeKobo && /to be confirmed/.test(d.timeframe ?? '');`);
rep("  if (topic === 'location') { const where = [business.area, business.city].filter(Boolean).join(', '); return where ? `${business.name} is in ${where}.` : null; }",
"  if (topic === 'location') { const where = shopAddress(business); return where ? `📍 ${business.name}: ${where}.` : null; }");
rep(`import { describeHours`, `import { describeLocation } from '../services/location';
import { describeHours`);
fs.writeFileSync(f,s);

f='src/services/delivery.ts';s=fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n');
rep(`  const zone = zones.find(z => location.toLowerCase().includes(z.match.toLowerCase()));`,`  const where = expandAliases(location).toLowerCase();
  const zone = zones.find(z => where.includes(z.match.toLowerCase()));`);
rep(`import type { Order, OrderDelivery } from '../domain/commerce';`,`import type { Order, OrderDelivery } from '../domain/commerce';
import { expandAliases } from './location';`);
fs.writeFileSync(f,s);

f='src/bots/onboarding.ts';s=fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n');
rep(`async function toPolicies(c: Ctx) { await setOb(c, { step: 'policies' }); return prompt(c); }`,`async function toPolicies(c: Ctx) {
  // The delivery prices, read back once they're all set.
  if (c.business!.fulfilment !== 'pickup') {
    const zones = await listZones(c.ctx.db, c.business!.id);
    const fee = (k: number) => (k ? formatKobo(k) : 'free');
    const local = zones.find(z => z.priority === 2), city = zones.find(z => z.priority === 1), other = zones.find(z => z.priority === 0 && !z.match);
    const parts = [
      local ? \`\${fee(local.feeKobo)} within \${local.name}\` : null,
      city ? \`\${fee(city.feeKobo)} elsewhere in \${city.name}\` : null,
      c.business!.shipsInterstate ? \`other states: \${other ? fee(other.feeKobo) : 'you quote per order'}\` : null,
    ].filter(Boolean);
    if (parts.length) await c.reply(\`✅ Delivery: \${parts.join(' · ')}.\${c.business!.fulfilment === 'both' ? ' Pickup is free.' : ''}\`);
  }
  await setOb(c, { step: 'policies' });
  return prompt(c);
}`);
fs.writeFileSync(f,s);
