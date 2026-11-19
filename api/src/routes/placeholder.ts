// GET /ph/<colour>/<letter>.png — the stand-in picture for a product without a photo.
import { Hono } from 'hono';
import type { Env } from '../env';
import { placeholderPng, SHOP_COLOURS } from '../services/placeholder';

export function placeholderRoutes() {
  const r = new Hono<{ Bindings: Env }>();
  r.get('/:hex/:file', async c => {
    const hex = c.req.param('hex');
    const m = /^([A-Z0-9])\.png$/.exec(c.req.param('file'));
    if (!m || !(SHOP_COLOURS as readonly string[]).includes(hex)) return c.body(null, 404);
    const png = await placeholderPng(hex, m[1]);
    return c.body(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, 200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' });
  });
  return r;
}
