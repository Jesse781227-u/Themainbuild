// Owner onboarding by chat (v3, 21 Nov 2026): about 7 owner replies from "hey" to the connect button.
//   shop_name   welcome + "What's your shop called?" (owner name from the WhatsApp profile; asked
//               only when it's missing or not a name)
//   products    the menu (PDF, photo, typed): one short summary [Looks good] [See full list]
//   place       address and opening hours in one reply; clear answers are saved with ✅ lines, a
//               missing one is asked for, a doubtful one gets [Yes, that's right] [Fix it]
//   delivery    [Pickup only], one price for everywhere, or a price list (saved straight away)
//   fee_payer   who pays Relay's fee [Customers pay] [I'll pay]
//   ready       [Connect my number] (and TEST to try it first)
// No step counter. Prep time, policies, greetings, after-hours and other states get defaults
// (applyDefaults), each changeable by its command. Picture, photos, contacts and "how did you
// hear" come after go-live as single nudges (services/nudges.ts), never during signup.
// A menu sent as the very first message is read straight away; the shop name is asked meanwhile.
// An owner who comes back after a break is asked whether to continue or start over.
import { feeRate, feeTerms } from '../services/orders';
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
import { closeDays, DAYS, describeHours, readWeek, sameEveryDay, validHours, type Hours } from '../services/hours';
import { answerHours, hoursDraftFrom, hoursQuestion, readHoursText, type HoursDraft } from './hours-review';
import { conversational, isFail, runAgent } from './agent';
import { loadMemory, remember, saveMemory } from './agent-memory';
import { amountsIn, signupContext, signupSystem, signupTools, type SignupHelpers } from './signup-agent';
import { defaultPolicies, policyText } from '../services/policies';
import { listZones, quoteDelivery, saveZone } from '../services/delivery';
import { describeLocation, knownArea, knownCity, parseLocation, tidyPlace, type Location } from '../services/location';
import { openTicket } from '../services/support';
import { buttons, findProducts, list, NO, storeProfilePhoto, YES, type BotDeps, type Input } from './common';
import { handleImport, parsePastedMenu } from './catalog-import';
import { handleMessageInput, showChoices } from './messages-flow';
import { SIGNUP_MESSAGES, TONES } from '../services/shop-messages';
import { log } from '../lib/logger';
import { parseAdminCommand } from './intent';
import { addProduct, handleProductInput, parseProduct, type FlowCtx, type Out, type ProductFlowState } from './products-flow';
import { categoryCarousel, productCarousel, productDetails } from './product-cards';
import { answerZoneImport, importZonesNow, startZoneImport } from './zones-flow';
import { CONTACTS_ASK, PICTURE_ASK, SOURCE_ASK } from '../services/nudges';

export type Stage = 'basics' | 'products' | 'location' | 'hours' | 'delivery' | 'connect' | 'live';
export type Step =
  | 'shop_name' | 'owner_name'
  | 'place'
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
  draft?: { city?: string; hours?: Hours; hoursReview?: HoursDraft | null; loc?: Location; streetAsked?: boolean; ticks?: string[]; connectLink?: string };
  lastSeenAt?: string; resumeAsked?: boolean; productsAdded?: number; photosAdded?: number;
  photosId?: string | null;            // photos from the uploaded file, being matched in the background
  msgIndex?: number;                   // which of SIGNUP_MESSAGES the owner is choosing wording for
}

const RESUME_AFTER_MS = 30 * 60_000;
const STEP_OF: Record<Exclude<Stage, 'live'>, number> = { basics: 1, products: 2, location: 3, hours: 4, delivery: 5, connect: 6 };
const STAGE_LABEL: Record<Stage, string> = { basics: 'your shop name', products: 'your products', location: 'your address and hours', hours: 'your opening hours', delivery: 'delivery', connect: 'the last step', live: 'the last few questions' };
const DONE = /^(done|i'?m done|finish(ed)?|that'?s all|that'?s it|next|continue|no more)$/i;
const SKIP = /^(skip|later|not now|no)$/i;
const MAX_TOP_PHOTOS = 5;
const PREP_TIMES = ['15–30 min', '30–60 min', '1 hr+'];
const SOURCES = [['src:friend', 'A friend'], ['src:instagram', 'Instagram'], ['src:other', 'Other']] as const;

const typeOf = (id?: string) => BUSINESS_TYPES.find(t => t.id === id);
// No step counter any more (v3): kept as a no-op so the old call sites read the same.
const stepLabel = (_stage: Stage) => '';
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
          if (!c.ob.nameSet) return c.reply("Saved ✅ Now, what's your shop called?");
          // [Change something]: saved, then fixed in words before moving on.
          if (choiceId === 'imp:fix') { await inferType(c); await setStage(c, 'products', 'preview'); return c.reply(buttons(fixHint(c, await listProducts(c.ctx.db, c.business.id)), [['ok:yes', 'Looks good']])); }
          // [Looks good]: straight on (the summary already said what's in it; TEST shows the shop).
          return afterProducts(c);
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

  // Chatty, long or Pidgin replies and questions: the signup assistant reads them first (the fixed
  // step below is the fallback when the AI is off, out of quota, slow or unsure).
  // "e correct", "yes na there", "no wahala" to a read-back: the Yes tap (never a correction).
  const tap = choiceId ? null : yesTap(c, text);
  if (tap) return fixedStep(c, '', tap, imageUrl, input);
  if (!choiceId && await signupAssistant(c, text, input)) return;
  return fixedStep(c, text, choiceId, imageUrl, input);
}

function yesTap(c: Ctx, text: string): string | null {
  const t = text.trim();
  if (t.split(/\s+/).length > 4 || !YES.test(t) || NO.test(t)) return null;
  const draft = c.ob.draft?.hoursReview;
  return c.ob.step === 'location_confirm' ? 'loc:ok' : c.ob.step === 'preview' ? 'ok:yes' : c.ob.step === 'hours_same' ? 'hrs:same'
    : c.ob.step === 'hours_review' && draft && !draft.doubts.length && !draft.missing.length ? 'hrv:ok' : null;
}

// ── Signup assistant ──
// The AI reads the reply and saves it through the same fixed step (as the tap or plain text that
// step expects), so every check stays. Replies the tools produce are held, then sent after the AI's
// words in one go; the code, never the AI, asks the next question.
const ASSISTANT_STEPS = new Set<Step>(['shop_name', 'owner_name', 'place', 'products', 'preview', 'type', 'photos', 'city', 'area', 'street', 'location_confirm', 'hours', 'hours_same', 'hours_perday', 'hours_closed', 'hours_review', 'prep', 'prep_custom', 'delivery', 'fee_local', 'fee_city', 'interstate', 'interstate_pricing', 'interstate_fee', 'policies', 'policies_edit', 'msg_offer', 'msg_pick', 'ready', 'fee_payer', 'check_wa', 'check_fb']);

