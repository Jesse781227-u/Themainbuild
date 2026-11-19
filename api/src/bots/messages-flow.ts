// Drafting and editing the shop's own messages (welcome, payment thank-you, …) by chat.
//   AI draft → "*Welcome message* … [Use this] [Edit] [Try another]" → saved on the business.
// Choice ids: msgok:<key>, msgedit:<key>, msgnew:<key>, msgshow:<key>, msgreset:<key>.
// While the owner is typing their own version, conversation.awaiting = "msg:<key>".
import { C } from '../db';
import { BUSINESS_TYPES, type Business } from '../domain/business';
import { log } from '../lib/logger';
import type { OutboundContent } from '../services/channel';
import { cleanMessage, DEFAULT_MESSAGES, draftPrompt, MESSAGE_INFO, MESSAGE_KEYS, renderMessage, type MessageKey, type ShopMessages } from '../services/shop-messages';
import { buttons, list } from './common';
import type { FlowCtx, Out } from './products-flow';

const isKey = (k: string): k is MessageKey => (MESSAGE_KEYS as readonly string[]).includes(k);
const typeLabel = (b: Business) => BUSINESS_TYPES.find(t => t.id === b.category)?.label ?? 'small';
const SAMPLE = { customer: 'Ada', order: 'RLY-7KQ2M', amount: '₦12,500' };

async function saveMessages(f: FlowCtx, messages: ShopMessages, edited = true) {
  f.business.messages = { ...(f.business.messages ?? {}), ...messages };
  await f.db.update(f.db.doc(C.businesses, f.business.id), { messages: f.business.messages, ...(edited ? { messagesEdited: true } : {}), updatedAt: new Date().toISOString() });
}

async function setAwaiting(f: FlowCtx, value: string | null) {
  f.state.awaiting = value;
  await f.db.set(f.convRef, { awaiting: value }, { merge: true });
}

// AI drafts in the shop's voice; the defaults when there's no AI or it fails.
async function draft(f: FlowCtx, only?: MessageKey): Promise<ShopMessages> {
  const keys = only ? [only] : [...MESSAGE_KEYS];
  if (f.deps.llm?.writeTexts) {
    try {
      const out = await f.deps.llm.writeTexts({ prompt: draftPrompt(f.business, typeLabel(f.business), only), keys });
      const cleaned = Object.fromEntries(keys.filter(k => out[k]).map(k => [k, cleanMessage(k, out[k])]).filter(([, v]) => v)) as ShopMessages;
      if (Object.keys(cleaned).length) return { ...Object.fromEntries(keys.map(k => [k, DEFAULT_MESSAGES[k]])), ...cleaned };
    } catch (e) { log('warn', 'llm_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); }
  }
  if (only) return { [only]: DEFAULT_MESSAGES[only] };
  return { ...DEFAULT_MESSAGES };
}

// Drafts all five and saves them (signup). Returns nothing; review() shows them one at a time.
export async function draftAllMessages(f: FlowCtx) {
  await saveMessages(f, await draft(f), false);
}

export function review(f: FlowCtx, key: MessageKey, intro = ''): OutboundContent {
  const info = MESSAGE_INFO[key];
  const text = f.business.messages?.[key] || DEFAULT_MESSAGES[key];
  const blanks = /\{\w+\}/.test(text) ? `\n\nHow a customer sees it:\n${renderMessage(f.business, key, SAMPLE)}` : '';
  return buttons(`${intro}*${info.label} message* (sent ${info.when}):\n\n${text}${blanks}`.slice(0, 1000), [[`msgok:${key}`, 'Use this'], [`msgedit:${key}`, 'Edit'], [`msgnew:${key}`, 'Try another']]);
}

export function messagesMenu(): OutboundContent {
  return list('Your messages to customers. Pick one to see or change it:', 'Messages', MESSAGE_KEYS.map(k => ({ id: `msgshow:${k}`, title: MESSAGE_INFO[k].label, description: MESSAGE_INFO[k].when.slice(0, 72) })), 'Messages');
}

// Taps and typed text for this flow. done = the owner approved that message (signup moves on).
export async function handleMessageInput(f: FlowCtx, choiceId: string | null, text: string): Promise<{ out: Out[]; done?: MessageKey } | null> {
  // The owner's own version of a message.
  if (!choiceId && f.state.awaiting?.startsWith('msg:') && text.trim()) {
    const key = f.state.awaiting.slice(4);
    if (!isKey(key)) { await setAwaiting(f, null); return null; }
    const cleaned = cleanMessage(key, text);
    if (cleaned.length < 2) return { out: ['Please type the message you want customers to get.'] };
    await setAwaiting(f, null);
    await saveMessages(f, { [key]: cleaned });
    return { out: [review(f, key, 'Saved ✅\n\n')] };
  }
  if (!choiceId) return null;
  const [kind, key] = choiceId.split(':');
  if (!['msgok', 'msgedit', 'msgnew', 'msgshow', 'msgreset'].includes(kind)) return null;
  if (!key || !isKey(key)) return { out: ['That message no longer exists. Send MESSAGES to see them.'] };
  if (kind === 'msgok') { await setAwaiting(f, null); return { out: [], done: key }; }
  if (kind === 'msgshow') return { out: [review(f, key)] };
  if (kind === 'msgreset') { await saveMessages(f, { [key]: DEFAULT_MESSAGES[key] }); return { out: [review(f, key, 'Back to the standard wording.\n\n')] }; }
  if (kind === 'msgedit') {
    await setAwaiting(f, `msg:${key}`);
    const blanks = MESSAGE_INFO[key].blanks.map(b => `{${b}}`).join(', ');
    return { out: [`Type your ${MESSAGE_INFO[key].label.toLowerCase()} message. You can use ${blanks} and I'll fill them in (e.g. {customer} becomes the customer's first name).`] };
  }
  // msgnew: a fresh AI version of just this one.
  await saveMessages(f, await draft(f, key));
  return { out: [review(f, key)] };
}
