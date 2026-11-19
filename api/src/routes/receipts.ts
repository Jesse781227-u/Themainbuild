// GET /receipts/:token — the PDF receipt for a paid order. The token is long and random and only
// sent to the customer and the owner, so the link itself is the permission. Built on request.
import { Hono } from 'hono';
import { C, getDb } from '../db';
import type { Env } from '../env';
import type { Business } from '../domain/business';
import type { Customer, Order } from '../domain/commerce';
import { receiptFilename, receiptPdf } from '../services/receipt';
import { log } from '../lib/logger';

const MAX_LOGO_BYTES = 3_000_000;

// The shop's profile photo from our own storage, if it has one (JPEG or PNG).
async function logoFor(env: Env, business: Business) {
  const key = business.profilePhotoUrl?.split('/media/')[1];
  if (!key || !env.PRODUCT_IMAGES) return null;
  try {
    const obj = await env.PRODUCT_IMAGES.get(key);
    const bytes = obj ? new Uint8Array(await new Response(obj.body).arrayBuffer()) : null;
    if (obj && bytes && bytes.byteLength <= MAX_LOGO_BYTES) return { bytes, mimeType: obj.httpMetadata?.contentType ?? (key.endsWith('.png') ? 'image/png' : 'image/jpeg') };
  } catch (e) { log('warn', 'receipt_logo_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); }
  return null;
}

export function receiptRoutes() {
  const r = new Hono<{ Bindings: Env }>();
  // TEST mode: the receipt for a pretend order (marked as a test payment).
  r.get('/test/:token', async c => {
    const token = c.req.param('token');
    if (!/^[A-Za-z0-9]{16,40}$/.test(token)) return c.body(null, 404);
    const db = getDb(c.env);
    const saved = (await db.get(db.doc(C.testReceipts, token))) as { businessId: string; order: Order } | null;
    if (!saved || saved.order.status !== 'paid') return c.body(null, 404);
    const business = (await db.get(db.doc(C.businesses, saved.businessId))) as Business | null;
    if (!business) return c.body(null, 404);
    const pdf = await receiptPdf({ order: saved.order, business, customer: null, logo: await logoFor(c.env, business), test: true });
    return c.body(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer, 200, { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${receiptFilename(saved.order)}"`, 'cache-control': 'private, max-age=300', 'x-robots-tag': 'noindex' });
  });

  r.get('/:token', async c => {
    const token = c.req.param('token');
    if (!/^[A-Za-z0-9]{16,40}$/.test(token)) return c.body(null, 404);
    const db = getDb(c.env);
    const [order] = (await db.query(C.orders, [['receiptToken', '==', token]], { limit: 1 })) as unknown as Order[];
    if (!order || order.status !== 'paid') return c.body(null, 404);
    const [business, customer] = (await db.getAll([db.doc(C.businesses, order.businessId), db.doc(C.customers, order.customerId)])) as [Business | null, Customer | null];
    if (!business) return c.body(null, 404);

    const pdf = await receiptPdf({ order, business, customer, logo: await logoFor(c.env, business), test: String(order.paymentId ?? '').startsWith('sim_') });
    return c.body(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer, 200, {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${receiptFilename(order)}"`,
      'cache-control': 'private, max-age=300',
      'x-robots-tag': 'noindex',
    });
  });
  return r;
}
