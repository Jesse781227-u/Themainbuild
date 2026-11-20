// The fact check on every agent reply, before it's sent: each ₦ amount and number, and each *bold*
// name, must appear in what Relay knows this turn (the shop context, the tool results, or the
// person's own message). Anything else is a guess, and a guess about a price, stock, a time or a
// product is never sent: the agent gets one rewrite, then the fixed flow answers instead.

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
// Every number in a text, as digits ("₦15,000" → 15000, "1.5k" → 1500, "9am" → 9).
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(m[2] ? n * 1000 : n);
  }
  return out;
}

export interface GuardResult { ok: boolean; unknown: string[] }

export function checkFacts(reply: string, known: string[]): GuardResult {
  const pool = known.join('\n');
  const nums = new Set(numbersIn(pool));
  // Kobo in tool results (priceKobo: 1500000) also count as their naira amount.
  for (const n of [...nums]) if (n >= 100 && n % 100 === 0) nums.add(n / 100);
  const unknown: string[] = [];
  for (const n of numbersIn(reply)) if (n > 1 && !nums.has(n)) unknown.push(String(n));
  const words = norm(pool);
  for (const m of reply.matchAll(/\*([^*\n]{2,60})\*/g)) {
    const name = norm(m[1]);
    if (name && !words.includes(name)) unknown.push(m[1]);
  }
  return { ok: unknown.length === 0, unknown: [...new Set(unknown)] };
}
