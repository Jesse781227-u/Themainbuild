// Typed answers to the buttons waiting in the owner chat: "yeah, add them" to [Add all] [Don't add
// these] is the first tap, "nah leave it" the second, "just lagos" to [Yes, other states] [No, just
// nearby] the second. Checked before any other reading of the message, so a short yes or no is never
// taken for something else ("Which product and price would you like to add?").
//   1. the words of a button (or most of them)
//   2. yes (yeah, ok, sure, looks good, add them…) → the button that isn't a "no"; no (nah, don't,
//      leave it…) → the "no" button. Only when the buttons make that clear: one "no" button, or two
//      buttons in all.
//   3. a word only one button has ("just lagos" → "No, just nearby")
// Longer messages are left to the rest of the bot (and the AI).
import { NO, YES } from './common';

export interface ButtonOption { id: string; title: string }

const CANCELISH = /^(no\b|nope|don'?t|do not|cancel|not now|later|skip|leave|keep|never ?mind|change|fix)/i;
const LOOKS_GOOD = /^\s*(looks? (good|great|right|fine)|all good|perfect|great|nice|good|lovely|sweet|correct|that'?s right|e correct|add (them|it|all)|save (them|it|all)|go on)\b/i;
const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'my', 'pls', 'please', 'abeg', 'just', 'yes', 'yeah', 'no', 'nah', 'its', 'it', 'that', 'this', 'one', 'them', 'all']);
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const words = (s: string) => norm(s).split(' ').filter(w => w.length >= 3 && !STOP.has(w));

export function matchButton(text: string, options: ButtonOption[]): string | null {
  const t = norm(text);
  if (!t || !options.length) return null;
  const n = t.split(' ').length;
  if (n > 6) return null;
  // 1. A button's own words.
  const exact = options.find(o => norm(o.title) === t);
  if (exact) return exact.id;
  // 2. Yes / no, when the buttons make it clear.
  const cancels = options.filter(o => CANCELISH.test(o.title.trim()));
  const others = options.filter(o => !CANCELISH.test(o.title.trim()));
  const clear = cancels.length === 1 || options.length === 2;
  if (n <= 4 && clear) {
    const yes = YES.test(text) || LOOKS_GOOD.test(text);
    // "just lagos", "only nearby" to a yes/no question: the no.
    const no = (NO.test(text) && !/^\s*no (wahala|problem)\b/i.test(text)) || (/^\s*(just|only)\b/i.test(text) && cancels.length === 1);
    if (no && !yes) return (cancels[0] ?? options[options.length - 1]).id;
    if (yes && !no && (cancels.length === 1 ? others.length >= 1 : true)) return (others[0] ?? options[0]).id;
  }
  // 3. Every word they wrote is in one button only ("customers" → "Customers pay"). A word shared
  //    with a button isn't enough ("hours whenever" is a command, not "Change hours").
  const said = words(text);
  if (!said.length || n > 3) return null;
  const hits = options.filter(o => { const w = norm(o.title).split(' '); return said.every(s => w.includes(s)); });
  return hits.length === 1 ? hits[0].id : null;
}
