// The Relay Admin Bot: the owner runs their business by chatting with it.
//   1. Unknown number → onboarding by chat (business name → category → first products → connect link).
//   2. A pending destructive action waits for YES/NO.
//   3. Otherwise the message (typed or a voice note) becomes one validated tool call.
import { C } from '../db';
import type { Business, BusinessCategory } from '../domain/business';
import { randomId } from '../lib/crypto';
import { log } from '../lib/logger';
import { send, type OutboundContent } from '../services/channel';
import type { AdminContext } from '../services/router';
import { createSignupSession } from '../services/signup';
import { HELP, prepare, runTool, isAdminTool, type ToolCtx } from './admin-tools';
import { buttons, NO, readInput, storeProductImage, transcribeVoice, YES, type BotDeps } from './common';
import { chooseAdminTool, parseAdminCommand, parseProductLine } from './intent';

const CONFIRM_MINUTES = 10;

const CATEGORIES: [BusinessCategory, string][] = [
  ['food_beverage', 'Food & drinks'], ['fashion_retail', 'Fashion & retail'], ['beauty_wellness', 'Beauty & wellness'],
  ['photography_events', 'Photography & events'], ['general_services', 'Services'], ['other', 'Something else'],
];

interface AdminConversation { onboarding?: { step: 'name' | 'category' | 'products' } | null; pendingAction?: { tool: string; args: Record<string, unknown>; expiresAt: string } | null }

