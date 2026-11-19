const fs=require('fs');
let f, s;
const rep=(a,b)=>{if(!s.includes(a))throw new Error(f+' missing: '+a.slice(0,70));s=s.replace(a,b);};
f='src/bots/shop.ts';s=fs.readFileSync(f,'utf8');
rep("`Delivery (${delivery.address ?? ''}): ${delivery.feeKobo || !quoteLater(delivery) ? formatKobo(delivery.feeKobo) : 'to be confirmed'}${delivery.timeframe ? `, ${delivery.timeframe}` : ''}`",
"quoteLater(delivery) ? `Delivery (${delivery.address ?? ''}): ${delivery.timeframe}` : `Delivery (${delivery.address ?? ''}): ${formatKobo(delivery.feeKobo)}${delivery.timeframe ? `, ${delivery.timeframe}` : ''}`");
fs.writeFileSync(f,s);
f='test/shop.test.ts';s=fs.readFileSync(f,'utf8');
rep("/Pickup: free\\nService fee: ₦30\\nTotal: about ₦3,030/","/Pickup: free\\nService fee: ₦30\\nTotal: ₦3,030\\n/");
fs.writeFileSync(f,s);
f='test/shop-settings.test.ts';s=fs.readFileSync(f,'utf8');
rep("/Business biz-a is in Yaba, Lagos\\./","/📍 Business biz-a: Yaba, Lagos\\./");
rep("/Delivery \\(5 Ring Road, Ibadan\\): ₦0, delivery price to be confirmed by Business biz-a/","/Delivery \\(5 Ring Road, Ibadan\\): delivery price to be confirmed by Business biz-a[\\s\\S]*Total: about ₦[\\d,]+ plus delivery/");
fs.writeFileSync(f,s);
f='test/test-mode.test.ts';s=fs.readFileSync(f,'utf8');
rep("  assert.deepEqual(last[0].options, ['test:start', 'ob:connect']);","  assert.deepEqual(last.at(-1)!.options, ['test:start', 'ob:connect']);");
rep("/Total: about ₦10,000/","/Total: ₦10,000\\n/");
fs.writeFileSync(f,s);
