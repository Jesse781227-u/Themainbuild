// Cron Triggers (wrangler.toml [triggers]). Cron times are UTC; Lagos is UTC+1.
import { C, getDb } from '../db';
import { queueDailySummaries } from './summary';
import { queueMorningBriefs } from './morning-brief';
import type { Env, ScheduledEventLike } from '../env';
import { log } from '../lib/logger';
import { findStuckEvents } from './inbound';
import { releaseExpiredHolds } from './orders';
import { findStuckOutbox } from './outbox';
import { enqueue } from './queue';
import { connectReminders, dayTwoNudges } from './nudges';
import { getConfig } from '../config';
import { dueStatusReports } from './status-posts';
import { abandonedCarts, releaseQueuedSends } from './reach';
import { dueCampaignReports } from './reach-results';
import { refreshSegments } from './segments';
import { activeShops } from './active-shops';
import { forgetOldChats } from '../bots/agent-memory';
import { afterDelivery, dailyReach, weeklySummaries } from './reach-triggers';

export const CRON_EVERY_MINUTE = '* * * * *';
export const CRON_DAILY_SUMMARY = '0 19 * * *'; // 20:00 Africa/Lagos
export const CRON_MORNING_BRIEF = '0 6 * * *'; // 07:00 Africa/Lagos

export async function runScheduled(event: ScheduledEventLike, env: Env) {
  const now = new Date(event.scheduledTime);
  const db = getDb(env);
  if (event.cron === CRON_MORNING_BRIEF) {
    const ids = await queueMorningBriefs(db, now);
    await enqueue(env, ids.map(messageId => ({ kind: 'outbox' as const, messageId })));
    log('info', 'morning_briefs_queued', { count: ids.length });
    return { briefs: ids.length };
  }
  if (event.cron === CRON_DAILY_SUMMARY) {
    const ids = await queueDailySummaries(db, now);
    const nudges = await dayTwoNudges(db, now);
    // Smart Reach: Relay's suggestions, regulars / win-back, and Monday's weekly summary.
    const cfg = getConfig(env);
    const reach = [...(await dailyReach(db, cfg, { enqueue: jobs => enqueue(env, jobs) }, now)), ...(await weeklySummaries(db, now))];
    // Smart Reach: every live shop's group sizes, fresh each night.
    for await (const b of activeShops(db)) await refreshSegments(db, b.id, now).catch(() => undefined);
    // Chat memory is kept 90 days after the last message, then forgotten.
    await forgetOldChats(db, now).catch(() => 0);
    await enqueue(env, [...ids, ...nudges, ...reach].map(messageId => ({ kind: 'outbox' as const, messageId })));
    log('info', 'daily_summaries_queued', { count: ids.length, nudges: nudges.length });
    return { summaries: ids.length, nudges: nudges.length };
  }
  const released = await releaseExpiredHolds(db, now);
  const events = await findStuckEvents(db, now);
  const outbox = await findStuckOutbox(db, now);
  const reminders = await connectReminders(db, getConfig(env), now);
  const statusReports = await dueStatusReports(db, now);
  // Smart Reach: updates that waited for 8am, and carts left for an hour.
  const cfg = getConfig(env);
  const reachIds = await releaseQueuedSends(db, cfg, now);
  await abandonedCarts(db, cfg, { enqueue: jobs => enqueue(env, jobs) }, now);
  if (now.getUTCMinutes() === 0) await afterDelivery(db, cfg, { enqueue: jobs => enqueue(env, jobs) }, now); // hourly
  const reachReports = await dueCampaignReports(db, now);
  await enqueue(env, [...events.map(eventId => ({ kind: 'inbound' as const, eventId })), ...[...outbox, ...reminders, ...statusReports, ...reachIds, ...reachReports].map(messageId => ({ kind: 'outbox' as const, messageId }))]);
  if (released || events.length || outbox.length) log('info', 'sweep', { released, requeuedEvents: events.length, requeuedOutbox: outbox.length });
  return { released, requeuedEvents: events.length, requeuedOutbox: outbox.length };
}
