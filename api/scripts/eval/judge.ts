// Scores one turn of a conversation fixture: tools called, cart, checkout, hand-over, updates, and
// what the reply must never say.
import type { Turn } from './fixtures';
import type { Recorder } from './fake-shop';

export function judge(t: Turn, x: { called: string[]; reply: string; rec: Recorder; failed: string | null }) {
  const p: string[] = [];
  if (x.failed && (t.tools?.length || t.allTools?.length)) p.push(`fell back (${x.failed})`);
  // Reading the catalogue, cart or shop info can come from the context instead of a tool (small
  // shops have it all there); actions and anything not in the context need their tool.
  const fromContext = ['searchProducts', 'getProduct', 'viewCart', 'showProducts', 'shopInfo'];
  const readOnly = !!t.tools?.length && t.tools.every(n => fromContext.includes(n));
  if (t.tools?.length && !t.tools.some(n => x.called.includes(n)) && !(readOnly && !x.failed)) p.push(`expected one of ${t.tools.join('/')}`);
  for (const n of t.allTools ?? []) if (!x.called.includes(n)) p.push(`expected ${n}`);
  for (const n of t.notTools ?? []) if (x.called.includes(n)) p.push(`must not call ${n}`);
  if (t.never && t.never.test(x.reply)) p.push(`reply matched ${t.never}`);
  if (t.cart) {
    const got = Object.fromEntries(x.rec.cart);
    if (JSON.stringify(Object.entries(got).sort()) !== JSON.stringify(Object.entries(t.cart).sort())) p.push(`cart ${JSON.stringify(got)} ≠ ${JSON.stringify(t.cart)}`);
  }
  if (t.checkout && !x.rec.checkout) p.push('checkout not started');
  if (t.owner && !x.rec.owner) p.push('not handed to the owner');
  if (t.updates !== undefined && x.rec.updates !== t.updates) p.push(`updates ${x.rec.updates} ≠ ${t.updates}`);
  return p;
}
