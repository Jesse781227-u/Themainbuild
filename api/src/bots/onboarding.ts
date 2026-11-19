// Owner onboarding by chat (v2): the owner sees their own shop working within about 90 seconds and
// finishes in about 5 minutes.
//   1 basics    shop name (owner name comes from the WhatsApp profile; asked only if missing)
//   2 products  menu/PDF/photo/pasted list, or typed products → summary + the real carousel
//               → business type (only if the products don't make it clear) → photos for top sellers
//   3 location  city, then area ("Lagos, Yaba" in one message works)
//   4 hours     opening and closing times (+ prep time for food)
//   5 delivery  pickup / delivery prices / other states, then shop policies
//   6 connect   TEST as a customer, who pays Relay's fee, two quick checks, the connect link
//   live        after connecting: profile photo (if missing), existing contacts, how they heard of Relay
// A menu sent as the very first message is read straight away; the shop name is asked meanwhile.
// One question per message, buttons or lists wherever there's a choice, everything editable later.
// An owner who comes back after a break is asked whether to continue or start over.
import { C } from '../db';
import { BUSINESS_TYPES, type Business, type BusinessCategory } from '../domain/business';
import type { Product } from '../domain/commerce';
import { randomId } from '../lib/crypto';
import { formatKobo, nairaToKobo } from '../lib/money';
import type { OutboundContent } from '../services/channel';
import { createCategories, listCategories, listProducts } from '../services/catalog';
import { createSignupSession } from '../services/signup';
import type { AdminContext } from '../services/router';
import { addShop, removeShop } from '../services/owners';
import { trackStep } from '../services/onboarding-events';
import { inferBusinessType } from '../services/business-type';
import { closeDays, describeHours, parseHours, parseWeek, sameEveryDay, validHours, type Hours } from '../services/hours';
import { defaultPolicies, policyText } from '../services/policies';
import { saveZone } from '../services/delivery';
import { openTicket } from '../services/support';
import { buttons, findProducts, list, storeProfilePhoto, type BotDeps, type Input } from './common';
import { handleImport, parsePastedMenu } from './catalog-import';
import { draftAllMessages } from './messages-flow';
import { log } from '../lib/logger';
import { parseAdminCommand } from './intent';
import { addProduct, handleProductInput, parseProduct, type FlowCtx, type Out, type ProductFlowState } from './products-flow';
import { categoryCarousel, productCarousel } from './product-cards';

export type Stage = 'basics' | 'products' | 'location' | 'hours' | 'delivery' | 'connect' | 'live';
export type Step =
  | 'shop_name' | 'owner_name'
  | 'products' | 'preview' | 'type' | 'photos'
  | 'city' | 'area'
  | 'hours' | 'hours_same' | 'hours_perday' | 'hours_closed' | 'prep' | 'prep_custom'
  | 'delivery' | 'fee_local' | 'fee_city' | 'interstate' | 'interstate_pricing' | 'interstate_fee' | 'policies' | 'policies_edit'
  | 'ready' | 'fee_payer' | 'check_wa' | 'check_fb'
  | 'live_photo' | 'live_contacts' | 'live_source';

export interface Onboarding {
  stage: Stage; step: Step;
  businessId?: string | null;          // the shop being set up (an owner can add more shops later)
  adding?: boolean;                    // NEW SHOP: this owner already has a shop
  welcomed?: boolean; nameSet?: boolean; typeConfident?: boolean;
  draft?: { city?: string; hours?: Hours };
  lastSeenAt?: string; resumeAsked?: boolean; productsAdded?: number; photosAdded?: number;
  photosId?: string | null;            // photos from the uploaded file, being matched in the background
}

