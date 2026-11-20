// Conversation memory for the agent: the last 20 messages of a chat (what the person said, what
// Relay replied, and which tools it used), plus a short running summary of anything older. Kept on
// the conversation doc and wiped 90 days after the last message (agentExpireAt, daily job).
import { C } from '../db';
import type { Firestore } from '../lib/firestore';

export const MEMORY_TURNS = 20;
export const MEMORY_DAYS = 90;
const SUMMARY_MAX = 800;

export interface MemoryTurn { r: 'u' | 'a'; t: string; at: string; tools?: string | null }
export interface AgentMemory { turns: MemoryTurn[]; summary: string | null }

export async function loadMemory(db: Firestore, conversationId: string): Promise<AgentMemory> {
  const conv = await db.get(db.doc(C.conversations, conversationId));
  const m = (conv?.agent ?? null) as AgentMemory | null;
  return { turns: Array.isArray(m?.turns) ? m!.turns : [], summary: m?.summary ?? null };
}

// Adds this exchange; anything past 20 messages is folded into the summary (oldest first).
export function remember(m: AgentMemory, user: string, assistant: string, tools: string[], now = new Date()): AgentMemory {
  const at = now.toISOString();
  const turns = [...m.turns, { r: 'u' as const, t: user.slice(0, 600), at }, { r: 'a' as const, t: assistant.slice(0, 600), at, tools: tools.length ? tools.join(',') : null }];
  const old = turns.splice(0, Math.max(0, turns.length - MEMORY_TURNS));
  const folded = old.map(x => `${x.r === 'u' ? 'Them' : 'Relay'}: ${x.t.replace(/\s+/g, ' ').slice(0, 120)}`).join(' | ');
  const summary = folded ? `${m.summary ? `${m.summary} | ` : ''}${folded}`.slice(-SUMMARY_MAX) : m.summary;
  return { turns, summary };
}

export async function saveMemory(db: Firestore, conversationId: string, m: AgentMemory, now = new Date()) {
  await db.set(db.doc(C.conversations, conversationId), { agent: { turns: m.turns, summary: m.summary }, agentExpireAt: new Date(now.getTime() + MEMORY_DAYS * 86_400_000).toISOString() }, { merge: true });
}

// Daily: chats nobody has written in for 90 days lose their memory (orders and receipts stay).
export async function forgetOldChats(db: Firestore, now = new Date(), limit = 500) {
  const due = await db.query(C.conversations, [['agentExpireAt', '<=', now.toISOString()]], { limit });
  for (const c of due) await db.set(db.doc(C.conversations, c._id), { agent: null, agentExpireAt: null }, { merge: true });
  return due.length;
}
