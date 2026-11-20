// The Relay Admin Bot: the owner runs their business by chatting with it.
//   1. Unknown number, or onboarding in progress → onboarding by chat (onboarding.ts).
//   2. Product taps and follow-ups (category picker, Correct/Edit) → products-flow.ts.
//   3. A pending destructive action waits for YES/NO.
//   4. Otherwise the message (typed or a voice note) becomes one validated tool call.
import { C } from '../db';
import type { Business } from '../domain/business';
import { log } from '../lib/logger';
import { nairaToKobo } from '../lib/money';
import { resolveSender, send, type OutboundContent } from '../services/channel';
import type { AdminContext } from '../services/router';
import { deleteCategory, listCategories, listProducts, moveCategoryProducts } from '../services/catalog';
import { prepare, runTool, isAdminTool, type ToolCtx } from './admin-tools';
import { actionById, actionForTool, followUps, handleActionTap, markOutForDelivery, matchAction, reachFromWords, reachPlan, runAction, withFollowUps } from './actions';
import type { Product } from '../domain/commerce';
import { readFlowReply } from '../services/flows';
import { handleFlowAnswer } from './flow-answers';
import { handleWalletInput } from './wallet-flow';
import { answerHours, hoursQuestion, readHoursText, type HoursDraft } from './hours-review';
import { describeHours } from '../services/hours';
import { example } from '../services/shop-type';
import { buttons, list, NO, readInput, storeProductImage, transcribeVoice, YES, type BotDeps } from './common';
import { chooseAdminTool, parseAdminCommand } from './intent';
import { conversational, isFail, runAgent } from './agent';
import { loadMemory, remember, saveMemory } from './agent-memory';
import { debugNote, recordAgentTurn } from './agent-stats';
import { waiting } from './owner-home';
import { ACTION_TOOLS, adminContext, adminSystem, adminTools2, applyUndo, confirmPrompt, mustConfirm, type AdminHelpers, type Undo } from './admin-agent';
import { firstOnboarding, handleOnboarding, normalise, resumeOnboarding } from './onboarding';
import { addProduct, handleProductInput, parseProduct, type FlowCtx, type ProductFlowState } from './products-flow';
import { handleImport } from './catalog-import';
import { answerZoneImport, startZoneImport, ZONES_ASK } from './zones-flow';
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
const HOW_IT_WORKS = "Relay runs your shop on your own WhatsApp number 👋\n\n1. Send me your menu or price list (a PDF, a photo, or just type it). I turn it into a shop customers can browse.\n2. Customers order by chat, any time. They pay by card or transfer and get a receipt.\n3. You get every order and payment here, and run everything by chat: prices, stock, delivery, reports.\n\nNo app to download, no monthly fee: 4.5% per sale. Setup takes about 5 minutes.";

// The two buttons under each "are you sure?" question.
const CONFIRM_LABELS: Record<string, [string, string][]> = {
  deleteProduct: [['yes', 'Yes, delete it'], ['no', 'No, keep it']],
  deleteCategory: [['yes', 'Yes, delete it'], ['no', 'No, keep it']],
  markPaid: [['yes', 'Yes, mark as paid'], ['no', 'Not paid yet']],
  cancelOrder: [['yes', 'Yes, cancel order'], ['no', 'No, keep order']],
  deleteMyData: [['yes', 'Yes, delete account'], ['no', 'No, keep account']],
  broadcast: [['yes', 'Yes, send it'], ['no', "No, don't send"]],
  setPrice: [['yes', 'Yes, change it'], ['no', 'No, keep it']],
  addDeliveryZone: [['yes', 'Yes, add it'], ['no', 'No, leave it']],
  setPaymentDetails: [['yes', 'Yes, save it'], ['no', 'No, leave it']],
};

interface AdminConversation extends ProductFlowState { onboarding?: unknown; pendingAction?: { tool: string; args: Record<string, unknown>; expiresAt: string } | null; undo?: (Undo & { expiresAt: string }) | null }

