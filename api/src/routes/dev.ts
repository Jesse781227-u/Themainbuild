// Development only: WhatsApp-style chat screens for trying the bots without WhatsApp.
//   /dev/owner     the demo shop's owner chatting with the Relay Admin Bot
//   /dev/customer  a customer chatting with the demo shop (Mama Put Kitchen)
// Open both in two tabs: an order placed as the customer shows up in the owner's chat.
// Messages typed on a page become signed Meta webhooks and go through the real webhook → queue →
// bot path; replies are captured by send() in log mode (devMessages) and shown on the page.
// Every route here 404s unless RELAY_ENV is development and META_SEND_MODE is log.
import { Hono, type ExecutionContext } from 'hono';
import { getConfig } from '../config';
import { C, getDb } from '../db';
import { DEMO, seedDemoShop } from '../dev/seed';
import { chatPage } from '../dev/page';
import type { Env } from '../env';
import { decrypt, hmacSha256Hex } from '../lib/crypto';
import { adminConversationId, customerConversationId } from '../services/conversations';

type Choice = { id: string; title: string; kind: 'button' | 'list' };
const CUSTOMER_PHONE = '2348090000001';

function payload(o: { botNumber: string; from: string; text: string; choice?: Choice }) {
  const id = `wamid.dev.${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = o.choice
    ? { from: o.from, id, timestamp, type: 'interactive', interactive: o.choice.kind === 'list' ? { type: 'list_reply', list_reply: { id: o.choice.id, title: o.choice.title } } : { type: 'button_reply', button_reply: { id: o.choice.id, title: o.choice.title } } }
    : { from: o.from, id, timestamp, type: 'text', text: { body: o.text } };
  return { object: 'whatsapp_business_account', entry: [{ id: 'waba-dev', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: o.botNumber }, contacts: [{ wa_id: o.from, profile: { name: 'Ada' } }], messages: [message] } }] }] };
}

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

export function devRoutes(getApp: () => { fetch: (req: Request, env: Env, ctx?: ExecutionContext) => Response | Promise<Response> }) {
  const r = new Hono<{ Bindings: Env }>();

  r.use('*', async (c, next) => {
    const cfg = getConfig(c.env);
    if (cfg.RELAY_ENV !== 'development' || cfg.META_SEND_MODE !== 'log') return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404);
    await next();
  });

  // The demo shop is created the first time a chat screen opens, and again if its connection can't
  // be decrypted (e.g. the test suite recreated it with a different key).
  async function ensureDemo(env: Env) {
    const db = getDb(env);
    const cfg = getConfig(env);
    const conn = await db.get(db.doc(C.whatsappConnections, DEMO.businessId));
    try {
      if (conn?.accessTokenEncrypted && (await db.get(db.doc(C.businesses, DEMO.businessId)))) { decrypt(String(conn.accessTokenEncrypted), cfg); return; }
    } catch { /* stale key: recreate below */ }
    await seedDemoShop(db, cfg);
  }

  r.get('/', c => c.redirect('/dev/owner'));

  r.get('/owner', async c => {
    await ensureDemo(c.env);
    const admin = getConfig(c.env).ADMIN_BOT_PHONE_NUMBER_ID ?? '';
    return c.html(chatPage({ role: 'owner', botNumber: admin, title: 'Relay', subtitle: 'Business account', defaultPhone: DEMO.owner.replace('+', '') }));
  });

  r.get('/customer', async c => {
    await ensureDemo(c.env);
    return c.html(chatPage({ role: 'customer', botNumber: DEMO.phoneNumberId, title: DEMO.name, subtitle: 'Business account', defaultPhone: CUSTOMER_PHONE }));
  });

  // Restock the demo shop and put it back to its starting products.
  r.post('/seed', async c => c.json(await seedDemoShop(getDb(c.env), getConfig(c.env))));

  // A message typed on a chat screen: record it, then deliver it exactly as Meta would.
  r.post('/send', async c => {
    const cfg = getConfig(c.env);
    const body = await c.req.json<{ botNumber: string; phone: string; text?: string; choice?: Choice }>();
    const from = digits(body.phone);
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
    const phone = `+${digits(c.req.query('phone'))}`;
    const botNumber = String(c.req.query('bot') ?? '');
    const db = getDb(c.env);
    const rows = (await db.query(C.devMessages, [['phone', '==', phone]])).filter(m => m.botNumber === botNumber);
    rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return c.json(rows.map(m => ({ direction: m.direction, content: m.content, at: m.at })));
  });

  // "Clear chat": forget the messages and the bot's memory of this chat (cart, onboarding step).
  r.post('/clear', async c => {
    const body = await c.req.json<{ botNumber: string; phone: string }>();
    const phone = `+${digits(body.phone)}`;
    const db = getDb(c.env);
    const rows = (await db.query(C.devMessages, [['phone', '==', phone]])).filter(m => m.botNumber === body.botNumber);
    const admin = getConfig(c.env).ADMIN_BOT_PHONE_NUMBER_ID;
    const account = await db.get(db.doc(C.channelAccounts, `whatsapp_${body.botNumber}`));
    const conversationId = body.botNumber === admin ? adminConversationId(phone) : account ? customerConversationId(String(account.businessId), 'whatsapp', phone) : null;
    const batch = db.batch();
    for (const m of rows) batch.delete(db.doc(C.devMessages, m._id));
    if (conversationId) { batch.delete(db.doc(C.conversations, conversationId)); batch.delete(db.doc(C.carts, conversationId)); }
    await batch.commit();
    return c.json({ success: true, cleared: rows.length });
  });

  return r;
}
