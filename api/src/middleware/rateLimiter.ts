import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';

// Webhooks are exempt: Meta and the payment provider deliver from a small pool of shared IPs, so a
// per-IP limit would reject legitimate bursts. Those routes are protected by signature checks instead.
export const isWebhookPath = (path: string) => path.startsWith('/api/v1/webhooks/');

// Uses the Workers Rate Limiting binding when it is configured (wrangler.toml [[ratelimits]]).
export const rateLimiter: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const limiter = c.env?.RATE_LIMITER;
  if (!limiter || isWebhookPath(c.req.path)) return next();
  // The local test chat polls every second from two tabs; it only exists in development.
  if (c.env.RELAY_ENV === 'development' && (c.req.path === '/dev' || c.req.path.startsWith('/dev/'))) return next();
  const key = c.req.header('cf-connecting-ip') ?? 'unknown';
  const { success } = await limiter.limit({ key });
  if (!success) return c.json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }, 429);
  return next();
};
