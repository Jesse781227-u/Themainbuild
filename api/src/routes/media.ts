import { Hono } from 'hono';
import type { Env } from '../env';

// Product images live in R2. They're public because WhatsApp and Instagram fetch carousel and
// product images by URL. Only product image keys are served; uploads happen server-side (Phase 3).
// Product photos and the shop's profile picture.
export const PRODUCT_IMAGE_KEY = /^businesses\/[A-Za-z0-9_-]{1,64}\/(products|profile)\/[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png|webp)$/;
export const productImageKey = (businessId: string, file: string) => `businesses/${businessId}/products/${file}`;

export const media = new Hono<{ Bindings: Env }>();
media.get('/*', async c => {
  const key = c.req.path.replace(/^\/media\//, '');
  if (!PRODUCT_IMAGE_KEY.test(key) || !c.env.PRODUCT_IMAGES) return c.body(null, 404);
  const obj = await c.env.PRODUCT_IMAGES.get(key);
  if (!obj) return c.body(null, 404);
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      etag: obj.httpEtag,
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    },
  });
});
