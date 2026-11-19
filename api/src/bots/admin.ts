// The Relay Admin Bot: the owner runs their business by chatting with it.
//   1. Unknown number, or onboarding in progress → onboarding by chat (onboarding.ts).
//   2. Product taps and follow-ups (category picker, Correct/Edit) → products-flow.ts.
//   3. A pending destructive action waits for YES/NO.
//   4. Otherwise the message (typed or a voice note) becomes one validated tool call.
import { C } from '../db';
import type { Business } from '../domain/business';
import { log } from '../lib/logger';
import { nairaToKobo } from '../lib/money';
import { send, type OutboundContent } from '../services/channel';
import type { AdminContext } from '../services/router';
import { deleteCategory, listCategories, moveCategoryProducts } from '../services/catalog';
import { HELP, prepare, runTool, isAdminTool, type ToolCtx } from './admin-tools';
import { buttons, list, NO, readInput, storeProductImage, transcribeVoice, YES, type BotDeps } from './common';
import { chooseAdminTool } from './intent';
import { firstOnboarding, handleOnboarding, normalise } from './onboarding';
import { addProduct, handleProductInput, parseProduct, type FlowCtx, type ProductFlowState } from './products-flow';
import { handleImport } from './catalog-import';
import { handleMessageInput } from './messages-flow';
import { handleCustomerChoice } from './customers';
import { CALL, openTicket } from '../services/support';
import { getOwner, switchShop } from '../services/owners';
import { exitTest, runTest, startTest, TEST_EXIT, TEST_START } from './test-mode';

const CONFIRM_MINUTES = 10;

