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
import { example, exampleType } from '../services/shop-type';
import { closeDays, DAYS, describeHours, sameEveryDay, validHours, type Hours } from '../services/hours';
import { answerHours, hoursQuestion, readHoursText, type HoursDraft } from './hours-review';
import { defaultPolicies, policyText } from '../services/policies';
import { listZones, saveZone } from '../services/delivery';
import { describeLocation, knownCity, parseLocation, tidyPlace, type Location } from '../services/location';
import { openTicket } from '../services/support';
import { buttons, findProducts, list, storeProfilePhoto, type BotDeps, type Input } from './common';
import { handleImport, parsePastedMenu } from './catalog-import';
import { handleMessageInput, showChoices } from './messages-flow';
import { SIGNUP_MESSAGES } from '../services/shop-messages';
import { log } from '../lib/logger';
import { parseAdminCommand } from './intent';
import { addProduct, handleProductInput, parseProduct, type FlowCtx, type Out, type ProductFlowState } from './products-flow';
import { categoryCarousel, productCarousel, productDetails } from './product-cards';
import { answerZoneImport, startZoneImport } from './zones-flow';

export type Stage = 'basics' | 'products' | 'location' | 'hours' | 'delivery' | 'connect' | 'live';
export type Step =
  | 'shop_name' | 'owner_name'
  | 'products' | 'preview' | 'type' | 'photos'
  | 'city' | 'area' | 'street' | 'location_confirm'
  | 'hours' | 'hours_same' | 'hours_perday' | 'hours_closed' | 'hours_review' | 'prep' | 'prep_custom'
  | 'delivery' | 'fee_local' | 'fee_city' | 'interstate' | 'interstate_pricing' | 'interstate_fee' | 'policies' | 'policies_edit'
  | 'ready' | 'fee_payer' | 'check_wa' | 'check_fb'
  | 'live_photo' | 'live_contacts' | 'live_source'
  | 'msg_offer' | 'msg_pick' | 'msg_custom' | 'msg_confirm';

