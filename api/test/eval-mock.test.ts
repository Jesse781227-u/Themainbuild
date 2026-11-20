// The conversation fixtures in CI, with a stand-in model (no network): for every turn it plays the
// moves the fixture expects (add, change, check out, hand over…) with real arguments, the real tools
// run against the pretend shop, and the same judge as the live eval checks the outcome. This keeps
// the tools, the pretend shop and the fixtures honest; the live model is scored by
// `npm run eval:conversation`.
import { runAgent, isFail } from '../src/bots/agent';
import { remember, type AgentMemory } from '../src/bots/agent-memory';
import { shopContext, shopSystem, shopTools } from '../src/bots/shop-agent';
import type { ConverseStep, LLMProvider } from '../src/services/ai';
import { FIXTURES, type Turn } from '../scripts/eval/fixtures';
import { fakeHelpers, SHOPS, type ShopKey, type Recorder } from '../scripts/eval/fake-shop';
import { judge } from '../scripts/eval/judge';
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Call = [string, Record<string, unknown>];

// The moves a good assistant makes for this turn, from what the fixture expects.
function plan(shop: ShopKey, t: Turn, rec: Recorder): Call[] {
  const products = SHOPS[shop].products;
  const calls: Call[] = [];
  const label = (key: string) => { const [id, v] = key.split('#'); return { id, option: v ? products.find(p => p.id === id)?.variants?.find(x => x.id === v)?.label ?? null : null }; };
  if (t.cart) {
    for (const [key, qty] of Object.entries(t.cart)) {
      const { id, option } = label(key);
      const now = rec.cart.get(key) ?? 0;
      if (!now) calls.push(['addToCart', { productId: id, ...(option ? { option } : {}), quantity: qty }]);
      else if (now !== qty) calls.push(['updateCart', { productId: id, ...(option ? { option } : {}), quantity: qty }]);
    }
    for (const key of rec.cart.keys()) if (!(key in t.cart)) { const { id, option } = label(key); calls.push(['updateCart', { productId: id, ...(option ? { option } : {}), quantity: 0 }]); }
  }
  const lower = t.say.toLowerCase();
  if (t.checkout) {
    const zone = Object.keys(SHOPS[shop].zones).find(z => lower.includes(z));
    calls.push(['goToCheckout', /pick/.test(lower) ? { pickup: true } : /usual|my house/.test(lower) ? { deliverTo: 'saved' } : zone ? { deliverTo: zone } : {}]);
  }
  if (t.owner) calls.push(['handToOwner', { reason: t.say.slice(0, 60) }]);
  if (t.updates !== undefined) calls.push(['setUpdates', { on: t.updates }]);
  const want = [...(t.allTools ?? []), ...(t.tools && !t.tools.some(n => calls.some(c => c[0] === n)) ? [t.tools[0]] : [])];
  for (const name of want) if (!calls.some(c => c[0] === name)) calls.push([name, argsFor(name, shop, t.say, products)]);
  return calls;
}

function argsFor(name: string, shop: ShopKey, say: string, products: (typeof SHOPS)[ShopKey]['products']): Record<string, unknown> {
  const lower = say.toLowerCase();
  const hit = products.find(p => p.name.toLowerCase().split(/\s+/).some(w => w.length > 3 && lower.includes(w.replace(/s$/, '')))) ?? products[0];
  switch (name) {
    case 'searchProducts': return { query: say };
    case 'getProduct': return { productId: hit.id };
    case 'showProducts': return { productIds: hit.id };
    case 'addToCart': return { productId: hit.id, ...(hit.variants?.length ? { option: (/\b(4\d)\b/.exec(lower)?.[1]) ?? hit.variants[0].label } : {}), quantity: Number(/\b(\d)\b/.exec(lower)?.[1] ?? 1) };
    case 'updateCart': return { productId: hit.id, quantity: /\b(remove|no need|comot)\b/.test(lower) ? 0 : Number(/\b(\d)\b/.exec(lower)?.[1] ?? 1) };
    case 'deliveryQuote': return { area: Object.keys(SHOPS[shop].zones).find(z => lower.includes(z)) ?? say };
    case 'shopInfo': return { topic: /pay|transfer/.test(lower) ? 'payment' : /return|refund/.test(lower) ? 'policy' : /where/.test(lower) ? 'location' : /deliver|reach/.test(lower) ? 'delivery' : 'hours' };
    case 'applyOfferCode': return { code: /\b([A-Z0-9]+-?[A-Z0-9]+)\b/.exec(say)?.[1] ?? 'NONE' };
    case 'askOwner': return { question: say };
    case 'handToOwner': return { reason: say.slice(0, 60) };
    case 'offerChoices': return { options: (hit.variants ?? []).map(v => v.label).slice(0, 3).join('|') || 'Yes|No' };
    case 'suggestPairings': return { productId: hit.id };
    default: return {};
  }
}

// A model that makes the planned calls, then writes a reply built only from the tool results.
function standIn(calls: Call[]): LLMProvider {
  let step = 0;
  return {
    async chooseTool() { return null; },
    async converse(): Promise<ConverseStep> {
      const usage = { inTokens: 0, outTokens: 0 };
      if (step++ === 0 && calls.length) return { calls: calls.map(([name, args]) => ({ name, args })), text: '', usage };
      return { calls: [], text: 'OK 👍', usage };
    },
  };
}

test(`eval fixtures (${FIXTURES.length} conversations) replay with a stand-in model: tools, pretend shop and expectations agree`, async () => {
  const problems: string[] = [];
  let turns = 0;
  for (const fx of FIXTURES) {
    const { h, rec, sent } = fakeHelpers(fx.shop, { first: fx.first, pastOrder: fx.pastOrder, savedAddress: fx.savedAddress });
    let memory: AgentMemory = { turns: [], summary: null };
    for (const [i, t] of fx.turns.entries()) {
      turns++;
      const calls = plan(fx.shop, t, rec);
      const before = sent.length;
      const r = await runAgent({ llm: standIn(calls), system: shopSystem(h), context: shopContext(h, await h.cart()), memory, message: t.say, tools: shopTools(h), c: null, maxSteps: 4, timeoutMs: 5000 });
      if (!isFail(r)) { if (r.finish) await r.finish(r.text); else sent.push(r.text); memory = remember(memory, t.say, r.text, r.calls.map(c => c.name)); }
      const called = r.calls.filter(c => c.ok).map(c => c.name);
      const p = judge(t, { called, reply: sent.slice(before).join('\n'), rec, failed: isFail(r) ? r.failed : null });
      if (p.length) problems.push(`${fx.id}#${i + 1}: ${p.join('; ')} (calls ${JSON.stringify(calls)})`);
    }
  }
  assert.ok(turns >= 80);
  assert.deepEqual(problems, []);
});
