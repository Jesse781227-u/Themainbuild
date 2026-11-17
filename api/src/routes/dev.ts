// Development only: a browser chat page for trying the bots without WhatsApp. Messages typed on the
// page are turned into signed Meta webhooks and go through the real webhook → queue → bot path;
// replies are captured by send() in log mode (devMessages) and shown on the page.
// Every route here 404s unless RELAY_ENV is development and META_SEND_MODE is log.
import { Hono, type ExecutionContext } from 'hono';
import { getConfig } from '../config';
import { C, getDb } from '../db';
import { seedDemoShop } from '../dev/seed';
import { DEV_PAGE } from '../dev/page';
import type { Env } from '../env';
import { hmacSha256Hex } from '../lib/crypto';

type Choice = { id: string; title: string; kind: 'button' | 'list' };

function payload(o: { botNumber: string; from: string; text: string; choice?: Choice }) {
  const id = `wamid.dev.${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = o.choice
    ? { from: o.from, id, timestamp, type: 'interactive', interactive: o.choice.kind === 'list' ? { type: 'list_reply', list_reply: { id: o.choice.id, title: o.choice.title } } : { type: 'button_reply', button_reply: { id: o.choice.id, title: o.choice.title } } }
    : { from: o.from, id, timestamp, type: 'text', text: { body: o.text } };
  return { object: 'whatsapp_business_account', entry: [{ id: 'waba-dev', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: o.botNumber }, contacts: [{ wa_id: o.from, profile: { name: 'Test' } }], messages: [message] } }] }] };
}

export function devRoutes(getApp: () => { fetch: (req: Request, env: Env, ctx?: ExecutionContext) => Response | Promise<Response> }) {
  const r = new Hono<{ Bindings: Env }>();

  r.use('*', async (c, next) => {
    const cfg = getConfig(c.env);
    if (cfg.RELAY_ENV !== 'development' || cfg.META_SEND_MODE !== 'log') return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404);
    await next();
  });

  r.get('/', c => c.html(DEV_PAGE));

  // The bots you can talk to: the Admin Bot and every shop with a WhatsApp number.
  r.get('/bots', async c => {
    const cfg = getConfig(c.env);
    const db = getDb(c.env);
    const accounts = await db.query(C.channelAccounts, [['channel', '==', 'whatsapp']]);
    const shops = await Promise.all(accounts.map(async a => {
      const b = await db.get(db.doc(C.businesses, String(a.businessId)));
      return { botNumber: String(a.accountId), name: String(b?.name ?? a.businessId), owner: String(b?.ownerPhone ?? '') };
    }));
    return c.json({ admin: cfg.ADMIN_BOT_PHONE_NUMBER_ID ?? null, shops });
  });

  r.post('/seed', async c => c.json(await seedDemoShop(getDb(c.env), getConfig(c.env))));

  // A message typed on the page: record it, then deliver it exactly as Meta would.
  r.post('/send', async c => {
    const cfg = getConfig(c.env);
    const body = await c.req.json<{ botNumber: string; phone: string; text?: string; choice?: Choice }>();
    const from = String(body.phone ?? '').replace(/\D/g, '');
    if (!body.botNumber || from.length < 8) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'botNumber and phone are required.' } }, 400);
    const text = String(body.choice?.title ?? body.text ?? '').slice(0, 4000);
    if (!text) return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Type a message.' } }, 400);
    const db = getDb(c.env);
    const at = new Date().toISOString();
    await db.set(db.doc(C.devMessages, `${at}_${crypto.randomUUID()}`), { phone: `+${from}`, botNumber: body.botNumber, direction: 'in', content: { type: 'text', text }, at });
    const raw = JSON.stringify(payload({ botNumber: body.botNumber, from, text, choice: body.choice }));
    const req = new Request(new URL('/api/v1/webhooks/meta', c.req.url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacSha256Hex(cfg.META_APP_SECRET ?? '', raw)}` }, body: raw });
    let ctx: ExecutionContext | undefined;
    try { ctx = c.executionCtx; } catch { ctx = undefined; }
    const res = await getApp().fetch(req, c.env, ctx);
    return c.json({ success: res.status === 200, status: res.status });
  });

  // The conversation between one phone and one bot, oldest first.
  r.get('/messages', async c => {
    const phone = `+${String(c.req.query('phone') ?? '').replace(/\D/g, '')}`;
    const botNumber = String(c.req.query('bot') ?? '');
    const db = getDb(c.env);
    const rows = (await db.query(C.devMessages, [['phone', '==', phone]])).filter(m => m.botNumber === botNumber);
    rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return c.json(rows.map(m => ({ direction: m.direction, content: m.content, at: m.at })));
  });

  return r;
}
