const fs=require('fs');
let f, s;
const rep=(a,b)=>{if(!s.includes(a))throw new Error(f+' missing: '+a.slice(0,70));s=s.replace(a,b);};
f='src/bots/onboarding.ts';s=fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n');
rep(`  draft?: { city?: string; hours?: Hours };`,`  draft?: { city?: string; hours?: Hours; loc?: Location; streetAsked?: boolean };`);
rep(`    case 'city': {
      const parts = text.split(/,|\\s+-\\s+/).map(s => s.trim()).filter(Boolean);
      if (choiceId || !parts.length || parts[0].length < 2) return prompt(c);
      if (parts.length === 1) { await setOb(c, { step: 'area', draft: { ...c.ob.draft, city: parts[0].slice(0, 60) } }); return c.reply(\`And which area in \${parts[0]}?\`); }
      return saveLocation(c, parts[0], parts.slice(1).join(', '));
    }
    case 'area': {
      const area = text.trim().slice(0, 60);
      if (choiceId || area.length < 2) return prompt(c);
      return saveLocation(c, c.ob.draft?.city ?? '', area);
    }`,`    // Location: whatever they send is split into area, city, street and landmark; anything missing is
    // asked for, then it's read back before saving. The address is also where pickup customers go.
    case 'city': case 'area': case 'street': {
      if (choiceId === 'loc:nostreet') { await setOb(c, { draft: { ...c.ob.draft, streetAsked: true } }); return nextLocation(c); }
      if (choiceId || text.trim().length < 2) return prompt(c);
      const got = parseLocation(text);
      const loc: Location = { city: null, area: null, street: null, landmark: null, ...c.ob.draft?.loc };
      for (const k of ['city', 'area', 'street', 'landmark'] as const) if (got[k] && (!loc[k] || c.ob.step === 'city')) loc[k] = got[k];
      // A plain answer to "Which area?" / "Which city?" / "Which street?" is that thing.
      const plain = tidyPlace(text.replace(/^(it'?s|it is|in|at)\\s+/i, ''));
      if (c.ob.step === 'area' && !got.area && !got.street && !got.city) loc.area = plain;
      if (c.ob.step === 'city' && loc.area && !got.city && !got.area && !got.street && !got.landmark) loc.city = knownCity(plain) ?? plain;
      if (c.ob.step === 'street' && !got.street) loc.street = got.landmark && !got.area ? loc.street : tidyPlace(text.replace(LANDMARK_RE, '').replace(/^(it'?s|it is|we'?re at|at|on)\\s+/i, ''));
      await setOb(c, { draft: { ...c.ob.draft, loc, ...(c.ob.step === 'street' ? { streetAsked: true } : {}) } });
      return nextLocation(c);
    }
    case 'location_confirm': {
      if (choiceId === 'loc:fix' || (!choiceId && /^(no|fix|wrong|change)/i.test(text.trim()))) { await setOb(c, { step: 'city', draft: { ...c.ob.draft, loc: undefined, streetAsked: false } }); return c.reply('No problem. Send the full address again, e.g. *12 Herbert Macaulay Way, Yaba, Lagos*.'); }
      if (choiceId === 'loc:ok' || (!choiceId && /^(yes|correct|right|ok(ay)?|that'?s right)\\b/i.test(text.trim()))) return saveLocation(c);
      return prompt(c);
    }`);
rep(`async function saveLocation(c: Ctx, city: string, area: string) {
  await patchBusiness(c, { city: city.slice(0, 60), area: area.slice(0, 60) });
  await setStage(c, 'hours', 'hours');
  return prompt(c);
}`,`const LANDMARK_RE = /[\\s,]+(near|opposite|beside|close to|behind|next to)\\s+.+$/i;

// Asks for whatever's still missing (area, then city, then street), then reads it all back.
async function nextLocation(c: Ctx) {
  const loc = c.ob.draft?.loc;
  const next: Step = !loc?.area ? 'area' : !loc.city ? 'city' : !loc.street && !c.ob.draft?.streetAsked ? 'street' : 'location_confirm';
  await setOb(c, { step: next });
  return prompt(c);
}

async function saveLocation(c: Ctx) {
  const loc = c.ob.draft?.loc;
  if (!loc?.area || !loc.city) { await setOb(c, { step: 'city' }); return prompt(c); }
  await patchBusiness(c, { city: loc.city.slice(0, 60), area: loc.area.slice(0, 60), address: loc.street?.slice(0, 120) ?? null, landmark: loc.landmark?.slice(0, 80) ?? null });
  await setStage(c, 'hours', 'hours');
  return prompt(c);
}`);
rep(`    case 'city': return c.reply(\`\${L}Where is \${biz?.name ?? 'your shop'}? Send the city and area, e.g. *Lagos, Yaba*.\`);
    case 'area': return c.reply(\`Which area in \${c.ob.draft?.city ?? 'your city'}?\`);`,`    case 'city': {
      const area = c.ob.draft?.loc?.area;
      if (area) return c.reply(\`Which city or state is *\${area}* in?\`);
      return c.reply(\`\${L}Where is \${biz?.name ?? 'your shop'}? Send the address, e.g. *12 Herbert Macaulay Way, Yaba, Lagos*.\\n\\nCustomers who pick up their orders will be sent this address.\`);
    }
    case 'area': return c.reply(\`Which area\${c.ob.draft?.loc?.city ? \` in \${c.ob.draft.loc.city}\` : ''} is \${biz?.name ?? 'your shop'} in? e.g. *Yaba*\`);
    case 'street': {
      const loc = c.ob.draft?.loc;
      return c.reply(buttons(\`What's the street or building in \${loc?.area ?? 'your area'}? e.g. *12 Herbert Macaulay Way*. Customers who pick up will be sent it.\`, [['loc:nostreet', 'No pickup address']]));
    }
    case 'location_confirm': return c.reply(buttons(\`📍 \${describeLocation(c.ob.draft?.loc ?? {})}. Is that right?\`, [['loc:ok', 'Yes, that\\'s right'], ['loc:fix', 'Fix it']]));`);
rep(`import { saveZone } from '../services/delivery';`,`import { listZones, saveZone } from '../services/delivery';
import { describeLocation, knownCity, parseLocation, tidyPlace, type Location } from '../services/location';`);
fs.writeFileSync(f,s);

f='src/domain/business.ts';s=fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n');
rep(`  ownerName?: string | null; city?: string | null; area?: string | null;`,`  ownerName?: string | null; city?: string | null; area?: string | null;
  address?: string | null; landmark?: string | null; // street/building and a landmark: where pickup customers go`);
fs.writeFileSync(f,s);