export async function handleAdmin(ctx: AdminContext, deps: BotDeps) {
  const { db, cfg } = ctx;
  const reply = (content: OutboundContent | string) => send(db, cfg, deps.transport, { from: { adminBot: true }, conversationId: ctx.conversationId, to: ctx.ownerPhone, content: typeof content === 'string' ? { type: 'text', text: content } : content });
  const convRef = db.doc(C.conversations, ctx.conversationId);
  const conv = ((await db.get(convRef)) ?? {}) as AdminConversation;
  // The owner's newest message: an AI reply still being written for an older one is dropped.
  const prevLatest = (conv as { lastOwnerMsgAt?: string | null }).lastOwnerMsgAt ?? '';
  if (ctx.event.sentAt >= prevLatest) await db.set(convRef, { lastOwnerMsgAt: ctx.event.sentAt, lastOwnerMsgId: ctx.event.messageId }, { merge: true });
  await showTyping(db, cfg, deps.transport, { adminBot: true }, ctx.ownerPhone, ctx.event.messageId);
  const reactTo = (emoji: string) => react(db, cfg, deps.transport, { from: { adminBot: true }, conversationId: ctx.conversationId, to: ctx.ownerPhone, messageId: ctx.event.messageId, emoji });

  const input = readInput(ctx.event);
  let text = input.text;
  let voice = false; // this message was a voice note (written out by a machine)
  if (input.audioId) {
    const heard = cfg.ADMIN_BOT_ACCESS_TOKEN ? await slowJob(() => transcribeVoice(cfg, deps, cfg.ADMIN_BOT_ACCESS_TOKEN!, input.audioId!), { react: reactTo, ok: r => !!r }) : null;
    if (!heard) return reply("Sorry, I couldn't listen to that voice note. Please type it instead.");
    text = heard;
    voice = true;
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
    if (choiceId === 'test:exit' || choiceId === 'act:exittest' || (!choiceId && TEST_EXIT.test(text.trim()))) {
      const ready = ob?.step === 'ready';
      await exitTest(ctx, ready, reply, { quiet: !ready && !!business });
      if (!ready && business) { const tb = await makeToolCtx(ctx, deps, business, null); return runAction(actionById('menu')!, { ...tb, admin: ctx, reply, setAwaiting: async () => {}, arg: null }); }
      return;
    }
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
  const setAwaiting = async (v: string | null) => { state.awaiting = v; await db.set(convRef, { awaiting: v, awaitingAt: v ? new Date().toISOString() : null }, { merge: true }); };
  const actionCtx = { ...toolBase, admin: ctx, reply, setAwaiting };

  // ── Navigation first: MENU / CANCEL / BACK, and taps that leave a half-done task behind ──
  const c0 = conv as AdminConversation & { awaitingAt?: string | null; zoneDraft?: unknown; hoursDraft?: unknown; kycDraft?: unknown; reachDraft?: unknown };
  // A question nobody answered for 10 minutes is dropped; the message is handled normally.
  if (state.awaiting && (!c0.awaitingAt || Date.now() - new Date(c0.awaitingAt).getTime() > CONFIRM_MINUTES * 60_000)) {
    state.awaiting = null;
    await db.set(convRef, { awaiting: null, awaitingAt: null }, { merge: true });
  }
  const pendingNow = !!(state.awaiting || c0.pendingAction || c0.zoneDraft || c0.hoursDraft || c0.kycDraft || c0.reachDraft || state.productDraft || state.editingProductId || state.importDraft);
  const clearPending = async (keep: string[] = []) => {
    const patch: Record<string, null> = { awaiting: null, awaitingAt: null, pendingAction: null, zoneDraft: null, hoursDraft: null, kycDraft: null, reachDraft: null, productDraft: null, editingProductId: null, importDraft: null };
    for (const k of keep) delete patch[k];
    Object.assign(c0, patch);
    state.awaiting = null; if (!keep.includes('productDraft')) state.productDraft = null; state.editingProductId = null; state.importDraft = null;
    await db.set(convRef, patch, { merge: true });
  };
  const word = text.trim().toLowerCase().replace(/[.!]+$/, '');
  if (!choiceId && !input.document && !input.imageId) {
    if (/^(menu|home|start|hi|hello)$/.test(word)) { await clearPending(); return runAction(actionById('menu')!, { ...actionCtx, arg: null }); }
    // "no" is only a cancel when the waiting question isn't itself a yes/no one (confirm a change,
    // the hours read-back, a withdrawal): there it's the answer.
    const yesNoQuestion = !!(c0.pendingAction || c0.hoursDraft || (conv as { withdrawConfirm?: unknown }).withdrawConfirm);
    if (/^(cancel|stop|back|exit|nevermind|never mind|no)$/.test(word) && !(word === 'no' && yesNoQuestion)) {
      if (pendingNow) { await clearPending(); return reply(buttons('Cancelled. Nothing was sent or saved.', [['act:menu', 'Menu']])); }
      return runAction(actionById('menu')!, { ...actionCtx, arg: null });
    }
  }
  // Any menu row or follow-up button leaves what was half-done (the wording pick keeps its draft).
  if (choiceId && /^(act|menu):/.test(choiceId) && pendingNow) await clearPending(choiceId.startsWith('act:reachpick') ? ['reachDraft'] : []);

  // ── A submitted form (WhatsApp Flow): only for the shop it was sent for ──
  const form = readFlowReply(input.flow);
  if (form) return reply(form.businessId === business.id ? await handleFlowAnswer(db, business, form.kind, form.answers) : 'That form was for another of your shops. Send SWITCH to change shop, then try again.');

  // ── Menu rows and follow-up buttons (act:…, menu:…), and the old greeting buttons ──
  const tap = choiceId ? ({ 'g:products': 'act:products', 'g:orders': 'act:orders', 'g:help': 'act:menu' } as Record<string, string>)[choiceId] ?? choiceId : null;
  if (tap && (await handleActionTap(tap, actionCtx))) return;

  // ── Wallet: verify (KYC) answers, withdraw amounts and confirmations ──
  const walletOut = await handleWalletInput({ ...actionCtx, arg: null }, choiceId, text);
  if (walletOut) return reply(walletOut);

  // ── A delivery list (pasted, spreadsheet, document or photo): read, review, save ──
  const zones = { db, cfg, deps, business, convRef };
  const zoneTap = await answerZoneImport(zones, choiceId);
  if (zoneTap) { for (const o of zoneTap.out) await reply(o); return; }
  const deliveryHint = /\bdeliver(y|ies)?\b/i.test(text) && (!!input.document || !!input.imageId || text.split(/\r?\n/).filter(l => /\d/.test(l)).length >= 3);
  if (!choiceId && (state.awaiting === 'zones' || deliveryHint) && (text.trim() || input.document || input.imageId)) {
    if (state.awaiting === 'zones' && !input.document && !input.imageId && matchAction(text)) await setAwaiting(null);
    else {
      const out = await startZoneImport(zones, input, text, reply);
      if (out) { await setAwaiting(null); for (const o of out) await reply(o); return; }
      if (state.awaiting === 'zones') return reply(`I couldn't find areas with prices there. ${ZONES_ASK}`);
    }
  }

  // ── Waiting for the next message after Add product / Send a campaign / Add photo ──
  if (state.awaiting === 'add' && !choiceId) {
    const parsed = parseProduct(text);
    if (parsed) { await setAwaiting(null); for (const o of await addProduct(flow, { ...parsed, imageUrl: await photo() })) await reply(o); return; }
    if (!matchAction(text)) return reply(waiting(`I need a name and a price, e.g. *${example(business, await listProducts(db, business.id))}*.`));
    await setAwaiting(null);
  }
  // "tell my sneaker buyers about the new Jordans": a group update, in plain words.
  if (!choiceId && text.trim() && ((state.awaiting === 'reach:group' && !matchAction(text)) || /^(?:please\s+)?(?:tell|message|remind|text)\s+(?:my|all|the|everyone|people|customers|those)\b/i.test(text.trim()))) {
    await setAwaiting(null);
    const out = await reachFromWords({ ...actionCtx, arg: null }, text);
    for (const o of Array.isArray(out) ? out : [out]) await reply(o);
    return;
  }
  if (state.awaiting === 'reach:all' && !choiceId && text.trim() && !matchAction(text)) {
    if (text.trim().split(/\s+/).length < 2) return reply(waiting('Type the whole message you want to send to your customers (a few words at least).'));
    await setAwaiting(null);
    return reply(await reachPlan({ ...actionCtx, arg: null }, text.trim()));
  }
  if (state.awaiting?.startsWith('campaign') && !choiceId && text.trim() && !matchAction(text)) {
    const statusPost = state.awaiting.startsWith('campaign:status:') ? state.awaiting.slice(16) : undefined;
    await setAwaiting(null);
    return askOrRun('broadcast', { message: text.trim(), ...(statusPost ? { statusPost } : {}) });
  }
  // "How many are back?" (Sold out / restock): a number, or a size and a number.
  if (state.awaiting?.startsWith('restock:') && !choiceId && text.trim()) {
    const p = (await db.get(db.doc(C.products, state.awaiting.slice(8)))) as Product | null;
    const m = /^(.*?)\s*(\d{1,6})$/.exec(text.trim().replace(/\s*(pcs|pieces|units)$/i, ''));
    if (!p || p.businessId !== business.id) { await setAwaiting(null); return reply(buttons('That product is gone.', [['act:soldout', 'Sold out / restock'], ['act:menu', 'Menu']])); }
    if (!m || !Number(m[2])) return reply(waiting(p.variants?.length ? `Send the size and how many, e.g. *${p.variants[0].label.split(' / ')[0]} 5*.` : 'Send how many are back, e.g. *10*.'));
    await setAwaiting(null);
    const out = await runTool('restock', { product: m[1] ? `${p.name} ${m[1]}` : p.name, quantity: Number(m[2]) }, toolBase);
    return reply(typeof out === 'string' ? buttons(`✅ ${out}`, [['act:soldout', 'Sold out / restock'], ['act:menu', 'Menu']]) : out);
  }
  // The rider and arrival time for an order going out ("Musa 0803 123 4567, 1 hour").
  if (state.awaiting?.startsWith('rider:') && !choiceId && text.trim() && !matchAction(text)) {
    return reply(await markOutForDelivery({ ...actionCtx, arg: state.awaiting.slice(6) }, text.trim()));
  }
  if (state.awaiting === 'policies' && !choiceId && text.trim()) {
    await setAwaiting(null);
    const r = await handleSettings(db, cfg, business, `policies: ${text.trim()}`, null);
    return reply(typeof r === 'string' ? buttons(r.slice(0, 1000), [['act:policies', 'Shop policies'], ['act:menu', 'Menu']]) : r ?? 'Saved.');
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

  // ── HOURS with times ("hours Mon–Fri 8am–6pm, Sat 10–4"): read, checked with the owner, then saved ──
  // "Change hours" asked for them: the next message is the hours.
  const askedHours = state.awaiting === 'hours' && !choiceId && text.trim() ? (await setAwaiting(null), ['', text.trim()] as unknown as RegExpExecArray) : null;
  const hoursText = askedHours ?? (!choiceId ? /^(?:hours|opening hours|set hours)\s*:?\s+(.+)$/i.exec(text.trim()) : null);
  if (hoursText && !/^(none|off|always open|24\/?7|any ?time)$/i.test(hoursText[1].trim())) {
    const d = await readHoursText(hoursText[1], deps.llm);
    if (!d) return reply("I couldn't read those hours. Try *hours 8am–9pm*, or *hours Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed*.");
    await db.set(convRef, { hoursDraft: d }, { merge: true });
    return reply(hoursQuestion(d));
  }
  const hoursDraft = (conv as { hoursDraft?: HoursDraft | null }).hoursDraft;
  if (hoursDraft && (choiceId?.startsWith('hrv:') || (!choiceId && text.trim() && !matchAction(text)))) {
    const r = answerHours(hoursDraft, choiceId, text);
    if (r && 'done' in r) {
      await db.update(db.doc(C.businesses, business.id), { hours: r.done, updatedAt: new Date().toISOString() });
      await db.set(convRef, { hoursDraft: null }, { merge: true });
      return reply(withFollowUps(`Saved ✅ ${describeHours(r.done)}.`, [['delivery', 'Delivery']]));
    }
    if (r && 'restart' in r) { await db.set(convRef, { hoursDraft: null }, { merge: true }); return reply('OK. Send them again, e.g. *hours Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed*.'); }
    if (r) { await db.set(convRef, { hoursDraft: r.draft }, { merge: true }); return reply(hoursQuestion(r.draft)); }
    if (choiceId) return reply(hoursQuestion(hoursDraft));
    await db.set(convRef, { hoursDraft: null }, { merge: true }); // they've moved on to something else
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

  // ── Undo (the button under a change the assistant just made) ──
  if (choiceId === 'undo' || (!choiceId && /^undo( that| it)?[.!]*$/i.test(text.trim()))) {
    await db.set(convRef, { undo: null }, { merge: true });
    return reply(withFollowUps(await applyUndo(db, toolBase, conv.undo), undefined));
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
  // Plain words go to the conversation agent; exact commands stay instant. If the agent can't
  // answer, the old routing does.
  if (deps.llm?.converse && cfg.AGENT_ENABLED !== 'false' && text.trim() && !input.imageId && (conversational(text.trim().toLowerCase()) || !parseAdminCommand(text))) {
    if (await ownerAgent(text)) return;
  }
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

  async function ownerAgent(message: string): Promise<boolean> {
    const memory = await loadMemory(db, ctx.conversationId);
    const helpers: AdminHelpers = {
      ctx: toolBase, llm: deps.llm, reply,
      askConfirm: async (tool, args, prompt, words) => {
        await db.set(convRef, { pendingAction: { tool, args, expiresAt: new Date(Date.now() + CONFIRM_MINUTES * 60_000).toISOString() } }, { merge: true });
        held = true;
        await reply(buttons(`${words ? `${words}\n\n` : ''}${prompt}`.slice(0, 1024), CONFIRM_LABELS[tool] ?? [['yes', 'Yes, do it'], ['no', 'No, leave it']]));
      },
      setUndo: async u => { await db.set(convRef, { undo: u ? { ...u, expiresAt: new Date(Date.now() + CONFIRM_MINUTES * 60_000).toISOString() } : null }, { merge: true }); },
      addProduct: async (words, p) => {
        if (words) await reply(words);
        const priceKobo = nairaToKobo(p.price);
        if (!priceKobo || priceKobo <= 0) { await reply(`What's the price of *${p.name}*?`); return; }
        for (const o of await addProduct(flow, { name: p.name, priceKobo, stock: p.stock ?? null, imageUrl: await photo() })) await reply(o);
      },
    };
    const tools = adminTools2(helpers);
    const r = await runAgent({ llm: deps.llm, system: adminSystem(business), context: `${await adminContext(toolBase)}${voice ? '\nThis message is a voice note written out by a machine: small mistakes are possible; ask if a name or number is unclear.' : ''}`, memory, message, tools, c: null, maxSteps: cfg.AGENT_MAX_STEPS, timeoutMs: cfg.AGENT_TIMEOUT_MS, actionTools: ACTION_TOOLS });
    await recordAgentTurn(db, cfg, business, 'admin', r).catch(() => undefined);
    const botNumber = await resolveSender(db, cfg, { adminBot: true }).then(s => s.phoneNumberId).catch(() => '');
    await debugNote(db, cfg, { phone: ctx.ownerPhone, botNumber, r }).catch(() => undefined);
    if (isFail(r)) return false;
    // The owner sent something newer while this was being written: this reply is out of date.
    const latest = ((await db.get(convRef)) as { lastOwnerMsgAt?: string | null } | null)?.lastOwnerMsgAt ?? '';
    if (latest > ctx.event.sentAt) { log('info', 'agent_reply_dropped', { businessId: business.id, reason: 'newer_owner_message' }); return true; }
    await saveMemory(db, ctx.conversationId, remember(memory, message, r.text, r.calls.map(c => c.name)));
    if (r.finish) await r.finish(r.text); else await reply(r.text);
    return true;
  }

  // A tool: asked first when it's destructive (YES/NO), else run, ending with a Menu button.
  async function askOrRun(name: string, args: Record<string, unknown>) {
    const prepared = await prepare(name, args, toolBase);
    if (prepared.kind === 'reply') return reply(withFollowUps(prepared.text, undefined));
    // Prices, money and messages to customers always wait for the owner's Confirm (their rule).
    if (prepared.kind === 'confirm' || mustConfirm(prepared.tool)) {
      const prompt = prepared.kind === 'confirm' ? prepared.prompt : confirmPrompt(prepared.tool, prepared.args);
      await db.set(convRef, { pendingAction: { tool: prepared.tool, args: prepared.args, expiresAt: new Date(Date.now() + CONFIRM_MINUTES * 60_000).toISOString() } }, { merge: true });
      held = true;
      return reply(buttons(prompt, CONFIRM_LABELS[prepared.tool] ?? [['yes', 'Yes, do it'], ['no', 'No, leave it']]));
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
