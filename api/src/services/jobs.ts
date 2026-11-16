// Cron Triggers (wrangler.toml [triggers]). Cron times are UTC; Lagos is UTC+1.
import { getDb } from '../db';
import type { Env, ScheduledEventLike } from '../env';
import { log } from '../lib/logger';
import { findStuckEvents } from './inbound';
import { releaseExpiredHolds } from './orders';
import { findStuckOutbox } from './outbox';
import { enqueue } from './queue';

export const CRON_EVERY_MINUTE = '* * * * *';
export const CRON_DAILY_SUMMARY = '0 19 * * *'; // 20:00 Africa/Lagos

export async function runScheduled(event: ScheduledEventLike, env: Env) {
  const now = new Date(event.scheduledTime);
  const db = getDb(env);
  if (event.cron === CRON_DAILY_SUMMARY) {
    // Phase 4 (C19): build and send each owner's daily summary from dailyStats.
    log('info', 'daily_summary_pending_phase4', {});
    return { summaries: 0 };
  }
  const released = await releaseExpiredHolds(db, now);
  const events = await findStuckEvents(db, now);
  const outbox = await findStuckOutbox(db, now);
  await enqueue(env, [...events.map(eventId => ({ kind: 'inbound' as const, eventId })), ...outbox.map(messageId => ({ kind: 'outbox' as const, messageId }))]);
  if (released || events.length || outbox.length) log('info', 'sweep', { released, requeuedEvents: events.length, requeuedOutbox: outbox.length });
  return { released, requeuedEvents: events.length, requeuedOutbox: outbox.length };
}