// The buttons or list rows a question shows ({ id, title, description }).
type Option = { id: string; title: string; description?: string };
function optionsIn(out: Out[]): Option[] {
  const found: Option[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.id === 'string' && typeof o.title === 'string') found.push({ id: o.id, title: o.title, ...(typeof o.description === 'string' ? { description: o.description } : {}) });
    for (const x of Object.values(o)) walk(x);
  };
  out.forEach(walk);
  return found.filter(o => o.id !== 'test:start'); // TEST is a command (admin.ts), not a signup step
}
// "Which wording?": from the samples already shown (showing them again would write new ones).
async function wordingQuestion(c: Ctx): Promise<{ text: string; options: Option[] }> {
  const conv = await c.ctx.db.get(c.ctx.db.doc(C.conversations, c.ctx.conversationId));
  const s = conv?.msgSamples as { key: string; samples: string[] } | undefined;
  if (!s?.samples?.length) return { text: 'Which wording should customers get?', options: [] };
  const options: Option[] = [...s.samples.map((_, i) => ({ id: `msgpick:${s.key}:${i + 1}`, title: `Option ${i + 1}`, description: TONES[i]?.label ?? '' })), { id: `msgedit:${s.key}`, title: 'Write my own' }, { id: `msgkeep:${s.key}`, title: 'Keep the current one' }];
  return { text: ['Which wording should customers get?', ...s.samples.map((x, i) => `Option ${i + 1}: ${x.slice(0, 160)}`)].join('\n'), options };
}
const QUESTION = /\?|^(what|how|why|when|where|who|which|can|could|do|does|is|are|will|should|abeg|wetin|how far|shey|abi)\b/i;
// Steps whose fixed reader takes any text as the answer ("delivery for surulere na 1500" would become
// the street): anything of three words or more goes to the assistant first.
const GREEDY = new Set<Step>(['shop_name', 'owner_name', 'city', 'area', 'street', 'location_confirm', 'prep_custom', 'policies_edit']);
// Whether the step's fixed reader clearly understands this reply (then it answers: free and instant).
// Anything else goes to the assistant: "that's all for now thanks", "we dey deliver and people fit
// come pick up too" (both, not delivery), "yes, I quote per order" (yes and how).
// With buttons on screen, only a button's own words or its number count as clear ("we don't open on
// sundays" is for the AI, not the fixed reader that only knows "Closed").
function fixedReads(step: Step, t: string, options: Option[]): boolean {
  const words = t.split(/\s+/).length;
  // Address and hours: the rules read it whole when each part they find is clear
  // ("Ikeja, Lagos · 8am-9pm"); anything doubtful or chatty goes to the assistant.
  if (step === 'place') {
    const { address, hours } = splitPlaceHours(t);
    const loc = address ? clearLocation(parseLocation(address)) : null;
    const week = hours ? readWeek(hours) : null;
    const hoursClear = !!week && !week.doubts.length && !week.orphan;
    return (!!address || !!hours) && (!address || !!loc) && (!hours || hoursClear);
  }
  if (conversational(t.toLowerCase())) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  switch (step) {
    case 'products': return DONE.test(t) || !!parseProduct(t);
    case 'photos': return SKIP.test(t) || DONE.test(t);
    case 'fee_local': case 'fee_city': case 'interstate_fee': return feeFrom(t) !== null || SKIP.test(t);
  }
  if (options.length) return /^\d{1,2}$/.test(t) || options.some(o => norm(o.title) === norm(t));
  return !GREEDY.has(step) || words < 3;
}
// "Your address is set", "✅ Hours saved" with nothing saved is never sent.
const SAVED_CLAIM = /\b(is|are|has been|have been|been|got) (saved|set|added|updated|noted|recorded)\b|\b(saved|noted)\b|✅/i;

