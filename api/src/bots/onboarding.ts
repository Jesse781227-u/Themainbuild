// Owner onboarding by chat: "Hi" → a shop with categories and products in about 10 minutes.
// Stages (ownerPhones.onboardingStage): basics → categories → products → connect.
// (payout and delivery come in later phases; test and live after connect.)
// One question per message, buttons or lists wherever there's a choice, everything editable later.
// An owner who comes back after a break is asked whether to continue or start over.
import { C } from '../db';
import { BUSINESS_TYPES, type Business, type BusinessCategory } from '../domain/business';
import type { Product } from '../domain/commerce';
import { randomId } from '../lib/crypto';
import type { Firestore } from '../lib/firestore';
import type { OutboundContent } from '../services/channel';
import { createCategories, listCategories, listProducts, parseCategoryList } from '../services/catalog';
import { createSignupSession } from '../services/signup';
import type { AdminContext } from '../services/router';
import { buttons, list, type BotDeps } from './common';
import { parseAdminCommand, parseProductLine } from './intent';
import { addProduct, customerPreview, handleProductInput, parseProduct, type FlowCtx, type Out, type ProductFlowState } from './products-flow';

export type Stage = 'basics' | 'categories' | 'products' | 'connect';
type Step = 'owner_name' | 'business_name' | 'type' | 'city' | 'area' | 'categories' | 'categories_type' | 'products' | 'connect';

export interface Onboarding {
  stage: Stage; step: Step;
  draft?: { ownerName?: string; businessName?: string; type?: BusinessCategory; city?: string };
  lastSeenAt?: string; resumeAsked?: boolean; productsAdded?: number;
}

const RESUME_AFTER_MS = 30 * 60_000;
const STAGE_LABEL: Record<Stage, string> = { basics: 'your shop details', categories: 'your categories', products: 'adding products', connect: 'connecting your WhatsApp number' };
const DONE = /^(done|i'?m done|finish(ed)?|that'?s all|next|continue)$/i;

const typeOf = (id?: string) => BUSINESS_TYPES.find(t => t.id === id);
const looksLikeCommand = (t: string) => !!parseAdminCommand(t) || parseProductLine(t)?.stock !== undefined;

// Old conversations (before stages) are mapped onto the new steps.
export function normalise(raw: unknown): Onboarding | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { stage?: Stage; step?: string };
  if (o.stage) return o as unknown as Onboarding;
  if (o.step === 'category') return { stage: 'basics', step: 'type' };
  if (o.step === 'products') return { stage: 'products', step: 'products' };
  return { stage: 'basics', step: 'owner_name' };
}

interface Ctx { ctx: AdminContext; deps: BotDeps; business: Business | null; ob: Onboarding; state: ProductFlowState; reply: (c: Out) => Promise<unknown> }

