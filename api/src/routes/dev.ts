// Development only: WhatsApp-style chat screens for trying the bots without WhatsApp.
//   /dev/owner     a brand-new business owner chatting with the Relay Admin Bot (signup from "Hi")
//   /dev/customer  a customer chatting with the shop that owner created
// Open both in two tabs (the customer tab finds the owner tab's shop through localStorage). The
// shop needs a WhatsApp number before customers can reach it: the connect link from signup offers a
// test-mode connect here (POST /dev/connect/:token) that gives it a pretend number.
// Messages typed on a page become signed Meta webhooks and go through the real webhook → queue →
// bot path; replies are captured by send() in log mode (devMessages) and shown on the page.
// Every route here 404s unless RELAY_ENV is development and META_SEND_MODE is log.
import { Hono, type ExecutionContext } from 'hono';
import { getConfig, type Config } from '../config';
import { C, getDb } from '../db';
import { chatPage } from '../dev/page';
import type { Env } from '../env';
import { hmacSha256Hex } from '../lib/crypto';
import { adminConversationId, customerConversationId } from '../services/conversations';
import { getSignupSession } from '../services/signup';
import { saveWhatsAppConnection } from '../services/whatsapp';

type Choice = { id: string; title: string; kind: 'button' | 'list' };
const CUSTOMER_PHONE = '2348090000001';

export const isDevChat = (cfg: Pick<Config, 'RELAY_ENV' | 'META_SEND_MODE'>) => cfg.RELAY_ENV === 'development' && cfg.META_SEND_MODE === 'log';

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
    if (!isDevChat(getConfig(c.env))) return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404);
    await next();
  });

  r.get('/', c => c.redirect('/dev/owner'));
  r.get('/owner', c => c.html(chatPage({ role: 'owner', botNumber: getConfig(c.env).ADMIN_BOT_PHONE_NUMBER_ID ?? '', title: 'Relay', subtitle: 'Business account', defaultPhone: '' })));
  r.get('/customer', c => c.html(chatPage({ role: 'customer', botNumber: '', title: 'Shop', subtitle: 'Business account', defaultPhone: CUSTOMER_PHONE })));

  // The shop owned by a phone number, if it has a (test) WhatsApp number yet.
  r.get('/shop', async c => {
    const db = getDb(c.env);
    const owner = await db.get(db.doc(C.ownerPhones, `+${digits(c.req.query('owner'))}`));
    const business = owner ? await db.get(db.doc(C.businesses, String(owner.businessId))) : null;
    if (!business) return c.json({ shop: null, reason: 'no_business' });
    const conn = await db.get(db.doc(C.whatsappConnections, String(business.id)));
    if (!conn || conn.status !== 'connected') return c.json({ shop: null, reason: 'not_connected', name: business.name });
    return c.json({ shop: { botNumber: String(conn.phoneNumberId), name: String(business.name) } });
  });

  // Test-mode "Connect WhatsApp": a pretend number, stored exactly like a real connection.
  r.post('/connect/:token', async c => {
    const db = getDb(c.env);
    const cfg = getConfig(c.env);
    const token = c.req.param('token');
    const session = await getSignupSession(db, token);
    if (!session) return c.json({ success: false, error: { code: 'LINK_EXPIRED', message: 'This link has expired or was already used.' } }, 404);
    const phoneNumberId = `dev${digits(session.businessId) || '0'}${String(Date.now()).slice(-6)}`;
    await saveWhatsAppConnection(db, cfg, { businessId: session.businessId, wabaId: 'waba-dev', phoneNumberId, accessToken: 'local-log-mode-placeholder' });
    const at = new Date().toISOString();
    await db.update(db.doc(C.businesses, session.businessId), { status: 'active', whatsappDisplayNumber: '+234 800 000 0000', updatedAt: at });
    await db.update(db.doc(C.signupSessions, token), { usedAt: at });
    return c.json({ success: true });
  });

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

  // "Clear chat": forget the messages and the bot's memory of this chat (cart, signup step).
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
