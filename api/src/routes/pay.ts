// The simulated payment page customers open from the "Pay ₦X" button (PAYMENTS_MODE=simulated).
// GET shows the order; POST "pays" it through the real on-paid pipeline, then the queued messages
// (the shop's thank-you, the owner's alert) go out. 404s when payments aren't simulated.
import { Hono } from 'hono';
import { getConfig } from '../config';
import { C, getDb } from '../db';
import type { Env } from '../env';
import type { Business } from '../domain/business';
import type { Order } from '../domain/commerce';
import { formatKobo } from '../lib/money';
import { paySimulated, type PayLink } from '../services/paylinks';
import { enqueue } from '../services/queue';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function page(title: string, body: string, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
:root { --bg: #f4f6f8; --card: #fff; --ink: #111b21; --muted: #667781; --line: #e6e9ec; --brand: #00a884; --brand-ink: #fff; --warn-bg: #fff7e6; --warn: #8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b141a; --card: #111b21; --ink: #e9edef; --muted: #8696a0; --line: #222d34; --warn-bg: #2a2310; --warn: #f0c36d; } }
* { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
main { max-width: 440px; margin: 0 auto; padding: 24px 16px 40px; }
.shop { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.logo { width: 48px; height: 48px; border-radius: 50%; background: var(--brand); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 20px; overflow: hidden; flex: none; }
.logo img { width: 100%; height: 100%; object-fit: cover; }
.shop b { display: block; font-size: 18px; } .shop small { color: var(--muted); }
.test { background: var(--warn-bg); color: var(--warn); border-radius: 10px; padding: 10px 12px; font-size: 14px; margin-bottom: 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; }
.row { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; }
.row span:last-child { white-space: nowrap; }
.muted { color: var(--muted); } .total { border-top: 1px solid var(--line); margin-top: 8px; padding-top: 12px; font-weight: 700; font-size: 18px; }
button { width: 100%; margin-top: 18px; border: 0; border-radius: 12px; padding: 15px; font: inherit; font-weight: 700; font-size: 17px; background: var(--brand); color: var(--brand-ink); cursor: pointer; }
button:disabled { opacity: .6; cursor: default; }
.done { text-align: center; padding: 20px 0 4px; } .done .big { font-size: 48px; } .done h1 { font-size: 22px; margin: 8px 0; }
.foot { text-align: center; color: var(--muted); font-size: 13px; margin-top: 18px; }
</style></head><body><main>${body}<p class="foot">Payments by Relay</p></main>${script}</body></html>`;
}

const shopHeader = (b: Business) => `<div class="shop"><div class="logo">${b.profilePhotoUrl ? `<img src="${esc(b.profilePhotoUrl)}" alt="">` : esc(b.name.charAt(0).toUpperCase())}</div><div><b>${esc(b.name)}</b><small>${esc([b.area, b.city].filter(Boolean).join(', '))}</small></div></div>`;
const success = (o: Order) => `<div class="card done"><div class="big">✅</div><h1>Payment successful</h1><p class="muted">${esc(formatKobo(o.payAmountKobo))} for order ${esc(o.ref)}.<br>You can go back to WhatsApp now.</p></div>`;

export function payRoutes() {
  const r = new Hono<{ Bindings: Env }>();

  r.use('*', async (c, next) => {
    if (getConfig(c.env).PAYMENTS_MODE !== 'simulated') return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404);
    await next();
  });

  r.get('/:token', async c => {
    const db = getDb(c.env);
    const link = (await db.get(db.doc(C.payLinks, c.req.param('token')))) as PayLink | null;
    const order = link ? ((await db.get(db.doc(C.orders, link.orderId))) as Order | null) : null;
    const business = order ? ((await db.get(db.doc(C.businesses, order.businessId))) as Business | null) : null;
    if (!link || !order || !business) return c.html(page('Link not found', '<div class="card"><h1>Link not found</h1><p class="muted">This payment link doesn\'t exist. Check the link in your WhatsApp chat.</p></div>'), 404);
    if (order.status === 'paid') return c.html(page('Paid', shopHeader(business) + success(order)));
    if (order.status !== 'awaiting_payment' || link.expiresAt <= new Date().toISOString()) {
      return c.html(page('Link expired', `${shopHeader(business)}<div class="card"><h1>This order has expired</h1><p class="muted">We held your items for a while, but the time ran out. Go back to WhatsApp and check out again.</p></div>`));
    }
    const lines = order.items.map(l => `<div class="row"><span>${l.qty} × ${esc(l.name)}</span><span>${esc(formatKobo(l.priceKobo * l.qty))}</span></div>`).join('');
    const extra = [
      order.deliveryFeeKobo ? `<div class="row muted"><span>Delivery</span><span>${esc(formatKobo(order.deliveryFeeKobo))}</span></div>` : '',
      order.feeKobo ? `<div class="row muted"><span>Service fee</span><span>${esc(formatKobo(order.feeKobo))}</span></div>` : '',
    ].join('');
    const body = `${shopHeader(business)}<div class="test"><b>Test payment.</b> No real money moves. Tapping Pay marks the order paid, like a real payment would.</div>
<div class="card"><div class="muted">Order ${esc(order.ref)}</div>${lines}${extra}<div class="row total"><span>Total</span><span>${esc(formatKobo(order.payAmountKobo))}</span></div>
<button id="pay" type="button">Pay ${esc(formatKobo(order.payAmountKobo))}</button><p id="msg" class="muted" style="text-align:center;margin:10px 0 0"></p></div>`;
    const script = `<script>document.getElementById('pay').onclick=function(){var b=this;b.disabled=true;b.textContent='Processing…';fetch(location.pathname,{method:'POST'}).then(function(r){return r.json()}).then(function(j){if(j.success){location.reload()}else{b.disabled=false;b.textContent='Try again';document.getElementById('msg').textContent=j.error&&j.error.message||'Something went wrong.'}}).catch(function(){b.disabled=false;b.textContent='Try again';document.getElementById('msg').textContent='Network error.'})};</script>`;
    return c.html(page(`Pay ${business.name}`, body, script));
  });

  r.post('/:token', async c => {
    const db = getDb(c.env);
    const out = await paySimulated(db, c.req.param('token'));
    if (!out.ok) {
      if (out.reason === 'already_paid') return c.json({ success: true, alreadyPaid: true });
      const message = { not_found: 'This payment link doesn\'t exist.', expired: 'This order has expired. Go back to WhatsApp and check out again.', cancelled: 'This order was cancelled.' }[out.reason];
      return c.json({ success: false, error: { code: out.reason.toUpperCase(), message } }, 409);
    }
    // The thank-you to the customer and the owner's alert, through the outbox like any payment.
    await enqueue(c.env, out.result.outboxIds.map(messageId => ({ kind: 'outbox' as const, messageId })));
    return c.json({ success: true });
  });

  return r;
}