export async function handleOnboarding(c: Ctx, text: string, choiceId: string | null, imageUrl: () => Promise<string | null>) {
  const { ctx } = c;
  const now = new Date();
  const back = c.ob.lastSeenAt && now.getTime() - new Date(c.ob.lastSeenAt).getTime() > RESUME_AFTER_MS;
  await setOb(c, { lastSeenAt: now.toISOString() });

  // Welcome back.
  if (choiceId === 'ob:continue') { await setOb(c, { resumeAsked: false }); return prompt(c); }
  if (choiceId === 'ob:restart') return startOver(c);
  if (back && !c.ob.resumeAsked && !(c.ob.stage === 'basics' && c.ob.step === 'owner_name')) {
    await setOb(c, { resumeAsked: true });
    const name = c.ob.draft?.ownerName ?? c.business?.ownerName;
    return c.reply(buttons(`Welcome back${name ? `, ${name.split(' ')[0]}` : ''}. You were on *${STAGE_LABEL[c.ob.stage]}*. Continue?`, [['ob:continue', 'Yes, continue'], ['ob:restart', 'Start over']]));
  }
  if (c.ob.resumeAsked) await setOb(c, { resumeAsked: false });

  switch (c.ob.step) {
    case 'owner_name': {
      const name = text.trim().replace(/^(my name is|i am|i'm|it'?s)\s+/i, '').slice(0, 40);
      if (name.length < 2 || looksLikeCommand(name) || /^(hi|hello|hey|start|good (morning|afternoon|evening))\b/i.test(name)) return c.reply("Welcome to Relay 👋 I'll get your shop taking orders on WhatsApp in about 10 minutes.\n\nFirst, what's your name?");
      await setOb(c, { step: 'business_name', draft: { ...c.ob.draft, ownerName: name } });
      return c.reply(`Nice to meet you, ${name.split(' ')[0]}! What's your business called?`);
    }
    case 'business_name': {
      const name = text.trim().slice(0, 80);
      if (name.length < 2) return c.reply("What's your business called?");
      if (looksLikeCommand(name)) return c.reply("That looks like a product or a command. First, what's your business called? You'll add products in a moment.");
      await setOb(c, { step: 'type', draft: { ...c.ob.draft, businessName: name } });
      return prompt(c);
    }
    case 'type': {
      const t = choiceId?.startsWith('btype:') ? typeOf(choiceId.slice(6))
        : BUSINESS_TYPES[Number(text.trim()) - 1] ?? BUSINESS_TYPES.find(x => x.label.toLowerCase().startsWith(text.trim().toLowerCase()) && text.trim().length >= 3);
      if (!t) return prompt(c);
      await setOb(c, { step: 'city', draft: { ...c.ob.draft, type: t.id } });
      return c.reply('Which city and area are you in? For example: *Lagos, Yaba*');
    }
    case 'city': {
      const parts = text.split(/,|\s+-\s+/).map(s => s.trim()).filter(Boolean);
      if (!parts.length || parts[0].length < 2) return c.reply('Which city and area are you in? For example: *Lagos, Yaba*');
      if (parts.length === 1) { await setOb(c, { step: 'area', draft: { ...c.ob.draft, city: parts[0] } }); return c.reply(`And which area in ${parts[0]}?`); }
      return finishBasics(c, parts[0], parts.slice(1).join(', '));
    }
    case 'area': {
      const area = text.trim().slice(0, 60);
      if (area.length < 2) return c.reply(`Which area in ${c.ob.draft?.city ?? 'your city'}?`);
      return finishBasics(c, c.ob.draft?.city ?? '', area);
    }
    case 'categories':
    case 'categories_type': {
      const biz = c.business!;
      if (choiceId === 'cat:ok') {
        if (!(await listCategories(ctx.db, biz.id)).length) return prompt(c);
        await setStage(c, 'products', 'products');
        return prompt(c);
      }
      if (choiceId === 'cat:own' || choiceId === 'cat:edit') { await setOb(c, { step: 'categories_type' }); return c.reply('Type your categories, separated by commas. For example: *Sneakers, Slides, Bags*'); }
      const names = choiceId === 'cat:use' ? typeOf(biz.category)?.starters ?? ['Products'] : parseCategoryList(text);
      if (!names.length) return prompt(c);
      await replaceEmptyCategories(ctx.db, biz.id);
      await createCategories(ctx.db, biz.id, names);
      const cats = await listCategories(ctx.db, biz.id);
      await setOb(c, { step: 'categories' });
      return c.reply(buttons(`Created ✅ ${cats.map(x => x.name).join(' · ')}`, [['cat:ok', 'Looks good'], ['cat:edit', 'Edit']]));
    }
    case 'products': {
      const biz = c.business!;
      const f: FlowCtx = { db: ctx.db, cfg: ctx.cfg, deps: c.deps, business: biz, convRef: ctx.db.doc(C.conversations, ctx.conversationId), state: c.state };
      if (choiceId === 'prod:done' || (!choiceId && DONE.test(text.trim()))) {
        if (!(await listProducts(ctx.db, biz.id)).length) return c.reply('Add at least one product first. Send its name and price, e.g. *Black AF1 25k*.');
        await setStage(c, 'connect', 'connect');
        return prompt(c);
      }
      if (choiceId === 'prod:more') return c.reply('Send the next product: a photo with the name and price as the caption, or just type it.');
      if (choiceId?.startsWith('pok:')) return c.reply(buttons('👍 Saved. Send the next product, or tap *I\'m done* when you\'ve added a few.', [['prod:done', "I'm done"]]));
      const handled = await handleProductInput(f, choiceId, text);
      if (handled) return sendAll(c, await afterCreate(c, f, handled));
      const parsed = parseProduct(text);
      if (!parsed) return c.reply('Send a product as its name and price, e.g. *Black AF1 25k*. Add a photo with it as the caption if you have one. Tap *I\'m done* when finished.');
      const out = await addProduct(f, { ...parsed, imageUrl: await imageUrl() });
      return sendAll(c, await afterCreate(c, f, out));
    }
    case 'connect':
      return prompt(c);
  }
}

