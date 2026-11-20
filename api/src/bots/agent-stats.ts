// Per shop, per day: agent messages, fallbacks, tokens and the estimated AI cost (agentStats/
// {businessId}_{date}). No cap (the owner's choice); it's tracked and shown. When fallbacks reach
// AGENT_FALLBACK_ALERT in a day, the owner gets one short note.
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import { increment } from '../lib/firestore';
import { lagosDate } from '../lib/time';
import { log } from '../lib/logger';
import type { Business } from '../domain/business';
import { adminConversationId } from '../services/conversations';
import type { AgentFail, AgentRun } from './agent';

// Cost in kobo, from the token counts and the configured Gemini prices.
export const costKobo = (cfg: Pick<Config, 'GEMINI_IN_USD_PER_M' | 'GEMINI_OUT_USD_PER_M' | 'NGN_PER_USD'>, u: { inTokens: number; outTokens: number }) =>
  Math.round(((u.inTokens * cfg.GEMINI_IN_USD_PER_M + u.outTokens * cfg.GEMINI_OUT_USD_PER_M) / 1_000_000) * cfg.NGN_PER_USD * 100 * 100) / 100;

export async function recordAgentTurn(db: Firestore, cfg: Config, business: Pick<Business, 'id' | 'ownerPhone'>, bot: 'shop' | 'admin', r: AgentRun | AgentFail, now = new Date()) {
  const date = lagosDate(now);
  const failed = 'failed' in r;
  const kobo = costKobo(cfg, r.usage);
  const id = `${business.id}_${date}`;
  await db.set(db.doc(C.agentStats, id), {
    businessId: business.id, date, [`${bot}Turns`]: increment(1), fallbacks: increment(failed ? 1 : 0),
    inTokens: increment(r.usage.inTokens), outTokens: increment(r.usage.outTokens), costKobo: increment(kobo), ms: increment(r.usage.ms), updatedAt: now.toISOString(),
  }, { merge: true });
  log(failed ? 'warn' : 'info', 'agent_turn', { businessId: business.id, bot, ...(failed ? { failed: r.failed } : {}), steps: r.usage.steps, ms: r.usage.ms, inTokens: r.usage.inTokens, outTokens: r.usage.outTokens, costKobo: kobo, tools: r.calls.map(c => c.name).join(',') });
  if (!failed || !business.ownerPhone) return;
  const stats = await db.get(db.doc(C.agentStats, id));
  if (Number(stats?.fallbacks ?? 0) < cfg.AGENT_FALLBACK_ALERT) return;
  const mid = `${business.id}_agentfallback_${date}`;
  await db.create(db.doc(C.outbox, mid), {
    id: mid, businessId: business.id, audience: 'owner', channel: 'whatsapp', to: business.ownerPhone, conversationId: adminConversationId(business.ownerPhone), kind: 'agent_fallback',
    text: `ℹ️ Today Relay's assistant couldn't answer ${stats?.fallbacks} customer messages in its own words, so it used the menus and buttons instead. Nothing was lost; this is just so you know.`,
    status: 'pending', attempts: 0, createdAt: now.toISOString(),
  }).catch(() => false);
}

// The test chat's debug panel (development only): what the agent did for each message.
export async function debugNote(db: Firestore, cfg: Pick<Config, 'RELAY_ENV'>, args: { phone: string; botNumber: string; r: AgentRun | AgentFail }) {
  if (cfg.RELAY_ENV !== 'development') return;
  const r = args.r;
  const at = new Date().toISOString();
  const text = [
    'failed' in r ? `🛠 agent fell back: ${r.failed}${r.detail ? ` (${r.detail})` : ''}` : `🛠 agent ok${r.facts.retried ? ' (rewritten once by the fact check)' : ''}`,
    r.calls.length ? `tools: ${r.calls.map(c => `${c.name}(${JSON.stringify(c.args).slice(0, 80)})${c.ok ? '' : ' ✗'}`).join(' → ')}` : 'tools: none',
    `${r.usage.steps} steps · ${r.usage.ms} ms · ${r.usage.inTokens}+${r.usage.outTokens} tokens`,
  ].join('\n');
  await db.set(db.doc(C.devMessages, `${at}_${crypto.randomUUID()}`), { phone: args.phone, botNumber: args.botNumber, direction: 'debug', content: { type: 'text', text }, at });
}
