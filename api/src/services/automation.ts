// The Admin Bot number's own WhatsApp command list ("/" in the chat) and ice breakers, set through
// Meta's Conversational Automation API from the action registry (bots/actions.ts). Run on purpose
// (npm run sync:commands), not on every start. Customer numbers get none (owner's choice).
import { commandsPayload } from '../bots/actions';

export interface SyncTarget { graphVersion: string; phoneNumberId: string; accessToken: string }

export async function syncCommands(t: SyncTarget, doFetch: typeof fetch = (...a) => fetch(...a)) {
  const payload = commandsPayload(); // throws COMMANDS_INVALID before anything is sent
  const res = await doFetch(`https://graph.facebook.com/${t.graphVersion}/${encodeURIComponent(t.phoneNumberId)}/conversational_automation`, {
    method: 'POST',
    headers: { authorization: `Bearer ${t.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { message?: string; code?: number } };
  if (!res.ok || body.error) throw new Error(`META_SYNC_FAILED: ${res.status} ${body.error?.code ?? ''} ${String(body.error?.message ?? '').slice(0, 200)}`.trim());
  return { commands: payload.commands.length, prompts: payload.prompts.length };
}