async function signupAssistant(c: Ctx, text: string, input?: Input, depth = 0): Promise<boolean> {
  const cfg = c.ctx.cfg;
  const t = text.trim();
  if (!c.deps.llm?.converse || cfg.AGENT_ENABLED === 'false' || !t || input?.imageId || input?.document) return false;
  if (!ASSISTANT_STEPS.has(c.ob.step) || !c.ob.welcomed || (!c.business && c.ob.step !== 'shop_name')) return false;
  const stepBefore = c.ob.step;

  let out: Out[] = [];
  const held: Ctx = { ...c, reply: async (o: Out) => { out.push(o); } };
  const capture = async (run: () => Promise<unknown>) => { out = []; await run(); const got = out; out = []; return got; };
  const asked = c.ob.step === 'msg_pick' ? await wordingQuestion(c) : await (async () => { const o = await capture(() => prompt(held)); return { text: o.map(textOf).join('\n'), options: optionsIn(o) }; })();
  if (!depth && !QUESTION.test(t) && fixedReads(c.ob.step, t, asked.options)) {
    // A button's own words or its number ("I quote per order", "2"): that tap, since some steps only read taps.
    const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const opt = /^\d{1,2}$/.test(t) ? asked.options[Number(t) - 1] : asked.options.find(o => norm(o.title) === norm(t));
    if (!opt) return false;
    await handleOnboarding(c, '', opt.id, async () => null);
    return true;
  }
  const question = asked.text;
  const productOuts: Out[] = [];
  let shown: Out[] = [];
  const replay = async (txt: string, choice: string | null) => { shown = await capture(() => fixedStep(held, txt, choice, async () => null, undefined)); return held.ob.step; };
  // The same question again (wording: the options already shown, not new ones).
  const reAsk = () => (held.ob.step === 'msg_pick' && stepBefore === 'msg_pick' && asked.options.length ? held.reply(list('Which one should customers get?', 'Choose wording', asked.options, 'Wording')) : prompt(held));
  // A button the owner meant in words: the same as tapping it.
  const tap = async (id: string) => { shown = await capture(() => handleOnboarding(held, '', id, async () => null)); return held.ob.step; };

  const memory = await loadMemory(c.ctx.db, c.ctx.conversationId);
  const helpers: SignupHelpers = {
    step: held.ob.step, message: t, question, voice: !!input?.audioId,
    heard: [...memory.turns.filter(x => x.r === 'u').slice(-8).map(x => x.t), t].join('\n'),
    business: held.business, feeTerms: feeTerms(cfg),
    checklist: await checklist(held),
    replay, options: asked.options, tap,
    currentStep: () => held.ob.step,
    setOwnerName: async name => {
      const clean = profileName(ownerNameFrom(name));
      if (!clean || !held.business) return false;
      if (held.ob.step === 'owner_name') { await replay(clean, null); return true; }
      await held.ctx.db.update(held.ctx.db.doc(C.businesses, held.business.id), { ownerName: clean, updatedAt: new Date().toISOString() });
      held.business.ownerName = clean;
      await held.ctx.db.set(held.ctx.db.doc(C.ownerPhones, held.ctx.ownerPhone), { ownerName: clean }, { merge: true });
      return true;
    },
    addProduct: async p => {
      await starterCategories(held, p.name);
      // Adding (products step): the AI gave distinct names, so "Fried rice" is not asked about as maybe
      // "Jollof Rice". Fixing the list (preview): a clear match is updated.
      productOuts.push(...await addProduct(flowFor(held), { name: p.name, priceKobo: p.priceKobo, stock: p.stock, imageUrl: null }, { prefer: held.ob.step === 'preview' ? 'update' : 'new' }));
    },
    setLocation: async got => {
      const loc: Location = { city: null, area: null, street: null, landmark: null, ...held.ob.draft?.loc };
      for (const k of ['city', 'area', 'street', 'landmark'] as const) if (got[k]) loc[k] = k === 'city' ? knownCity(got[k]!) ?? tidyPlace(got[k]!) : tidyPlace(got[k]!);
      // The area's city when it's known and none was given ("Gbagada" → Lagos).
      if (loc.area && !loc.city) loc.city = knownArea(loc.area);
      await setOb(held, { draft: { ...held.ob.draft, loc, ...(got.street ? { streetAsked: true } : {}) } });
      // At "address and hours": a clear address is saved quietly, so the hours tool can follow and
      // one message carries both ✅ lines (sent after the tools, below).
      if (held.ob.step === 'place') {
        const clear = clearLocation(loc);
        if (clear) await saveLoc(held, clear);
        return held.ob.step;
      }
      shown = await capture(() => nextLocation(held));
      return held.ob.step;
    },
    setHours: async days => {
      const draft = hoursDraftFrom(days);
      if (!draft) return false;
      // Clear: saved with a ✅ line and on to what's missing; doubtful: checked first.
      const clear = clearHours(draft);
      if (clear) { await saveHoursQuiet(held, clear); shown = await capture(() => placeNext(held)); }
      else shown = await capture(() => review(held, draft));
      return true;
    },
    callMe: async reason => {
      await openTicket(held.ctx.db, held.ctx.cfg, held.deps, { ownerPhone: held.ctx.ownerPhone, businessId: held.business?.id ?? null, businessName: held.business?.name ?? null, stage: `${held.ob.stage}/${held.ob.step}`, message: reason.slice(0, 300) });
      shown = ['Got it 👍 A real person from Relay will call or WhatsApp you shortly on this number.'];
    },
  };

  const tools = signupTools(helpers);
  const run = () => runAgent({ llm: c.deps.llm, system: signupSystem(), context: signupContext(helpers), memory, message: t, tools, c: null, maxSteps: cfg.AGENT_MAX_STEPS, timeoutMs: cfg.SIGNUP_AGENT_TIMEOUT_MS, actionTools: tools.map(x => x.spec.name).filter(n => n !== 'callMe'),
    // Saved, no question asked: the step's own message is the reply, so no second model call for words.
    doneAfterTools: done => !QUESTION.test(t) && done.length > 0 && done.every(x => x.ok) });
  // An empty answer or a garbled tool call (gpt-oss sometimes does either) gets one more try.
  let r = await run();
  if (isFail(r) && !r.calls.length && (r.failed === 'empty' || r.failed === 'error') && !/quota|rate limited|resting/i.test(r.detail ?? '')) r = await run();
  const calls = r.calls.filter(x => x.ok);
  c.ob = held.ob; c.business = held.business;
  log('info', 'signup_agent', { step: stepBefore, now: c.ob.step, calls: r.calls.map(x => `${x.name}${x.ok ? '' : ` ✗ ${x.error ?? ''}`}`).join(', ').slice(0, 200), failed: isFail(r) ? r.failed : null, ms: r.usage.ms, tokens: r.usage.inTokens + r.usage.outTokens, steps: r.usage.steps });
  if (!calls.length && isFail(r)) {
    log('info', 'signup_agent_fallback', { step: c.ob.step, reason: r.failed, detail: r.detail?.slice(0, 80) });
    // A question is never saved as an answer ("how much una dey charge?" is not a shop name).
    if (/\?\s*$/.test(t)) { for (const m of joinWords("Sorry, I can't answer that right now. Reply *CALL* and a person from Relay will help.", await capture(reAsk))) await c.reply(m); return true; }
    return false;
  }

  // Products typed in words: their cards, then one "send the next one" (not one per product).
  if (productOuts.length && !calls.some(x => x.name === 'productsDone')) shown = [...await capture(() => afterTyped(held, productOuts)), ...(calls.some(x => x.name !== 'addProduct') ? shown : [])];
  // "Address and hours": the address alone was saved (or is doubtful): its ✅ line or read-back, then
  // what's missing.
  if (stepBefore === 'place' && held.ob.step === 'place' && !shown.length && calls.length) {
    const doubtful = held.ob.draft?.loc;
    shown = await capture(() => (doubtful?.area && doubtful.city ? nextLocation(held) : placeNext(held)));
  }
  c.ob = held.ob;
  let words = isFail(r) ? '' : r.text;
  // Something was saved: the step's own message says so. The AI's words stay only when they answer the
  // owner's question or ask about something it couldn't save ("How much is the fried rice?").
  if (calls.length) {
    const asksAboutFailed = /\?\s*$/.test(words) && r.calls.some(x => !x.ok);
    if (!QUESTION.test(t) && !asksAboutFailed) words = '';
    else if (SAVED_CLAIM.test(words) && !asksAboutFailed) words = words.split(/(?<=[.!?])\s+/).filter(x => !SAVED_CLAIM.test(x)).join(' '); // the step says what was saved
  }
  else {
    if (SAVED_CLAIM.test(words)) words = ''; // claims a save that didn't happen
    // They answered something not asked yet ("we dey deliver too" during the hours): no chit-chat
    // that sounds saved; this step's question again.
    if (!QUESTION.test(t) && !/\?\s*$/.test(words)) words = "We'll get to that 👍";
    if (!/\?\s*$/.test(words)) shown = await capture(reAsk); // answered a question: the same question again
  }
  if (!shown.length && !/\?\s*$/.test(words)) shown = await capture(reAsk); // saved quietly (e.g. the owner's name): ask where we are
  const msgs = joinWords(words, shown);
  // Moving on, and the message also answers the next step ("add photos later, we're at 15 Adeniran
  // Ogunsanya Street"): the next step's question isn't sent; the same message is read for that step.
  const carry = !depth && c.ob.step !== stepBefore && ASSISTANT_STEPS.has(c.ob.step) && r.calls.some(x => x.ok && x.args?.movingOn === true);
  const send = carry ? msgs.slice(0, -1) : msgs;
  for (const m of send) await c.reply(m);
  await saveMemory(c.ctx.db, c.ctx.conversationId, remember(memory, t, msgs.map(textOf).join('\n').slice(0, 600), calls.map(x => x.name)));
  if (carry && !(await signupAssistant(c, text, input, 1))) for (const m of msgs.slice(-1)) await c.reply(m);
  return true;
}

