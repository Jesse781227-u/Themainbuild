// The owner chooses how their shop talks to customers (MESSAGES, and an optional signup step).
//   MESSAGES → list of message types → one type: what customers get now + 3 samples written for this
//   shop (one text) → list: Option 1 · Option 2 · Option 3 · Write my own · Keep this one
//   → saved, then shown exactly as a customer will see it.
//   Write my own → they type it → checked (length, blanks spelled right) → preview [Save] [Try again]
// Choice ids: msgshow:<key>, msgpick:<key>:<1-3>, msgedit:<key>, msgkeep:<key>, msgsave:<key>.
// While the owner types their own: conversation.awaiting = "msg:<key>"; the typed text waits in
// conversation.msgDraft until Save. The samples shown are kept in conversation.msgSamples so the
// option picked is the option they read.
import { C } from '../db';
import { BUSINESS_TYPES, type Business } from '../domain/business';
import { log } from '../lib/logger';
import type { OutboundContent } from '../services/channel';
import { checkMessage, cleanMessage, DEFAULT_MESSAGES, fallbackSamples, fill, MESSAGE_INFO, MESSAGE_KEYS, SAMPLE_VARS, samplesPrompt, TONES, type MessageKey, type ShopMessages } from '../services/shop-messages';
import { buttons, list } from './common';
import type { FlowCtx, Out } from './products-flow';

const isKey = (k: string): k is MessageKey => (MESSAGE_KEYS as readonly string[]).includes(k);
const typeLabel = (b: Business) => BUSINESS_TYPES.find(t => t.id === b.category)?.label ?? 'small';
const current = (b: Business, key: MessageKey) => b.messages?.[key] || DEFAULT_MESSAGES[key];
// Exactly what a customer sees, with sample values in the blanks.
export const asCustomerSees = (b: Business, text: string) => fill(text, b.name, SAMPLE_VARS);

async function saveMessages(f: FlowCtx, messages: ShopMessages, edited = true) {
  f.business.messages = { ...(f.business.messages ?? {}), ...messages };
  await f.db.update(f.db.doc(C.businesses, f.business.id), { messages: f.business.messages, ...(edited ? { messagesEdited: true } : {}), updatedAt: new Date().toISOString() });
}

async function setConv(f: FlowCtx, patch: Record<string, unknown>) {
  if ('awaiting' in patch) f.state.awaiting = patch.awaiting as string | null;
  await f.db.set(f.convRef, patch, { merge: true });
}