// After a product card: count it, and at 3 products show what customers will see.
async function afterCreate(c: Ctx, f: FlowCtx, out: Out[]): Promise<Out[]> {
  const isCard = (o: Out) => typeof o !== 'string' && o.type === 'interactive' && JSON.stringify(o).includes('"pok:');
  if (!out.some(isCard)) return out;
  const count = (c.ob.productsAdded ?? 0) + 1;
  await setOb(c, { productsAdded: count });
  if (count !== 3) return out;
  const preview = await customerPreview(f);
  return preview ? [...out, "Here's what your customers will see 👇", preview, buttons('Keep adding products, or move on?', [['prod:more', 'Add more'], ['prod:done', "I'm done"]])] : out;
}

async function finishBasics(c: Ctx, city: string, area: string) {
  const { ctx } = c;
  const d = c.ob.draft ?? {};
  if (!d.businessName || !d.type) { await setOb(c, { step: 'business_name' }); return prompt(c); }
  const id = randomId(9).replace(/[^A-Za-z0-9]/g, 'x');
  const at = new Date().toISOString();
  const created = await ctx.db.create(ctx.db.doc(C.ownerPhones, ctx.ownerPhone), { businessId: id, ownerName: d.ownerName ?? null, onboardingStage: 'categories' });
  if (!created) return c.reply('This number already has a Relay business. Send HELP.');
  const business: Business = { id, name: d.businessName, category: d.type, ownerName: d.ownerName ?? null, city: city.slice(0, 60), area: area.slice(0, 60), ownerPhone: ctx.ownerPhone, status: 'onboarding', timezone: 'Africa/Lagos', createdAt: at, updatedAt: at };
  await ctx.db.create(ctx.db.doc(C.businesses, id), { ...business });
  c.business = business;
  await ctx.db.set(ctx.db.doc(C.conversations, ctx.conversationId), { businessId: id }, { merge: true });
  await setStage(c, 'categories', 'categories');
  return prompt(c);
}

