// Learning from the owner's own replies. When the owner answers a customer from the WhatsApp
// Business app (a coexistence echo), the customer's last question and the owner's answer are kept
// as an example; the shop assistant is shown the newest ones so it answers the way the owner does.
// Phone numbers and emails are removed, and no names or customer ids are stored with an example.
// Facts (prices, stock, payment details) still come only from the shop's data; the prompt says so.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';

export interface OwnerExample { q: string; a: string; at: string }
export const EXAMPLES_KEPT = 30;
export const EXAMPLES_SHOWN = 8;
const Q_MAX = 240, A_MAX = 320, PAIR_WINDOW_MS = 24 * 3_600_000;

export const scrub = (s: string) => s
  .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
  .replace(/\+?\d[\d\s-]{7,}\d/g, '[number]')
  .replace(/\s+/g, ' ')
  .trim();

// Called for each owner echo with text. Consecutive owner messages after one question are one answer.
export async function learnFromOwner(db: Firestore, businessId: string, conversationId: string, text: string, now = new Date()): Promise<OwnerExample | null> {
  const answer = scrub(text);
  if (answer.length < 2) return null;
  const convRef = db.doc(C.conversations, conversationId), bizRef = db.doc(C.businesses, businessId);
  const [conv, biz] = await db.getAll([convRef, bizRef]);
  const ask = conv?.lastAsk as { t?: string; at?: string; id?: string } | undefined;
  const askKey = ask?.id ?? ask?.at;
  if (!ask?.t || !ask.at || now.getTime() - new Date(ask.at).getTime() > PAIR_WINDOW_MS) return null;
  const list = (Array.isArray(biz?.ownerExamples) ? biz!.ownerExamples : []) as OwnerExample[];
  const at = now.toISOString();
  // Already answered this question: the owner is still typing their answer, so add to it.
  if (conv?.lastAskAnswered === askKey && conv?.lastExampleAt) {
    const i = list.findIndex(e => e.at === conv.lastExampleAt);
    if (i >= 0) {
      list[i] = { ...list[i], a: `${list[i].a} ${answer}`.slice(0, A_MAX) };
      await db.update(bizRef, { ownerExamples: list });
      return list[i];
    }
  }
  const question = scrub(ask.t).slice(0, Q_MAX);
  if (question.length < 2) return null;
  const example: OwnerExample = { q: question, a: answer.slice(0, A_MAX), at };
  await db.update(bizRef, { ownerExamples: [example, ...list].slice(0, EXAMPLES_KEPT) });
  await db.set(convRef, { lastAskAnswered: askKey, lastExampleAt: at }, { merge: true });
  return example;
}

// For the shop assistant's context: the newest examples first.
export function examplesBlock(examples: unknown): string {
  const list = (Array.isArray(examples) ? examples : []).slice(0, EXAMPLES_SHOWN) as OwnerExample[];
  if (!list.length) return '';
  return [
    'How the owner answers customers (newest first). Follow their wording, tone and way of answering; prices, stock, delivery fees and payment details come only from the catalogue and tools, never from these:',
    ...list.map(e => `Q: ${e.q}\nA: ${e.a}`),
  ].join('\n');
}