export async function handleAdmin(ctx: AdminContext, deps: BotDeps) {
  const { db, cfg } = ctx;
  const reply = (content: OutboundContent | string) => send(db, cfg, deps.transport, { from: { adminBot: true }, conversationId: ctx.conversationId, to: ctx.ownerPhone, content: typeof content === 'string' ? { type: 'text', text: content } : content });
  const convRef = db.doc(C.conversations, ctx.conversationId);
  const conv = ((await db.get(convRef)) ?? {}) as AdminConversation;

  const input = readInput(ctx.event);
  let text = input.text;
  if (input.audioId) {
    const heard = cfg.ADMIN_BOT_ACCESS_TOKEN ? await transcribeVoice(cfg, deps, cfg.ADMIN_BOT_ACCESS_TOKEN, input.audioId) : null;
    if (!heard) return reply("Sorry, I couldn't listen to that voice note. Please type it instead.");
    text = heard;
  }
  if (input.choiceId === 'yes' || input.choiceId === 'no') text = input.choiceId;

  // ── Onboarding ──
  let business = ctx.businessId ? ((await db.get(db.doc(C.businesses, ctx.businessId))) as Business | null) : null;
  if (!business || conv.onboarding) {
    const step = conv.onboarding?.step;
    if (!business && !step) {
      await db.set(convRef, { onboarding: { step: 'name' } }, { merge: true });
      return reply("Welcome to Relay 👋 I'll help you sell on WhatsApp. First, what's your business called?");
    }
    if (step === 'name') {
      const name = text.trim().slice(0, 80);
      if (name.length < 2) return reply("What's your business called?");
      // A command or a full product line ("add Jollof rice, 2500, 10") is not a business name.
      if (parseAdminCommand(name) || parseProductLine(name)?.stock !== undefined) return reply("That looks like a product or a command. First, what's your business called? You can add products right after.");
      const id = randomId(9).replace(/[^A-Za-z0-9]/g, 'x');
      const at = new Date().toISOString();
      const created = await db.create(db.doc(C.ownerPhones, ctx.ownerPhone), { businessId: id });
      if (!created) return reply('This number already has a Relay business. Send HELP.');
      await db.create(db.doc(C.businesses, id), { id, name, category: 'other', ownerPhone: ctx.ownerPhone, status: 'onboarding', timezone: 'Africa/Lagos', createdAt: at, updatedAt: at });
      await db.set(convRef, { businessId: id, onboarding: { step: 'category' } }, { merge: true });
      return reply(`Great, ${name}! What do you sell?\n${CATEGORIES.map(([, label], i) => `${i + 1}. ${label}`).join('\n')}\nReply with a number.`);
    }
    if (!business) return; // unreachable: a business exists after the name step
    if (step === 'category') {
      const n = Number(text.trim());
      const cat = CATEGORIES[n - 1] ?? CATEGORIES.find(([, label]) => label.toLowerCase().startsWith(text.trim().toLowerCase()));
      if (!cat) return reply('Reply with a number from 1 to 6.');
      await db.update(db.doc(C.businesses, business.id), { category: cat[0], updatedAt: new Date().toISOString() });
      await db.set(convRef, { onboarding: { step: 'products' } }, { merge: true });
      return reply('Now add your first products, one per message: name, price, stock. For example:\nJollof rice, 2500, 10\nSend a photo with the text as its caption to add a picture. Send DONE when you\'ve added a few.');
    }
    if (step === 'products') {
      if (/^(done|finish(ed)?|skip|that'?s all)$/i.test(text.trim())) {
        await db.set(convRef, { onboarding: null }, { merge: true });
        const link = await createSignupSession(db, cfg, business.id);
        return reply(`Last step: connect your WhatsApp Business number so customers can order from it. Open this link (valid 24 hours):\n${link}\nYou keep using the WhatsApp Business app as normal. Meanwhile, send HELP to see everything I can do.`);
      }
      const choice = parseAdminCommand(/^add\s/i.test(text) ? text : `add ${text}`);
      if (choice?.tool !== 'addProduct') return reply('Send a product as: name, price, stock (e.g. Jollof rice, 2500, 10), or DONE.');
      const toolCtx = await makeToolCtx(ctx, deps, business, input.imageId);
      const prepared = await prepare('addProduct', choice.args, toolCtx);
      if (prepared.kind === 'reply') return reply(prepared.text);
      return reply(`${await runTool('addProduct', choice.args, toolCtx)} Send another, or DONE.`);
    }
  }
  business = business!;
  if (business.status === 'deleted') return;

  // ── Confirmation of a destructive action ──
  const pending = conv.pendingAction;
  if (pending) {
    await db.set(convRef, { pendingAction: null }, { merge: true });
    const live = pending.expiresAt > new Date().toISOString();
    if (live && YES.test(text) && isAdminTool(pending.tool)) {
      await reply(await runTool(pending.tool, pending.args, await makeToolCtx(ctx, deps, business, null)));
      if (pending.tool === 'deleteMyData') await db.delete(convRef); // after the confirmation, which needs the window
      return;
    }
    if (NO.test(text)) return reply('OK, cancelled.');
    if (YES.test(text)) return reply('That request expired. Please send it again.');
    // Anything else: drop the pending action and treat this as a new message.
  }

  if (!text && !input.imageId) return reply(HELP);
  const choice = await chooseAdminTool(text, deps.llm).catch(e => { log('warn', 'llm_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); return null; });
  if (!choice) return reply(`Sorry, I didn't understand that.\n\n${HELP}`);
  const toolCtx = await makeToolCtx(ctx, deps, business, choice.tool === 'addProduct' ? input.imageId : null);
  const prepared = await prepare(choice.tool, choice.args, toolCtx);
  if (prepared.kind === 'reply') return reply(prepared.text);
  if (prepared.kind === 'confirm') {
    await db.set(convRef, { pendingAction: { tool: prepared.tool, args: prepared.args, expiresAt: new Date(Date.now() + CONFIRM_MINUTES * 60_000).toISOString() } }, { merge: true });
    return reply(buttons(prepared.prompt, [['yes', 'Yes'], ['no', 'No']]));
  }
  log('info', 'admin_tool', { businessId: business.id, tool: prepared.tool });
  return reply(await runTool(prepared.tool, prepared.args, toolCtx));
}

async function makeToolCtx(ctx: AdminContext, deps: BotDeps, business: Business, imageId: string | null): Promise<ToolCtx> {
  let imageUrl: string | null = null;
  if (imageId && ctx.cfg.ADMIN_BOT_ACCESS_TOKEN) {
    imageUrl = await storeProductImage(ctx.cfg, deps, ctx.cfg.ADMIN_BOT_ACCESS_TOKEN, imageId, business.id, 'p').catch(e => { log('warn', 'image_store_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); return null; });
  }
  return { db: ctx.db, cfg: ctx.cfg, deps, business, ownerPhone: ctx.ownerPhone, imageUrl };
}