interface AdminConversation extends ProductFlowState { onboarding?: unknown; pendingAction?: { tool: string; args: Record<string, unknown>; expiresAt: string } | null }

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
  const choiceId = input.choiceId;
  if (choiceId === 'yes' || choiceId === 'no') text = choiceId;

  let business = ctx.businessId ? ((await db.get(db.doc(C.businesses, ctx.businessId))) as Business | null) : null;
  const state: ProductFlowState = { productDraft: conv.productDraft ?? null, awaiting: conv.awaiting ?? null, editingProductId: conv.editingProductId ?? null, importDraft: conv.importDraft ?? null };
  // Stored once per message, only if a photo came with it.
  let imageUrl: string | null | undefined;
  const photo = async () => {
    if (imageUrl === undefined) imageUrl = business && input.imageId ? await storeImage(ctx, deps, business, input.imageId) : null;
    return imageUrl;
  };

  // ── CALL: a real person, at any point ──
  const ob = normalise(conv.onboarding);
  if (!choiceId && CALL.test(text.trim())) {
    const stage = ob ? `${ob.stage}/${ob.step}` : business ? business.status : 'new';
    await openTicket(db, cfg, deps, { ownerPhone: ctx.ownerPhone, businessId: business?.id ?? null, businessName: business?.name ?? null, stage, message: text });
    return reply("Got it 👍 A real person from Relay will call or WhatsApp you shortly on this number. You can keep going here in the meantime.");
  }

  // ── TEST: the owner shops in their own shop (any time) ──
  const testing = (conv as { testMode?: { businessId: string } | null }).testMode;
  if (testing) {
    if (choiceId === 'test:exit' || (!choiceId && TEST_EXIT.test(text.trim()))) return exitTest(ctx, ob?.step === 'ready', reply);
    return runTest(ctx, deps, testing.businessId);
  }
  if (choiceId === 'test:start' || (!choiceId && !input.imageId && !input.document && TEST_START.test(text.trim()))) {
    const shop = ob?.businessId ? ((await db.get(db.doc(C.businesses, ob.businessId))) as Business | null) : business;
    return startTest(ctx, deps, shop, reply);
  }

  // ── Onboarding ──
  if (!business || ob) {
    // The shop being set up isn't always the active one (NEW SHOP, before its name is given).
    if (ob?.businessId && ob.businessId !== business?.id) business = (await db.get(db.doc(C.businesses, ob.businessId))) as Business | null;
    else if (ob?.adding && !ob.businessId) business = null;
    if (business?.status === 'deleted') return;
    const res = await handleOnboarding({ ctx, deps, business, ob: ob ?? firstOnboarding(), state, reply }, text, choiceId, photo, input);
    if (res !== 'pass' || !business) return;
  }
  business = business!;
  if (business.status === 'deleted') return;
  const flow: FlowCtx = { db, cfg, deps, business, convRef, state };

  // ── A whole menu / price list (PDF, photo or pasted list), and its Add all / Cancel ──
  const imported = await handleImport(flow, input, text, cfg.ADMIN_BOT_ACCESS_TOKEN, reply);
  if (imported) { for (const o of imported.out) await reply(o); return; }

  // ── Product follow-ups (category picker, Correct/Edit, new category name) ──
  if (choiceId?.startsWith('pok:')) return reply('👍 Saved.');
  const handled = await handleProductInput(flow, choiceId, text);
  if (handled) { for (const o of handled) await reply(o); return; }
  if (state.editingProductId && !choiceId) {
    const parsed = parseProduct(text);
    if (parsed) { for (const o of await addProduct(flow, { ...parsed, imageUrl: await photo() })) await reply(o); return; }
  }

  // ── The shop's messages to customers (MESSAGES) ──
  const msg = await handleMessageInput(flow, choiceId, text);
  if (msg) {
    if (msg.done) return reply('Saved ✅ Customers will get that message from now on. Send MESSAGES to change another.');
    for (const o of msg.out) await reply(o);
    return;
  }

  // ── Several shops on one number: SWITCH, NEW SHOP ──
  const shops = await handleShops(ctx, business, choiceId, text, reply);
  if (shops) return;

  // ── Taps on the customer list (CUSTOMERS) ──
  const custOut = await handleCustomerChoice(db, business, choiceId ?? null);
  if (custOut) return reply(custOut);

  // ── Moving a category's products before deleting it ──
  if (choiceId?.startsWith('movecat:')) {
    const [, from, to] = choiceId.split(':');
    const cats = await listCategories(db, business.id);
    const [a, b] = [cats.find(c => c.id === from), cats.find(c => c.id === to)];
    if (!a || !b) return reply('That category no longer exists.');
    const moved = await moveCategoryProducts(db, business.id, a.id, b.id);
    await deleteCategory(db, business.id, a.id);
    return reply(`Moved ${moved} product${moved === 1 ? '' : 's'} to ${b.name} and deleted ${a.name}.`);
  }

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

  // New products go through the shared flow (category guess, confirmation card).
  if (choice.tool === 'addProduct') {
    // The AI's arguments first ("puff puff", "200 naira", 50), then the owner's own words.
    const name = String(choice.args.name ?? '').trim().slice(0, 120);
    const priceKobo = choice.args.price == null ? null : nairaToKobo(String(choice.args.price));
    const stock = Number.isInteger(Number(choice.args.stock)) && choice.args.stock !== undefined && choice.args.stock !== null && Number(choice.args.stock) >= 0 ? Number(choice.args.stock) : null;
    const parsed = (name && priceKobo && priceKobo > 0 ? { name, priceKobo, stock } : null) ?? parseProduct(text);
    if (!parsed) return reply('To add a product send its name and price, e.g. "add Black AF1 25k" (add a stock number at the end if you track it).');
    for (const o of await addProduct(flow, { ...parsed, imageUrl: await photo() })) await reply(o);
    return;
  }

  const toolCtx = await makeToolCtx(ctx, deps, business, null);
  const prepared = await prepare(choice.tool, choice.args, toolCtx);
  if (prepared.kind === 'reply') return reply(prepared.text);
  if (prepared.kind === 'confirm') {
    await db.set(convRef, { pendingAction: { tool: prepared.tool, args: prepared.args, expiresAt: new Date(Date.now() + CONFIRM_MINUTES * 60_000).toISOString() } }, { merge: true });
    return reply(buttons(prepared.prompt, [['yes', 'Yes'], ['no', 'No']]));
  }
  log('info', 'admin_tool', { businessId: business.id, tool: prepared.tool });
  return reply(await runTool(prepared.tool, prepared.args, toolCtx));
}

