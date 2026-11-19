// Sizes and colours typed with a product: "Black boots 15000 sizes 40-44 colours black, brown"
// → the line without them ("Black boots 15000") + [{ Size: 40…44 }, { Colour: Black, Brown }].
//   sizes 40-44 · size: S, M, L · sizes S M L XL · colours black/brown · colors: red and light blue
// A number at the end of a size list that looks like a price (₦, k, or 100 and up) stays the price.
export interface OptionList { name: string; values: string[] }

const KEY = /\b(sizes?|colou?rs?)\b\s*:?\s*/gi;
const PRICE = /^(?:₦|n)?\d[\d,]*(?:\.\d+)?k$|^(?:₦|n)\d|^\d{1,3}(?:,\d{3})+$|^\d{3,}$/i;
const LETTER_SIZE = /^(xxs|xs|s|m|l|xl|xxl|xxxl|[2-5]xl)$/i;

const tidyColour = (c: string) => c.trim().toLowerCase().replace(/(^|\s)\p{L}/gu, m => m.toUpperCase());
const tidySize = (s: string) => (LETTER_SIZE.test(s) ? s.toUpperCase() : s.trim());

function values(raw: string, kind: 'Size' | 'Colour'): string[] {
  const parts = /[,/&]|\band\b/i.test(raw) ? raw.split(/\s*(?:,|\/|&|\band\b)\s*/i) : kind === 'Size' ? raw.split(/\s+/) : [raw];
  const out: string[] = [];
  for (const p of parts.map(x => x.trim()).filter(Boolean)) {
    const range = /^(\d{1,3})\s*[-–]\s*(\d{1,3})$/.exec(p);
    if (kind === 'Size' && range && Number(range[2]) > Number(range[1]) && Number(range[2]) - Number(range[1]) <= 15) {
      for (let n = Number(range[1]); n <= Number(range[2]); n++) out.push(String(n));
    } else out.push(kind === 'Size' ? tidySize(p) : tidyColour(p));
  }
  return [...new Set(out)].filter(v => v.length <= 20).slice(0, 15);
}

export function extractOptions(text: string): { rest: string; options: OptionList[] } {
  const marks = [...text.matchAll(KEY)];
  if (!marks.length) return { rest: text, options: [] };
  const options: OptionList[] = [];
  let rest = text.slice(0, marks[0].index);
  let trailing = '';
  marks.forEach((m, i) => {
    const kind = /^s/i.test(m[1]) ? 'Size' : 'Colour';
    let seg = text.slice(m.index! + m[0].length, i + 1 < marks.length ? marks[i + 1].index : text.length).trim();
    // The price (and a stock count after it) can come after the list: "sizes 40-44 15000".
    const tokens = seg.split(/\s+/);
    const tail: string[] = [];
    while (tokens.length > 1 && (PRICE.test(tokens[tokens.length - 1]) || (kind === 'Colour' && /^\d+$/.test(tokens[tokens.length - 1])) || (tail.length === 0 && /^\d+$/.test(tokens[tokens.length - 1]) && tokens.length > 1 && PRICE.test(tokens[tokens.length - 2])))) tail.unshift(tokens.pop()!);
    if (tail.length) { seg = tokens.join(' '); trailing = `${trailing} ${tail.join(' ')}`; }
    const vals = values(seg.replace(/[.;]+$/, ''), kind);
    if (vals.length && !options.some(o => o.name === kind)) options.push({ name: kind, values: vals });
  });
  rest = `${rest} ${trailing}`.replace(/\s+/g, ' ').replace(/[\s,]+$/, '').trim();
  return { rest, options };
}

export const optionSummary = (options: OptionList[]) => options.map(o => `${o.name === 'Size' ? 'Sizes' : 'Colours'}: ${o.values.join(', ')}`).join(' · ');
