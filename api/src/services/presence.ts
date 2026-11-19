// What people see while Relay works on their message:
//   1. typing: their message turns blue-ticked and the chat shows "typing…" until we reply (WhatsApp
//      shows it for up to 25 seconds). Sent as soon as a message is picked up.
//   2. ⏳ → ✅ on their message for slow jobs (reading a menu, listening to a voice note).
//   3. one "still working" message if a slow job passes 20 seconds.
// None of these are allowed to break the reply: failures are logged and ignored.
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import { log } from '../lib/logger';
import { resolveSender, send, type Transport } from './channel';

type From = { adminBot: true } | { businessId: string };
export const STILL_WORKING_MS = 20_000;

export async function showTyping(db: Firestore, cfg: Config, transport: Transport, from: From, to: string, messageId: string | null | undefined) {
  if (!messageId) return;
  try {
    const sender = await resolveSender(db, cfg, from);
    await transport.markTyping(sender, messageId);
    // The local test chat shows it too.
    if (cfg.RELAY_ENV === 'development' && cfg.META_SEND_MODE === 'log') {
      const at = new Date().toISOString();
      await db.set(db.doc(C.devMessages, `${at}_${crypto.randomUUID()}`), { phone: to, botNumber: sender.phoneNumberId, direction: 'out', content: { type: 'typing', messageId }, at });
    }
  } catch (e) { log('warn', 'typing_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); }
}

// An emoji on the person's own message ('' takes it off).
export async function react(db: Firestore, cfg: Config, transport: Transport, args: { from: From; conversationId: string; to: string; messageId: string | null | undefined; emoji: string }) {
  if (!args.messageId) return;
  try { await send(db, cfg, transport, { from: args.from, conversationId: args.conversationId, to: args.to, content: { type: 'reaction', messageId: args.messageId, emoji: args.emoji } }); }
  catch (e) { log('warn', 'reaction_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); }
}

// Runs a slow job: ⏳ on the message while it runs, ✅ when it worked (taken off if it failed), and
// one "still working" message if it takes longer than STILL_WORKING_MS.
export async function slowJob<T>(job: () => Promise<T>, ui: { react?: (emoji: string) => Promise<unknown>; stillWorking?: () => Promise<unknown>; ok?: (result: T) => boolean }, afterMs = STILL_WORKING_MS): Promise<T> {
  await ui.react?.('⏳');
  const timer = ui.stillWorking ? setTimeout(() => { ui.stillWorking!().catch(() => undefined); }, afterMs) : null;
  try {
    const result = await job();
    await ui.react?.(ui.ok && !ui.ok(result) ? '' : '✅');
    return result;
  } catch (e) {
    await ui.react?.('');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
