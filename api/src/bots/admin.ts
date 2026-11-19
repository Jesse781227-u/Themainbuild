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
import { deleteCategory, listCategories, listProducts, moveCategoryProducts } from '../services/catalog';
import { prepare, runTool, isAdminTool, type ToolCtx } from './admin-tools';
import { actionById, actionForTool, followUps, handleActionTap, matchAction, runAction, withFollowUps } from './actions';
import type { Product } from '../domain/commerce';
import { example } from '../services/shop-type';
import { buttons, list, NO, readInput, storeProductImage, transcribeVoice, YES, type BotDeps } from './common';
import { chooseAdminTool } from './intent';
import { firstOnboarding, handleOnboarding, normalise, resumeOnboarding } from './onboarding';
import { addProduct, handleProductInput, parseProduct, type FlowCtx, type ProductFlowState } from './products-flow';
import { handleImport } from './catalog-import';
import { handleMessageInput } from './messages-flow';
import { handleCustomerChoice } from './customers';
import { CALL, openTicket } from '../services/support';
import { react, showTyping, slowJob } from '../services/presence';
import { getOwner, switchShop } from '../services/owners';
import { exitTest, runTest, startTest, TEST_EXIT, TEST_START } from './test-mode';
import { handleSettings } from './settings';
import { handleShops } from './shops';

const CONFIRM_MINUTES = 10;

// The "See how Relay works" ice breaker, before signup.
const HOW_IT_WORKS = "Relay runs your shop on your own WhatsApp number 👋\n\n1. Send me your menu or price list (a PDF, a photo, or just type it). I turn it into a shop customers can browse.\n2. Customers order by chat, any time. They pay by card or transfer and get a receipt.\n3. You get every order and payment here, and run everything by chat: prices, stock, delivery, reports.\n\nNo app to download, no monthly fee: 1% per paid order. Setup takes about 5 minutes.";

// The two buttons under each "are you sure?" question.
const CONFIRM_LABELS: Record<string, [string, string][]> = {
  deleteProduct: [['yes', 'Yes, delete it'], ['no', 'No, keep it']],
  deleteCategory: [['yes', 'Yes, delete it'], ['no', 'No, keep it']],
  markPaid: [['yes', 'Yes, mark as paid'], ['no', 'Not paid yet']],
  cancelOrder: [['yes', 'Yes, cancel order'], ['no', 'No, keep order']],
  deleteMyData: [['yes', 'Yes, delete account'], ['no', 'No, keep account']],
  broadcast: [['yes', 'Yes, send it'], ['no', "No, don't send"]],
};

interface AdminConversation extends ProductFlowState { onboarding?: unknown; pendingAction?: { tool: string; args: Record<string, unknown>; expiresAt: string } | null }

