import { Hono } from 'hono';
import { z } from 'zod';
import { getConfig } from '../config';
import { C, getDb } from '../db';
import type { Env } from '../env';
import { hmacSha256Hex, safeEqual } from '../lib/crypto';
import { log } from '../lib/logger';
import { adminConversationId } from '../services/conversations';
import { completeSignup, getSignupSession, SignupError } from '../services/signup';
import { enqueue } from '../services/queue';
import { goLive } from '../services/go-live';
import { deletionCode } from '../bots/deletion';
import { isDevChat } from './dev';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const page = (title: string, body: string, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/legal.css"></head><body><main><p class="brand"><img src="/logo.png" alt="Relay" height="32"></p><h1>${esc(title)}</h1>${body}</main>${script}</body></html>`;

export function signupRoutes(deps: { fetch?: typeof fetch } = {}) {
  const r = new Hono<{ Bindings: Env }>();
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  // The page the Admin Bot links to. It runs Meta's Embedded Signup (Facebook JS SDK) and posts the
  // authorization code plus the WABA and phone number ids back to /api/v1/signup/complete.
  // TODO(jesse): confirm the Embedded Signup extras for coexistence (featureType
  // "whatsapp_business_app_onboarding", sessionInfoVersion) and the message event names against
  // Meta's current docs; the configuration itself (META_ES_CONFIG_ID) is created in the Meta app.
  r.get('/connect/:token', async c => {
    const cfg = getConfig(c.env);
    const token = c.req.param('token');
    const session = await getSignupSession(getDb(c.env), token);
    if (!session) return c.html(page('Link expired', '<p>This link has expired or was already used. Send CONNECT to the Relay Admin Bot on WhatsApp for a new one.</p>'), 404);
    // Local test chat: no Facebook login, just a pretend number (see routes/dev.ts).
    if (isDevChat(cfg)) {
      const testScript = `<script>document.getElementById('go').onclick=function(){var o=document.getElementById('status');o.textContent='Connecting…';fetch('/dev/connect/${token}',{method:'POST'}).then(function(r){return r.json()}).then(function(j){o.textContent=j.success?'Connected (test mode). Your shop now has a pretend WhatsApp number. Open the customer chat to try it like a customer.':'Something went wrong. Send CONNECT to the Relay Admin Bot for a new link.'})}</script>`;
      return c.html(page('Connect your WhatsApp Business number', '<p><b>Test mode.</b> On real WhatsApp this step logs in with Facebook and links your WhatsApp Business number. Here it gives your shop a pretend number so you can try it from the customer chat.</p><p><button id="go" type="button">Connect (test mode)</button></p><p id="status" class="meta"></p>', testScript));
    }
    if (!cfg.META_APP_ID || !cfg.META_ES_CONFIG_ID) return c.html(page('Not available yet', '<p>WhatsApp connection is not configured yet. Please try again later.</p>'), 503);
    const data = JSON.stringify({ token, appId: cfg.META_APP_ID, configId: cfg.META_ES_CONFIG_ID, version: cfg.META_GRAPH_VERSION }).replace(/</g, '\\u003c');
    const script = `<script>
const S=${data};let info=null,code=null;const out=document.getElementById('status');
function finish(){if(!info||!code)return;out.textContent='Connecting…';fetch('/api/v1/signup/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:S.token,code:code,wabaId:info.waba_id,phoneNumberId:info.phone_number_id})}).then(r=>r.json()).then(j=>{out.textContent=j.success?'Connected! Go back to WhatsApp: the Relay Admin Bot will confirm.':'Something went wrong ('+(j.error&&j.error.code||'error')+'). Send CONNECT to the Admin Bot to try again.'}).catch(()=>{out.textContent='Network error. Please try again.'})}
window.addEventListener('message',e=>{if(!/facebook\\.com$/.test(new URL(e.origin).hostname))return;try{const d=typeof e.data==='string'?JSON.parse(e.data):e.data;if(d&&d.type==='WA_EMBEDDED_SIGNUP'&&/^FINISH/.test(d.event)){info=d.data;finish()}else if(d&&d.type==='WA_EMBEDDED_SIGNUP'&&d.event==='CANCEL'){out.textContent='Cancelled. You can start again.'}}catch(_){}});
window.fbAsyncInit=function(){FB.init({appId:S.appId,autoLogAppEvents:true,xfbml:false,version:S.version})};
document.getElementById('go').onclick=function(){FB.login(function(r){if(r.authResponse&&r.authResponse.code){code=r.authResponse.code;finish()}else{out.textContent='Not connected. You can try again.'}},{config_id:S.configId,response_type:'code',override_default_response_type:true,extras:{setup:{},featureType:'whatsapp_business_app_onboarding',sessionInfoVersion:'3'}})};
</script><script async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>`;
    return c.html(page('Connect your WhatsApp Business number', '<p>Log in with Facebook and choose your WhatsApp Business account and number. You keep using the WhatsApp Business app; Relay answers customers for you.</p><p><button id="go" type="button">Connect WhatsApp</button></p><p id="status" class="meta"></p><p class="meta"><b>On regular WhatsApp?</b> Switch to the free WhatsApp Business app first (the icon with a "B"): back up your chats, install WhatsApp Business and verify the same number. Your chats come with you.</p><p class="meta"><b>No Facebook account?</b> Create a free one at facebook.com, then open this link again.</p><p class="meta">Stuck? Reply <b>CALL</b> in your Relay chat and a person will help.</p>', script));
  });

  const completeInput = z.object({ token: z.string().min(10).max(64), code: z.string().min(10).max(2000), wabaId: z.string().regex(/^\d{5,30}$/), phoneNumberId: z.string().regex(/^\d{5,30}$/) });
  r.post('/api/v1/signup/complete', async c => {
    const parsed = completeInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ success: false, error: { code: 'INVALID_REQUEST' } }, 400);
    const db = getDb(c.env);
    const cfg = getConfig(c.env);
    try {
      const done = await completeSignup(db, cfg, doFetch, parsed.data);
      await goLive(db, cfg, { businessId: done.businessId, enqueue: jobs => enqueue(c.env, jobs), fetch: doFetch, images: c.env.PRODUCT_IMAGES });
      log('info', 'signup_completed', { businessId: done.businessId });
      return c.json({ success: true });
    } catch (e) {
      if (e instanceof SignupError) { log('warn', 'signup_failed', { code: e.message }); return c.json({ success: false, error: { code: e.message } }, 400); }
      throw e;
    }
  });

  // Meta's Data Deletion Request Callback (when someone removes Relay in their Facebook settings).
  // The signed_request is verified with the app secret; the request is recorded and a status URL
  // and confirmation code are returned, as Meta requires.
  // TODO(jesse): store the Meta user id at Embedded Signup so these requests can be mapped to a
  // business automatically; until then they are handled by hand from the deletionRequests list.
  r.post('/api/v1/meta/data-deletion', async c => {
    const cfg = getConfig(c.env);
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const signed = String(form.signed_request ?? '');
    const [sig, payload] = signed.split('.');
    if (!sig || !payload || !cfg.META_APP_SECRET) return c.json({ error: 'invalid' }, 400);
    const expected = Buffer.from(hmacSha256Hex(cfg.META_APP_SECRET, payload), 'hex').toString('base64url');
    if (!safeEqual(sig, expected)) return c.json({ error: 'invalid' }, 400);
    let data: { user_id?: string; algorithm?: string };
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return c.json({ error: 'invalid' }, 400); }
    if (String(data.algorithm ?? '').toUpperCase() !== 'HMAC-SHA256' || !data.user_id) return c.json({ error: 'invalid' }, 400);
    const ref = deletionCode();
    await getDb(c.env).create(getDb(c.env).doc(C.deletionRequests, ref), { id: ref, kind: 'meta_callback', metaUserId: String(data.user_id), status: 'received', at: new Date().toISOString() });
    return c.json({ url: `${cfg.API_BASE_URL}/data-deletion?code=${ref}`, confirmation_code: ref });
  });

  return r;
}