async function storeImage(ctx: AdminContext, deps: BotDeps, business: Business, imageId: string) {
  if (!ctx.cfg.ADMIN_BOT_ACCESS_TOKEN) return null;
  return storeProductImage(ctx.cfg, deps, ctx.cfg.ADMIN_BOT_ACCESS_TOKEN, imageId, business.id, 'p').catch(e => { log('warn', 'image_store_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); return null; });
}

async function makeToolCtx(ctx: AdminContext, deps: BotDeps, business: Business, imageUrl: string | null): Promise<ToolCtx> {
  return { db: ctx.db, cfg: ctx.cfg, deps, business, ownerPhone: ctx.ownerPhone, imageUrl };
}

// SWITCH lists the owner's shops; NEW SHOP starts signup for another shop or branch (its own number,
// products and wallet). Returns true when it handled the message.
async function handleShops(ctx: AdminContext, business: Business, choiceId: string | null, text: string, reply: (c: OutboundContent | string) => Promise<unknown>) {
  const { db } = ctx;
  const t = text.trim().toLowerCase();
  if (choiceId?.startsWith('shop:')) {
    const id = choiceId.slice(5);
    if (!(await switchShop(db, ctx.ownerPhone, id))) { await reply("That shop isn't on this number."); return true; }
    const next = (await db.get(db.doc(C.businesses, id))) as Business | null;
    await db.set(db.doc(C.conversations, ctx.conversationId), { businessId: id, productDraft: null, awaiting: null, editingProductId: null, importDraft: null, pendingAction: null }, { merge: true });
    await reply(`Now managing *${next?.name ?? 'that shop'}* ✅ Everything you send now is for this shop. Send SWITCH to change again.`);
    return true;
  }
  if (/^(switch|switch shops?|my shops|shops|branches|my branches)$/.test(t)) {
    const owner = await getOwner(db, ctx.ownerPhone);
    const all = ((await db.getAll((owner?.businessIds ?? [business.id]).map(id => db.doc(C.businesses, id)))) as (Business | null)[]).filter((b): b is Business => !!b && b.status !== 'deleted');
    if (all.length < 2) {
      await reply(buttons(`You have one shop on this number: *${business.name}*. Want to add another shop or branch?`, [['newshop:yes', 'Add a shop'], ['newshop:no', 'No thanks']]));
      return true;
    }
    await reply(list(`You're managing *${business.name}*. Which shop do you want to manage?`, 'Choose shop', all.slice(0, 10).map(b => ({ id: `shop:${b.id}`, title: b.name, description: [b.area, b.status === 'active' ? 'live' : 'setting up'].filter(Boolean).join(' · ') })), 'Your shops'));
    return true;
  }
  if (/^(new shop|add (a |another )?shop|new branch|add (a |another )?branch|another shop|open (a |another )?(shop|branch))$/.test(t)) {
    await reply(buttons('Add another shop or branch? It gets its own WhatsApp number, products and wallet, and you manage it from this chat (send SWITCH to move between shops).', [['newshop:yes', 'Yes, add one'], ['newshop:no', 'Cancel']]));
    return true;
  }
  if (choiceId === 'newshop:no') { await reply('OK.'); return true; }
  if (choiceId === 'newshop:yes') {
    const ob = firstOnboarding({ adding: true });
    await db.set(db.doc(C.conversations, ctx.conversationId), { onboarding: { ...ob, lastSeenAt: new Date().toISOString() }, productDraft: null, awaiting: null, editingProductId: null, importDraft: null }, { merge: true });
    await reply("*Step 1 of 6* · What's the new shop or branch called?");
    return true;
  }
  return false;
}
