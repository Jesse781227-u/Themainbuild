// The signup assistant: the owner answers signup questions in their own words (typos, Pidgin, half
// sentences, a voice note) or asks something, and the AI reads it.
//
// It never saves anything itself. Each tool hands the answer to the same fixed signup step a tap or a
// plain reply would reach (onboarding.ts), so every check, read-back and "Correct?" stays. Only the
// tools for the step the owner is on are offered. Prices and fees must be numbers the owner wrote.
// The code, not the AI, asks the next question. Who pays Relay's fee and connecting the number stay
// buttons only.
import { BUSINESS_TYPES, type Business } from '../domain/business';
import { nairaToKobo } from '../lib/money';
import type { Location } from '../services/location';
import type { AgentTool } from './agent';
import type { Step } from './onboarding';

export interface SignupHelpers {
  step: Step; message: string; question: string; checklist: string; voice: boolean;
  business: Business | null; feeTerms: string;
  // Hands an answer to the fixed step (text, or the id of the button it stands for); returns the step after.
  replay: (text: string, choiceId: string | null) => Promise<Step>;
  currentStep: () => Step;
  setOwnerName: (name: string) => Promise<boolean>;
  addProduct: (p: { name: string; priceKobo: number; stock: number | null }) => Promise<void>;
  setLocation: (loc: Partial<Location>) => Promise<Step>;
  setHours: (days: Record<string, unknown>) => Promise<boolean>;
  callMe: (reason: string) => Promise<void>;
}

const LOCATION: Step[] = ['city', 'area', 'street', 'location_confirm'];
const HOURS: Step[] = ['hours', 'hours_same', 'hours_perday', 'hours_closed', 'hours_review'];
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export function signupSystem() {
  return [
    "You are Relay's signup assistant on WhatsApp. You help a Nigerian business owner set up their WhatsApp shop. Relay asks one question at a time; you read the owner's reply and save it with a tool.",
    'If the reply answers the question, in any words, Nigerian Pidgin, with typos or half sentences, call the tool that saves it. Read typos for what they mean ("weedays" = weekdays, "satuday" = Saturday).',
    'Shop times written without am/pm mean the usual shop hours: "8 to 7" is 08:00-19:00, "10 to 6" is 10:00-18:00.',
    'After a tool saved the answer, write nothing more than a few words. Relay sends the next question itself: never ask it yourself.',
    'If they asked something, answer in one or two short sentences using only the facts below, then stop (call a tool too only if they also answered the question).',
    'If you can\'t tell what they mean, ask one short question and call no tool.',
    'Only use prices, fees, times and names the owner wrote. Never guess a price.',
    'If the message has nothing to do with setting up their shop, say you can only help them set up their shop.',
    'If they want a person, are stuck, or are upset, call callMe.',
  ].join('\n');
}

export function signupContext(h: SignupHelpers) {
  return [
    `They are on this signup step: ${h.step}. The question Relay asked them:\n"""${h.question.slice(0, 700)}"""`,
    `What's done so far:\n${h.checklist}`,
    'Facts you may use when they ask:',
    '- Relay is an AI that runs their shop in WhatsApp: it replies to customers, takes orders and payments, and sends receipts. Customers keep messaging the shop\'s own number.',
    `- Relay's fee: ${h.feeTerms}. You only pay when you get paid. Nothing upfront or monthly.`,
    '- Signup takes about 5 minutes: shop name, products, location, opening hours, delivery and policies, then connecting their WhatsApp Business number.',
    '- Everything can be changed later: PRODUCTS, HOURS, POLICIES, FEE.',
    '- Their address is shown to pickup customers. Delivery prices are per area.',
    '- Before going live they can try their own shop as a customer with TEST (pretend payment).',
    '- A real person from Relay can help: they can reply CALL.',
    ...(h.voice ? ['This message is a voice note written out by a machine: small mistakes are possible; ask if a name or number is unclear.'] : []),
  ].join('\n');
}

// Naira amounts written in the message: "2500", "2,500", "₦2.5k", "5k".
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.toLowerCase().matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/g)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(m[2] ? Math.round(n * 1000) : n);
  }
  return out;
}
const FREE = /\b(free|0|nothing|zero|no charge)\b/i;
const naira = (v: unknown) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/[₦,\s]|naira/gi, '')));
const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
// A price or fee the owner actually wrote (or "free" for 0).
function ownAmount(h: SignupHelpers, v: unknown): number {
  const n = naira(v);
  if (!Number.isFinite(n) || n < 0) throw new Error('NOT_AN_AMOUNT');
  if (n === 0 ? !FREE.test(h.message) : !amountsIn(h.message).includes(n)) throw new Error('AMOUNT_NOT_IN_MESSAGE: only use amounts the owner wrote');
  return n;
}
const moved = (before: Step, after: Step) => ({ saved: true, nowOn: after, ...(before === after ? { note: 'not accepted; Relay will ask again' } : {}) });