export async function handleAdmin(ctx: AdminContext, deps: BotDeps) {
  const { db, cfg } = ctx;
  const reply = (content: OutboundContent | string) => send(db, cfg, deps.transport, { from: { adminBot: true }, conversationId: ctx.conversationId, to: ctx.ownerPhone, content: typeof content === 'string' ? { type: 'text', text: content } : content });
  const convRef = db.doc(C.conversations, ctx.conversationId);
  const conv = ((await db.get(convRef)) ?? {}) as AdminConversation;
  await showTyping(db, cfg, deps.transport, { adminBot: true }, ctx.ownerPhone, ctx.event.messageId);
  const reactTo = (emoji: string) => react(db, cfg, deps.transport, { from: { adminBot: true }, conversationId: ctx.conversationId, to: ctx.ownerPhone, messageId: ctx.event.messageId, emoji });

  const input = readInput(ctx.event);
  let text = input.text;
  if (input.audioId) {
    const heard = cfg.ADMIN_BOT_ACCESS_TOKEN ? await slowJob(() => transcribeVoice(cfg, deps, cfg.ADMIN_BOT_ACCESS_TOKEN!, input.audioId!), { react: reactTo, ok: r => !!r }) : null;
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

  // ── Ice breaker "See how Relay works" on a brand-new chat: explain first, signup when they tap ──
  if (!business && (!ob || (ob.step === 'shop_name' && !ob.welcomed)) && !choiceId && /^see how relay works[.!?]*$/i.test(text.trim())) {
    return reply(buttons(HOW_IT_WORKS, [['ob:begin', 'Set up my shop'], ['ob:call', 'Talk to a person']]));
  }

  // ── Onboarding ──
  // YES/NO to "Delete …?" asked during signup goes to that question, not to the signup step.
  const confirming = !!conv.pendingAction && (choiceId === 'yes' || choiceId === 'no' || (!choiceId && (YES.test(text) || NO.test(text))));
  let resume = false;
  if (!business || ob) {
    // The shop being set up isn't always the active one (NEW SHOP, before its name is given).
    if (ob?.businessId && ob.businessId !== business?.id) business = (await db.get(db.doc(C.businesses, ob.businessId))) as Business | null;
    else if (ob?.adding && !ob.businessId) business = null;
    if (business?.status === 'deleted') return;
    if (!confirming || !business) {
      const res = await handleOnboarding({ ctx, deps, business, ob: ob ?? firstOnboarding(), state, reply, react: reactTo }, text, choiceId, photo, input);
      if (res !== 'pass' || !business) return;
    }
    // A command in the middle of signup (PRODUCTS, delete X, FEE…): answer it, then back to the step.
    resume = !!ob && ob.stage !== 'live';
  }
  if (!business || business.status === 'deleted') return;
  let held = false; // a YES/NO question was just asked: don't repeat the signup step under it
  const out = await everyday(business);
  if (resume && !held) {
    const now = normalise(((await db.get(convRef)) as AdminConversation | null)?.onboarding);
    if (now && now.stage !== 'live') await resumeOnboarding({ ctx, deps, business, ob: now, state, reply, react: reactTo });
  }
  return out;

  async function everyday(business: Business): Promise<unknown> {
  const flow: FlowCtx = { db, cfg, deps, business, convRef, state };
  const toolBase = await makeToolCtx(ctx, deps, business, null);
  const setAwaiting = async (v: string | null) => { state.awaiting = v; await db.set(convRef, { awaiting: v }, { merge: true }); };
  const actionCtx = { ...toolBase, admin: ctx, reply, setAwaiting };

  // ── Menu rows and follow-up buttons (act:…, menu:…), and the old greeting buttons ──
  const tap = choiceId ? ({ 'g:products': 'act:products', 'g:orders': 'act:orders', 'g:help': 'act:menu' } as Record<string, string>)[choiceId] ?? choiceId : null;
  if (tap && (await handleActionTap(tap, actionCtx))) return;

  // ── Waiting for the next message after Add product / Send a campaign / Add photo ──
  if (state.awaiting === 'add' && !choiceId) {
    const parsed = parseProduct(text);
    if (parsed) { await setAwaiting(null); for (const o of await addProduct(flow, { ...parsed, imageUrl: await photo() })) await reply(o); return; }
    if (!matchAction(text)) return reply(withFollowUps(`Send the name and price together, e.g. *${example(business, await listProducts(db, business.id))}*.`, undefined));
    await setAwaiting(null);
  }
  if (state.awaiting === 'campaign' && !choiceId && text.trim() && !matchAction(text)) {
    await setAwaiting(null);
    return askOrRun('broadcast', { message: text.trim() });
  }
  if (state.awaiting?.startsWith('photo:') && input.imageId) {
    const id = state.awaiting.slice(6);
    await setAwaiting(null);
    const p = (await db.get(db.doc(C.products, id))) as Product | null;
    const url = await photo();
    if (!p || p.businessId !== business.id || p.deletedAt || !url) return reply("Sorry, I couldn't add that photo. Please try again.");
    await db.update(db.doc(C.products, p.id), { images: [url, ...p.images.filter(u => u !== url)].slice(0, 10), updatedAt: new Date().toISOString() });
    return reply(buttons(`📷 Added to *${p.name}*.`, followUps([['add', 'Add another'], ['products', 'My products']])));
  }

  // ── A whole menu / price list (PDF, photo or pasted list), and its Add all / Cancel ──
  const imported = await handleImport(flow, input, text, cfg.ADMIN_BOT_ACCESS_TOKEN, reply, reactTo);
  if (imported) { for (const o of imported.out) await reply(o); return; }

  // ── Product follow-ups (category picker, Correct/Edit, new category name) ──
  if (choiceId?.startsWith('pok:')) return reply(buttons('👍 Saved.', followUps([['add', 'Add another'], [`photo:${choiceId.slice(4)}`, 'Add photo']])));
  const handled = await handleProductInput(flow, choiceId, text);
  if (handled) { for (const o of handled) await reply(o); return; }
  if (state.editingProductId && !choiceId) {
    const parsed = parseProduct(text);
    if (parsed) { for (const o of await addProduct(flow, { ...parsed, imageUrl: await photo() })) await reply(o); return; }
  }

  // ── The shop's messages to customers (MESSAGES) ──
  const msg = await handleMessageInput(flow, choiceId, text);
  if (msg) {
    for (const o of msg.out) await reply(o);
    if (msg.done) return reply(buttons('Want to change another message?', [['msgmenu', 'Change another'], ['act:menu', 'Menu']]));
    return;
  }

  // ── Owner actions by name: "/sales", "sales", "how much did I make today", "hi" (the MENU) ──
  const named = !choiceId && !input.imageId ? matchAction(text) : null;
  if (named) return runAction(named.action, { ...actionCtx, arg: named.arg });

  // ── Settings: HOURS, AFTER HOURS, POLICIES, FEE ──
  const setting = await handleSettings(db, cfg, business, text, choiceId);
  if (setting) return reply(withFollowUps(setting, undefined));

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
      await reply(withFollowUps(await runTool(pending.tool, pending.args, toolBase), undefined));
      if (pending.tool === 'deleteMyData') await db.delete(convRef); // after the confirmation, which needs the window
      return;
    }
    if (NO.test(text)) return reply('OK, cancelled.');
    if (YES.test(text)) return reply('That request expired. Please send it again.');
    // Anything else: drop the pending action and treat this as a new message.
  }

  if (!text && !input.imageId) return runAction(actionById('menu')!, { ...actionCtx, arg: null });
  const choice = await chooseAdminTool(text, deps.llm).catch(e => { log('warn', 'llm_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); return null; });
  if (!choice) return reply(buttons("Sorry, I didn't get that. Tap *Menu* to see what I can do, or type it another way.", [['act:menu', 'Menu'], ['act:help', 'All commands']]));
  // The AI understood an action from the menu ("how much have I sold?"): the same reply and buttons.
  const same = actionForTool(choice.tool, choice.args);
  if (same) return runAction(same, { ...actionCtx, arg: null });

  // New products go through the shared flow (category guess, confirmation card).
  if (choice.tool === 'addProduct') {
    // The AI's arguments first ("puff puff", "200 naira", 50), then the owner's own words.
    const name = String(choice.args.name ?? '').trim().slice(0, 120);
    const priceKobo = choice.args.price == null ? null : nairaToKobo(String(choice.args.price));
    const stock = Number.isInteger(Number(choice.args.stock)) && choice.args.stock !== undefined && choice.args.stock !== null && Number(choice.args.stock) >= 0 ? Number(choice.args.stock) : null;
    const parsed = (name && priceKobo && priceKobo > 0 ? { name, priceKobo, stock } : null) ?? parseProduct(text);
    if (!parsed) return reply(`To add a product send its name and price, e.g. "add ${example(business)}" (add a stock number at the end if you track it).`);
    for (const o of await addProduct(flow, { ...parsed, imageUrl: await photo() })) await reply(o);
    return;
  }

  return askOrRun(choice.tool, choice.args);

  // A tool: asked first when it's destructive (YES/NO), else run, ending with a Menu button.
  async function askOrRun(name: string, args: Record<string, unknown>) {
    const prepared = await prepare(name, args, toolBase);
    if (prepared.kind === 'reply') return reply(withFollowUps(prepared.text, undefined));
    if (prepared.kind === 'confirm') {
      await db.set(convRef, { pendingAction: { tool: prepared.tool, args: prepared.args, expiresAt: new Date(Date.now() + CONFIRM_MINUTES * 60_000).toISOString() } }, { merge: true });
      held = true;
      return reply(buttons(prepared.prompt, CONFIRM_LABELS[prepared.tool] ?? [['yes', 'Yes, do it'], ['no', 'No, leave it']]));
    }
    log('info', 'admin_tool', { businessId: business.id, tool: prepared.tool });
    return reply(withFollowUps(await runTool(prepared.tool, prepared.args, toolBase), undefined));
  }
  }
}

async function storeImage(ctx: AdminContext, deps: BotDeps, business: Business, imageId: string) {
  if (!ctx.cfg.ADMIN_BOT_ACCESS_TOKEN) return null;
  return storeProductImage(ctx.cfg, deps, ctx.cfg.ADMIN_BOT_ACCESS_TOKEN, imageId, business.id, 'p').catch(e => { log('warn', 'image_store_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); return null; });
}

async function makeToolCtx(ctx: AdminContext, deps: BotDeps, business: Business, imageUrl: string | null): Promise<ToolCtx> {
  return { db: ctx.db, cfg: ctx.cfg, deps, business, ownerPhone: ctx.ownerPhone, imageUrl };
}
