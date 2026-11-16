// Cloudflare Queue consumer. Each message is acked once handled, or retried with backoff; Queues
// gives up after max_retries (wrangler.toml) and moves it to the dead-letter queue.
import { getConfig } from '../config';
import { getDb } from '../db';
import type { Env, MessageBatchLike, QueueJob } from '../env';
import { log } from '../lib/logger';
import { graphTransport, type Transport } from './channel';
import { claimEvent, markFailed, markProcessed } from './inbound';
import { processOutbox } from './outbox';
import { placeholderHandlers, routeEvent, type Handlers } from './router';

export interface QueueDeps { handlers?: Handlers; transport?: Transport; now?: () => Date }

const backoff = (attempts: number) => Math.min(30 * 2 ** Math.max(0, attempts - 1), 900);

export async function handleQueueBatch(batch: MessageBatchLike<QueueJob>, env: Env, deps: QueueDeps = {}) {
  const db = getDb(env);
  const cfg = getConfig(env);
  const handlers = deps.handlers ?? placeholderHandlers;
  const transport = deps.transport ?? graphTransport(cfg);
  for (const msg of batch.messages) {
    const job = msg.body;
    try {
      if (job.kind === 'inbound') {
        const claim = await claimEvent(db, job.eventId, deps.now?.());
        if (claim.state === 'busy') { msg.retry({ delaySeconds: 30 }); continue; }
        if (claim.state !== 'claimed') { msg.ack(); continue; }
        try {
          const route = await routeEvent(db, cfg, claim.event, handlers);
          await markProcessed(db, claim.event.id, route);
          msg.ack();
        } catch (e) {
          const final = await markFailed(db, claim.event, e);
          log('error', 'inbound_failed', { eventId: claim.event.id, attempt: claim.event.attempts, final, error: String(e instanceof Error ? e.message : e).slice(0, 200) });
          if (final) msg.ack(); else msg.retry({ delaySeconds: backoff(claim.event.attempts) });
        }
      } else if (job.kind === 'outbox') {
        const result = await processOutbox(db, cfg, transport, job.messageId, deps.now?.());
        if (result === 'retry' || result === 'busy') msg.retry({ delaySeconds: result === 'busy' ? 30 : backoff(msg.attempts) });
        else msg.ack();
      } else {
        msg.ack();
      }
    } catch (e) {
      // Infrastructure failure (e.g. Firestore unreachable) before the job was claimed.
      log('error', 'queue_job_error', { kind: (job as QueueJob)?.kind, error: String(e instanceof Error ? e.message : e).slice(0, 200) });
      msg.retry({ delaySeconds: backoff(msg.attempts) });
    }
  }
}

export async function enqueue(env: Env, jobs: QueueJob[]) {
  if (!jobs.length) return;
  if (!env.EVENTS) { log('warn', 'queue_binding_missing', { jobs: jobs.length }); return; } // the sweep picks them up
  for (const job of jobs) await env.EVENTS.send(job);
}
