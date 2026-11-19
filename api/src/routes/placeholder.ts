// GET /ph/<colour>/<letter>.png — the stand-in picture for a product without a photo.
import { Hono } from 'hono';
import type { Env } from '../env';
import { placeholderPng, SHOP_COLOURS } from '../services/placeholder';
import { C, getDb } from '../db';
import type { Business } from '../domain/business';
import { statusImage } from '../services/go-live';

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

// GET /golive/<businessId>.png — the shop's "Now taking orders on WhatsApp 24/7" Status image.
export function goLiveRoutes() {
  const r = new Hono<{ Bindings: Env }>();
  r.get('/:file', async c => {
    const m = /^([A-Za-z0-9]{6,40})\.png$/.exec(c.req.param('file'));
    if (!m) return c.body(null, 404);
    const db = getDb(c.env);
    const business = (await db.get(db.doc(C.businesses, m[1]))) as Business | null;
    if (!business || business.status === 'deleted') return c.body(null, 404);
    const png = await statusImage(business);
    return c.body(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, 200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' });
  });
  return r;
}