// The AI's words in front of the step's own message (one bubble when it fits).
function joinWords(words: string, out: Out[]): Out[] {
  if (!words) return out;
  if (!out.length) return [words];
  const [head, ...rest] = out;
  if (typeof head === 'string') return [`${words}\n\n${head}`, ...rest];
  const body = (head as { interactive?: { body?: { text: string } } }).interactive?.body;
  if (body && words.length + body.text.length + 2 <= 1024) { body.text = `${words}\n\n${body.text}`; return out; }
  return [words, ...out];
}

const textOf = (o: Out) => (typeof o === 'string' ? o : (o as { interactive?: { body?: { text: string } } }).interactive?.body?.text ?? '');

// What's done and what's left, for the assistant.
async function checklist(c: Ctx) {
  const b = c.business;
  const products = b ? await listProducts(c.ctx.db, b.id) : [];
  const loc = c.ob.draft?.loc;
  const hours = c.ob.draft?.hoursReview;
  return [
    `Shop name: ${b && c.ob.nameSet ? b.name : 'not yet'}`,
    `Owner's name: ${b?.ownerName ?? 'not yet'}`,
    `Products: ${products.length ? `${products.length} (${products.slice(0, 8).map(p => `${p.name} ${formatKobo(p.priceKobo)}`).join(', ')})` : 'none yet'}`,
    `Business type: ${b && b.category !== 'other' ? typeOf(b.category)?.label ?? b.category : 'not set'}`,
    `Location: ${b?.area ? describeLocation({ area: b.area, city: b.city ?? null, street: b.address ?? null, landmark: b.landmark ?? null }) : loc ? `so far: ${describeLocation(loc)}` : 'not yet'}`,
    `Opening hours: ${b?.hours ? describeHours(b.hours) : hours ? `so far: ${DAYS.map(d => `${d} ${d in hours.week ? (hours.week[d] ? `${hours.week[d]!.open}-${hours.week[d]!.close}` : 'closed') : 'unknown'}`).join(', ')}` : 'not yet'}`,
    `Delivery: ${b?.fulfilment ?? 'not yet'}`,
  ].join('\n');
}