type Tool = AgentTool<null>;
const tool = (spec: Tool['spec'], run: (a: Record<string, unknown>) => Promise<unknown>): Tool => ({ spec, run: async a => ({ result: await run(a) }) });

export function signupTools(h: SignupHelpers): Tool[] {
  const s = h.step;
  const tools: Tool[] = [];
  const replay = async (text: string, choice: string | null) => { const before = h.currentStep(); return moved(before, await h.replay(text, choice)); };

  if (s === 'shop_name') tools.push(tool({ name: 'setShopName', description: "Saves the shop's name, exactly as the owner wrote it (without words like \"my shop is\").", params: { name: { type: 'string', description: 'The shop name' } }, required: ['name'] },
    async a => { const n = str(a.name, 80); if (n.length < 2) throw new Error('NO_NAME'); return replay(n, null); }));
  if (s === 'shop_name' || s === 'owner_name') tools.push(tool({ name: 'setOwnerName', description: "Saves the owner's own name (the person, not the shop).", params: { name: { type: 'string', description: 'Their name' } }, required: ['name'] },
    async a => { if (!(await h.setOwnerName(str(a.name, 40)))) throw new Error(h.business ? 'NOT_A_NAME' : 'SHOP_NAME_FIRST: save the shop name first'); return { saved: true }; }));

  if (s === 'products' || s === 'preview') {
    tools.push(tool({ name: 'addProduct', description: s === 'preview' ? 'Adds a product, or changes the price of one they already have. One call per product.' : 'Adds one product with its price. One call per product.',
      params: { name: { type: 'string', description: 'Product name as written' }, price: { type: 'number', description: 'Price in naira, as written (2.5k = 2500)' }, stock: { type: 'integer', description: 'How many they have, only if they said' } }, required: ['name', 'price'] },
    async a => {
      const name = str(a.name, 80);
      const price = ownAmount(h, a.price);
      const priceKobo = nairaToKobo(String(price));
      if (name.length < 2 || !priceKobo || priceKobo <= 0) throw new Error('NEED_NAME_AND_PRICE');
      const stock = Number.isInteger(a.stock) && Number(a.stock) >= 0 && amountsIn(h.message).includes(Number(a.stock)) ? Number(a.stock) : null;
      await h.addProduct({ name, priceKobo, stock });
      return { added: name };
    }));
    if (s === 'products') tools.push(tool({ name: 'productsDone', description: "They have no more products to add for now (\"that's all\", \"na everything be that\").", params: {} }, () => replay('', 'prod:done')));
    if (s === 'preview') {
      tools.push(tool({ name: 'previewLooksRight', description: 'They say the shop preview looks right.', params: {} }, () => replay('', 'ok:yes')));
      tools.push(tool({ name: 'addMoreProducts', description: 'They want to add more products but did not give them yet.', params: {} }, () => replay('', 'prod:more')));
    }
  }
  if (s === 'type') tools.push(tool({ name: 'setBusinessType', description: 'Saves what kind of business it is.', params: { type: { type: 'string', description: 'The business type', enum: BUSINESS_TYPES.map(t => t.id) } }, required: ['type'] },
    async a => { const t = BUSINESS_TYPES.find(x => x.id === a.type); if (!t) throw new Error('UNKNOWN_TYPE'); return replay('', `btype:${t.id}`); }));
  if (s === 'photos') tools.push(tool({ name: 'skipPhotos', description: 'They will add product photos later, or have none.', params: {} }, () => replay('', 'ph:skip')));

  if (LOCATION.includes(s)) tools.push(tool({ name: 'setLocation', description: 'Saves where the shop is. Give only the parts they said; Relay reads it back to them.',
    params: { street: { type: 'string', description: 'Street and number or building' }, area: { type: 'string', description: 'Area or neighbourhood, e.g. Yaba' }, city: { type: 'string', description: 'City or state, e.g. Lagos' }, landmark: { type: 'string', description: 'A landmark, e.g. near the market' } } },
  async a => {
    const loc = { street: str(a.street) || null, area: str(a.area, 60) || null, city: str(a.city, 60) || null, landmark: str(a.landmark, 80) || null };
    if (!loc.street && !loc.area && !loc.city && !loc.landmark) throw new Error('NO_PLACE');
    return { saved: true, nowOn: await h.setLocation(loc) };
  }));
  if (s === 'location_confirm') tools.push(tool({ name: 'locationIsRight', description: 'They confirm the address read back to them is right.', params: {} }, () => replay('', 'loc:ok')));

  if (HOURS.includes(s)) tools.push(tool({ name: 'setHours', description: 'Saves opening hours for the whole week. For each day: "HH:MM-HH:MM" (24-hour), "closed", or "unknown" if they didn\'t say. Relay checks doubtful times and unknown days with them.',
    params: Object.fromEntries(DAY_KEYS.map(d => [d, { type: 'string' as const, description: `${d}: "HH:MM-HH:MM", "closed" or "unknown"` }])), required: [...DAY_KEYS] },
  async a => { if (!(await h.setHours(a))) throw new Error('NO_HOURS: give HH:MM-HH:MM, closed or unknown per day'); return { saved: true, note: 'Relay will check it with them' }; }));
  if (s === 'hours_review' || s === 'hours_same') tools.push(tool({ name: 'hoursAreRight', description: 'They confirm the hours read back to them are right.', params: {} }, () => replay('yes', null)));
  if (s === 'prep' || s === 'prep_custom') tools.push(tool({ name: 'setPrepTime', description: 'How long an order usually takes to prepare, as they said it, e.g. "45 minutes".', params: { time: { type: 'string', description: 'The time, e.g. 45 minutes' } }, required: ['time'] },
    async a => { const t = str(a.time, 40); if (t.length < 2 || !amountsIn(t).every(n => amountsIn(h.message).includes(n))) throw new Error('TIME_NOT_IN_MESSAGE'); if (h.currentStep() === 'prep') await h.replay('', 'prep:custom'); return replay(t, null); }));

  if (s === 'delivery') tools.push(tool({ name: 'setDeliveryMethod', description: 'How customers get their orders.', params: { how: { type: 'string', description: 'pickup, delivery, or both', enum: ['pickup', 'delivery', 'both'] } }, required: ['how'] },
    async a => replay('', a.how === 'pickup' ? 'dl:pickup' : a.how === 'both' ? 'dl:both' : 'dl:deliver')));
  if (s === 'fee_local' || s === 'fee_city' || s === 'interstate_fee') tools.push(tool({ name: 'setDeliveryFee', description: 'The one delivery price asked about, in naira (0 if free).', params: { fee: { type: 'number', description: 'Naira, as written' } }, required: ['fee'] },
    async a => replay(String(ownAmount(h, a.fee)), null)));
  if (s === 'fee_local' || s === 'fee_city') tools.push(tool({ name: 'deliveryPriceList', description: 'They sent several areas with different prices (a list). Relay reads the list and shows it to them.', params: {} }, () => replay(h.message, null)));
  if (s === 'fee_city') tools.push(tool({ name: 'noDeliveryElsewhere', description: "They don't deliver elsewhere in the city.", params: {} }, () => replay('', 'fc:no')));
  if (s === 'interstate' || s === 'interstate_pricing') tools.push(tool({ name: 'setOtherStates', description: 'Whether they send orders to other states, and how they charge.',
    params: { answer: { type: 'string', description: 'no, flat (one price for other states) or quote (they quote per order)', enum: ['no', 'flat', 'quote'] }, fee: { type: 'number', description: 'The flat price in naira, only if they said it' } }, required: ['answer'] },
  async a => {
    if (a.answer === 'no') return replay('', 'is:no');
    if (h.currentStep() === 'interstate') await h.replay('', 'is:yes');
    const r = await replay('', a.answer === 'quote' ? 'is:quote' : 'is:flat');
    return a.answer === 'flat' && a.fee !== undefined && a.fee !== null ? replay(String(ownAmount(h, a.fee)), null) : r;
  }));
  if (s === 'policies' || s === 'policies_edit') tools.push(tool({ name: 'setPolicies', description: 'Their returns/exchanges/refunds policy: use the suggested one, none, or their own words.',
    params: { choice: { type: 'string', description: 'suggested, none, or own', enum: ['suggested', 'none', 'own'] } }, required: ['choice'] },
  async a => {
    if (a.choice === 'suggested') return replay('', 'pol:use');
    if (a.choice === 'none') return replay('', 'pol:skip');
    if (h.message.length < 5) throw new Error('NO_POLICY_TEXT');
    if (h.currentStep() === 'policies') await h.replay('', 'pol:edit');
    return replay(h.message, null); // their own words, never the AI's
  }));

  tools.push(tool({ name: 'callMe', description: 'A real person from Relay contacts them (they asked for a person, are stuck or upset).', params: { reason: { type: 'string', description: 'What they need, in a few words' } } },
    async a => { await h.callMe(str(a.reason, 200) || h.message); return { done: true }; }));
  return tools;
}
