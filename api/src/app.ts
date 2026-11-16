import { Hono } from 'hono';
import { ZodError } from 'zod';
import type { Env } from './env';
import { log } from './lib/logger';
import { rateLimiter } from './middleware/rateLimiter';
import { health } from './routes/health';
import { media } from './routes/media';
import { webhooks } from './routes/webhooks';
import type { BachsAdapter } from './services/bachs';

// Static files in public/ (Privacy, Terms, Data Deletion) are served by Workers Assets before the
// Worker runs, so they never reach this app.
export function createApp(deps: { bachs?: BachsAdapter } = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') || crypto.randomUUID();
    c.set('requestId', requestId);
    const started = Date.now();
    await next();
    c.header('x-request-id', requestId);
    c.header('x-content-type-options', 'nosniff');
    c.header('x-frame-options', 'DENY');
    c.header('referrer-policy', 'strict-origin-when-cross-origin');
    const status = c.res.status;
    log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'http_request', { requestId, method: c.req.method, path: c.req.path, statusCode: status, durationMs: Date.now() - started });
  });
  app.use('*', rateLimiter);

  app.route('/health', health);
  app.route('/media', media);
  app.route('/api/v1/webhooks', webhooks(deps));

  app.notFound(c => c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404));
  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request.' } }, 400);
    log('error', 'request_error', { requestId: c.get('requestId'), method: c.req.method, path: c.req.path, error: String(err instanceof Error ? err.message : err).slice(0, 300) });
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } }, 500);
  });
  return app;
}