async function fixedStep(c: Ctx, text: string, choiceId: string | null, imageUrl: () => Promise<string | null>, input?: Input): Promise<unknown> {
  const now = new Date();
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
      if (!c.business!.ownerName) { await setOb(c, { step: 'owner_name' }); return c.reply('And what should I call you?'); }
      return afterBasics(c);
    }
    case 'owner_name': {
      const name = profileName(ownerNameFrom(text));
      if (!name || choiceId) return c.reply('What should I call you?');
      await c.ctx.db.update(c.ctx.db.doc(C.businesses, c.business!.id), { ownerName: name, updatedAt: now.toISOString() });
      c.business!.ownerName = name;
      await c.ctx.db.set(c.ctx.db.doc(C.ownerPhones, c.ctx.ownerPhone), { ownerName: name }, { merge: true });
      return afterBasics(c, `Nice to meet you, ${first(name)}! `);
    }

    case 'products': {
      const f = flowFor(c);
      if (choiceId === 'prod:done' || (!choiceId && DONE.test(text.trim()))) {
        if (!(await listProducts(c.ctx.db, c.business!.id)).length) return c.reply(`Add at least one product first, e.g. *${example(c.business!)}*.`);
        return afterProducts(c);
      }
      if (choiceId === 'prod:more') return c.reply('Send the next product: its name and price, with a photo if you have one.');
      if (choiceId?.startsWith('pok:')) return c.reply(buttons('👍 Saved. Send the next product, or tap *That\'s all*.', [['prod:done', "That's all"]]));
      const handled = await handleProductInput(f, choiceId, text);
      if (handled) return afterTyped(c, handled);
      if (passToAdmin(text)) return 'pass';
      const parsed = parseProduct(text);
      if (!parsed) return c.reply(`${MENU_ASK} e.g. *${example(c.business!, await listProducts(c.ctx.db, c.business!.id))}*${(c.ob.productsAdded ?? 0) > 0 ? '\nTap *That\'s all* when you\'re done.' : ''}`);
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
      if (handled) { await sendAll(c, handled); if (choiceId?.startsWith('pmatch:') || choiceId?.startsWith('pcat:')) return c.reply(buttons('Anything else to change?', [['ok:yes', 'Looks good']])); return; }
      if (choiceId?.startsWith('cat:') || choiceId?.startsWith('more:') || choiceId?.startsWith('cats:') || choiceId?.startsWith('buy:') || choiceId?.startsWith('det:') || choiceId === 'menu') return previewTap(c, choiceId);
      if (passToAdmin(text)) return 'pass';
      const parsed = parseProduct(text);
      if (parsed) {
        await sendAll(c, await addProduct(flowFor(c), { ...parsed, imageUrl: await imageUrl() }, { prefer: 'update' }));
        if (!c.state.productDraft) return c.reply(buttons('Anything else to change?', [['ok:yes', 'Looks good']]));
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

    // Address and hours in one reply ("16 Atunrase Estate, Gbagada · Mon–Fri 8–7, Sat 10–7"): what's
    // clear is saved with a ✅ line, what's missing is asked for, what's doubtful is read back.
    case 'place': {
      if (choiceId || text.trim().length < 2) return prompt(c);
      return placeAnswer(c, text);
    }

    // Location: whatever they send is split into area, city, street and landmark; anything missing is
    // asked for; a known area is saved straight away, an unknown one is read back first.
    case 'city': case 'area': case 'street': {
      if (choiceId === 'loc:nostreet') { await setOb(c, { draft: { ...c.ob.draft, streetAsked: true } }); return nextLocation(c); }
      if (choiceId || text.trim().length < 2) return prompt(c);
      // Hours sent with it ("Yaba · 8am to 7am"): both read, as at the first question.
      if (splitPlaceHours(text).hours) return placeAnswer(c, text);
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
      if (choiceId === 'loc:fix' || (!choiceId && /^(no|fix|wrong|change)/i.test(text.trim()))) { await setOb(c, { step: 'city', draft: { ...c.ob.draft, loc: undefined, streetAsked: false } }); return c.reply('No problem. Send the address again, e.g. *16 Atunrase Estate, Gbagada*.'); }
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
      // Clear hours are saved with a ✅ line (days not named are closed); doubtful ones are checked.
      const clear = clearHours(draft);
      if (clear) return saveHours(c, clear);
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
      // The doubt is settled: saved now, no second "Correct?" (days not named are closed).
      const settled = r.draft.asking ? null : clearHours(r.draft);
      if (settled) return saveHours(c, settled);
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

    // "Do you deliver?" [Pickup only] / one price for everywhere / a price list (saved straight away).
    case 'delivery': {
      const t = text.trim();
      if (choiceId === 'dl:pickup' || (!choiceId && !input?.document && !input?.imageId && /^(pick ?up( only)?|only pick ?up|no( delivery)?|we don'?t deliver|no,? (we )?(don'?t|dont) deliver|collection only)\b/i.test(t))) {
        await patchBusiness(c, { fulfilment: 'pickup', shipsInterstate: false, interstatePricing: null });
        return toFee(c, '✅ Pickup only.');
      }
      if (choiceId === 'dl:deliver' || choiceId === 'dl:both') { await patchBusiness(c, { fulfilment: 'both' }); return c.reply('Send your area price list, or type one price if it\'s the same everywhere.'); }
      if (choiceId) return prompt(c);
      const flat = input?.document || input?.imageId ? null : flatFee(t);
      if (flat !== null) {
        await addZone(c, 'Everywhere', '', flat, 0);
        await patchBusiness(c, { fulfilment: 'both', shipsInterstate: false, interstatePricing: null });
        return toFee(c, flat ? `✅ Delivery is ${formatKobo(flat)} everywhere.` : '✅ Delivery is free everywhere.');
      }
      const zones = { db: c.ctx.db, cfg: c.ctx.cfg, deps: c.deps, business: c.business!, convRef: c.ctx.db.doc(C.conversations, c.ctx.conversationId) };
      const got = await importZonesNow(zones, input ?? ({ text, choiceId: null, imageId: null, audioId: null, document: null } as Input), text, c.reply);
      if (!got) return c.reply(buttons(`Sorry, I didn't catch that. ${DELIVERY_ASK}`, [['dl:pickup', 'Pickup only']]));
      if ('say' in got) return c.reply(got.say);
      // All the areas are in one state: no "other states" question (DELIVERY changes it).
      await patchBusiness(c, { fulfilment: 'both', shipsInterstate: false, interstatePricing: null });
      // The list doesn't cover the shop's own area: that one price, then the fee.
      const own = c.business!.area;
      if (own && !(await quoteDelivery(c.ctx.db, c.business!.id, [own, c.business!.city].filter(Boolean).join(', '), 'self_arranged'))) {
        await setOb(c, { step: 'fee_local' });
        return c.reply(`${got.line}\n\nHow much is delivery around ${own}? Type 0 if it's free.`);
      }
      return toFee(c, got.line);
    }
    case 'fee_local': {
      const fee = choiceId ? null : feeFrom(text);
      if (fee === null) return c.reply(`How much is delivery around ${c.business!.area ?? 'your area'}? Type 0 if it's free.`);
      await addZone(c, c.business!.area ?? 'Nearby', c.business!.area ?? '', fee, 2);
      if (!c.business!.fulfilment || c.business!.fulfilment === 'pickup') await patchBusiness(c, { fulfilment: 'both' });
      return toFee(c, `✅ ${fee ? formatKobo(fee) : 'Free'} around ${c.business!.area ?? 'your area'}.`);
    }
    case 'fee_city': {
      const list = await deliveryList(c, text, choiceId, input);
      if (list) return list === 'shown' ? undefined : prompt(c);
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

    // Signup is done but for connecting: everything goes to the everyday Admin Bot (commands, NEW SHOP,
    // questions); "connect" or the old button shows [Connect my number] again. TEST is a command.
    case 'ready': {
      if (choiceId === 'ob:connect' || /^(connect( my number| now)?|link|go live)$/i.test(text.trim())) return prompt(c);
      return 'pass';
    }
    case 'fee_payer': {
      const payer = choiceId === 'fee:customer' ? 'customer' : choiceId === 'fee:owner' ? 'owner' : null;
      if (!payer) return prompt(c);
      // No separate confirmation (FEE changes it later): straight to the connect button.
      await patchBusiness(c, { feePayer: payer });
      await applyDefaults(c);
      return sendReady(c);
    }
    // v3: no "WhatsApp Business?" / "Facebook?" questions; the connect page explains both.
    case 'check_wa': case 'check_fb': return sendReady(c);
    case 'live_photo': case 'live_contacts': case 'live_source':
      return live(c, text, choiceId, input);
  }
}

// "menu" for food shops, "catalogue" for everyone else.
const listWord = (b: Pick<Business, 'category' | 'name'> | null) => (b && exampleType(b) === 'food_beverage' ? 'menu' : b && exampleType(b) !== 'other' ? 'catalogue' : 'menu or catalogue');

// ── Steps ──

function welcomeText(c: Ctx, question: string) {
  const name = c.business?.ownerName ?? profileName(c.ctx.event.contactName);
  return `Hi${name ? ` ${first(name)}` : ''} 👋 I'll set up your WhatsApp shop so customers can order and pay without you answering every chat. Takes about 3 minutes.\n\n${question}\n\nBy continuing you agree to our terms: ${c.ctx.cfg.API_BASE_URL}/terms`;
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

async function afterBasics(c: Ctx, lead = 'Love it. ') {
  // A menu was already added while the name was asked.
  if ((c.ob.productsAdded ?? 0) > 0) return afterProducts(c, lead === 'Love it. ' ? '' : lead);
  if (c.state.importDraft?.items.length) { await setStage(c, 'products', 'products'); return c.reply(`${lead}Now tap *Looks good* on the list above to add your products.`); }
  await setStage(c, 'products', 'products');
  return c.reply(`${lead}${MENU_ASK}`);
}

const MENU_ASK = 'Send me your menu: a PDF, a photo, or just type it out.';
const PLACE_ASK = "Where's the shop, and when are you open?\ne.g. 16 Atunrase Estate, Gbagada · Mon–Fri 8–7, Sat 10–7";
const DELIVERY_ASK = 'Do you deliver? Send your area price list, or type one price if it\'s the same everywhere.';

// Products are in: the type is guessed quietly (never asked), photos come after go-live, and the next
// question is the address and hours together.
async function afterProducts(c: Ctx, lead = '') {
  await trackStep(c.ctx.db, { ownerPhone: c.ctx.ownerPhone, businessId: c.business!.id, step: 'products', event: 'completed' });
  await inferType(c);
  await setStage(c, 'location', 'place');
  return c.reply(`${lead}${PLACE_ASK}`);
}

// The business type from the products themselves (never asked); left "other" when unclear.
async function inferType(c: Ctx) {
  if (c.business!.category !== 'other' || c.business!.businessTypeInferred) return;
  const [cats, products] = await Promise.all([listCategories(c.ctx.db, c.business!.id), listProducts(c.ctx.db, c.business!.id)]);
  const guess = inferBusinessType(products.map(p => ({ name: p.name, category: cats.find(x => x.id === p.categoryId)?.name })));
  if (guess.confident && guess.type) await patchBusiness(c, { category: guess.type, businessTypeInferred: true });
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


// "Change something" after a list: how, in one line ([Looks good] when done).
function fixHint(c: Ctx, ps: Product[]) {
  const name = example(c.business!, ps, { nameOnly: true });
  const p = ps.find(x => x.name === name);
  return `Saved. To change a price send it, e.g. *${example(c.business!, ps, { price: p ? Math.round(p.priceKobo / 100) + 500 : undefined })}*. To remove one: *delete ${name}*.`;
}

// v3: no business-type question and no photos before launch (both come later on their own).
async function afterPreview(c: Ctx) { return afterProducts(c); }

// v3: photos come after go-live; these old steps go straight on.
async function toPhotos(c: Ctx) { return afterProducts(c); }
async function toLocation(c: Ctx) { return afterProducts(c); }

const LANDMARK_RE = /[\s,]+(near|opposite|beside|close to|behind|next to)\s+.+$/i;

// ── Address and hours ──
// "16 Atunrase Estate, Gbagada · Mon–Fri 8–7, Sat 10–7": the parts with days or times are the hours,
// the rest is the address (either order, either may be missing).
const HOURS_PART = /\b(mon|tue|wed|thu|fri|sat|sun|week ?days?|week ?ends?|daily|every ?day|closed?|open|24 ?hours)/i;
const TIME_RANGE = /\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a|p)?\s*(?:-|–|—|to|till|til|until)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a|p)?\b/i;
export function splitPlaceHours(text: string): { address: string; hours: string } {
  // A comma starts the hours when what follows has a day, "daily", "closed"… or a time range.
  const parts = text.split(/\s*[·•|\n;]\s*|,\s*(?=[^,]*(?:\b(?:mon|tue|wed|thu|fri|sat|sun|week|daily|every|closed|open)|\d{1,2}\s*(?:am|pm)?\s*(?:-|–|to|till)\s*\d))/i).map(p => p.trim()).filter(Boolean);
  const address: string[] = [], hours: string[] = [];
  for (const p of parts) {
    const timeish = HOURS_PART.test(p) || (TIME_RANGE.test(p) && !/[a-z]{3,}/i.test(p.replace(TIME_RANGE, '').replace(/\b(am|pm|to|till|until|from|we|are|open|daily)\b/gi, '')));
    (timeish ? hours : address).push(p.replace(/^(we'?re|we are|we dey|i'?m|it'?s|at|in)\s+/i, ''));
  }
  return { address: address.join(', '), hours: hours.join(', ') };
}

// Hours with nothing doubtful: the week (days not named are closed). null: they need checking.
function clearHours(d: HoursDraft): Hours | null {
  if (d.doubts.length || d.orphan) return null;
  if (!Object.keys(d.week).length) return null;
  return validHours(Object.fromEntries(DAYS.map(day => [day, d.week[day] ?? null])));
}

// A complete address in an area Relay knows: saved without asking. Otherwise null.
function clearLocation(loc: Partial<Location> | undefined): Location | null {
  if (!loc?.area || !loc.city) return null;
  // Known, and in the city given ("Sango" is an Ibadan area: "Sango Ota, Ogun" is read back).
  const city = knownArea(loc.area);
  return city && city.toLowerCase() === loc.city.toLowerCase() ? { city: loc.city, area: loc.area, street: loc.street ?? null, landmark: loc.landmark ?? null } : null;
}

async function placeAnswer(c: Ctx, text: string) {
  const { address, hours } = splitPlaceHours(text);
  let doubtfulLoc: Location | null = null, doubtfulHours: HoursDraft | null = null;
  if (address) {
    const got = parseLocation(address);
    const loc: Location = { city: null, area: null, street: null, landmark: null, ...c.ob.draft?.loc };
    for (const k of ['city', 'area', 'street', 'landmark'] as const) if (got[k]) loc[k] = got[k];
    const clear = clearLocation(loc);
    if (clear) await saveLoc(c, clear);
    else if (loc.area || loc.street) { doubtfulLoc = loc; await setOb(c, { draft: { ...c.ob.draft, loc } }); }
  }
  if (hours) {
    const draft = await readHoursText(hours, c.deps.llm);
    const clear = draft ? clearHours(draft) : null;
    if (clear) await saveHoursQuiet(c, clear);
    else if (draft) doubtfulHours = draft;
  }
  // Doubtful: only that one is read back (with the ✅ lines for what was saved).
  if (doubtfulLoc) {
    if (!doubtfulLoc.area || !doubtfulLoc.city) return nextLocation(c);
    const ticks = takeTicks(c);
    await setStage(c, 'location', 'location_confirm');
    if (doubtfulHours) await setOb(c, { draft: { ...c.ob.draft, hoursReview: doubtfulHours } });
    return c.reply(buttons(`${ticks}📍 ${describeLocation(doubtfulLoc)}. Is that right?`, [['loc:ok', 'Yes, that\'s right'], ['loc:fix', 'Fix it']]));
  }
  if (doubtfulHours) return review(c, doubtfulHours);
  if (!c.ob.draft?.ticks?.length) return c.reply(`Sorry, I didn't catch that. ${PLACE_ASK}`);
  return placeNext(c);
}

// The ✅ lines for what was just saved, sent with the next question (one message).
function addTick(c: Ctx, line: string) { c.ob = { ...c.ob, draft: { ...c.ob.draft, ticks: [...(c.ob.draft?.ticks ?? []), line] } }; }
function takeTicks(c: Ctx) {
  const t = c.ob.draft?.ticks ?? [];
  c.ob = { ...c.ob, draft: { ...c.ob.draft, ticks: [] } };
  return t.length ? `${t.join('\n')}\n\n` : '';
}

async function saveLoc(c: Ctx, loc: Location) {
  await patchBusiness(c, { city: loc.city!.slice(0, 60), area: loc.area!.slice(0, 60), address: loc.street?.slice(0, 120) ?? null, landmark: loc.landmark?.slice(0, 80) ?? null });
  addTick(c, `✅ ${describeLocation(loc)}`);
  await setOb(c, { draft: { ...c.ob.draft, loc: undefined, streetAsked: false } });
}
async function saveHoursQuiet(c: Ctx, hours: Hours) {
  // Orders after hours stay on by default (AFTER HOURS changes it); not mentioned here.
  await patchBusiness(c, { hours, afterHours: c.business!.afterHours ?? 'orders' });
  addTick(c, `✅ ${describeHours(hours)}`);
  await setOb(c, { draft: { ...c.ob.draft, hoursReview: null } });
}

// What's still missing (address, then hours), then "Do you deliver?".
async function placeNext(c: Ctx) {
  const b = c.business!;
  const ticks = takeTicks(c); // cleared before the step is saved, so they're sent once
  if (!b.area) { await setStage(c, 'location', 'city'); return c.reply(`${ticks}And where's the shop? e.g. *16 Atunrase Estate, Gbagada*`); }
  if (!b.hours) { await setStage(c, 'hours', 'hours'); return c.reply(`${ticks}And what time do you open and close?`); }
  await setStage(c, 'delivery', 'delivery');
  return c.reply(buttons(`${ticks}${DELIVERY_ASK}`, [['dl:pickup', 'Pickup only']]));
}

// Asks for what's missing (area, then city); a known area is saved, an unknown one is read back.
async function nextLocation(c: Ctx) {
  const loc = c.ob.draft?.loc;
  if (!loc?.area || !loc.city) { await setOb(c, { step: !loc?.area ? 'area' : 'city' }); return prompt(c); }
  const clear = clearLocation(loc);
  if (clear) { await saveLoc(c, clear); return placeNext(c); }
  await setOb(c, { step: 'location_confirm' });
  return prompt(c);
}

async function saveLocation(c: Ctx) {
  const loc = c.ob.draft?.loc;
  if (!loc?.area || !loc.city) { await setOb(c, { step: 'city' }); return prompt(c); }
  await saveLoc(c, { city: loc.city, area: loc.area, street: loc.street ?? null, landmark: loc.landmark ?? null });
  // Hours sent with the address and also doubtful: checked next.
  const pending = c.ob.draft?.hoursReview;
  if (pending && !c.business!.hours) return review(c, pending);
  return placeNext(c);
}

async function review(c: Ctx, draft: HoursDraft) {
  const ticks = takeTicks(c);
  await setOb(c, { step: 'hours_review', draft: { ...c.ob.draft, hoursReview: draft } });
  const q = hoursQuestion(draft);
  return c.reply(ticks ? withLabel(q, ticks) : q);
}

async function saveHours(c: Ctx, hours: Hours) {
  await saveHoursQuiet(c, hours);
  return placeNext(c);
}

async function savePrep(c: Ctx, label: string) {
  await patchBusiness(c, { prepTime: label });
  return placeNext(c);
}

// One price for everywhere: "1500", "0", "free", "₦2k everywhere". Not "Yaba 3000" (an area).
function flatFee(t: string): number | null {
  const s = t.trim().toLowerCase();
  if (/^(0|free|free delivery|nothing|zero)$/.test(s)) return 0;
  const bare = nairaToKobo(s.replace(/^(₦|n)\s*/, '').replace(/\s*naira$/, ''));
  if (bare !== null && bare >= 0 && bare <= 100_000_000) return bare;
  if (/\b(everywhere|all areas|anywhere|same (price|everywhere)|flat|any area)\b/.test(s)) return feeFrom(s);
  return null;
}

// "Last thing": who pays Relay's fee.
async function toFee(c: Ctx, line: string) {
  await setStage(c, 'connect', 'fee_payer');
  const cfg = c.ctx.cfg;
  const cap = formatKobo(cfg.FEE_CAP_KOBO + (cfg.PROCESSOR_FEE_BPS ? cfg.PROCESSOR_FEE_CAP_KOBO : 0));
  return c.reply(buttons(`${line ? `${line}\n\n` : ''}Last thing: Relay costs nothing upfront. We take ${feeRate(cfg)} of each sale (max ${cap}), only when you get paid. Who pays it?`, [['fee:customer', 'Customers pay'], ['fee:owner', "I'll pay"]]));
}

// What signup no longer asks, set quietly (each one has its command): prep time and policies for food
// shops, orders after hours on, no shipping to other states.
async function applyDefaults(c: Ctx) {
  const b = c.business!;
  const food = b.category === 'food_beverage';
  await patchBusiness(c, {
    prepTime: b.prepTime ?? (food ? '15–30 min' : null),
    policies: b.policies !== undefined ? b.policies : food ? defaultPolicies('food_beverage') : null,
    afterHours: b.afterHours ?? 'orders',
    shipsInterstate: b.shipsInterstate ?? false,
  });
}

// "Done 🎉 … [Connect my number]": the link opens the connect page (24 hours). TEST tries the shop first.
// From here the owner uses the everyday Admin Bot (signup is closed; ownerPhones.onboardingStage stays
// "connect" until the number is connected). CONNECT, or EXIT after TEST, shows the button again.
async function sendReady(c: Ctx) {
  const link = await createSignupSession(c.ctx.db, c.ctx.cfg, c.business!.id);
  await trackStep(c.ctx.db, { ownerPhone: c.ctx.ownerPhone, businessId: c.business!.id, step: 'connect_link', event: 'entered' });
  await setStage(c, 'connect', 'ready');
  await c.ctx.db.set(c.ctx.db.doc(C.conversations, c.ctx.conversationId), { onboarding: null }, { merge: true });
  return c.reply(readyMessage(c.business!.name, link));
}
// The [Connect my number] message with a fresh link (CONNECT, and after TEST).
export async function connectButton(db: AdminContext['db'], cfg: AdminContext['cfg'], business: Pick<Business, 'id' | 'name'>) {
  return readyMessage(business.name, await createSignupSession(db, cfg, business.id));
}
export const readyMessage = (name: string, link: string): OutboundContent => ({
  type: 'interactive',
  interactive: { type: 'cta_url', body: { text: `Done 🎉 ${name} is ready. Connect your WhatsApp number to go live. Meta will ask you to log into Facebook.\n\nWant to try it as a customer first? Reply *TEST*.` }, action: { name: 'cta_url', parameters: { display_text: 'Connect my number', url: link } } },
});

const feeFrom = (text: string) => {
  const t = text.trim().toLowerCase();
  if (/^(0|free|nothing|zero)$/.test(t)) return 0;
  const k = nairaToKobo(t.replace(/^(₦|n)\s*/, '').replace(/\s*naira$/, ''));
  if (k !== null && k >= 0 && k <= 100_000_000) return k;
  // One amount in a sentence: "5000 for the rest of lagos", "delivery for surulere na 1.5k". Two or
  // more ("3k in Yaba, 5k elsewhere") are a list, not one price.
  const amounts = [...new Set(amountsIn(t))].filter(n => n >= 100);
  if (amounts.length === 1 && amountsIn(t).length === 1) { const one = nairaToKobo(String(amounts[0])); return one !== null && one <= 100_000_000 ? one : null; }
  return null;
};

// At the delivery price steps, a whole list (pasted, even squashed into one line, or a spreadsheet,
// document or photo) instead of one price. 'shown': the review is up; 'moved': saved or cancelled,
// the next step is set; null: not a list (a single price, carry on).
async function deliveryList(c: Ctx, text: string, choiceId: string | null, input?: Input): Promise<'shown' | 'moved' | null> {
  const zones = { db: c.ctx.db, cfg: c.ctx.cfg, deps: c.deps, business: c.business!, convRef: c.ctx.db.doc(C.conversations, c.ctx.conversationId) };
  const tapped = await answerZoneImport(zones, choiceId);
  if (tapped) {
    for (const o of tapped.out) await c.reply(o);
    if (tapped.saved) await setOb(c, { step: 'interstate' });
    return 'moved';
  }
  if (choiceId || !(input?.document || input?.imageId || text.trim())) return null;
  const out = await startZoneImport(zones, input ?? ({ text, choiceId: null, imageId: null, audioId: null, document: null } as never), text, c.reply);
  if (!out) return null;
  for (const o of out) await c.reply(o);
  return 'shown';
}

async function addZone(c: Ctx, name: string, match: string, feeKobo: number, priority: number) {
  await saveZone(c.ctx.db, { id: `${c.business!.id}_${randomId(6).replace(/[^A-Za-z0-9]/g, 'x')}`, businessId: c.business!.id, name: name.slice(0, 60), match: match.slice(0, 60), feeKobo, timeframe: '', active: true, priority });
}

// The old in-between steps (other states, policies, messages) finish into the fee question, for
// chats that were halfway through the previous flow.
async function toPolicies(c: Ctx) {
  const parts: string[] = [];
  if (c.business!.fulfilment !== 'pickup') {
    const zones = await listZones(c.ctx.db, c.business!.id);
    const fee = (k: number) => (k ? formatKobo(k) : 'free');
    const local = zones.find(z => z.priority === 2), city = zones.find(z => z.priority === 1);
    if (local) parts.push(`${fee(local.feeKobo)} within ${local.name}`);
    if (city) parts.push(`${fee(city.feeKobo)} elsewhere in ${city.name}`);
  }
  return toFee(c, parts.length ? `✅ Delivery: ${parts.join(' · ')}.` : '');
}
async function toMessages(c: Ctx) { return toFee(c, ''); }
async function toReady(c: Ctx) { return toFee(c, ''); }

// ── After go-live: optional questions; anything else goes to the Admin Bot ──
async function live(c: Ctx, text: string, choiceId: string | null, input?: Input): Promise<unknown> {
  const biz = c.business;
  if (!biz) return 'pass';
  switch (c.ob.step) {
    case 'live_photo': {
      if (input?.imageId && c.ctx.cfg.ADMIN_BOT_ACCESS_TOKEN) {
        const url = await storeProfilePhoto(c.ctx.cfg, c.deps, c.ctx.cfg.ADMIN_BOT_ACCESS_TOKEN, input.imageId, biz.id).catch(e => { log('warn', 'profile_photo_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) }); return null; });
        if (!url) return c.reply(buttons('Sorry, I couldn\'t save that photo. Try again, or skip for now.', [['lp:skip', 'Skip']]));
        await patchBusiness(c, { profilePhotoUrl: url });
        return finishLive(c, 'Lovely ✅ That\'s your shop\'s picture now.');
      }
      if (choiceId !== 'lp:skip') return 'pass';
      return finishLive(c, 'OK 👍 Send *PICTURE* any time.');
    }
    // Each follow-up is one question (a nudge after go-live, or its command): answered, it's done.
    case 'live_contacts': {
      if (choiceId !== 'lc:yes' && choiceId !== 'lc:no') return 'pass';
      await patchBusiness(c, { importContacts: choiceId === 'lc:yes' });
      return finishLive(c, choiceId === 'lc:yes' ? 'Done ✅ They\'ll appear in *CUSTOMERS* as WhatsApp shares them.' : 'OK 👍 Only people who order will be in your customer list.');
    }
    case 'live_source': {
      const pick = SOURCES.find(([id]) => id === choiceId);
      if (!pick) return 'pass';
      await patchBusiness(c, { acquisitionSource: pick[0].slice(4) });
      return finishLive(c, 'Thank you! 🙏');
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

// The follow-up questions (nudges.ts sends them after go-live; PICTURE and CONTACTS ask them again).
export function liveQuestion(step: Step, _business: Pick<Business, 'name'>): OutboundContent | null {
  if (step === 'live_photo') return PICTURE_ASK();
  if (step === 'live_contacts') return CONTACTS_ASK();
  if (step === 'live_source') return SOURCE_ASK();
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
    // The welcome only once: after it, just the question.
    case 'shop_name': return ask(c.ob.adding ? `What's the new shop or branch called?` : c.ob.welcomed ? 'What\'s your shop called?' : welcomeText(c, 'What\'s your shop called?'));
    case 'owner_name': return ask('And what should I call you?');
    case 'products': return ask(MENU_ASK);
    case 'place': return ask(PLACE_ASK);
    case 'preview': return ask(buttons(fixHint(c, biz ? await listProducts(c.ctx.db, biz.id) : []).replace(/^Saved\. /, ''), [['ok:yes', 'Looks good']]));
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
      return ask("And where's the shop? e.g. *16 Atunrase Estate, Gbagada*");
    }
    case 'area': return ask(`Which area${c.ob.draft?.loc?.city ? ` of ${c.ob.draft.loc.city}` : ''} is that in? e.g. *Gbagada*`);
    case 'street': {
      const loc = c.ob.draft?.loc;
      return ask(buttons(`What's the street or building in ${loc?.area ?? 'your area'}? e.g. *12 Herbert Macaulay Way*`, [['loc:nostreet', 'No pickup address']]));
    }
    case 'location_confirm': return ask(buttons(`📍 ${describeLocation(c.ob.draft?.loc ?? {})}. Is that right?`, [['loc:ok', 'Yes, that\'s right'], ['loc:fix', 'Fix it']]));
    case 'hours': return ask('And what time do you open and close? e.g. *Mon–Fri 8–7, Sat 10–7*');
    case 'hours_same': {
      const h = validHours(c.ob.draft?.hours);
      return ask(buttons(`${h ? `${describeHours(h).replace(/^Every day /, '')}. ` : ''}Same every day?`, [['hrs:same', 'Yes, every day'], ['hrs:perday', 'No, set per day'], ['hrs:closed', 'Closed some days']]));
    }
    case 'hours_perday': return ask('Send your hours by day, e.g. *Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed*.');
    case 'hours_closed': return ask('Which days are you closed? e.g. *Sunday*.');
    case 'hours_review': return c.ob.draft?.hoursReview ? ask(hoursQuestion(c.ob.draft.hoursReview)) : ask('What time do you open and close? e.g. *8am – 9pm*');
    case 'prep': return ask(list('How long does an order usually take to prepare?', 'Pick prep time', [...PREP_TIMES.map((t, i) => ({ id: `prep:${i}`, title: t })), { id: 'prep:custom', title: 'Something else' }], 'Prep time'));
    case 'prep_custom': return ask('How long does an order usually take? e.g. *45 minutes*');
    case 'delivery': return ask(buttons(DELIVERY_ASK, [['dl:pickup', 'Pickup only']]));
    case 'fee_local': return ask(`How much is delivery around ${biz?.area ?? 'your area'}? Type 0 if it's free.`);
    case 'fee_city': return ask(buttons(`And elsewhere in ${biz?.city ?? 'your city'}? e.g. *3000*\n\nOr paste your full list of areas and prices (or send the spreadsheet, PDF or photo).`, [['fc:no', `Only ${(biz?.area ?? 'my area').slice(0, 15)}`]]));
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
    case 'ready': return sendReady(c);
    case 'fee_payer': return toFee(c, '');
    case 'check_wa': case 'check_fb': return sendReady(c);

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
const ONE_WORD = /^(help|products|my products|fee|hours|policies|messages|orders|categories|after ?hours|customers|commands|delivery|name|prep|greeting|picture|photos|contacts)$/i;
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
