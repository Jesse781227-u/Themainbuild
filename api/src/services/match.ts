// Matching what the owner typed ("pink crop top") to a product they already have
// ("Pink Tie-Front Crop Top"): case-insensitive word overlap, with plurals and punctuation ignored.
//   strong    → one clear match: use it
//   ambiguous → a likely match (or a few): ask "Did you mean …?"
//   none      → nothing close
export type ProductMatch<T> = { kind: 'strong'; product: T } | { kind: 'ambiguous'; products: T[] } | { kind: 'none' };

const STOP = new Set(['the', 'a', 'an', 'and', '&', 'of', 'with', 'for', 'in']);
export const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)
  .filter(w => w && !STOP.has(w)).map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));

// 0–1: how much of the query is in the name, lightly penalised when the name has many other words.
export function nameScore(query: string, name: string) {
  const q = words(query), n = words(name);
  if (!q.length || !n.length) return 0;
  if (q.join(' ') === n.join(' ')) return 1;
  const hit = q.filter(w => n.some(x => x === w || (w.length >= 4 && (x.startsWith(w) || w.startsWith(x))))).length;
  const cover = hit / q.length;
  const extra = hit / n.length;
  return cover * 0.8 + extra * 0.2;
}

export function matchProduct<T extends { name: string }>(query: string, products: T[]): ProductMatch<T> {
  const scored = products.map(p => ({ p, s: nameScore(query, p.name) })).filter(x => x.s >= 0.5).sort((a, b) => b.s - a.s);
  if (!scored.length) return { kind: 'none' };
  const exact = scored.filter(x => x.s === 1);
  if (exact.length === 1) return { kind: 'strong', product: exact[0].p };
  const [top, next] = scored;
  // Every word they typed is in this name, and nothing else comes close.
  if (top.s >= 0.85 && (!next || top.s - next.s >= 0.15)) return { kind: 'strong', product: top.p };
  return { kind: 'ambiguous', products: scored.filter(x => x.s >= Math.max(0.5, top.s - 0.15)).slice(0, 3).map(x => x.p) };
}

// "pink crop top" → "Pink Crop Top"; names with their own capitals are kept as typed.
export const titleCase = (name: string) => (name === name.toLowerCase() ? name.replace(/(^|[\s(/-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()) : name);