// The question for the current step (also used to re-ask after "Continue").
async function prompt(c: Ctx): Promise<unknown> {
  const d = c.ob.draft ?? {};
  switch (c.ob.step) {
    case 'owner_name': return c.reply("Welcome to Relay 👋 I'll get your shop taking orders on WhatsApp in about 10 minutes.\n\nFirst, what's your name?");
    case 'business_name': return c.reply("What's your business called?");
    case 'type': return c.reply(list(`What kind of business is ${d.businessName ?? 'it'}?`, 'Choose type', BUSINESS_TYPES.map(t => ({ id: `btype:${t.id}`, title: t.label })), 'Business type'));
    case 'city': return c.reply('Which city and area are you in? For example: *Lagos, Yaba*');
    case 'area': return c.reply(`Which area in ${d.city ?? 'your city'}?`);
    case 'categories': case 'categories_type': {
      const cats = c.business ? await listCategories(c.ctx.db, c.business.id) : [];
      if (cats.length) return c.reply(buttons(`Your categories: ${cats.map(x => x.name).join(' · ')}`, [['cat:ok', 'Looks good'], ['cat:edit', 'Edit']]));
      const t = typeOf(c.business?.category);
      return c.reply(buttons(`What do you sell? Group your products into categories, the way customers will browse them.\n\nMany ${t?.label ?? ''} shops start with:\n*${(t?.starters ?? ['Products']).join(' · ')}*\n\nUse these, or type your own (e.g. *Sneakers, Bags, Watches*).`, [['cat:use', 'Use these'], ['cat:own', 'Type my own']]));
    }
    case 'products': return c.reply("Now let's add products. Send a *photo* with the name and price as the caption, e.g. *Black AF1 25k*.\n\nNo photo yet? Just type it. If you track stock, add the number at the end (e.g. *Black AF1 25k 10*).");
    case 'connect': {
      const link = await createSignupSession(c.ctx.db, c.ctx.cfg, c.business!.id);
      // From here the owner uses the everyday Admin Bot; ownerPhones.onboardingStage stays "connect"
      // until the number is connected.
      await c.ctx.db.set(c.ctx.db.doc(C.conversations, c.ctx.conversationId), { onboarding: null }, { merge: true });
      return c.reply(`Your shop is set up 🎉\n\nLast step: connect your WhatsApp Business number so customers can order from it. Open this link (valid 24 hours):\n${link}\n\nYou keep using the WhatsApp Business app as normal. Meanwhile, send HELP to see everything I can do.`);
    }
  }
}

async function startOver(c: Ctx) {
  const { db } = c.ctx;
  if (c.business && c.business.status === 'onboarding') {
    const [products, cats] = await Promise.all([db.query(C.products, [['businessId', '==', c.business.id]]), db.query(C.categories, [['businessId', '==', c.business.id]])]);
    const batch = db.batch();
    for (const p of products as unknown as Product[]) batch.delete(db.doc(C.products, p.id));
    for (const x of cats) batch.delete(db.doc(C.categories, x._id));
    batch.delete(db.doc(C.businesses, c.business.id));
    batch.delete(db.doc(C.ownerPhones, c.ctx.ownerPhone));
    await batch.commit();
    c.business = null;
  }
  c.ob = { stage: 'basics', step: 'owner_name', lastSeenAt: new Date().toISOString() };
  await db.set(db.doc(C.conversations, c.ctx.conversationId), { businessId: null, onboarding: c.ob, productDraft: null, awaiting: null, editingProductId: null }, { merge: true });
  return prompt(c);
}

// Categories the owner is replacing during onboarding: only empty ones are removed.
async function replaceEmptyCategories(db: Firestore, businessId: string) {
  const cats = await listCategories(db, businessId);
  const empty = cats.filter(x => !x.productCount);
  if (!empty.length) return;
  const batch = db.batch();
  for (const x of empty) batch.delete(db.doc(C.categories, x.id));
  await batch.commit();
}

async function setOb(c: Ctx, patch: Partial<Onboarding>) {
  c.ob = { ...c.ob, ...patch };
  await c.ctx.db.set(c.ctx.db.doc(C.conversations, c.ctx.conversationId), { onboarding: c.ob }, { merge: true });
}

async function setStage(c: Ctx, stage: Stage, step: Step) {
  await setOb(c, { stage, step });
  if (c.business) await c.ctx.db.set(c.ctx.db.doc(C.ownerPhones, c.ctx.ownerPhone), { onboardingStage: stage }, { merge: true });
}

async function sendAll(c: Ctx, out: Out[]) { for (const o of out) await c.reply(o); }

export const firstOnboarding = (): Onboarding => ({ stage: 'basics', step: 'owner_name' });
export type { OutboundContent };
