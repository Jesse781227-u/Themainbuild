// Cloudflare Worker entry: HTTP (webhooks, health, media), the queue consumer, and Cron Triggers.
import { createApp } from './app';
import { getConfig } from './config';
import type { Env, ExecutionContextLike, MessageBatchLike, QueueJob, ScheduledEventLike } from './env';
import { runScheduled } from './services/jobs';
import { handleQueueBatch } from './services/queue';

const app = createApp();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike) {
    getConfig(env); // fail closed on bad config before handling anything
    return app.fetch(request, env, ctx as never);
  },
  async queue(batch: MessageBatchLike<QueueJob>, env: Env) {
    await handleQueueBatch(batch, env);
  },
  async scheduled(event: ScheduledEventLike, env: Env) {
    await runScheduled(event, env);
  },
};