// Three samples (warm · short · Naija) by the AI, or written ones when there's no AI or it fails.
export async function samplesFor(f: FlowCtx, key: MessageKey): Promise<[string, string, string]> {
  const fallback = fallbackSamples(key, f.business);
  if (!f.deps.llm?.writeTexts) return fallback;
  try {
    const out = await f.deps.llm.writeTexts({ prompt: samplesPrompt(f.business, typeLabel(f.business), key), keys: TONES.map(t => t.id) });
    return TONES.map((t, i) => {
      const text = out[t.id] ? cleanMessage(key, out[t.id]) : '';
      return text.length >= 2 && !checkMessage(key, text) ? text : fallback[i];
    }) as [string, string, string];
  } catch (e) {
    log('warn', 'llm_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) });
    return fallback;
  }
}

export function messagesMenu(): OutboundContent {
  return list('How your shop talks to customers. Pick a message to see it and choose new wording:', 'See my messages', MESSAGE_KEYS.map(k => ({ id: `msgshow:${k}`, title: MESSAGE_INFO[k].label, description: MESSAGE_INFO[k].when })), 'Messages');
}

// One message: what customers get now, three samples, then the choice.
export async function showChoices(f: FlowCtx, key: MessageKey, intro = ''): Promise<Out[]> {
  const samples = await samplesFor(f, key);
  await setConv(f, { msgSamples: { key, samples } });
  const info = MESSAGE_INFO[key];
  const text = [
    `${intro}*${info.label}* — sent ${info.when}.`,
    `Now:\n${asCustomerSees(f.business, current(f.business, key))}`,
    ...samples.map((s, i) => `*Option ${i + 1}* (${TONES[i].label})\n${asCustomerSees(f.business, s)}`),
  ].join('\n\n');
  return [text.slice(0, 4000), list('Which one should customers get?', 'Choose wording', [
    ...samples.map((_, i) => ({ id: `msgpick:${key}:${i + 1}`, title: `Option ${i + 1}`, description: TONES[i].label })),
    { id: `msgedit:${key}`, title: 'Write my own' },
    { id: `msgkeep:${key}`, title: 'Keep the current one' },
  ], info.label)];
}

const saved = (f: FlowCtx, key: MessageKey) => `Saved ✅ Here's exactly how customers will see your *${MESSAGE_INFO[key].label.toLowerCase()}* message:\n\n${asCustomerSees(f.business, current(f.business, key))}`;

// Taps and typed text for this flow. done = the owner settled that message (signup moves on).
export async function handleMessageInput(f: FlowCtx, choiceId: string | null, text: string): Promise<{ out: Out[]; done?: MessageKey } | null> {
  // Their own wording: check it, then show it before saving.
  if (!choiceId && f.state.awaiting?.startsWith('msg:') && text.trim()) {
    const key = f.state.awaiting.slice(4);
    if (!isKey(key)) { await setConv(f, { awaiting: null }); return null; }
    const problem = checkMessage(key, text);
    if (problem) return { out: [problem] };
    const draft = cleanMessage(key, text);
    await setConv(f, { awaiting: null, msgDraft: { key, text: draft } });
    return { out: [buttons(`Here's how customers will see it:\n\n${asCustomerSees(f.business, draft)}`, [[`msgsave:${key}`, 'Save'], [`msgedit:${key}`, 'Try again']])] };
  }
  if (!choiceId) return null;
  if (choiceId === 'msgmenu') return { out: [messagesMenu()] };
  const [kind, key, n] = choiceId.split(':');
  if (!['msgshow', 'msgpick', 'msgedit', 'msgkeep', 'msgsave', 'msgok', 'msgnew', 'msgreset'].includes(kind)) return null;
  if (!key || !isKey(key)) return { out: ['That message no longer exists. Send MESSAGES to see them.'] };
  if (kind === 'msgshow' || kind === 'msgnew') return { out: await showChoices(f, key) };
  if (kind === 'msgpick') {
    const conv = await f.db.get(f.convRef);
    const shown = conv?.msgSamples as { key: string; samples: string[] } | undefined;
    const pick = shown?.key === key ? shown.samples[Number(n) - 1] : fallbackSamples(key, f.business)[Number(n) - 1];
    if (!pick) return { out: await showChoices(f, key) };
    await saveMessages(f, { [key]: pick });
    await setConv(f, { msgSamples: null, awaiting: null });
    return { out: [saved(f, key)], done: key };
  }
  if (kind === 'msgsave') {
    const conv = await f.db.get(f.convRef);
    const draft = conv?.msgDraft as { key: string; text: string } | undefined;
    if (!draft || draft.key !== key) return { out: ['That message was already saved. Send MESSAGES to see them.'] };
    await saveMessages(f, { [key]: draft.text });
    await setConv(f, { msgDraft: null });
    return { out: [saved(f, key)], done: key };
  }
  if (kind === 'msgkeep' || kind === 'msgok') { await setConv(f, { awaiting: null, msgSamples: null }); return { out: [`👍 Keeping your *${MESSAGE_INFO[key].label.toLowerCase()}* message as it is.`], done: key }; }
  if (kind === 'msgreset') { await saveMessages(f, { [key]: DEFAULT_MESSAGES[key] }); return { out: [saved(f, key)], done: key }; }
  // msgedit: they'll type their own.
  await setConv(f, { awaiting: `msg:${key}` });
  const blanks = MESSAGE_INFO[key].blanks.map(b => `{${b}}`).join(', ');
  return { out: [`Type your *${MESSAGE_INFO[key].label.toLowerCase()}* message (under 300 characters). You can use ${blanks} and I'll fill them in, e.g. {customer_name} becomes the customer's first name.`] };
}
