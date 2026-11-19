// Worker bindings. The Cloudflare types are declared structurally here (only what Relay uses) so the
// same code type-checks and runs under Node for the tests, where the bindings are fakes.

export interface QueueLike<T = unknown> { send(body: T): Promise<void> }
export interface QueueMessage<T = unknown> { id: string; body: T; attempts: number; ack(): void; retry(opts?: { delaySeconds?: number }): void }
export interface MessageBatchLike<T = unknown> { queue: string; messages: readonly QueueMessage<T>[] }
export interface ScheduledEventLike { cron: string; scheduledTime: number }
export interface ExecutionContextLike { waitUntil(promise: Promise<unknown>): void; passThroughOnException?(): void }
export interface R2ObjectBodyLike { body: ReadableStream; httpEtag: string; httpMetadata?: { contentType?: string } }
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: ArrayBuffer | ReadableStream | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}
export interface RateLimiterLike { limit(opts: { key: string }): Promise<{ success: boolean }> }

export type QueueJob =
  | { kind: 'inbound'; eventId: string }
  | { kind: 'outbox'; messageId: string }
  | { kind: 'matchPhotos'; id: string };   // importPhotos/{id}

export interface Env {
  // Plain vars and secrets (strings); validated by parseConfig.
  [key: string]: unknown;
  EVENTS?: QueueLike<QueueJob>;
  PRODUCT_IMAGES?: R2BucketLike;
  RATE_LIMITER?: RateLimiterLike;
}