export interface Onboarding {
  stage: Stage; step: Step;
  businessId?: string | null;          // the shop being set up (an owner can add more shops later)
  adding?: boolean;                    // NEW SHOP: this owner already has a shop
  welcomed?: boolean; nameSet?: boolean; typeConfident?: boolean;
  draft?: { city?: string; hours?: Hours; hoursReview?: HoursDraft | null; loc?: Location; streetAsked?: boolean };
  lastSeenAt?: string; resumeAsked?: boolean; productsAdded?: number; photosAdded?: number;
  photosId?: string | null;            // photos from the uploaded file, being matched in the background
  msgIndex?: number;                   // which of SIGNUP_MESSAGES the owner is choosing wording for
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

// "My name is Teniola" / "I'm Teniola" / "call me Teni" / "Teniola here" → the name.
export function ownerNameFrom(text: string) {
  return text.trim().replace(/[.!]+$/, '')
    .replace(/^(hi|hello|hey)[,!\s]+/i, '')
    .replace(/^(my name is|my name's|name is|i am|i'm|im|it'?s|this is|call me|na|you can call me|they call me)\s+/i, '')
    .replace(/\s+(here|by name)$/i, '');
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
  const renaming = c.state.awaiting === 'shopName' && !choiceId; // "Change shop name" after the file check
  if ((c.ob.stage === 'basics' || c.ob.stage === 'products') && (menuish || renaming || choiceId?.startsWith('imp:'))) {
    if (!c.business && menuish) await createShop(c, null);
    if (c.business) {
      const photosId = c.state.importDraft?.photosId ?? null;
      const imported = await handleImport(flowFor(c), input!, text, c.ctx.cfg.ADMIN_BOT_ACCESS_TOKEN, c.reply, c.react);
      if (imported?.created && photosId) await setOb(c, { photosId });
      if (imported) {
        if (imported.created > 0) {
          await setOb(c, { productsAdded: (c.ob.productsAdded ?? 0) + imported.created });
          if (!c.ob.nameSet) { await sendAll(c, imported.out); return c.reply(`${stepLabel('basics')}Now, what's your shop called?`); }
          // One message: "Done ✅ Added 24 products in 4 categories… here's what customers see" (not two).
          return showPreview(c, { added: imported.created });
        }
        await sendAll(c, imported.out);
        // The menu is being checked (Add all / Cancel); ask the name meanwhile.
        if (!c.ob.nameSet && !choiceId) {
          if (!c.ob.welcomed) { await setOb(c, { welcomed: true }); return c.reply(welcomeText(c, 'While you check that list: what\'s your shop called?')); }
          return c.reply('While you check that list: what\'s your shop called?');
        }
        return;
      }
    }
  }

  // Owner commands (PRODUCTS, HELP, FEE, delete X…) work at every step; admin.ts answers them and
  // then repeats this step's question.
  if (c.business && c.ob.step !== 'shop_name') {
    if (!choiceId && isCommand(text, c.ob.step)) return 'pass';
    if (choiceId && /^(fee|ah|movecat|shop|newshop):/.test(choiceId) && c.ob.step !== 'fee_payer') return 'pass';
    if (choiceId && /^(pmatch|pcat|pedit|setcat):/.test(choiceId) && c.ob.step !== 'products' && c.ob.step !== 'preview') return 'pass';
  }

  switch (c.ob.step) {
    case 'shop_name': {
      if (!c.ob.welcomed) { await setOb(c, { welcomed: true }); return c.reply(welcomeText(c, 'What\'s your shop called?')); }
      const name = text.trim().replace(/^(it'?s|it is|my shop is|my business is|we are|we're)\s+/i, '').replace(/[.!]+$/, '').slice(0, 80);
      if (name.length < 2 || choiceId || !/\p{L}{2}/u.test(name)) return c.reply(`${stepLabel('basics')}Sorry, what's your shop called?`);
      if (parseAdminCommand(name)?.tool === 'addProduct' || (parseProduct(name)?.priceKobo ?? 0) >= 10_000) return c.reply('That looks like a product. First, what\'s your shop called? You\'ll add products next.');
      if (c.business) {
        await c.ctx.db.update(c.ctx.db.doc(C.businesses, c.business.id), { name, termsAcceptedAt: c.business.termsAcceptedAt ?? now.toISOString(), termsVersion: c.ctx.cfg.TERMS_VERSION, updatedAt: now.toISOString() });
        Object.assign(c.business, { name });
      } else await createShop(c, name);
      await setOb(c, { nameSet: true });
      await trackStep(c.ctx.db, { ownerPhone: c.ctx.ownerPhone, businessId: c.business!.id, step: 'shop_name', event: 'completed' });
      if (!c.business!.ownerName) { await setOb(c, { step: 'owner_name' }); return c.reply(`${stepLabel('basics')}Lovely name! And what's *your* name?`); }
      return afterBasics(c);
    }
    case 'owner_name': {
      const name = profileName(ownerNameFrom(text));
      if (!name || choiceId) return c.reply(`${stepLabel('basics')}What's your name? (Just so I know what to call you.)`);
      await c.ctx.db.update(c.ctx.db.doc(C.businesses, c.business!.id), { ownerName: name, updatedAt: now.toISOString() });
      c.business!.ownerName = name;
      await c.ctx.db.set(c.ctx.db.doc(C.ownerPhones, c.ctx.ownerPhone), { ownerName: name }, { merge: true });
      await c.reply(`Nice to meet you, ${first(name)}! 👋`);
      return afterBasics(c);
    }

    case 'products': {
      const f = flowFor(c);
      if (choiceId === 'prod:done' || (!choiceId && DONE.test(text.trim()))) {
        if (!(await listProducts(c.ctx.db, c.business!.id)).length) return c.reply(`Add at least one product first. Send its name and price, e.g. *${example(c.business!)}*.`);
        return showPreview(c);
      }
      if (choiceId === 'prod:more') return c.reply('Send the next product: its name and price, with a photo if you have one.');
      if (choiceId?.startsWith('pok:')) return c.reply(buttons('👍 Saved. Send the next product, or tap *That\'s all*.', [['prod:done', "That's all"]]));
      const handled = await handleProductInput(f, choiceId, text);
      if (handled) return afterTyped(c, handled);
      if (passToAdmin(text)) return 'pass';
      const parsed = parseProduct(text);
      if (!parsed) return c.reply(`Send a product as its name and price, e.g. *${example(c.business!, await listProducts(c.ctx.db, c.business!.id))}*, or send your ${listWord(c.business!)} as a PDF or photo.${(c.ob.productsAdded ?? 0) > 0 ? ' Tap *That\'s all* when you\'re done.' : ''}`);
      await starterCategories(c, parsed.name);
      return afterTyped(c, await addProduct(f, { ...parsed, imageUrl: await imageUrl() }));
    }
    case 'preview': {
      if (choiceId === 'ok:yes' || /^(yes|looks (right|good)|ok(ay)?|correct|perfect|great)\b/i.test(text.trim())) return afterPreview(c);
      if (choiceId === 'ok:fix') {
        const ps = await listProducts(c.ctx.db, c.business!.id);
        const name = example(c.business!, ps, { nameOnly: true });
        const p = ps.find(x => x.name === name);
        return c.reply(buttons(`To change a price, send the product with the new price, e.g. *${example(c.business!, ps, { price: p ? Math.round(p.priceKobo / 100) + 500 : undefined })}*. To remove one: *delete ${name}*.`, [['ok:yes', 'Looks right']]));
      }
      if (choiceId === 'prod:more') { await setOb(c, { step: 'products' }); return c.reply('Send the next product: its name and price, with a photo if you have one. Tap *That\'s all* when you\'re done.'); }
      if (choiceId === 'ok:see') return showPreview(c, { again: true });
      const handled = await handleProductInput(flowFor(c), choiceId, text);
      if (handled) { await sendAll(c, handled); if (choiceId?.startsWith('pmatch:') || choiceId?.startsWith('pcat:')) return c.reply(buttons('Anything else to change?', [['ok:yes', 'Looks right now'], ['ok:fix', 'Change something'], ['ok:see', 'See my shop again']])); return; }
      if (choiceId?.startsWith('cat:') || choiceId?.startsWith('more:') || choiceId?.startsWith('cats:') || choiceId?.startsWith('buy:') || choiceId?.startsWith('det:') || choiceId === 'menu') return previewTap(c, choiceId);
      if (passToAdmin(text)) return 'pass';
      const parsed = parseProduct(text);
      if (parsed) {
        await sendAll(c, await addProduct(flowFor(c), { ...parsed, imageUrl: await imageUrl() }, { prefer: 'update' }));
        if (!c.state.productDraft) return c.reply(buttons('Anything else to change?', [['ok:yes', 'Looks right now'], ['ok:fix', 'Change something'], ['ok:see', 'See my shop again']]));
        return;
      }
      return prompt(c);
    }
    case 'type': {
      const t = choiceId?.startsWith('btype:') ? typeOf(choiceId.slice(6))
        : BUSINESS_TYPES[Number(text.trim()) - 1] ?? BUSINESS_TYPES.find(x => text.trim().length >= 3 && x.label.toLowerCase().startsWith(text.trim().toLowerCase()));
      if (!t) return prompt(c);
      await c.ctx.db.update(c.ctx.db.doc(C.businesses, c.business!.id), { category: t.id, businessTypeInferred: false, updatedAt: now.toISOString() });
      c.business!.category = t.id;
      return toPhotos(c);
    }
    case 'photos': {
      if (choiceId === 'ph:skip' || choiceId === 'ph:done' || (!choiceId && !input?.imageId && (SKIP.test(text.trim()) || DONE.test(text.trim())))) return toLocation(c);
      if (input?.imageId) {
        if (!text.trim()) {
          const missing = (await listProducts(c.ctx.db, c.business!.id)).filter(p => !p.images.length);
          return c.reply(`Which product is this? Send the photo again with the product's name as the caption, e.g. *${example(c.business!, missing, { nameOnly: true })}*.`);
        }
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

    // Location: whatever they send is split into area, city, street and landmark; anything missing is
    // asked for, then it's read back before saving. The address is also where pickup customers go.
    case 'city': case 'area': case 'street': {
      if (choiceId === 'loc:nostreet') { await setOb(c, { draft: { ...c.ob.draft, streetAsked: true } }); return nextLocation(c); }
      if (choiceId || text.trim().length < 2) return prompt(c);
      const got = parseLocation(text);
      const loc: Location = { city: null, area: null, street: null, landmark: null, ...c.ob.draft?.loc };
      for (const k of ['city', 'area', 'street', 'landmark'] as const) if (got[k] && (!loc[k] || c.ob.step === 'city')) loc[k] = got[k];
      // A plain answer to "Which area?" / "Which city?" / "Which street?" is that thing.
      const plain = tidyPlace(text.replace(/^(it'?s|it is|in|at)\s+/i, ''));
      if (c.ob.step === 'area' && !got.area && !got.street && !got.city) loc.area = plain;
      if (c.ob.step === 'city' && loc.area && !got.city && !got.area && !got.street && !got.landmark) loc.city = knownCity(plain) ?? plain;
      // "Which street?": a plain answer is the street. If they sent the area/city again ("it's in
      // Lagos, Yaba, near Tejuosho market") that's kept, and the street is asked once more.
      const placeOnly = !got.street && (got.area || got.city || got.landmark);
      if (c.ob.step === 'street' && !got.street && !placeOnly) loc.street = tidyPlace(text.replace(LANDMARK_RE, '').replace(/^(it'?s|it is|we'?re at|at|on)\s+/i, ''));
      const asked = c.ob.step === 'street' && !placeOnly;
      await setOb(c, { draft: { ...c.ob.draft, loc, ...(asked ? { streetAsked: true } : {}) } });
      return nextLocation(c);
    }
    case 'location_confirm': {
      if (choiceId === 'loc:fix' || (!choiceId && /^(no|fix|wrong|change)/i.test(text.trim()))) { await setOb(c, { step: 'city', draft: { ...c.ob.draft, loc: undefined, streetAsked: false } }); return c.reply('No problem. Send the full address again, e.g. *12 Herbert Macaulay Way, Yaba, Lagos*.'); }
      if (choiceId === 'loc:ok' || (!choiceId && /^(yes|correct|right|ok(ay)?|that'?s right)\b/i.test(text.trim()))) return saveLocation(c);
      // A correction typed instead ("12 Herbert Macaulay Way", "near the market"): merged, read back again.
      if (!choiceId && text.trim().length >= 3) {
        const got = parseLocation(text);
        const loc: Location = { city: null, area: null, street: null, landmark: null, ...c.ob.draft?.loc };
        for (const k of ['city', 'area', 'street', 'landmark'] as const) if (got[k]) loc[k] = got[k];
        if (!got.street && !got.area && !got.city && !got.landmark) loc.street = tidyPlace(text);
        await setOb(c, { draft: { ...c.ob.draft, loc } });
      }
      return prompt(c);
    }

    // Hours: read by position (services/hours.ts), then checked with the owner (hours-review.ts):
    // doubtful times and days not mentioned are asked about, and nothing is saved unconfirmed.
    case 'hours': case 'hours_perday': {
      const draft = choiceId ? null : await readHoursText(text, c.deps.llm);
      if (!draft) return c.reply('I couldn\'t read that. Try *8am – 9pm*, or *Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed*.');
      // One time for every day: "Same every day?" is the check.
      const allSame = !draft.missing.length && !draft.doubts.length && DAYS.every(d => JSON.stringify(draft.week[d]) === JSON.stringify(draft.week.mon)) && !!draft.week.mon && c.ob.step === 'hours';
      if (allSame) { await setOb(c, { step: 'hours_same', draft: { ...c.ob.draft, hours: sameEveryDay(draft.week.mon!) } }); return prompt(c); }
      return review(c, draft);
    }
    case 'hours_same': {
      const hours = validHours(c.ob.draft?.hours);
      if (!hours) { await setOb(c, { step: 'hours' }); return prompt(c); }
      if (choiceId === 'hrs:same' || /^(yes|same|every ?day)\b/i.test(text.trim())) return saveHours(c, hours);
      if (choiceId === 'hrs:perday') { await setOb(c, { step: 'hours_perday' }); return c.reply('Send your hours by day, e.g. *Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed*.'); }
      if (choiceId === 'hrs:closed') { await setOb(c, { step: 'hours_closed' }); return c.reply('Which days are you closed? e.g. *Sunday*, or *Sat and Sun*.'); }
      const draft = choiceId ? null : await readHoursText(text, c.deps.llm);
      if (draft) return review(c, draft);
      return prompt(c);
    }
    case 'hours_closed': {
      const hours = validHours(c.ob.draft?.hours) ?? sameEveryDay(null);
      const closed = choiceId ? null : closeDays(hours, text);
      if (!closed) return c.reply('Which days are you closed? Send the day names, e.g. *Sunday*.');
      return review(c, { week: closed, doubts: [], missing: [], orphan: null, asking: null });
    }
    case 'hours_review': {
      const draft = c.ob.draft?.hoursReview;
      if (!draft) { await setOb(c, { step: 'hours' }); return prompt(c); }
      const r = answerHours(draft, choiceId, text);
      if (!r) return c.reply(hoursQuestion(draft));
      if ('restart' in r) { await setOb(c, { step: 'hours', draft: { ...c.ob.draft, hoursReview: null } }); return c.reply('OK, send your hours again, e.g. *Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed*.'); }
      if ('done' in r) { await setOb(c, { draft: { ...c.ob.draft, hoursReview: null } }); return saveHours(c, r.done); }
      return review(c, r.draft);
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
      // A whole list instead of one price (pasted, spreadsheet, document or photo).
      const zones = { db: c.ctx.db, cfg: c.ctx.cfg, deps: c.deps, business: c.business!, convRef: c.ctx.db.doc(C.conversations, c.ctx.conversationId) };
      const tapped = await answerZoneImport(zones, choiceId);
      if (tapped) {
        for (const o of tapped.out) await c.reply(o);
        if (tapped.saved) { await setOb(c, { step: 'interstate' }); return prompt(c); }
        return prompt(c);
      }
      if (!choiceId && (input?.document || input?.imageId || text.split(/\r?\n/).length >= 2)) {
        const out = await startZoneImport(zones, input ?? { text, choiceId: null, imageId: null, audioId: null, document: null } as never, text, c.reply);
        if (out) { for (const o of out) await c.reply(o); return; }
      }
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
      if (choiceId === 'pol:use' || (!choiceId && /^(use|yes|ok)/i.test(text.trim()))) { await patchBusiness(c, { policies: defaultPolicies(c.business!.category) }); return toMessages(c); }
      if (choiceId === 'pol:skip' || (!choiceId && SKIP.test(text.trim()))) { await patchBusiness(c, { policies: null }); return toMessages(c); }
      if (choiceId === 'pol:edit') { await setOb(c, { step: 'policies_edit' }); return c.reply('Type your policies: returns, exchanges and refunds.'); }
      return prompt(c);
    }
    case 'policies_edit': {
      const t = text.trim().slice(0, 600);
      if (choiceId || t.length < 5) return prompt(c);
      await patchBusiness(c, { policies: { ...defaultPolicies(c.business!.category), custom: t } });
      await c.reply('Saved ✅ Send *POLICIES* any time to change them.');
      return toMessages(c);
    }
    // Optional: the owner picks the wording of the three messages customers see most.
    case 'msg_offer': {
      if (choiceId === 'msgs:choose' || (!choiceId && /^(choose|yes)/i.test(text.trim()))) { await setOb(c, { step: 'msg_pick', msgIndex: 0 }); return prompt(c); }
      if (choiceId === 'msgs:default' || (!choiceId && /^(use defaults?|defaults?|no|skip)/i.test(text.trim()))) return toReady(c);
      return prompt(c);
    }
    case 'msg_pick': case 'msg_custom': case 'msg_confirm': {
      const r = await handleMessageInput(flowFor(c), choiceId, text);
      if (!r) return prompt(c);
      await sendAll(c, r.out);
      if (!r.done) return;
      const next = (c.ob.msgIndex ?? 0) + 1;
      if (next >= SIGNUP_MESSAGES.length) { await c.reply('Messages done 👍 Change them any time with *MESSAGES*.'); return toReady(c); }
      await setOb(c, { msgIndex: next });
      return prompt(c);
    }

    case 'ready': {
      if (choiceId === 'ob:connect' || /^(connect|connect now|next|continue)$/i.test(text.trim())) { await setOb(c, { step: 'check_wa' }); return prompt(c); }
      return prompt(c);
    }
    case 'fee_payer': {
      const payer = choiceId === 'fee:customer' ? 'customer' : choiceId === 'fee:owner' ? 'owner' : null;
      if (!payer) return prompt(c);
      await patchBusiness(c, { feePayer: payer });
      await c.reply(payer === 'owner' ? "👍 You'll pay the fee — customers see your prices only." : "👍 Your customers pay the fee — it's added to their total as a small service fee.");
      await setOb(c, { step: 'ready' });
      return prompt(c);
    }
    case 'check_wa': {
      if (choiceId === 'wa:yes' || choiceId === 'wa:done' || choiceId === 'wa:hasb') { await setOb(c, { step: 'check_fb' }); return prompt(c); }
      if (choiceId === 'wa:unsure') return c.reply(buttons('WhatsApp Business has a "B" on its icon. Does yours?', [['wa:hasb', 'It has a B'], ['wa:nob', 'No B']]));
      if (choiceId === 'wa:no' || choiceId === 'wa:nob') {
        return c.reply(buttons("Switching is free and keeps your chats: back up your chats, install *WhatsApp Business*, and verify the same number.\n\nTap *I've switched* when done, or *Call me* for help.", [['wa:done', "I've switched"], ['ob:call', 'Call me']]));
      }
      return prompt(c);
    }
    case 'check_fb': {
      if (choiceId === 'fb:yes' || choiceId === 'fb:now') return sendConnectLink(c);
      if (choiceId === 'fb:no') return c.reply(buttons('Meta needs a Facebook login to set up your business account. Create a free one at facebook.com, or tap *Call me* for help.', [['fb:now', 'I have one now'], ['ob:call', 'Call me']]));
      return prompt(c);
    }
    case 'live_photo': case 'live_contacts': case 'live_source':
      return live(c, text, choiceId, input);
  }
}

// "menu" for food shops, "catalogue" for everyone else.
const listWord = (b: Pick<Business, 'category' | 'name'> | null) => (b && exampleType(b) === 'food_beverage' ? 'menu' : b && exampleType(b) !== 'other' ? 'catalogue' : 'menu or catalogue');

// ── Steps ──

function welcomeText(c: Ctx, question: string) {
  const name = c.business?.ownerName ?? profileName(c.ctx.event.contactName);
  return `Welcome to Relay${name ? `, ${first(name)}` : ''} 👋 Let's set up your WhatsApp shop. It takes about 5 minutes.\n\nBy continuing you agree to our Terms: ${c.ctx.cfg.API_BASE_URL}/terms\nStuck? Reply *CALL*.\n\n${stepLabel('basics')}${question}`;
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
async function showPreview(c: Ctx, opts: { added?: number; again?: boolean } = {}) {
  const biz = c.business!;
  if (c.ob.stage !== 'products') await setStage(c, 'products', 'preview');
  else await setOb(c, { step: 'preview' });
  if (opts.again) {
    await sendAll(c, await shopPreview(c, `Hi, welcome to ${biz.name} 👋`));
    return c.reply(buttons('Does that look right?', [['ok:yes', 'Looks right'], ['ok:fix', 'Change something'], ['prod:more', 'Add more products']]));
  }
  const [cats, products] = await Promise.all([listCategories(c.ctx.db, biz.id), listProducts(c.ctx.db, biz.id)]);
  const used = cats.filter(x => products.some(p => p.categoryId === x.id));
  // The type, from the products themselves.
  if (biz.category === 'other' && !biz.businessTypeInferred) {
    const guess = inferBusinessType(products.map(p => ({ name: p.name, category: cats.find(x => x.id === p.categoryId)?.name })));
    await setOb(c, { typeConfident: guess.confident });
    if (guess.confident && guess.type) { await patchBusiness(c, { category: guess.type, businessTypeInferred: true }); }
  }
  const n = products.length;
  const catLine = used.length > 1 ? ` in ${used.length} categories: ${used.map(x => x.name).join(' · ')}` : '';
  const photos = products.filter(p => p.images.length).length;
  const photoNote = opts.added && photos ? `\n📷 ${photos === n ? 'All of them have' : `${photos} have`} a photo from your file.` : '';
  await c.reply(opts.added
    ? `Done ✅ Added ${opts.added} product${opts.added === 1 ? '' : 's'}${catLine}.${photoNote}\n\nHere's what your customers will see 👇`
    : `✅ ${n} product${n === 1 ? '' : 's'}${catLine}. Here's what your customers will see 👇`);
  await sendAll(c, await shopPreview(c, `Hi, welcome to ${biz.name} 👋`));
  await c.reply(buttons('Does that look right?', [['ok:yes', 'Looks right'], ['ok:fix', 'Change something'], ['prod:more', 'Add more products']]));
}

// What a customer sees first: the sections (or the products, with one section).
async function shopPreview(c: Ctx, hello: string): Promise<OutboundContent[]> {
  const biz = c.business!;
  const [cats, products] = await Promise.all([listCategories(c.ctx.db, biz.id), listProducts(c.ctx.db, biz.id)]);
  const used = cats.filter(x => products.some(p => p.categoryId === x.id));
  return used.length > 1
    ? [categoryCarousel(c.ctx.cfg, used, products, { intro: `${hello} What are you looking for?` })]
    : productCarousel(c.ctx.cfg, biz, products, { title: used[0]?.name ?? 'Our products', key: used[0]?.id ?? 'all', intro: hello });
}

// Taps on the preview work like they will for customers, so the owner can check items and photos.
async function previewTap(c: Ctx, choiceId: string) {
  const biz = c.business!;
  const [cats, products] = await Promise.all([listCategories(c.ctx.db, biz.id), listProducts(c.ctx.db, biz.id)]);
  const [kind, a, b] = choiceId.split(':');
  if (kind === 'cat' || kind === 'more') {
    const cat = cats.find(x => x.id === a);
    const items = a === 'all' ? products : products.filter(p => p.categoryId === a);
    await sendAll(c, productCarousel(c.ctx.cfg, biz, items, { title: cat?.name ?? 'Our products', key: a, page: kind === 'more' ? Number(b) || 0 : 0 }));
  } else if (kind === 'cats' || kind === 'menu') {
    const used = cats.filter(x => products.some(p => p.categoryId === x.id));
    await c.reply(categoryCarousel(c.ctx.cfg, used, products, { intro: `Hi, welcome to ${biz.name} 👋 What are you looking for?`, page: Number(a) || 0 }));
  } else if (kind === 'det') {
    const p = products.find(x => x.id === a);
    if (p) await sendAll(c, productDetails(c.ctx.cfg, p));
  } else if (kind === 'buy') {
    await c.reply("That button adds it to the customer's cart. Tap *Test my shop* later to try a whole order.");
  }
  return c.reply(buttons('Does your shop look right?', [['ok:yes', 'Looks right'], ['ok:fix', 'Change something'], ['prod:more', 'Add more products']]));
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

const LANDMARK_RE = /[\s,]+(near|opposite|beside|close to|behind|next to)\s+.+$/i;

// Asks for whatever's still missing (area, then city, then street), then reads it all back.
async function nextLocation(c: Ctx) {
  const loc = c.ob.draft?.loc;
  const next: Step = !loc?.area ? 'area' : !loc.city ? 'city' : !loc.street && !c.ob.draft?.streetAsked ? 'street' : 'location_confirm';
  await setOb(c, { step: next });
  return prompt(c);
}

async function saveLocation(c: Ctx) {
  const loc = c.ob.draft?.loc;
  if (!loc?.area || !loc.city) { await setOb(c, { step: 'city' }); return prompt(c); }
  await patchBusiness(c, { city: loc.city.slice(0, 60), area: loc.area.slice(0, 60), address: loc.street?.slice(0, 120) ?? null, landmark: loc.landmark?.slice(0, 80) ?? null });
  await setStage(c, 'hours', 'hours');
  return prompt(c);
}

async function review(c: Ctx, draft: HoursDraft) {
  await setOb(c, { step: 'hours_review', draft: { ...c.ob.draft, hoursReview: draft } });
  return c.reply(withLabel(hoursQuestion(draft), stepLabel('hours')));
}

async function saveHours(c: Ctx, hours: Hours) {
  await patchBusiness(c, { hours, afterHours: c.business!.afterHours ?? 'orders' });
  await c.reply(`✅ ${describeHours(hours)}. When you're closed, customers can still order for later (*AFTER HOURS* to change).`);
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

async function toPolicies(c: Ctx) {
  // The delivery prices, read back once they're all set.
  if (c.business!.fulfilment !== 'pickup') {
    const zones = await listZones(c.ctx.db, c.business!.id);
    const fee = (k: number) => (k ? formatKobo(k) : 'free');
    const local = zones.find(z => z.priority === 2), city = zones.find(z => z.priority === 1), other = zones.find(z => z.priority === 0 && !z.match);
    const parts = [
      local ? `${fee(local.feeKobo)} within ${local.name}` : null,
      city ? `${fee(city.feeKobo)} elsewhere in ${city.name}` : null,
      c.business!.shipsInterstate ? `other states: ${other ? fee(other.feeKobo) : 'you quote per order'}` : null,
    ].filter(Boolean);
    if (parts.length) await c.reply(`✅ Delivery: ${parts.join(' · ')}.${c.business!.fulfilment === 'both' ? ' Pickup is free.' : ''}`);
  }
  await setOb(c, { step: 'policies' });
  return prompt(c);
}
// Who pays Relay's fee comes before TEST, so the pretend order already shows the right total.
async function toMessages(c: Ctx) { await setOb(c, { step: 'msg_offer' }); return prompt(c); }
async function toReady(c: Ctx) { await setStage(c, 'connect', 'fee_payer'); return prompt(c); }

async function sendConnectLink(c: Ctx) {
  const link = await createSignupSession(c.ctx.db, c.ctx.cfg, c.business!.id);
  await trackStep(c.ctx.db, { ownerPhone: c.ctx.ownerPhone, businessId: c.business!.id, step: 'connect_link', event: 'entered' });
  // From here the owner uses the everyday Admin Bot; ownerPhones.onboardingStage stays "connect"
  // until the number is connected (then the go-live questions come).
  await c.ctx.db.set(c.ctx.db.doc(C.conversations, c.ctx.conversationId), { onboarding: null }, { merge: true });
  return c.reply(`Last step: open this link and log in with Facebook to connect your number (valid 24 hours):\n${link}\n\nYou keep using WhatsApp Business as normal. I'll message you when it's done.`);
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
  // Every question says where they are ("*Step 4 of 6* · …"), once.
  const ask = (content: Out): Promise<unknown> => c.reply(withLabel(content, L));
  switch (c.ob.step) {
    case 'shop_name': return ask(c.ob.adding ? `What's the new shop or branch called?` : welcomeText(c, 'What\'s your shop called?'));
    case 'owner_name': return ask("What's *your* name?");
    case 'products': return ask(`Send your ${listWord(biz)} or price list (PDF, photo or pasted list).\n\nNo list? Type one product, e.g. *${example(biz ?? {})}*.`);
    case 'preview': return ask(buttons('Does your shop look right?', [['ok:yes', 'Looks right'], ['ok:fix', 'Change something'], ['prod:more', 'Add more products']]));
    case 'type': return ask(list(`What kind of business is ${biz?.name ?? 'it'}?`, 'Pick business type', BUSINESS_TYPES.map(t => ({ id: `btype:${t.id}`, title: t.label })), 'Business type'));
    case 'photos': {
      const without = biz ? (await listProducts(c.ctx.db, biz.id)).filter(p => !p.images.length) : [];
      const missing = without.length;
      const named = missing <= 3 ? without.map(p => `*${p.name}*`).join(', ').replace(/, ([^,]*)$/, ' and $1') : `${missing} products`;
      return ask(buttons(`📷 ${named} ${missing === 1 ? 'has' : 'have'} no photo yet. Send up to ${MAX_TOP_PHOTOS} of your top sellers, each with its name as the caption, e.g. *${example(biz ?? {}, without, { nameOnly: true })}*.`, [['ph:skip', 'Add photos later']]));
    }
    case 'city': {
      const area = c.ob.draft?.loc?.area;
      if (area) return ask(`Which city or state is *${area}* in?`);
      return ask(`Where is ${biz?.name ?? 'your shop'}? e.g. *12 Herbert Macaulay Way, Yaba, Lagos*\nPickup customers get this address.`);
    }
    case 'area': return ask(`Which area${c.ob.draft?.loc?.city ? ` in ${c.ob.draft.loc.city}` : ''} is ${biz?.name ?? 'your shop'} in? e.g. *Yaba*`);
    case 'street': {
      const loc = c.ob.draft?.loc;
      return ask(buttons(`What's the street or building in ${loc?.area ?? 'your area'}? e.g. *12 Herbert Macaulay Way*`, [['loc:nostreet', 'No pickup address']]));
    }
    case 'location_confirm': return ask(buttons(`📍 ${describeLocation(c.ob.draft?.loc ?? {})}. Is that right?`, [['loc:ok', 'Yes, that\'s right'], ['loc:fix', 'Fix it']]));
    case 'hours': return ask(`What time do you open and close? e.g. *8am – 9pm*, or *Mon–Fri 8am–6pm, Sun closed*`);
    case 'hours_same': {
      const h = validHours(c.ob.draft?.hours);
      return ask(buttons(`${h ? `${describeHours(h).replace(/^Every day /, '')}. ` : ''}Same every day?`, [['hrs:same', 'Yes, every day'], ['hrs:perday', 'No, set per day'], ['hrs:closed', 'Closed some days']]));
    }
    case 'hours_perday': return ask('Send your hours by day, e.g. *Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed*.');
    case 'hours_closed': return ask('Which days are you closed? e.g. *Sunday*.');
    case 'hours_review': return c.ob.draft?.hoursReview ? ask(hoursQuestion(c.ob.draft.hoursReview)) : ask('What time do you open and close? e.g. *8am – 9pm*');
    case 'prep': return ask(list('How long does an order usually take to prepare?', 'Pick prep time', [...PREP_TIMES.map((t, i) => ({ id: `prep:${i}`, title: t })), { id: 'prep:custom', title: 'Something else' }], 'Prep time'));
    case 'prep_custom': return ask('How long does an order usually take? e.g. *45 minutes*');
    case 'delivery': return ask(buttons(`How do customers get their orders?`, [['dl:pickup', 'Pickup only'], ['dl:deliver', 'Delivery only'], ['dl:both', 'Pickup & delivery']]));
    case 'fee_local': return ask(`How much is delivery within ${biz?.area ?? 'your area'}? e.g. *1500*, or *0* if free.\n\nHave a full list of areas and prices? Paste it or send the spreadsheet, PDF or photo.`);
    case 'fee_city': return ask(buttons(`And elsewhere in ${biz?.city ?? 'your city'}? e.g. *3000*`, [['fc:no', `Only ${(biz?.area ?? 'my area').slice(0, 15)}`]]));
    case 'interstate': return ask(buttons('Do you send orders to other states?', [['is:yes', 'Yes, other states'], ['is:no', 'No, just nearby']]));
    case 'interstate_pricing': return ask(buttons('How do you charge for other states?', [['is:flat', 'One flat price'], ['is:quote', 'I quote per order']]));
    case 'interstate_fee': return ask('What\'s the flat price for other states? e.g. *6000*');
    case 'policies': {
      const t = typeOf(biz?.category);
      const text = policyText(defaultPolicies(biz?.category));
      return ask(buttons(`Your shop policies (what most ${t && t.id !== 'other' ? `${t.label.toLowerCase()} ` : ''}shops use):\n\n${text}`, [['pol:use', 'Use these policies'], ['pol:edit', 'Write my own'], ['pol:skip', 'No policies for now']]));
    }
    case 'policies_edit': return ask('Type your policies: returns, exchanges and refunds.');
    case 'msg_offer': return ask(buttons(`Want to pick how ${biz?.name ?? 'your shop'} greets and thanks customers? I've written some options.`, [['msgs:choose', 'Choose messages'], ['msgs:default', 'Use defaults']]));
    case 'msg_pick': case 'msg_custom': case 'msg_confirm': {
      const i = Math.min(c.ob.msgIndex ?? 0, SIGNUP_MESSAGES.length - 1);
      const [first, ...rest] = await showChoices(flowFor(c), SIGNUP_MESSAGES[i], `Message ${i + 1} of ${SIGNUP_MESSAGES.length} · `);
      await ask(first);
      return sendAll(c, rest);
    }
    case 'ready': return ask(buttons(`${biz?.name ?? 'Your shop'} is ready 🎉 Try it as a customer first (pretend payment, real receipt), then connect your number.`, [['test:start', 'Test my shop'], ['ob:connect', 'Connect my number']]));
    case 'fee_payer': return ask(buttons(`Relay's fee is *1% of each paid order*, at most ${formatKobo(c.ctx.cfg.FEE_CAP_KOBO)}. No monthly fee, nothing on delivery.\n\nWho pays it? You can change this with *FEE*.`, [['fee:customer', 'My customers pay'], ['fee:owner', "I'll pay the fee"]]));
    case 'check_wa': return ask(buttons('Is your shop\'s number on the *WhatsApp Business* app (the one with a "B")?', [['wa:yes', "Yes, it's Business"], ['wa:no', 'No, regular WhatsApp'], ['wa:unsure', 'Not sure']]));
    case 'check_fb': return ask(buttons('Can you log into Facebook? Meta uses it to set up your business account.', [['fb:yes', 'Yes, I can log in'], ['fb:no', 'No Facebook account']]));
    case 'live_photo': case 'live_contacts': case 'live_source': return livePrompt(c);
  }
}

// "*Step 4 of 6* · " in front of a question (text, buttons or list), unless it already has one.
function withLabel(content: Out, label: string): Out {
  if (!label) return content;
  if (typeof content === 'string') return content.includes('*Step ') ? content : label + content;
  const body = (content as { interactive?: { body?: { text: string } } }).interactive?.body;
  if (body && !body.text.includes('*Step ')) body.text = label + body.text;
  return content;
}

// Owner commands (PRODUCTS, delete X, categories, …) work during the product steps too.
function passToAdmin(text: string) {
  const cmd = parseAdminCommand(text);
  return !!cmd && !['addProduct', 'greet', 'help'].includes(cmd.tool);
}

// Steps whose answer is free text: only the one-word commands count there.
const FREE_TEXT: Step[] = ['msg_pick', 'owner_name', 'city', 'area', 'street', 'location_confirm', 'prep_custom', 'policies_edit', 'fee_local', 'fee_city', 'interstate_fee', 'msg_custom'];
const ONE_WORD = /^(help|products|my products|fee|hours|policies|messages|orders|categories|after ?hours|customers|commands)$/i;
function isCommand(text: string, step: Step) {
  const t = text.trim().replace(/[.!]+$/, '');
  if (ONE_WORD.test(t)) return true;
  return !FREE_TEXT.includes(step) && passToAdmin(t);
}

// After a command in the middle of signup: the question for the step they were on.
export function resumeOnboarding(c: Ctx) { return prompt(c); }

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
