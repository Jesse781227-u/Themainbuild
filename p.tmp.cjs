const fs=require('fs');const f='test/helpers.ts';let s=fs.readFileSync(f,'utf8');
const rep=(a,b)=>{if(!s.includes(a))throw new Error('missing '+a);s=s.replace(a,b);};
rep("o: { shop?: string; product?: string; type?: string; name?: string; until?: 'ready' | 'linked' } = {}","o: { shop?: string; product?: string; type?: string; name?: string; until?: 'ready' | 'linked'; fee?: 'customer' | 'owner' } = {}");
rep("  await say('Lagos, Ikeja');\n","  await say('Lagos, Ikeja');\n  await say('No pickup address', 'loc:nostreet');\n  await say('Yes', 'loc:ok');\n");
rep("  last = await say('Use these', 'pol:use');\n","  last = await say('Use these', 'pol:use');\n  last = await say('Who pays', `fee:${o.fee ?? 'customer'}`);\n");
rep("    await say('My customers', 'fee:customer');\n","");
fs.writeFileSync(f,s);