const RESUME_AFTER_MS = 30 * 60_000;
const STEP_OF: Record<Exclude<Stage, 'live'>, number> = { basics: 1, products: 2, location: 3, hours: 4, delivery: 5, connect: 6 };
const STAGE_LABEL: Record<Stage, string> = { basics: 'your shop name', products: 'your products', location: 'your location', hours: 'your opening hours', delivery: 'delivery and policies', connect: 'connecting your WhatsApp number', live: 'the last few questions' };
const DONE = /^(done|i'?m done|finish(ed)?|that'?s all|that'?s it|next|continue|no more)$/i;
const SKIP = /^(skip|later|not now|no)$/i;
const MAX_TOP_PHOTOS = 5;
const PREP_TIMES = ['15–30 min', '30–60 min', '1 hr+'];
const SOURCES = [['src:friend', 'A friend'], ['src:instagram', 'Instagram'], ['src:status', 'WhatsApp Status'], ['src:event', 'An event'], ['src:other', 'Somewhere else']] as const;

const typeOf = (id?: string) => BUSINESS_TYPES.find(t => t.id === id);
const stepLabel = (stage: Stage) => (stage === 'live' ? '' : `*Step ${STEP_OF[stage]} of 6* · `);
const first = (name?: string | null) => name?.split(' ')[0] ?? '';

// A usable first name from the WhatsApp profile ("Ada Obi 🌸" → "Ada Obi"); null if there isn't one.
export function profileName(raw: string | null | undefined) {
  const name = (raw ?? '').normalize('NFKC').replace(/[^\p{L}\p{M}' .-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return /\p{L}{2,}/u.test(name) ? name : null;
}

// Conversations from the first onboarding (owner name → type → … → categories → products) are
// mapped onto the new steps.
export function normalise(raw: unknown): Onboarding | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Omit<Partial<Onboarding>, 'stage' | 'step'> & { step?: string; stage?: string };
  const known: Stage[] = ['basics', 'products', 'location', 'hours', 'delivery', 'connect', 'live'];
  if (o.stage && known.includes(o.stage as Stage) && o.step && !['business_name', 'categories', 'categories_type', 'photo', 'messages', 'connect'].includes(o.step)) return o as Onboarding;
  if (o.stage === 'branding' || o.stage === 'categories' || o.stage === 'products' || o.step === 'products') return { ...o, stage: 'products', step: 'products', welcomed: true, nameSet: true } as Onboarding;
  if (o.stage === 'connect') return { ...o, stage: 'connect', step: 'ready', welcomed: true, nameSet: true } as Onboarding;
  return { stage: 'basics', step: 'shop_name', lastSeenAt: o.lastSeenAt };
}

export const firstOnboarding = (opts: { adding?: boolean } = {}): Onboarding => ({ stage: 'basics', step: 'shop_name', ...(opts.adding ? { adding: true, welcomed: true } : {}) });

interface Ctx { ctx: AdminContext; deps: BotDeps; business: Business | null; ob: Onboarding; state: ProductFlowState; reply: (c: Out) => Promise<unknown>; react?: (emoji: string) => Promise<unknown> }

// Returns 'pass' when the message isn't for onboarding (after go-live), so the Admin Bot handles it.
export async function handleOnboarding(c: Ctx, text: string, choiceId: string | null, imageUrl: () => Promise<string | null>, input?: Input): Promise<unknown> {
  const now = new Date();
  const back = c.ob.lastSeenAt && now.getTime() - new Date(c.ob.lastSeenAt).getTime() > RESUME_AFTER_MS;
  await setOb(c, { lastSeenAt: now.toISOString() });

  if (c.ob.stage === 'live') return live(c, text, choiceId, input);

  // Welcome back.
  if (choiceId === 'ob:continue') { await setOb(c, { resumeAsked: false }); return prompt(c); }
  if (choiceId === 'ob:restart') return startOver(c);
  if (back && !c.ob.resumeAsked && c.ob.welcomed && (c.business || c.ob.step !== 'shop_name')) {
    await setOb(c, { resumeAsked: true });
    const name = c.business?.ownerName;
    return c.reply(buttons(`Welcome back${name ? `, ${first(name)}` : ''}. You were on *${STAGE_LABEL[c.ob.stage]}*. Continue?`, [['ob:continue', 'Yes, continue'], ['ob:restart', 'Start over']]));
  }
  if (c.ob.resumeAsked) await setOb(c, { resumeAsked: false });
  if (choiceId === 'ob:call') {
    await openTicket(c.ctx.db, c.ctx.cfg, c.deps, { ownerPhone: c.ctx.ownerPhone, businessId: c.business?.id ?? null, businessName: c.business?.name ?? null, stage: `${c.ob.stage}/${c.ob.step}`, message: 'Tapped "Call me" during signup' });
    return c.reply('Got it 👍 A real person from Relay will call or WhatsApp you shortly on this number.');
  }

  // A whole menu or price list, during the first two steps (also as the very first message).
  const menuish = !!input && !choiceId && (!!input.document || (!!input.imageId && !parseProduct(text)) || !!parsePastedMenu(text));
  if ((c.ob.stage === 'basics' || c.ob.stage === 'products') && (menuish || choiceId?.startsWith('imp:'))) {
    if (!c.business && menuish) await createShop(c, null);
    if (c.business) {
      const photosId = c.state.importDraft?.photosId ?? null;
      const imported = await handleImport(flowFor(c), input!, text, c.ctx.cfg.ADMIN_BOT_ACCESS_TOKEN, c.reply, c.react);
      if (imported?.created && photosId) await setOb(c, { photosId });
      if (imported) {
        await sendAll(c, imported.out);
        if (imported.created > 0) {
          await setOb(c, { productsAdded: (c.ob.productsAdded ?? 0) + imported.created });
          if (!c.ob.nameSet) return c.reply(`${stepLabel('basics')}Now, what's your shop called?`);
          return showPreview(c);
        }
        // The menu is being checked (Add all / Cancel); ask the name meanwhile.
        if (!c.ob.nameSet && !choiceId) {
          if (!c.ob.welcomed) { await setOb(c, { welcomed: true }); return c.reply(welcomeText(c, 'While you check that list: what\'s your shop called?')); }
          return c.reply('While you check that list: what\'s your shop called?');
        }
        return;
      }
    }
  }

  switch (c.ob.step) {
    case 'shop_name': {
      if (!c.ob.welcomed) { await setOb(c, { welcomed: true }); return c.reply(welcomeText(c, 'What\'s your shop called?')); }
      const name = text.trim().replace(/^(it'?s|it is|my shop is|my business is|we are|we're)\s+/i, '').replace(/[.!]+$/, '').slice(0, 80);
      if (name.length < 2 || choiceId) return prompt(c);
      if (parseAdminCommand(name)?.tool === 'addProduct' || (parseProduct(name)?.priceKobo ?? 0) >= 10_000) return c.reply('That looks like a product. First, what\'s your shop called? You\'ll add products next.');
      if (c.business) {
        await c.ctx.db.update(c.ctx.db.doc(C.businesses, c.business.id), { name, termsAcceptedAt: c.business.termsAcceptedAt ?? now.toISOString(), termsVersion: c.ctx.cfg.TERMS_VERSION, updatedAt: now.toISOString() });
        Object.assign(c.business, { name });
      } else await createShop(c, name);
      await setOb(c, { nameSet: true });
      await trackStep(c.ctx.db, { ownerPhone: c.ctx.ownerPhone, businessId: c.business!.id, step: 'shop_name', event: 'completed' });
      if (!c.business!.ownerName) { await setOb(c, { step: 'owner_name' }); return c.reply(`Lovely name! And what's *your* name?`); }
      return afterBasics(c);
    }
    case 'owner_name': {
      const name = profileName(text.replace(/^(my name is|i am|i'm|it'?s)\s+/i, ''));
      if (!name || choiceId) return c.reply("What's your name? (Just so I know what to call you.)");
      await c.ctx.db.update(c.ctx.db.doc(C.businesses, c.business!.id), { ownerName: name, updatedAt: now.toISOString() });
      c.business!.ownerName = name;
      await c.ctx.db.set(c.ctx.db.doc(C.ownerPhones, c.ctx.ownerPhone), { ownerName: name }, { merge: true });
      return afterBasics(c);
    }

    case 'products': {
      const f = flowFor(c);
      if (choiceId === 'prod:done' || (!choiceId && DONE.test(text.trim()))) {
        if (!(await listProducts(c.ctx.db, c.business!.id)).length) return c.reply('Add at least one product first. Send its name and price, e.g. *Jollof rice & chicken 3500*.');
        return showPreview(c);
      }
      if (choiceId === 'prod:more') return c.reply('Send the next product: its name and price, with a photo if you have one.');
      if (choiceId?.startsWith('pok:')) return c.reply(buttons('👍 Saved. Send the next product, or tap *That\'s all*.', [['prod:done', "That's all"]]));
      const handled = await handleProductInput(f, choiceId, text);
      if (handled) return afterTyped(c, handled);
      if (passToAdmin(text)) return 'pass';
      const parsed = parseProduct(text);
      if (!parsed) return c.reply(`Send a product as its name and price, e.g. *Jollof rice & chicken 3500*, or send your menu as a PDF or photo.${(c.ob.productsAdded ?? 0) > 0 ? ' Tap *That\'s all* when you\'re done.' : ''}`);
      await starterCategories(c, parsed.name);
      return afterTyped(c, await addProduct(f, { ...parsed, imageUrl: await imageUrl() }));
    }
    case 'preview': {
      if (choiceId === 'ok:yes' || /^(yes|looks (right|good)|ok(ay)?|correct|perfect|great)\b/i.test(text.trim())) return afterPreview(c);
      if (choiceId === 'ok:fix') return c.reply(buttons('No problem. To change a price, send the product again with the new price (e.g. *Jollof rice 3000*). To remove one, send *delete* and its name. *PRODUCTS* shows everything.\n\nTap *Looks right* when you\'re done.', [['ok:yes', 'Looks right']]));
      if (choiceId === 'prod:more') { await setOb(c, { step: 'products' }); return c.reply('Send the next product: its name and price, with a photo if you have one. Tap *That\'s all* when you\'re done.'); }
      const handled = await handleProductInput(flowFor(c), choiceId, text);
      if (handled) return sendAll(c, handled);
      if (passToAdmin(text)) return 'pass';
      const parsed = parseProduct(text);
      if (parsed) return sendAll(c, await addProduct(flowFor(c), { ...parsed, imageUrl: await imageUrl() }));
      return prompt(c);
    }
    case 'type': {
      const t = choiceId?.startsWith('btype:') ? typeOf(choiceId.slice(6))
        : BUSINESS_TYPES[Number(text.trim()) - 1] ?? BUSINESS_TYPES.find(x => text.trim().length >= 3 && x.label.toLowerCase().startsWith(text.trim().toLowerCase()));
      if (!t) return prompt(c);
      await c.ctx.db.update(c.ctx.db.doc(C.businesses, c.business!.id), { category: t.id, businessTypeInferred: false, updatedAt: now.toISOString() });
      c.business!.category = t.id;
      await draftMessagesOnce(c);
      return toPhotos(c);
    }
    case 'photos': {
      if (choiceId === 'ph:skip' || choiceId === 'ph:done' || (!choiceId && !input?.imageId && (SKIP.test(text.trim()) || DONE.test(text.trim())))) return toLocation(c);
      if (input?.imageId) {
        if (!text.trim()) return c.reply('Which product is this? Send the photo again with the product\'s name as the caption, e.g. *Jollof rice*.');
        const matches = await findProducts(c.ctx.db, c.business!.id, text.replace(/\s+(?:₦|n)?\d[\d,]*(\.\d+)?k?$/i, '').trim());
        if (matches.length !== 1) {
          const parsed = parseProduct(text);
          if (!matches.length && parsed) return sendAll(c, await addProduct(flowFor(c), { ...parsed, imageUrl: await imageUrl() }));
          return c.reply(matches.length ? `"${text.slice(0, 40)}" matches ${matches.length} products: ${matches.slice(0, 4).map(p => p.name).join(', ')}. Send the photo again with the full name.` : `I couldn't find "${text.slice(0, 40)}" in your shop. Check the name and send the photo again.`);
        }
        const url = await imageUrl();
        if (!url) return c.reply('Sorry, I couldn\'t save that photo. Please send it again.');
        const p = matches[0];
        await c.ctx.db.update(c.ctx.db.doc(C.products, p.id), { images: [url, ...p.images.filter(u => u !== url)].slice(0, 10), updatedAt: now.toISOString() });
        const added = (c.ob.photosAdded ?? 0) + 1;
        await setOb(c, { photosAdded: added });
        if (added >= MAX_TOP_PHOTOS) { await c.reply(`✅ Added to ${p.name}. That's ${MAX_TOP_PHOTOS} 👏 You can add more any time.`); return toLocation(c); }
        return c.reply(buttons(`✅ Added to ${p.name}. Send another, or tap *Done*.`, [['ph:done', "That's all photos"]]));
      }
      return prompt(c);
    }

    case 'city': {
      const parts = text.split(/,|\s+-\s+/).map(s => s.trim()).filter(Boolean);
      if (choiceId || !parts.length || parts[0].length < 2) return prompt(c);
      if (parts.length === 1) { await setOb(c, { step: 'area', draft: { ...c.ob.draft, city: parts[0].slice(0, 60) } }); return c.reply(`And which area in ${parts[0]}?`); }
      return saveLocation(c, parts[0], parts.slice(1).join(', '));
    }
    case 'area': {
      const area = text.trim().slice(0, 60);
      if (choiceId || area.length < 2) return prompt(c);
      return saveLocation(c, c.ob.draft?.city ?? '', area);
    }

    case 'hours': {
      const parsed = choiceId ? null : parseHours(text);
      if (!parsed) return c.reply('I couldn\'t read that. Send your opening and closing times like *8am – 9pm*, or by day like *Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed*.');
      if (parsed.perDay) return saveHours(c, parsed.hours);
      await setOb(c, { step: 'hours_same', draft: { ...c.ob.draft, hours: parsed.hours } });
      return prompt(c);
    }
    case 'hours_same': {
      const hours = validHours(c.ob.draft?.hours);
      if (!hours) { await setOb(c, { step: 'hours' }); return prompt(c); }
      if (choiceId === 'hrs:same' || /^(yes|same|every ?day)\b/i.test(text.trim())) return saveHours(c, hours);
      if (choiceId === 'hrs:perday') { await setOb(c, { step: 'hours_perday' }); return c.reply('Send your hours by day, e.g. *Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed*.'); }
      if (choiceId === 'hrs:closed') { await setOb(c, { step: 'hours_closed' }); return c.reply('Which days are you closed? e.g. *Sunday*, or *Sat and Sun*.'); }
      const week = parseWeek(text);
      if (week) return saveHours(c, week);
      return prompt(c);
    }
    case 'hours_perday': {
      const week = choiceId ? null : parseWeek(text);
      if (!week) return c.reply('I couldn\'t read that. Try like this: *Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed*.');
      return saveHours(c, week);
    }
    case 'hours_closed': {
      const hours = validHours(c.ob.draft?.hours) ?? sameEveryDay(null);
      const closed = choiceId ? null : closeDays(hours, text);
      if (!closed) return c.reply('Which days are you closed? Send the day names, e.g. *Sunday*.');
      return saveHours(c, closed);
    }
    case 'prep': {
      const pick = choiceId?.startsWith('prep:') ? choiceId.slice(5) : null;
      if (pick === 'custom') { await setOb(c, { step: 'prep_custom' }); return c.reply('How long does an order usually take? e.g. *45 minutes*'); }
      const label = pick ? PREP_TIMES[Number(pick)] : null;
      if (!label) return prompt(c);
      return savePrep(c, label);
    }
    case 'prep_custom': {
      const t = text.trim().slice(0, 40);
      if (choiceId || t.length < 2) return prompt(c);
      return savePrep(c, t);
    }

    case 'delivery': {
      const how = choiceId === 'dl:pickup' ? 'pickup' : choiceId === 'dl:deliver' ? 'delivery' : choiceId === 'dl:both' ? 'both' : /^pick/i.test(text) ? 'pickup' : /^both/i.test(text) ? 'both' : /deliver/i.test(text) ? 'delivery' : null;
      if (!how) return prompt(c);
      await patchBusiness(c, { fulfilment: how });
      if (how === 'pickup') return toPolicies(c);
      await setOb(c, { step: 'fee_local' });
      return prompt(c);
    }
    case 'fee_local': {
      const fee = feeFrom(text);
      if (fee === null || choiceId) return c.reply(`How much is delivery within ${c.business!.area ?? 'your area'}? Send an amount, e.g. *1500*, or *0* if it's free.`);
      await addZone(c, c.business!.area ?? 'Nearby', c.business!.area ?? '', fee, 2);
      await setOb(c, { step: 'fee_city' });
      return prompt(c);
    }
    case 'fee_city': {
      if (choiceId === 'fc:no' || (!choiceId && SKIP.test(text.trim()))) { await setOb(c, { step: 'interstate' }); return prompt(c); }
      const fee = feeFrom(text);
      if (fee === null || choiceId) return prompt(c);
      await addZone(c, c.business!.city ?? 'City', c.business!.city ?? '', fee, 1);
      await setOb(c, { step: 'interstate' });
      return prompt(c);
    }
    case 'interstate': {
      if (choiceId === 'is:no' || (!choiceId && /^no\b/i.test(text))) { await patchBusiness(c, { shipsInterstate: false, interstatePricing: null }); return toPolicies(c); }
      if (choiceId === 'is:yes' || (!choiceId && /^yes\b/i.test(text))) { await patchBusiness(c, { shipsInterstate: true }); await setOb(c, { step: 'interstate_pricing' }); return prompt(c); }
      return prompt(c);
    }
    case 'interstate_pricing': {
      if (choiceId === 'is:quote') { await patchBusiness(c, { interstatePricing: 'quote' }); return toPolicies(c); }
      if (choiceId === 'is:flat') { await patchBusiness(c, { interstatePricing: 'flat' }); await setOb(c, { step: 'interstate_fee' }); return prompt(c); }
      return prompt(c);
    }
    case 'interstate_fee': {
      const fee = feeFrom(text);
      if (fee === null || choiceId) return prompt(c);
      // An empty match covers any address; more specific zones (area, city) are tried first.
      await addZone(c, 'Other states', '', fee, 0);
      return toPolicies(c);
    }
    case 'policies': {
      if (choiceId === 'pol:use' || (!choiceId && /^(use|yes|ok)/i.test(text.trim()))) { await patchBusiness(c, { policies: defaultPolicies(c.business!.category) }); return toReady(c); }
      if (choiceId === 'pol:skip' || (!choiceId && SKIP.test(text.trim()))) { await patchBusiness(c, { policies: null }); return toReady(c); }
      if (choiceId === 'pol:edit') { await setOb(c, { step: 'policies_edit' }); return c.reply('Type your policies in your own words: returns, exchanges, refunds, and how customers should report a problem.'); }
      return prompt(c);
    }
    case 'policies_edit': {
      const t = text.trim().slice(0, 600);
      if (choiceId || t.length < 5) return prompt(c);
      await patchBusiness(c, { policies: { ...defaultPolicies(c.business!.category), custom: t } });
      await c.reply('Saved ✅ Send *POLICIES* any time to change them.');
      return toReady(c);
    }

    case 'ready': {
      if (choiceId === 'ob:connect' || /^(connect|connect now|next|continue)$/i.test(text.trim())) { await setOb(c, { step: 'fee_payer' }); return prompt(c); }
      return prompt(c);
    }
    case 'fee_payer': {
      const payer = choiceId === 'fee:customer' ? 'customer' : choiceId === 'fee:owner' ? 'owner' : null;
      if (!payer) return prompt(c);
      await patchBusiness(c, { feePayer: payer });
      await setOb(c, { step: 'check_wa' });
      return prompt(c);
    }
    case 'check_wa': {
      if (choiceId === 'wa:yes' || choiceId === 'wa:done') { await setOb(c, { step: 'check_fb' }); return prompt(c); }
      if (choiceId === 'wa:no' || choiceId === 'wa:unsure') {
        return c.reply(buttons("Switching is free and keeps your chats:\n1. Back up your chats (WhatsApp → Settings → Chats → Chat backup).\n2. Install *WhatsApp Business* from the Play Store or App Store.\n3. Open it and verify the same number. Your chats move over.\n\nTap *Done* once you're on WhatsApp Business, or tap *Call me* and we'll help.", [['wa:done', "I've switched"], ['ob:call', 'Call me']]));
      }
      return prompt(c);
    }
    case 'check_fb': {
      if (choiceId === 'fb:yes' || choiceId === 'fb:now') return sendConnectLink(c);
      if (choiceId === 'fb:no') return c.reply(buttons('Meta (who run WhatsApp) need a Facebook login to confirm the number is yours. You can create a free account at facebook.com in a few minutes, or tap *Call me* and we\'ll walk you through it.', [['fb:now', 'I have one now'], ['ob:call', 'Call me']]));
      return prompt(c);
    }
    case 'live_photo': case 'live_contacts': case 'live_source':
      return live(c, text, choiceId, input);
  }
}

// ── Steps ──

function welcomeText(c: Ctx, question: string) {
  const name = c.business?.ownerName ?? profileName(c.ctx.event.contactName);
  return `Welcome to Relay${name ? `, ${first(name)}` : ''} 👋 I'll set up your shop so customers can order from your own WhatsApp number any time, with payments and receipts handled for you. It takes about 5 minutes.\n\nBy continuing, you agree to Relay's Terms: ${c.ctx.cfg.API_BASE_URL}/terms\nStuck? Reply *CALL* anytime and a real person will help.\n\n${stepLabel('basics')}${question}`;
}

async function createShop(c: Ctx, name: string | null) {
  const { ctx } = c;
  const id = randomId(9).replace(/[^A-Za-z0-9]/g, 'x');
  const at = new Date().toISOString();
  const ownerName = profileName(ctx.event.contactName);
  const business: Business = {
    id, name: name ?? 'My shop', category: 'other', ownerName, city: null, area: null, ownerPhone: ctx.ownerPhone, status: 'onboarding', timezone: 'Africa/Lagos',
    termsAcceptedAt: name ? at : null, termsVersion: ctx.cfg.TERMS_VERSION, businessTypeInferred: false, feePayer: 'customer', createdAt: at, updatedAt: at,
  };
  await ctx.db.create(ctx.db.doc(C.businesses, id), { ...business });
  await addShop(ctx.db, ctx.ownerPhone, id, { ownerName, onboardingStage: 'basics' });
  c.business = business;
  await ctx.db.set(ctx.db.doc(C.conversations, ctx.conversationId), { businessId: id }, { merge: true });
  await setOb(c, { businessId: id });
  await trackStep(ctx.db, { ownerPhone: ctx.ownerPhone, businessId: id, step: 'basics', event: 'entered' });
}

async function afterBasics(c: Ctx) {
  // A menu was already added while the name was asked.
  if ((c.ob.productsAdded ?? 0) > 0) return showPreview(c);
  if (c.state.importDraft?.items.length) { await setStage(c, 'products', 'products'); return c.reply(`Thanks${c.business!.ownerName ? `, ${first(c.business!.ownerName)}` : ''}! Now tap *Add all* on the list above to add your products.`); }
  await setStage(c, 'products', 'products');
  return prompt(c);
}

// Products typed one by one: the first one decides the starter categories, so the owner isn't asked.
async function starterCategories(c: Ctx, productName: string) {
  if ((await listCategories(c.ctx.db, c.business!.id)).length) return;
  const guess = inferBusinessType([{ name: productName }]);
  const t = guess.confident ? typeOf(guess.type!) : null;
  await createCategories(c.ctx.db, c.business!.id, t?.starters ?? ['Products']);
}

async function afterTyped(c: Ctx, out: Out[]) {
  const isCard = (o: Out) => typeof o !== 'string' && o.type === 'interactive' && JSON.stringify(o).includes('"pok:');
  if (out.some(isCard)) await setOb(c, { productsAdded: (c.ob.productsAdded ?? 0) + 1 });
  await sendAll(c, out);
  if (out.some(isCard)) return c.reply(buttons('Send the next product, or tap *That\'s all* to see your shop.', [['prod:done', "That's all"]]));
}

// The value moment: what the shop looks like to customers, with the owner's real products.
async function showPreview(c: Ctx) {
  const biz = c.business!;
  if (c.ob.stage !== 'products') await setStage(c, 'products', 'preview');
  else await setOb(c, { step: 'preview' });
  const [cats, products] = await Promise.all([listCategories(c.ctx.db, biz.id), listProducts(c.ctx.db, biz.id)]);
  const used = cats.filter(x => products.some(p => p.categoryId === x.id));
  // The type, from the products themselves.
  if (biz.category === 'other' && !biz.businessTypeInferred) {
    const guess = inferBusinessType(products.map(p => ({ name: p.name, category: cats.find(x => x.id === p.categoryId)?.name })));
    await setOb(c, { typeConfident: guess.confident });
    if (guess.confident && guess.type) { await patchBusiness(c, { category: guess.type, businessTypeInferred: true }); }
  }
  const n = products.length;
  await c.reply(`✅ ${n} product${n === 1 ? '' : 's'}${used.length > 1 ? ` in ${used.length} categories: ${used.map(x => x.name).join(' · ')}` : ''}. Here's what your customers will see 👇`);
  const hello = `Hi, welcome to ${biz.name} 👋`;
  const preview: OutboundContent[] = used.length > 1
    ? [categoryCarousel(c.ctx.cfg, used, products, { intro: `${hello} What are you looking for?` })]
    : productCarousel(c.ctx.cfg, biz, products, { title: used[0]?.name ?? 'Our products', key: used[0]?.id ?? 'all', intro: hello });
  await sendAll(c, preview);
  await c.reply(buttons('Does that look right?', [['ok:yes', 'Looks right'], ['ok:fix', 'Change something'], ['prod:more', 'Add more products']]));
  // All the customer messages (welcome, thank-you, order updates) are drafted now, quietly; MESSAGES changes them.
  if (biz.category !== 'other' || biz.businessTypeInferred) await draftMessagesOnce(c);
}

async function draftMessagesOnce(c: Ctx) {
  if (c.business!.messages) return;
  try { await draftAllMessages(flowFor(c)); } catch (e) { log('warn', 'draft_messages_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); }
}

async function afterPreview(c: Ctx) {
  await trackStep(c.ctx.db, { ownerPhone: c.ctx.ownerPhone, businessId: c.business!.id, step: 'preview', event: 'completed' });
  if (c.business!.category === 'other' && !c.business!.businessTypeInferred) { await setOb(c, { step: 'type' }); return prompt(c); }
  return toPhotos(c);
}

async function toPhotos(c: Ctx) {
  const products = await listProducts(c.ctx.db, c.business!.id);
  if (products.every(p => p.images.length)) return toLocation(c);
  // Photos from their file are still being matched: don't ask for photos now.
  if (c.ob.photosId && (await c.ctx.db.get(c.ctx.db.doc(C.importPhotos, c.ob.photosId)))?.status === 'pending') return toLocation(c);
  await setOb(c, { step: 'photos' });
  return prompt(c);
}

async function toLocation(c: Ctx) { await setStage(c, 'location', 'city'); return prompt(c); }

async function saveLocation(c: Ctx, city: string, area: string) {
  await patchBusiness(c, { city: city.slice(0, 60), area: area.slice(0, 60) });
  await setStage(c, 'hours', 'hours');
  return prompt(c);
}

async function saveHours(c: Ctx, hours: Hours) {
  await patchBusiness(c, { hours, afterHours: c.business!.afterHours ?? 'orders' });
  await c.reply(`✅ ${describeHours(hours)}.\nWhen you're closed, customers can still order for when you open. (Send *AFTER HOURS* to change that.)`);
  if (c.business!.category === 'food_beverage') { await setOb(c, { step: 'prep' }); return prompt(c); }
  await setStage(c, 'delivery', 'delivery');
  return prompt(c);
}

async function savePrep(c: Ctx, label: string) {
  await patchBusiness(c, { prepTime: label });
  await setStage(c, 'delivery', 'delivery');
  return prompt(c);
}

const feeFrom = (text: string) => {
  const t = text.trim().toLowerCase();
  if (/^(0|free|nothing|zero)$/.test(t)) return 0;
  const k = nairaToKobo(t.replace(/^(₦|n)\s*/, '').replace(/\s*naira$/, ''));
  return k !== null && k >= 0 && k <= 100_000_000 ? k : null;
};

async function addZone(c: Ctx, name: string, match: string, feeKobo: number, priority: number) {
  await saveZone(c.ctx.db, { id: `${c.business!.id}_${randomId(6).replace(/[^A-Za-z0-9]/g, 'x')}`, businessId: c.business!.id, name: name.slice(0, 60), match: match.slice(0, 60), feeKobo, timeframe: '', active: true, priority });
}

async function toPolicies(c: Ctx) { await setOb(c, { step: 'policies' }); return prompt(c); }
async function toReady(c: Ctx) { await setStage(c, 'connect', 'ready'); return prompt(c); }

async function sendConnectLink(c: Ctx) {
  const link = await createSignupSession(c.ctx.db, c.ctx.cfg, c.business!.id);
  await trackStep(c.ctx.db, { ownerPhone: c.ctx.ownerPhone, businessId: c.business!.id, step: 'connect_link', event: 'entered' });
  // From here the owner uses the everyday Admin Bot; ownerPhones.onboardingStage stays "connect"
  // until the number is connected (then the go-live questions come).
  await c.ctx.db.set(c.ctx.db.doc(C.conversations, c.ctx.conversationId), { onboarding: null }, { merge: true });
  return c.reply(`Last step: open this link and log in with Facebook to connect your shop's number (valid 24 hours):\n${link}\n\nYou keep using the WhatsApp Business app as normal. I'll message you here when it's done. Meanwhile, send *HELP* to see everything I can do, or *TEST* to try your shop again.`);
}

// ── After go-live: optional questions; anything else goes to the Admin Bot ──
async function live(c: Ctx, text: string, choiceId: string | null, input?: Input): Promise<unknown> {
  const biz = c.business;
  if (!biz) return 'pass';
  switch (c.ob.step) {
    case 'live_photo': {
      if (input?.imageId && c.ctx.cfg.ADMIN_BOT_ACCESS_TOKEN) {
        const url = await storeProfilePhoto(c.ctx.cfg, c.deps, c.ctx.cfg.ADMIN_BOT_ACCESS_TOKEN, input.imageId, biz.id).catch(e => { log('warn', 'profile_photo_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); return null; });
        if (!url) return c.reply(buttons('Sorry, I couldn\'t save that photo. Try again, or skip for now.', [['lp:skip', 'Skip the picture']]));
        await patchBusiness(c, { profilePhotoUrl: url });
        await c.reply('Lovely ✅ That\'s your shop\'s picture now.');
      } else if (choiceId !== 'lp:skip') return 'pass';
      await setOb(c, { step: 'live_contacts' });
      return livePrompt(c);
    }
    case 'live_contacts': {
      if (choiceId !== 'lc:yes' && choiceId !== 'lc:no') return 'pass';
      await patchBusiness(c, { importContacts: choiceId === 'lc:yes' });
      await c.reply(choiceId === 'lc:yes' ? 'Done ✅ Your existing customers will appear in *CUSTOMERS* as WhatsApp shares them.' : 'OK, only people who order through Relay will be in your customer list.');
      await setOb(c, { step: 'live_source' });
      return livePrompt(c);
    }
    case 'live_source': {
      const pick = SOURCES.find(([id]) => id === choiceId);
      if (!pick) return 'pass';
      await patchBusiness(c, { acquisitionSource: pick[0].slice(4) });
      return finishLive(c, 'Thank you! 🙏 Send *HELP* any time to see what I can do.');
    }
    default: return 'pass';
  }
}

async function finishLive(c: Ctx, text: string) {
  await c.ctx.db.set(c.ctx.db.doc(C.conversations, c.ctx.conversationId), { onboarding: null }, { merge: true });
  await c.ctx.db.set(c.ctx.db.doc(C.ownerPhones, c.ctx.ownerPhone), { onboardingStage: 'live' }, { merge: true });
  await trackStep(c.ctx.db, { ownerPhone: c.ctx.ownerPhone, businessId: c.business!.id, step: 'live', event: 'completed' });
  return c.reply(text);
}

// The go-live questions, used right after connecting (go-live.ts) and when re-asked.
export function liveQuestion(step: Step, business: Pick<Business, 'name'>): OutboundContent | null {
  if (step === 'live_photo') return buttons(`Your WhatsApp Business profile has no picture yet. Send one for ${business.name}: your logo or a nice photo of your shop or products.`, [['lp:skip', 'Skip the picture']]);
  if (step === 'live_contacts') return buttons('WhatsApp can share the contacts and recent chats already on your shop\'s number. Add those people to your customer list (*CUSTOMERS*)? Only you see them, and you can remove them any time.', [['lc:yes', 'Yes, add them'], ['lc:no', 'No, leave them out']]);
  if (step === 'live_source') return list('Last one, and optional: how did you hear about Relay?', 'How I found Relay', SOURCES.map(([id, title]) => ({ id, title })), 'How you found us');
  return null;
}

async function livePrompt(c: Ctx) {
  const q = liveQuestion(c.ob.step, c.business!);
  return q ? c.reply(q) : 'pass';
}

// ── The question for each step (also used to re-ask after "Continue" or an unclear answer) ──
async function prompt(c: Ctx): Promise<unknown> {
  const biz = c.business;
  const L = stepLabel(c.ob.stage);
  switch (c.ob.step) {
    case 'shop_name': return c.reply(c.ob.adding ? `${L}What's the new shop or branch called?` : welcomeText(c, 'What\'s your shop called?'));
    case 'owner_name': return c.reply("What's your name?");
    case 'products': return c.reply(`${L}Send your menu, price list or product photos (PDF, photo, or paste the list) and I'll set up your shop.\n\nNo list? Just type a product, e.g. *Jollof rice & chicken 3500*.`);
    case 'preview': return c.reply(buttons('Does your shop look right?', [['ok:yes', 'Looks right'], ['ok:fix', 'Change something'], ['prod:more', 'Add more products']]));
    case 'type': return c.reply(list(`What kind of business is ${biz?.name ?? 'it'}? This helps me set up the right defaults.`, 'Pick business type', BUSINESS_TYPES.map(t => ({ id: `btype:${t.id}`, title: t.label })), 'Business type'));
    case 'photos': {
      const missing = biz ? (await listProducts(c.ctx.db, biz.id)).filter(p => !p.images.length).length : 0;
      return c.reply(buttons(`📷 ${missing} product${missing === 1 ? ' has' : 's have'} no photo yet, so customers see a coloured card with the first letter.\n\nSend photos of your top sellers (up to ${MAX_TOP_PHOTOS}): each photo with the product's name as the caption, e.g. *Jollof rice*.`, [['ph:skip', 'Add photos later']]));
    }
    case 'city': return c.reply(`${L}Where is ${biz?.name ?? 'your shop'}? Send the city and area, e.g. *Lagos, Yaba*.`);
    case 'area': return c.reply(`Which area in ${c.ob.draft?.city ?? 'your city'}?`);
    case 'hours': return c.reply(`${L}What time do you open and close? e.g. *8am – 9pm*\n\nDifferent on some days? Send it like *Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed*.`);
    case 'hours_same': {
      const h = validHours(c.ob.draft?.hours);
      return c.reply(buttons(`${h ? `${describeHours(h).replace(/^Every day /, '')}. ` : ''}Same every day?`, [['hrs:same', 'Yes, every day'], ['hrs:perday', 'No, set per day'], ['hrs:closed', 'Closed some days']]));
    }
    case 'hours_perday': return c.reply('Send your hours by day, e.g. *Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed*.');
    case 'hours_closed': return c.reply('Which days are you closed? e.g. *Sunday*.');
    case 'prep': return c.reply(list('How long does an order usually take to prepare?', 'Pick prep time', [...PREP_TIMES.map((t, i) => ({ id: `prep:${i}`, title: t })), { id: 'prep:custom', title: 'Something else' }], 'Prep time'));
    case 'prep_custom': return c.reply('How long does an order usually take? e.g. *45 minutes*');
    case 'delivery': return c.reply(buttons(`${L}How do customers get their orders?`, [['dl:pickup', 'Pickup only'], ['dl:deliver', 'Delivery only'], ['dl:both', 'Pickup & delivery']]));
    case 'fee_local': return c.reply(`How much is delivery within ${biz?.area ?? 'your area'}? e.g. *1500*, or *0* if it's free.`);
    case 'fee_city': return c.reply(buttons(`And elsewhere in ${biz?.city ?? 'your city'}? e.g. *3000*`, [['fc:no', `Only ${(biz?.area ?? 'my area').slice(0, 15)}`]]));
    case 'interstate': return c.reply(buttons('Do you send orders to other states?', [['is:yes', 'Yes, other states'], ['is:no', 'No, just nearby']]));
    case 'interstate_pricing': return c.reply(buttons('How do you charge for other states?', [['is:flat', 'One flat price'], ['is:quote', 'I quote per order']]));
    case 'interstate_fee': return c.reply('What\'s the flat price for other states? e.g. *6000*');
    case 'policies': {
      const t = typeOf(biz?.category);
      const text = policyText(defaultPolicies(biz?.category));
      return c.reply(buttons(`Your shop policies. These are what most ${t && t.id !== 'other' ? `${t.label.toLowerCase()} ` : ''}shops use:\n\n${text}\n\nYour shop assistant answers customers' questions about returns and problems from these.`, [['pol:use', 'Use these policies'], ['pol:edit', 'Write my own'], ['pol:skip', 'No policies for now']]));
    }
    case 'policies_edit': return c.reply('Type your policies in your own words: returns, exchanges, refunds, and how customers should report a problem.');
    case 'ready': return c.reply(buttons(`${L}${biz?.name ?? 'Your shop'} is ready 🎉\n\nBefore customers see it, try it yourself: tap *Test my shop* (or type *TEST*) to shop exactly as a customer would, with a pretend payment and a real receipt. Type *EXIT* to come back.\n\nThen we'll connect your WhatsApp number.`, [['test:start', 'Test my shop'], ['ob:connect', 'Connect my number']]));
    case 'fee_payer': return c.reply(buttons(`Before you connect: Relay's fee is *1% of each paid order*, at most ${formatKobo(c.ctx.cfg.FEE_CAP_KOBO)}. No monthly fee, and nothing on delivery charges.\n\nWho should pay it?\n• *My customers*: added to their total as a small service fee.\n• *I'll pay it*: customers pay your prices; the fee comes out of what you receive.\n\nYou can change this any time with *FEE*.`, [['fee:customer', 'My customers pay'], ['fee:owner', "I'll pay the fee"]]));
    case 'check_wa': return c.reply(buttons('Quick check: is your shop\'s number on the *WhatsApp Business* app (the green one with a "B"), not regular WhatsApp?', [['wa:yes', "Yes, it's Business"], ['wa:no', 'No, regular WhatsApp'], ['wa:unsure', 'Not sure']]));
    case 'check_fb': return c.reply(buttons('And can you log into Facebook? Meta use it to confirm the number is yours.', [['fb:yes', 'Yes, I can log in'], ['fb:no', 'No Facebook account']]));
    case 'live_photo': case 'live_contacts': case 'live_source': return livePrompt(c);
  }
}

// Owner commands (PRODUCTS, delete X, categories, …) work during the product steps too.
function passToAdmin(text: string) {
  const cmd = parseAdminCommand(text);
  return !!cmd && !['addProduct', 'greet', 'help'].includes(cmd.tool);
}

async function startOver(c: Ctx) {
  const { db } = c.ctx;
  if (c.business && c.business.status === 'onboarding') {
    const [products, cats, zones] = await Promise.all([db.query(C.products, [['businessId', '==', c.business.id]]), db.query(C.categories, [['businessId', '==', c.business.id]]), db.query(C.deliveryZones, [['businessId', '==', c.business.id]])]);
    const batch = db.batch();
    for (const p of products as unknown as Product[]) batch.delete(db.doc(C.products, p.id));
    for (const x of [...cats]) batch.delete(db.doc(C.categories, x._id));
    for (const z of zones) batch.delete(db.doc(C.deliveryZones, z._id));
    batch.delete(db.doc(C.businesses, c.business.id));
    await batch.commit();
    await removeShop(db, c.ctx.ownerPhone, c.business.id);
    c.business = null;
  }
  c.ob = { ...firstOnboarding({ adding: c.ob.adding }), welcomed: true, lastSeenAt: new Date().toISOString() };
  await db.set(db.doc(C.conversations, c.ctx.conversationId), { businessId: null, onboarding: c.ob, productDraft: null, awaiting: null, editingProductId: null, importDraft: null }, { merge: true });
  return c.reply(`OK, starting again.\n\n${stepLabel('basics')}What's your shop called?`);
}

const flowFor = (c: Ctx): FlowCtx => ({ db: c.ctx.db, cfg: c.ctx.cfg, deps: c.deps, business: c.business!, convRef: c.ctx.db.doc(C.conversations, c.ctx.conversationId), state: c.state });

async function patchBusiness(c: Ctx, patch: Partial<Business>) {
  await c.ctx.db.update(c.ctx.db.doc(C.businesses, c.business!.id), { ...patch, updatedAt: new Date().toISOString() } as Record<string, unknown>);
  Object.assign(c.business!, patch);
}

async function setOb(c: Ctx, patch: Partial<Onboarding>) {
  c.ob = { ...c.ob, ...patch };
  await c.ctx.db.set(c.ctx.db.doc(C.conversations, c.ctx.conversationId), { onboarding: c.ob }, { merge: true });
}

async function setStage(c: Ctx, stage: Stage, step: Step) {
  const prev = c.ob.stage;
  await setOb(c, { stage, step });
  if (!c.business) return;
  await c.ctx.db.set(c.ctx.db.doc(C.ownerPhones, c.ctx.ownerPhone), { onboardingStage: stage }, { merge: true });
  if (prev !== stage) {
    await trackStep(c.ctx.db, { ownerPhone: c.ctx.ownerPhone, businessId: c.business.id, step: prev, event: 'completed' });
    await trackStep(c.ctx.db, { ownerPhone: c.ctx.ownerPhone, businessId: c.business.id, step: stage, event: 'entered' });
  }
}

async function sendAll(c: Ctx, out: Out[]) { for (const o of out) await c.reply(o); }

export type { OutboundContent };
export type { BusinessCategory };
