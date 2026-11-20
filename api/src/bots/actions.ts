// Every owner action in one place. The WhatsApp / commands (npm run sync:commands), the MENU list,
// HELP, typed words ("sales", "/sales", "how much did I make today") and the follow-up buttons
// after each reply are all built from this list, so an action is never defined twice.
//   act:<id>[:<arg>]   tapping an action (menu row, follow-up button)
//   menu:<section>     one section of the MENU when everything doesn't fit in one list
// Free text the rules don't know still goes to the LLM (intent.ts), which picks an admin tool;
// actionForTool() maps that back here so the same follow-up buttons appear.
import { C } from '../db';
import type { Business } from '../domain/business';
import type { Order, Product } from '../domain/commerce';
import { hasStock, totalStock } from '../domain/commerce';
import { formatKobo } from '../lib/money';
import { lagosDate } from '../lib/time';
import type { OutboundContent } from '../services/channel';
import { listProducts } from '../services/catalog';
import { listZones, byPriority } from '../services/delivery';
import { recentOrders } from '../services/orders';
import { exportFilename, exportToken } from '../services/export';
import { getOwner } from '../services/owners';
import { openTicket } from '../services/support';
import { matchProduct } from '../services/match';
import { example } from '../services/shop-type';
import { DAYS, describeHours } from '../services/hours';
import { describeRule, evaluate, loadSegmentData, refreshSegments, ruleFromWords, systemSegments } from '../services/segments';
import { ZONES_ASK } from './zones-flow';
import { deliverPick, mainMenu, moneyScreen, ordersScreen, pauseChoice, reachHub, reopenAt, restockList, soldOutPicker, soldOutSection, subList, waiting, whenLabel } from './owner-home';
import { ALL_TRIGGERS, executeCampaign, markOwnerSent, planCampaign, planText, TRIGGER_HINT, TRIGGER_LABEL, triggerOn } from '../services/reach';
import { interestedIn } from '../services/reach-triggers';
import { confirmPosted, loadPost, MENTIONS, nextMentions, prepareStatus, type StatusPost } from '../services/status-posts';
import { flowId, flowMessage } from '../services/flows';
import { listCategories } from '../services/catalog';
import { helpFor, runTool, type AdminToolName, type ToolCtx } from './admin-tools';
import { buttons, findProducts, list, sectionList } from './common';
import { messagesMenu } from './messages-flow';
import { payoutHistory, startVerify, startWithdraw, walletView } from './wallet-flow';
import { handleShops } from './shops';
import { handleSettings } from './settings';
import { startTest } from './test-mode';
import type { AdminContext } from '../services/router';

export type Out = OutboundContent | string;
export type Section = 'Shop' | 'Orders' | 'Money' | 'Customers' | 'Settings' | 'Help';
export const SECTIONS: Section[] = ['Shop', 'Orders', 'Money', 'Customers', 'Settings', 'Help'];

export interface ActionCtx extends ToolCtx { admin: AdminContext; arg: string | null; reply: (c: Out) => Promise<unknown>; setAwaiting: (v: string | null) => Promise<void> }

export interface OwnerAction {
  id: string;
  command?: string;                              // WhatsApp / command: ≤32 chars, a–z 0–9 _
  hint: string;                                  // shown next to the command: ≤256 chars, no emoji
  menu?: { section: Section; title: string; description?: string };
  aliases?: string[];                            // whole messages that mean this action (lower case)
  tool?: { name: AdminToolName; args?: Record<string, unknown> }; // the LLM's tool that means this
  next?: [action: string, title: string][];      // follow-up buttons (≤3; a third is always Menu)
  hidden?: (c: ActionCtx) => Promise<boolean> | boolean; // not in the MENU when it doesn't apply
  run: (c: ActionCtx) => Promise<Out | Out[] | null>;
}

const tool = (name: AdminToolName, args: Record<string, unknown> = {}) => (c: ActionCtx) => runTool(name, args, c);
const GREETING = /^(hi+|hello+|hey+|hiya|helo|good (morning|afternoon|evening|day)|howdy|yo|sup|what'?s up|how far|hi there|hello there)(\s+relay)?[\s!.]*$/;

// The MENU itself (also the reply to "hi" from an owner who's set up).
async function menu(c: ActionCtx, section?: Section | null): Promise<Out> {
  if (section === 'Settings' || section === 'Help') {
    const rows: { id: string; title: string; description?: string }[] = [];
    for (const a of ACTIONS) if (a.menu?.section === section && !(await a.hidden?.(c))) rows.push({ id: `act:${a.id}`, title: a.menu.title, description: a.menu.description ?? a.hint });
    if (section === 'Help') { const order = ['act:test', 'act:help', 'act:call']; rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); }
    return subList(section, section === 'Settings' ? 'Settings 👇' : 'Help 👇', rows);
  }
  if (!section) return mainMenu(c);
  const visible: OwnerAction[] = [];
  for (const a of ACTIONS) if (a.menu && !(await a.hidden?.(c))) visible.push(a);
  const first = c.business.ownerName?.split(' ')[0];
  const notConnected = c.business.status === 'onboarding' ? "\n\nYour WhatsApp number isn't connected yet, so customers can't order. Send *CONNECT* to get the link." : '';
  const hello = `Hi${first ? ` ${first}` : ''} 👋 What would you like to do for ${c.business.name}?${notConnected}`;
  const rows = (s: Section) => visible.filter(a => a.menu!.section === s).map(a => ({ id: `act:${a.id}`, title: a.menu!.title, description: a.menu!.description ?? a.hint }));
  // Everything in one list when it fits (≤10 rows); otherwise the sections first, each its own list.
  if (section) return sectionList(`${section} 👇`, section, [{ title: section, rows: rows(section) }]);
  if (visible.length <= 10) return sectionList(hello, 'Open menu', SECTIONS.map(s => ({ title: s, rows: rows(s) })).filter(s => s.rows.length));
  return list(hello, 'Open menu', SECTIONS.map(s => ({ s, items: visible.filter(a => a.menu!.section === s) })).filter(x => x.items.length).map(({ s, items }) => (
    // A section with one item opens it straight away.
    items.length === 1 ? { id: `act:${items[0].id}`, title: items[0].menu!.title, description: items[0].hint } : { id: `menu:${s}`, title: s, description: items.map(a => a.menu!.title).join(' · ') }
  )), 'Menu');
}

const orderLine = (o: Order) => `• ${o.ref}: ${formatKobo(o.payAmountKobo)} · ${o.items.map(l => `${l.qty}× ${l.name}`).join(', ').slice(0, 60)}`;
const REF = /^rly-[a-z0-9]{5}$/i;

async function findOrder(c: ActionCtx, ref: string | null) {
  if (!ref || !REF.test(ref)) return null;
  const [o] = await recentOrders(c.db, [['businessId', '==', c.business.id], ['ref', '==', ref.toUpperCase()]], 1);
  return o ?? null;
}

// Lagos dates from `days` ago up to today.
function lastDays(days: number, now = new Date()) {
  return Array.from({ length: days }, (_, i) => lagosDate(new Date(now.getTime() - i * 86_400_000)));
}

// The assistant's tone: learned from the shop's messages (default) or one the owner picks.
async function toneMenu(c: ActionCtx): Promise<Out> {
  const now = c.business.tone ?? null;
  const mark = (v: string | null) => (now === v ? ' ✓' : '');
  return subList('Tone', 'How should your shop assistant sound to customers?', [
    { id: 'act:settone:learned', title: `Like my messages${mark(null)}`, description: 'Copies the tone of your welcome and other messages' },
    { id: 'act:settone:friendly', title: `Friendly${mark('friendly')}`, description: 'Warm and chatty, a few emojis' },
    { id: 'act:settone:professional', title: `Professional${mark('professional')}`, description: 'Polite and clear, no slang' },
    { id: 'act:settone:street', title: `Street${mark('street')}`, description: 'Relaxed Lagos style, Pidgin welcome' },
  ]);
}

async function setTone(c: ActionCtx): Promise<Out> {
  const tone = (['friendly', 'professional', 'street'] as const).find(t => t === c.arg) ?? null;
  await c.db.update(c.db.doc(C.businesses, c.business.id), { tone, updatedAt: new Date().toISOString() });
  c.business.tone = tone;
  return `✅ Your shop assistant will now sound ${tone ? tone : 'like your own messages'}.`;
}

async function soldOut(c: ActionCtx): Promise<Out> {
  // The picker: sections, then a section's products (paged), or what's sold out (to restock).
  if (!c.arg) return soldOutPicker(c);
  if (c.arg.startsWith('cat:')) { const [, cat, page] = c.arg.split(':'); return soldOutSection(c, cat, Number(page) || 0); }
  if (c.arg === 'out' || c.arg.startsWith('out:')) return restockList(c, Number(c.arg.split(':')[1]) || 0);
  const products = (await listProducts(c.db, c.business.id)).filter(p => p.available);
  let p: Product | null = null;
  // One size/colour: "act:soldout:<product>:<option>".
  const [argId, variantId] = (c.arg ?? '').split(':');
  if (variantId) {
    const prod = products.find(x => x.id === argId);
    const v = prod?.variants?.find(x => x.id === variantId);
    if (!prod || !v) return 'That option is gone. Send *products* to see them.';
    const variants = prod.variants!.map(x => (x.id === v.id ? { ...x, stock: 0 } : x));
    await c.db.update(c.db.doc(C.products, prod.id), { variants, stock: totalStock(variants), updatedAt: new Date().toISOString() });
    return `✅ *${prod.name} (${v.label})* is marked sold out. When it's back, send *restock ${prod.name} ${v.label.replace(/ \/ /g, ' ')} 10*.`;
  }
  if (c.arg) {
    p = products.find(x => x.id === c.arg) ?? null;
    if (!p) {
      const exact = await findProducts(c.db, c.business.id, c.arg);
      const m = exact.length === 1 ? { kind: 'strong' as const, product: exact[0] } : matchProduct(c.arg, products);
      if (m.kind === 'strong') p = m.product;
      else if (m.kind === 'ambiguous') return list(`Which one is sold out?`, 'Pick product', m.products.map(x => ({ id: `act:soldout:${x.id}`, title: x.name })), 'Products');
      else return `I couldn't find "${c.arg}". Send *products* to see them.`;
    }
  }
  if (!p) {
    const inStock = products.filter(p => hasStock(p));
    if (!inStock.length) return 'Everything is already sold out or hidden.';
    const rows = inStock.slice(0, 10).map(x => ({ id: `act:soldout:${x.id}`, title: x.name, description: formatKobo(x.priceKobo) }));
    return list(`Which product is sold out?${inStock.length > 10 ? `\n\nNot in the list? Send *soldout* and its name, e.g. *soldout ${example(c.business, inStock, { nameOnly: true })}*.` : ''}`, 'Pick product', rows, 'In stock');
  }
  // With sizes/colours: which one (or all of them).
  if (p.variants?.length) {
    const rows = p.variants.filter(v => v.stock !== 0).slice(0, 9).map(v => ({ id: `act:soldout:${p!.id}:${v.id}`, title: v.label }));
    if (rows.length) return list(`Which *${p.name}* is sold out?`, 'Pick option', [...rows, { id: `act:soldoutall:${p.id}`, title: 'All of them' }], p.optionNames?.join(' / ') || 'Options');
  }
  await c.db.update(c.db.doc(C.products, p.id), { stock: 0, ...(p.variants?.length ? { variants: p.variants.map(v => ({ ...v, stock: 0 })) } : {}), updatedAt: new Date().toISOString() });
  return `✅ *${p.name}* is marked sold out. Customers still see it, marked *Sold out*. When it's back, send *restock ${p.name} 10*.`;
}

// EXPORT: the Excel file (Orders + Customers) and the Google Sheets formulas, on a private link.
async function exportScreen(c: ActionCtx, fresh: boolean): Promise<Out[]> {
  const token = await exportToken(c.db, c.business.id, fresh);
  const base = `${c.cfg.API_BASE_URL}/export/${token}`;
  return [
    { type: 'document', link: `${base}/relay-export.xlsx`, filename: exportFilename(c.business.name), caption: fresh ? 'New links made: the old ones no longer work. Your orders and customers, 2 sheets.' : 'Your orders and customers, 2 sheets.' },
    buttons(`📊 *Live in Google Sheets*: paste into cell A1 of an empty sheet:

=IMPORTDATA("${base}/orders.csv")

Customers:
=IMPORTDATA("${base}/customers.csv")

It updates by itself. Keep these private: anyone with the link can see your orders.`, [['act:exportnew', 'New private link'], ['act:menu', 'Menu']]),
  ];
}

async function receipt(c: ActionCtx): Promise<Out> {
  if (c.arg) return runTool('orderReceipt', { order: c.arg }, c);
  const paid = await recentOrders(c.db, [['businessId', '==', c.business.id], ['status', '==', 'paid']], 10);
  if (!paid.length) return 'No paid orders yet, so there are no receipts to send.';
  return subList('Paid orders', 'Which order\'s receipt?', paid.slice(0, 9).map(o => ({ id: `act:receipt:${o.ref}`, title: o.ref, description: `${formatKobo(o.payAmountKobo)} · ${o.items.map(l => l.name).join(', ')}`.slice(0, 72) })));
}

// "Back in stock": how many (a number), or which size and how many for products with options.
async function restockAsk(c: ActionCtx): Promise<Out> {
  const p = c.arg ? ((await c.db.get(c.db.doc(C.products, c.arg))) as Product | null) : null;
  if (!p || p.businessId !== c.business.id || p.deletedAt) return buttons('That product is gone.', [['act:soldout', 'Sold out / restock'], ['act:menu', 'Menu']]);
  await c.setAwaiting(`restock:${p.id}`);
  return waiting(p.variants?.length
    ? `Which *${p.name}* is back, and how many? e.g. *${p.variants[0].label.split(' / ')[0]} 5*`
    : `How many *${p.name}* are back in stock? Send a number, e.g. *10*.`);
}

// The one button that moves a paid order on: Mark ready → Out for delivery (or Picked up) → Delivered.
function nextStep(o: Pick<Order, 'ref' | 'status' | 'fulfilment' | 'delivery'>): [string, string] | null {
  if (o.status !== 'paid') return null;
  const pickup = o.delivery?.method === 'pickup';
  if (o.fulfilment === 'pending') return [`act:ready:${o.ref}`, 'Mark ready'];
  if (o.fulfilment === 'ready') return pickup ? [`act:delivered:${o.ref}`, 'Picked up'] : [`act:out:${o.ref}`, 'Out for delivery'];
  if (o.fulfilment === 'out_for_delivery') return [`act:delivered:${o.ref}`, 'Mark delivered'];
  return null;
}

// Out for delivery: who's taking it and when it should arrive (one line), or Skip.
async function outAsk(c: ActionCtx): Promise<Out> {
  const o = await findOrder(c, c.arg);
  if (!o || o.status !== 'paid') return buttons("I couldn't find that paid order.", [['act:orders', 'Orders'], ['act:menu', 'Menu']]);
  await c.setAwaiting(`rider:${o.ref}`);
  return buttons(`🛵 Who's taking *${o.ref}*, and when should it arrive?\nSend e.g. *Musa 0803 123 4567, 1 hour*. The customer sees it.`, [[`act:outskip:${o.ref}`, 'Skip'], ['act:cancel', 'Cancel'], ['act:menu', 'Menu']]);
}

async function markOut(c: ActionCtx, rider: string | null): Promise<Out> {
  await c.setAwaiting(null);
  const out = await runTool('updateFulfilment', { order: c.arg ?? '', status: 'out_for_delivery', ...(rider ? { rider } : {}) }, c);
  return typeof out === 'string' ? buttons(`🛵 ${out}`, [[`act:delivered:${c.arg}`, 'Mark delivered'], ['act:orders', 'To deliver'], ['act:menu', 'Menu']]) : out;
}
export const markOutForDelivery = markOut;

async function viewOrder(c: ActionCtx): Promise<Out> {
  const o = await findOrder(c, c.arg);
  if (!o) return "I couldn't find that order.";
  const customer = (await c.db.get(c.db.doc(C.customers, o.customerId))) as { name?: string; phone?: string } | null;
  const lines = [
    `*${o.ref}* · ${o.status === 'paid' ? `paid, ${o.fulfilment.replace(/_/g, ' ')}` : o.status.replace(/_/g, ' ')}`,
    ...o.items.map(l => `• ${l.qty} × ${l.name}: ${formatKobo(l.priceKobo * l.qty)}`),
    `Total: ${formatKobo(o.payAmountKobo)}`,
    o.delivery?.method === 'pickup' ? 'Pickup' : o.delivery?.address ? `Deliver to: ${o.delivery.address}` : '',
    customer?.name || customer?.phone ? `Customer: ${[customer.name, customer.phone].filter(Boolean).join(' · ')}` : '',
  ].filter(Boolean);
  const next: [string, string][] = o.status === 'paid'
    ? [nextStep(o) ?? [`act:msgcust:${o.ref}`, 'Message customer'], ...(nextStep(o) ? [[`act:msgcust:${o.ref}`, 'Message customer'] as [string, string]] : []), ['act:menu', 'Menu']]
    : [[`act:msgcust:${o.ref}`, 'Message customer'], ['act:owing', 'Who owes me'], ['act:menu', 'Menu']];
  return buttons(lines.join('\n'), next);
}

async function messageCustomer(c: ActionCtx): Promise<Out> {
  const o = await findOrder(c, c.arg);
  const customer = o ? ((await c.db.get(c.db.doc(C.customers, o.customerId))) as { name?: string; phone?: string } | null) : null;
  const digits = customer?.phone?.replace(/\D/g, '');
  if (!o || !digits) return "I don't have a WhatsApp number for that customer.";
  return { type: 'interactive', interactive: { type: 'cta_url', body: { text: `Chat with ${customer?.name ?? 'the customer'} about ${o.ref} in your WhatsApp Business app.` }, action: { name: 'cta_url', parameters: { display_text: 'Open the chat', url: `https://wa.me/${digits}` } } } };
}

// Paused: customers see the shop and a "back on …" note, but can't order until then.
async function pause(c: ActionCtx): Promise<Out> {
  const paused = c.business.pausedUntil;
  const choose = pauseChoice(null, c.business.hours);
  if (!c.arg) return pauseChoice(paused, c.business.hours);
  if (c.arg === 'cancel') return buttons('Your shop is still open.', [['act:menu', 'Menu']]);
  const days = c.arg === 'open' ? null : Number(c.arg);
  if (c.arg !== 'open' && !(days && days > 0 && days <= 30)) return choose;
  // Reopens at that day's opening time (or the next open day's).
  const at = days ? reopenAt(c.business.hours, days) : null;
  const until = at ? at.toISOString() : 'open';
  await c.db.update(c.db.doc(C.businesses, c.business.id), { pausedUntil: until, updatedAt: new Date().toISOString() });
  c.business.pausedUntil = until;
  return buttons(`⏸️ Paused. Customers can look but can't order${at ? ` until ${whenLabel(at)}` : ' until you reopen'}.`, [['act:reopen', 'Reopen now'], ['act:menu', 'Menu']]);
}

async function reopen(c: ActionCtx): Promise<Out> {
  await c.db.update(c.db.doc(C.businesses, c.business.id), { pausedUntil: null, updatedAt: new Date().toISOString() });
  c.business.pausedUntil = null;
  return '▶️ Your shop is open for orders again.';
}

async function hours(c: ActionCtx): Promise<Out> {
  const h = c.business.hours;
  const form = flowId(c.cfg, 'hours');
  if (form) return flowMessage('hours', form, c.business.id, `${h ? `Your opening hours: ${describeHours(h)}.` : 'No opening hours set yet.'} Tap below to set them day by day.`, Object.fromEntries(DAYS.flatMap(d => [[`${d}_open`, h?.[d]?.open ?? 'closed'], [`${d}_close`, h?.[d]?.close ?? 'closed']])));
  return buttons(`${h ? `Your opening hours: ${describeHours(h)}.` : 'No opening hours set: customers can order any time.'}`, [['act:hourschange', 'Change hours'], ['act:menu', 'Menu']]);
}

async function hoursChange(c: ActionCtx): Promise<Out> {
  await c.setAwaiting('hours');
  return waiting('Send your new opening hours, e.g. *Mon–Sat 8am–9pm, Sun closed*, or *8am–9pm* for every day.');
}

async function delivery(c: ActionCtx): Promise<Out | Out[]> {
  const zones = (await listZones(c.db, c.business.id)).sort(byPriority);
  const form = flowId(c.cfg, 'delivery');
  if (form) return flowMessage('delivery', form, c.business.id, `${zones.length ? `You deliver to ${zones.length} area${zones.length === 1 ? '' : 's'}.` : 'No delivery prices yet.'} Tap below to add areas and prices, or send *DELIVERY LIST* to upload them all.`);
  const how = c.business.fulfilment === 'pickup' ? 'Pickup only.' : zones.length ? `Delivery prices:\n${zones.map(z => `• ${z.name}: ${z.feeKobo ? formatKobo(z.feeKobo) : 'free'}${z.timeframe ? `, ${z.timeframe}` : ''}`).join('\n')}${c.business.shipsInterstate && c.business.interstatePricing === 'quote' ? '\n• Other states: you quote per order' : ''}` : 'No delivery prices yet.';
  return [`${how}`.slice(0, 3800), buttons('Add one with e.g. *delivery zone Lekki, 1500, same day*, or send your whole list at once.', [['act:zonesupload', 'Send my price list'], ['act:menu', 'Menu']])];
}

// "Send my price list": the next message (a paste, spreadsheet, document or photo) is the delivery list.
async function zonesUpload(c: ActionCtx): Promise<Out> {
  await c.setAwaiting('zones');
  return waiting(ZONES_ASK);
}

// ── Status posts (services/status-posts.ts) ──
async function makeStatus(c: ActionCtx): Promise<Out | Out[] | null> {
  if (!c.arg) {
    // What should it be about: the newest products, then the sections.
    const products = (await listProducts(c.db, c.business.id)).filter(p => p.available && hasStock(p)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!products.length) return 'Add a product first, then I can make a Status for it.';
    const cats = (await listCategories(c.db, c.business.id)).filter(x => products.some(p => p.categoryId === x.id));
    const rows = [
      ...products.slice(0, cats.length > 1 ? 6 : 9).map(p => ({ id: `act:status:p:${p.id}`, title: p.name, description: formatKobo(p.priceKobo) })),
      ...(cats.length > 1 ? cats.slice(0, 3).map(x => ({ id: `act:status:c:${x.id}`, title: `All of ${x.name}`, description: 'A Status for the whole section' })) : []),
    ];
    return subList('Post a Status', 'What should the Status be about? I\'ll make the picture and pick the customers to mention.', rows);
  }
  const [kind, id] = c.arg.split(':');
  if (!id || !['p', 'c'].includes(kind)) return 'Send */status* to pick a product.';
  const post = await prepareStatus(c.db, c.cfg, c.deps.images, c.business, kind === 'p' ? { productIds: [id], categoryId: null } : { productIds: [], categoryId: id });
  if (!post) return 'That product or section isn\'t there any more. Send */status* to pick another.';
  await c.reply({ type: 'image', link: post.imageUrl, caption: post.caption });
  return [statusSteps(post), ...(post.wider.length ? [buttons(`${post.wider.length} more customer${post.wider.length === 1 ? '' : 's'} might like this. Send them a personal message instead? (Only those who opted in to updates; you'll see the cost first.)`, [[`act:stothers:${post.id}`, 'Yes, write it'], ['act:menu', 'No thanks']])] : [])];
}

function statusSteps(post: StatusPost): Out {
  const n = post.suggestedMentions.length;
  if (!n) return buttons('Here\'s your Status ☝️ Save the picture and post it to your Status with the caption.\n\nNo customers to mention for this yet. As people buy and browse, I\'ll suggest who to tag.', [[`act:stposted:${post.id}`, "I've posted it"], [`act:stskip:${post.id}`, 'Skip']]);
  const names = post.suggestedMentions.map((m, i) => `${i + 1}. ${m.name} (…${m.phone.replace(/\D/g, '').slice(-4)})`).join('\n');
  return buttons(`Here's your Status ☝️\n1. Save the picture.\n2. Post it to your Status with the caption.\n3. Before you post, tap *@* and add these ${n}:\n${names}\n\nOnly they get a notification, in their chat with you.`, [[`act:stposted:${post.id}`, "I've posted it"], [`act:stpeople:${post.id}`, 'Change people'], [`act:stskip:${post.id}`, 'Skip']]);
}

async function statusPost(c: ActionCtx, what: 'posted' | 'people' | 'skip' | 'others'): Promise<Out> {
  const post = await loadPost(c.db, c.business.id, c.arg);
  if (!post) return 'That Status isn\'t there any more. Send */status* to make a new one.';
  if (what === 'posted') {
    const first = await confirmPosted(c.db, post);
    return first ? `🎉 Nice! I'll tell you tomorrow if any of the people you mentioned message or order.` : 'You already told me that one is posted 👍';
  }
  if (what === 'people') return post.ranking.length > MENTIONS ? statusSteps(await nextMentions(c.db, post)) : 'These are the only customers I can suggest for this right now.';
  if (what === 'skip') { await c.db.update(c.db.doc(C.statusPosts, post.id), { status: 'skipped' }); return 'OK, skipped.'; }
  await c.setAwaiting(`campaign:status:${post.id}`);
  return waiting(`Type the message for those ${post.wider.length} customers, e.g. "${post.title} is here! Reply to order." You'll see how many opted in and the cost before anything is sent.`);
}

async function tips(c: ActionCtx, on: boolean): Promise<Out> {
  await c.db.update(c.db.doc(C.businesses, c.business.id), { statusTips: on, updatedAt: new Date().toISOString() });
  return on ? '✅ I\'ll suggest a Status when you add products, restock, or drop a price (at most once a day).' : '🔕 OK, no more Status tips. Send */status* any time to make one, or *status tips on* to get tips again.';
}

// ── Smart Reach (services/reach.ts) ──
async function reachHome(c: ActionCtx): Promise<Out> {
  const rows = ALL_TRIGGERS.map(t => ({ id: `act:reachtoggle:${t}`, title: `${triggerOn(c.business, t) ? '✅' : '⬜'} ${TRIGGER_LABEL[t]}`, description: TRIGGER_HINT[t] }));
  // Sending one message yourself is Message customers → Send a broadcast.
  return subList('Automatic updates', 'Automatic updates go to the right customers, free where they can. Tap one to switch it on or off.', [...rows,
    { id: 'act:segments', title: 'My customer groups', description: 'Who buys what, and how many' },
  ]);
}
async function reachToggle(c: ActionCtx): Promise<Out> {
  const t = ALL_TRIGGERS.find(x => x === c.arg);
  if (!t) return reachHome(c);
  const on = !triggerOn(c.business, t);
  const reachTriggers = { ...(c.business.reachTriggers ?? {}), [t]: on };
  await c.db.update(c.db.doc(C.businesses, c.business.id), { reachTriggers, updatedAt: new Date().toISOString() });
  c.business.reachTriggers = reachTriggers;
  return buttons(`${on ? '✅' : '⬜'} ${TRIGGER_LABEL[t]} is ${on ? 'on' : 'off'}.`, [['act:reach', 'Automatic updates'], ['act:menu', 'Menu']]);
}
async function reachEveryone(c: ActionCtx): Promise<Out> {
  await c.setAwaiting('reach:all');
  return waiting('Type your broadcast. Write *{name}* where their first name should go, e.g. "Hi {name}, new Ankara gowns just landed!" You\'ll see who gets it and the cost before anything is sent.');
}
// "Send to a group": who (in plain words) and what. "tell my sneaker buyers about the new Jordans".
async function reachGroup(c: ActionCtx): Promise<Out> {
  await c.setAwaiting('reach:group');
  return waiting('Who should get it, and what\'s the news? e.g. *tell my sneaker buyers about the new Jordans, 10% off this weekend*');
}

export async function reachFromWords(c: ActionCtx, raw: string): Promise<Out | Out[]> {
  const t = raw.trim().replace(/[.!]+$/, '');
  const m = /^(?:please\s+)?(?:tell|message|remind|text|send (?:a message|an update|this) to|let)\s+(.+?)\s+(?:about|that|know about|know that)\s+(.+)$/i.exec(t) ?? /^(.{3,80}?)\s*:\s*(.+)$/.exec(t);
  if (!m) { await c.setAwaiting('reach:group'); return 'Say who and what, e.g. *tell my sneaker buyers about the new Jordans* or *my top customers: free delivery this week*.'; }
  const [cats, products] = await Promise.all([listCategories(c.db, c.business.id), listProducts(c.db, c.business.id)]);
  const rule = await ruleFromWords(m[1], { categories: cats, products, llm: c.deps.llm });
  if (!rule) return buttons(`I couldn't tell who "${m[1].slice(0, 60)}" means. Try e.g. *my sneaker buyers*, *people who haven't ordered in a month*, or *my top customers*.`, [['act:reachgroup', 'Try again'], ['act:segments', 'My customer groups']]);
  const who = describeRule(rule, { categories: cats, products });
  const members = evaluate(rule, await loadSegmentData(c.db, c.business.id));
  if (!members.length) return buttons(`Nobody matches *${who}* yet.`, [['act:reachgroup', 'Try another group'], ['act:menu', 'Menu']]);
  const samples = await draftUpdates(c, m[2]);
  await c.db.set(c.db.doc(C.conversations, c.admin.conversationId), { reachDraft: { audience: members, segment: who, samples } }, { merge: true });
  return [`*${members.length} customer${members.length === 1 ? '' : 's'}*: ${who}.\n\nPick the wording ({name} becomes their first name):\n\n${samples.map((x, i) => `*${i + 1}.* ${x}`).join('\n\n')}`.slice(0, 4000),
    list('Which one?', 'Pick wording', samples.map((_, i) => ({ id: `act:reachpick:${i + 1}`, title: `Option ${i + 1}` })), 'Wording')];
}

// Three ways to say the owner's news, in the shop's voice (the AI; plain versions without it).
async function draftUpdates(c: ActionCtx, news: string): Promise<string[]> {
  const n = news.trim().replace(/^(the |that )/i, '');
  const plain = [`Hi {name}! ${n.charAt(0).toUpperCase()}${n.slice(1)} at ${c.business.name} 🎉`, `Hi {name}, quick news from ${c.business.name}: ${n}.`, `{name}, ${n}! Reply to order 🙌`];
  if (!c.deps.llm?.writeTexts) return plain;
  try {
    const out = await c.deps.llm.writeTexts({ prompt: [`Write a short WhatsApp update from the shop "${c.business.name}" to one of its customers about: ${n.slice(0, 300)}.`, 'Start with "Hi {name}" (keep {name} exactly; it becomes their first name). Under 300 characters. At most one emoji. Never invent prices, dates or offers that aren\'t in the news.', 'Write it three ways: "warm" (warm and chatty), "short" (short and clear), "naija" (light Nigerian Pidgin, never forced).'].join('\n'), keys: ['warm', 'short', 'naija'] });
    return ['warm', 'short', 'naija'].map((k, i) => { const x = String(out[k] ?? '').trim().slice(0, 400); return x.length > 10 && !/\{(?!name\})/.test(x) ? x : plain[i]; });
  } catch { return plain; }
}

async function reachPick(c: ActionCtx): Promise<Out> {
  const d = (await c.db.get(c.db.doc(C.conversations, c.admin.conversationId)))?.reachDraft as { audience: string[]; segment: string; samples: string[] } | null | undefined;
  const text = d?.samples?.[Number(c.arg) - 1];
  if (!d || !text) return reachGroup(c);
  await c.db.set(c.db.doc(C.conversations, c.admin.conversationId), { reachDraft: null }, { merge: true });
  return reachPlan(c, text, d.audience, d.segment);
}

// From Relay's daily suggestion: an update to the people who looked at a product and didn't buy.
async function reachAsk(c: ActionCtx): Promise<Out> {
  const p = (await listProducts(c.db, c.business.id)).find(x => x.id === c.arg);
  if (!p) return reachGroup(c);
  const audience = await interestedIn(c.db, c.business.id, p.id, new Date());
  if (!audience.length) return buttons(`Nobody is waiting on *${p.name}* any more.`, [['act:reach', 'Automatic updates'], ['act:menu', 'Menu']]);
  const samples = await draftUpdates(c, `${p.name} is available now, ${formatKobo(p.priceKobo)}`);
  await c.db.set(c.db.doc(C.conversations, c.admin.conversationId), { reachDraft: { audience, segment: `looked at ${p.name}`, samples } }, { merge: true });
  return [`*${audience.length} people* looked at ${p.name}.\n\nPick the wording:\n\n${samples.map((x, i) => `*${i + 1}.* ${x}`).join('\n\n')}`.slice(0, 4000),
    list('Which one?', 'Pick wording', samples.map((_, i) => ({ id: `act:reachpick:${i + 1}`, title: `Option ${i + 1}` })), 'Wording')] as unknown as Out;
}

// "Picked for you": each customer gets a carousel of products matched to what they looked at or bought.
async function reachPicks(c: ActionCtx): Promise<Out> {
  return reachPlan(c, `Hi {name}, we picked these for you at ${c.business.name} 👇`, null, null, { picks: true });
}

async function segmentsView(c: ActionCtx): Promise<Out> {
  const groups = await refreshSegments(c.db, c.business.id);
  return buttons(`Your customer groups:\n${groups.map(g => `• ${g.name}: ${g.size}`).join('\n')}\n\nTo message one, start a broadcast and pick the group after the preview.`.slice(0, 1000), [['act:campaign', 'Send a broadcast'], ['act:reach', 'Automatic updates'], ['act:menu', 'Menu']]);
}

// The route plan, then [Send all] [Free ones only] [Edit message].
export async function reachPlan(c: ActionCtx, text: string, audience?: string[] | null, segment?: string | null, extra: { picks?: boolean } = {}): Promise<Out> {
  // "10% off with a code" in the news: each customer gets their own single-use code ({code}).
  const pct = /\b(\d{1,2})\s*%\s*(?:off|discount)\b.*\bcode\b|\bcode\b.*\b(\d{1,2})\s*%/i.exec(text);
  const offer = pct ? { percentOff: Number(pct[1] ?? pct[2]), days: 7 } : null;
  const body = offer && !/\{code\}/i.test(text) ? `${text} Your code: {code}` : text;
  const { campaign, decisions, summary } = await planCampaign(c.db, c.cfg, c.business, { name: extra.picks ? 'Picked for you' : segment ? `Update to ${segment}` : 'Update to everyone', text: body, source: 'owner', button: ['menu', 'See what we have'], audience: audience ?? null, segment: segment ?? null, picks: extra.picks ?? false, offer });
  if (!decisions.length) return buttons('You have no customers yet. Once people chat or order, you can send them updates here.', [['act:menu', 'Menu']]);
  if (!summary.open && !summary.owner_sent && !summary.paid_template) return buttons(`${planText(summary, decisions.length)}\n\nNobody can get this right now: paid updates need your marketing template approved by Meta.`, [['act:reach', 'Automatic updates'], ['act:menu', 'Menu']]);
  // A broadcast to everyone: the preview, then who gets it (everyone, or a group).
  if (!audience && !segment && !extra.picks) return buttons(`${planText(summary, decisions.length)}\n\nWho should get it?`, [[`act:reachsend:${campaign.id}`, 'Everyone'], [`act:bcgroup:${campaign.id}`, 'Choose a group'], ['act:cancel', 'Cancel']]);
  const mixed = summary.owner_sent > 0 || summary.paid_template > 0;
  return buttons(planText(summary, decisions.length), mixed ? [[`act:reachsend:${campaign.id}`, 'Send all'], [`act:reachfree:${campaign.id}`, 'Free ones only'], ['act:cancel', 'Cancel']] : [[`act:reachsend:${campaign.id}`, 'Send'], ['act:reachall', 'Edit'], ['act:cancel', 'Cancel']]);
}

// Broadcast → Choose a group: the shop's groups with their sizes; the pick plans it again for them.
async function broadcastGroups(c: ActionCtx): Promise<Out> {
  const camp = c.arg ? ((await c.db.get(c.db.doc(C.campaigns, c.arg))) as { businessId: string; text: string } | null) : null;
  if (!camp || camp.businessId !== c.business.id) return buttons('That broadcast is gone. Start again from Message customers.', [['act:reachhub', 'Message customers'], ['act:menu', 'Menu']]);
  const groups = (await refreshSegments(c.db, c.business.id)).filter(g => g.size > 0);
  if (!groups.length) return buttons('No groups have anyone in them yet.', [[`act:reachsend:${c.arg}`, 'Send to everyone'], ['act:cancel', 'Cancel']]);
  return subList('Groups', 'Which group gets it?', groups.slice(0, 9).map(g => ({ id: `act:bcpick:${c.arg}:${g.key}`, title: g.name, description: `${g.size} customer${g.size === 1 ? '' : 's'}` })));
}

async function broadcastToGroup(c: ActionCtx): Promise<Out> {
  const [campaignId, key] = (c.arg ?? '').split(':');
  const camp = (await c.db.get(c.db.doc(C.campaigns, campaignId))) as { businessId: string; text: string } | null;
  if (!camp || camp.businessId !== c.business.id) return buttons('That broadcast is gone. Start again from Message customers.', [['act:reachhub', 'Message customers'], ['act:menu', 'Menu']]);
  const cats = await listCategories(c.db, c.business.id);
  const seg = systemSegments(cats).find(s => s.key === key);
  if (!seg) return broadcastGroups({ ...c, arg: campaignId });
  const members = evaluate(seg.rule, await loadSegmentData(c.db, c.business.id));
  return reachPlan(c, camp.text, members, seg.name);
}
async function reachSend(c: ActionCtx, freeOnly: boolean): Promise<Out | Out[]> {
  const r = await executeCampaign(c.db, c.cfg, c.deps, c.business, c.arg ?? '', { freeOnly });
  if (!r) return 'That update isn\'t there any more. Send */reach* to start again.';
  if ('blocked' in r && r.blocked) return buttons(`Your wallet has ${formatKobo(r.blocked.haveKobo)}, and the paid messages cost ${formatKobo(r.blocked.needKobo)}. Nothing was sent. Send the free ones only, or wait for more sales.`, [[`act:reachfree:${r.campaign.id}`, 'Free ones only'], ['act:wallet', 'My wallet'], ['act:menu', 'Menu']]);
  if (r.campaign.status !== 'planned' && !r.sent && !r.queued && !r.links.length) return 'That update was already sent.';
  const head = `✅ Sent to ${r.sent}${r.queued ? `; ${r.queued} more at 8am (it's late now)` : ''}.`;
  if (!r.links.length) return buttons(head, [['act:reach', 'Automatic updates'], ['act:menu', 'Menu']]);
  const list = r.links.map((l, i) => `${i + 1}. ${l.name}: ${l.link}`).join('\n');
  return [head, `Your regulars: tap each link to send it from your own WhatsApp (free). The message is already typed.\n\n${list}`.slice(0, 4000), buttons('Sent them all?', [[`act:reachmark:${r.campaign.id}`, 'Mark all sent'], ['act:menu', 'Menu']])];
}

export const ACTIONS: OwnerAction[] = [
  { id: 'menu', command: 'menu', hint: 'Everything Relay can do for your shop, to tap', aliases: ['menu', 'main menu', 'options', 'home', 'start', 'open my menu', 'set up my shop'], run: c => menu(c) },
  { id: 'help', hint: 'What I can do, in short', menu: { section: 'Help', title: 'Commands', description: 'What to type, with your own products' }, tool: { name: 'help' }, aliases: ['help', 'commands', 'what can you do', 'what can you do?', '?', 'see how relay works'], next: [['menu', 'Menu']], async run(c) { return helpText(c.business, await listProducts(c.db, c.business.id)); } },
  // Shop
  { id: 'add', command: 'add', hint: 'Add a product: send its name and price, with a photo if you have one', menu: { section: 'Shop', title: 'Add product' }, aliases: ['add', 'add product', 'add a product', 'new product'],
    async run(c) {
      const form = flowId(c.cfg, 'add');
      if (form) return flowMessage('add', form, c.business.id, 'Tap below to add a product: name, price, category and stock in one form.', { categories: (await listCategories(c.db, c.business.id)).map(x => ({ id: x.id, title: x.name })) });
      await c.setAwaiting('add'); return waiting(`Send the product's name and price, e.g. *${example(c.business, await listProducts(c.db, c.business.id))}*. Add a photo with it as the caption if you have one. Add a number at the end if you count stock.`); } },
  { id: 'products', command: 'products', hint: 'See all your products and prices', menu: { section: 'Shop', title: 'My products' }, aliases: ['products', 'my products', 'product list', 'list products', 'stock', 'inventory', 'catalogue', 'catalog'], tool: { name: 'listProducts' }, next: [['add', 'Add product'], ['soldout', 'Mark sold out'], ['menu', 'Menu']], run: tool('listProducts') },
  { id: 'soldout', command: 'soldout', hint: 'Mark a product as sold out', menu: { section: 'Shop', title: 'Mark sold out' }, aliases: ['soldout', 'sold out', 'mark sold out', 'out of stock'], next: [['soldout', 'Mark another'], ['products', 'My products'], ['menu', 'Menu']], run: soldOut },
  // Orders
  { id: 'orders', command: 'orders', hint: 'Orders: what to deliver, and today\'s', aliases: ['orders', "today's orders", 'todays orders', 'orders today', 'recent orders', 'my orders'], tool: { name: 'listOrders', args: { filter: 'today' } }, run: ordersScreen },
  { id: 'pending', hint: 'To deliver', aliases: ['pending', 'pending orders', 'to deliver', 'paid orders'], run: ordersScreen },
  { id: 'deliverpick', hint: 'Mark an order delivered', run: deliverPick },
  { id: 'delivered', hint: 'This order was delivered or picked up', next: [['orders', 'Orders'], ['menu', 'Menu']], async run(c) {
    const o = await findOrder(c, c.arg);
    if (!o) return 'That order is gone. Send *orders* to see them.';
    return runTool('updateFulfilment', { order: o.ref, status: o.delivery?.method === 'pickup' ? 'picked_up' : 'delivered' }, c);
  } },
  { id: 'money', hint: 'Sales (goods and delivery) and your wallet', aliases: ['money', 'my money'], run: moneyScreen },
  { id: 'reachhub', hint: 'Status, broadcast or automatic updates', aliases: ['message customers', 'marketing', 'promote'], run: async () => reachHub() },
  { id: 'restock', hint: 'Put a sold-out product back in stock', run: restockAsk },
  { id: 'hourschange', hint: 'Change your opening hours', run: hoursChange },
  { id: 'bcgroup', hint: 'Choose who gets the broadcast', run: broadcastGroups },
  { id: 'bcpick', hint: 'Send the broadcast to this group', run: broadcastToGroup },
  { id: 'cancel', hint: 'Stop what you were doing', async run() { return buttons('Cancelled. Nothing was sent or saved.', [['act:menu', 'Menu']]); } },
  { id: 'policyedit', hint: 'Change your shop policies', async run(c) { await c.setAwaiting('policies'); return waiting('Type your policies in your own words: returns, exchanges and refunds, e.g. *Exchange within 3 days. No refunds.*'); } },
  { id: 'export', command: 'export', hint: 'Your orders and customers as a spreadsheet, and a live Google Sheets link', aliases: ['export', 'export orders', 'download orders', 'spreadsheet', 'excel', 'google sheets', 'google sheet', 'sheets', 'export customers'], run: c => exportScreen(c, false) },
  { id: 'exportnew', hint: 'Make new private export links (the old ones stop working)', run: c => exportScreen(c, true) },
  { id: 'receipt', command: 'receipt', hint: 'Send the PDF receipt of a paid order again', menu: { section: 'Orders', title: 'Resend a receipt' }, aliases: ['receipt', 'receipts', 'resend receipt'], next: [['orders', "Today's orders"], ['menu', 'Menu']], run: receipt },
  // Money
  { id: 'sales', command: 'sales', hint: 'Sales today, this week and this month',  aliases: ['sales', 'sales today', 'sales report', 'report', 'today', 'how much did i make', 'how much did i make today', 'how much have i made', 'how much did i sell today', 'how much have i sold today', 'how much i make today'], tool: { name: 'salesToday' }, run: moneyScreen },
  { id: 'wallet', command: 'wallet', hint: 'Your Relay wallet: balance, withdrawals and where payouts go', aliases: ['wallet', 'my wallet', 'balance', 'my balance'], run: moneyScreen },
  { id: 'walletdetails', hint: 'Wallet details', aliases: ['wallet details', 'payout details'], run: walletView },
  { id: 'withdraw', command: 'withdraw', hint: 'Send money from your wallet to your bank account, no fee', aliases: ['withdraw', 'withdrawal', 'payout', 'cash out'], run: startWithdraw },
  { id: 'verify', hint: 'Verify your account once to withdraw', aliases: ['verify', 'verify me', 'verify account', 'kyc'], run: startVerify },
  { id: 'payouts', hint: 'Your last withdrawals', aliases: ['payouts', 'payout history', 'withdrawals'], next: [['wallet', 'My wallet'], ['menu', 'Menu']], run: payoutHistory },
  { id: 'owing', command: 'owing', hint: 'Orders still waiting for payment', menu: { section: 'Money', title: 'Who owes me' }, aliases: ['owing', 'who owes me', 'unpaid', 'unpaid orders', 'awaiting payment', 'debtors'], tool: { name: 'listOrders', args: { filter: 'unpaid' } }, next: [['money', 'Money'], ['orders', 'Orders'], ['menu', 'Menu']], run: tool('listOrders', { filter: 'unpaid' }) },
  // Customers
  { id: 'customers', command: 'customers', hint: 'Your top customers: who buys most and what they like', menu: { section: 'Customers', title: 'Top customers' }, aliases: ['customers', 'my customers', 'top customers', 'customer list'], tool: { name: 'listCustomers', args: { sort: 'top' } }, next: [['campaign', 'Send a campaign'], ['menu', 'Menu']], run: tool('listCustomers', { sort: 'top' }) },
  { id: 'status', command: 'status', hint: 'Make a WhatsApp Status for a product and see which customers to mention', menu: { section: 'Customers', title: 'Post a Status' }, aliases: ['status', 'make a status', 'make status', 'status post', 'post a status'], next: [['menu', 'Menu']], run: makeStatus },
  { id: 'reach', command: 'reach', hint: 'Automatic updates: back in stock, left in cart, price drops; and updates to a group', menu: { section: 'Customers', title: 'Automatic updates' }, aliases: ['reach', 'smart reach', 'automatic updates'], run: reachHome },
  { id: 'campaign', command: 'campaign', hint: 'Send a broadcast to your customers; you see who gets it and the cost first', menu: { section: 'Customers', title: 'Send a broadcast' }, aliases: ['campaign', 'broadcast', 'send a campaign', 'send campaign', 'send to everyone'], run: c => reachEveryone(c) },
  { id: 'reachall', hint: 'Send an update to everyone', run: c => reachEveryone(c) },
  { id: 'reachgroup', hint: 'Send an update to a group of customers', run: reachGroup },
  { id: 'reachpick', hint: 'Use this wording', run: reachPick },
  { id: 'reachask', hint: 'Write an update to the people who looked', run: reachAsk },
  { id: 'reachpicks', hint: 'Send each customer products picked for them', aliases: ['picked for you', 'personal picks', 'send picks'], run: reachPicks },
  { id: 'segments', hint: 'Your customer groups and their sizes', aliases: ['groups', 'segments', 'customer groups', 'my groups'], run: segmentsView },
  { id: 'reachtoggle', hint: 'Switch an automatic update on or off', run: reachToggle },
  { id: 'reachsend', hint: 'Send the planned update', run: c => reachSend(c, false) },
  { id: 'reachfree', hint: 'Send the planned update by free routes only', run: c => reachSend(c, true) },
  { id: 'reachmark', hint: 'The links were sent from your phone', next: [['reach', 'Automatic updates'], ['menu', 'Menu']], async run(c) { const n = await markOwnerSent(c.db, c.business.id, c.arg ?? ''); return n ? `👍 Marked ${n} as sent.` : 'Those were already marked as sent.'; } },
  // Settings
  { id: 'hours', command: 'hours', hint: 'See or change your opening hours', menu: { section: 'Settings', title: 'Opening hours' }, aliases: ['hours', 'opening hours', 'my hours'], next: [['delivery', 'Delivery'], ['menu', 'Menu']], run: hours },
  { id: 'delivery', command: 'delivery', hint: 'See or change your delivery areas and prices', menu: { section: 'Settings', title: 'Delivery' }, aliases: ['delivery', 'delivery prices', 'delivery zones', 'zones'], next: [['hours', 'Opening hours'], ['menu', 'Menu']], run: delivery },
  { id: 'messages', command: 'messages', hint: 'Choose the messages customers get from your shop', menu: { section: 'Settings', title: 'Messages' }, aliases: ['messages', 'my messages', 'customer messages'], async run() { return messagesMenu(); } },
  { id: 'policies', hint: 'Your returns and refunds policy (the shop assistant answers from it)', menu: { section: 'Settings', title: 'Shop policies', description: 'Returns and refunds; the assistant answers from them' }, aliases: ['policies', 'policy', 'my policies'], next: [['policyedit', 'Change policies'], ['menu', 'Menu']], async run(c) { const r = (await handleSettings(c.db, c.cfg, c.business, 'policies', null)) ?? 'No policies set.'; return typeof r === 'string' ? r.replace(/\n\nTo change them send \*policies:\* followed by your own words\.$/, '') : r; } },
  { id: 'zonesupload', hint: 'Upload all your delivery areas and prices at once', aliases: ['delivery list', 'upload delivery', 'delivery prices list', 'upload delivery prices', 'send delivery list'], run: zonesUpload },
  { id: 'tone', hint: 'How the shop assistant sounds to your customers', menu: { section: 'Settings', title: 'Assistant tone', description: 'Friendly, professional or street' }, aliases: ['tone', 'assistant tone', 'change tone', 'my tone'], next: [['menu', 'Menu']], run: toneMenu },
  { id: 'settone', hint: 'Set the assistant tone', run: setTone },
  { id: 'fee', hint: "Who pays Relay's 1% fee: you or your customers", menu: { section: 'Settings', title: "Relay's fee" }, aliases: ['fee', 'fees', 'relay fee', 'service fee'], async run(c) { return (await handleSettings(c.db, c.cfg, c.business, 'fee', null))!; } },
  { id: 'close', command: 'close', hint: 'Pause your shop for a while: customers can look but not order', aliases: ['close', 'close shop', 'close my shop', 'pause', 'pause shop', 'pause my shop'], run: pause,
    hidden: c => !!c.business.pausedUntil },
  { id: 'reopen', hint: 'Open your shop for orders again', aliases: ['reopen', 'open shop', 'reopen shop', 'unpause'], next: [['menu', 'Menu']], run: reopen, hidden: c => !c.business.pausedUntil },
  { id: 'switch', command: 'switch', hint: 'Move between your shops or add another one', menu: { section: 'Settings', title: 'Switch shop' }, aliases: ['switch', 'switch shop', 'switch shops', 'my shops', 'shops'],
    hidden: async c => ((await getOwner(c.db, c.ownerPhone))?.businessIds?.length ?? 1) < 2,
    async run(c) { await handleShops(c.admin, c.business, null, 'switch', c.reply); return null; } },
  // Help
  { id: 'test', command: 'test', hint: 'Try your shop as a customer, with pretend payments', menu: { section: 'Help', title: 'Try my shop' }, aliases: ['test', 'test my shop', 'try my shop'],
    async run(c) { await startTest(c.admin, c.deps, c.business, c.reply); return null; } },
  { id: 'call', command: 'call', hint: 'A real person from Relay calls or WhatsApps you', menu: { section: 'Help', title: 'Talk to a person' }, aliases: ['call', 'call me', 'talk to a person', 'talk to someone', 'support'], next: [['menu', 'Menu']],
    async run(c) { await openTicket(c.db, c.cfg, c.deps, { ownerPhone: c.ownerPhone, businessId: c.business.id, businessName: c.business.name, stage: c.business.status, message: 'Asked from the menu' }); return 'Got it 👍 A real person from Relay will call or WhatsApp you shortly on this number.'; } },
  // Not in the menu: the buttons on order alerts, Status posts and after adding a product.
  { id: 'stposted', hint: 'The Status is posted', next: [['status', 'Make another'], ['menu', 'Menu']], run: c => statusPost(c, 'posted') },
  { id: 'stpeople', hint: 'Other customers to mention', run: c => statusPost(c, 'people') },
  { id: 'stskip', hint: 'Skip this Status', next: [['menu', 'Menu']], run: c => statusPost(c, 'skip') },
  { id: 'stothers', hint: 'Message the rest instead', run: c => statusPost(c, 'others') },
  { id: 'tipsoff', hint: 'Stop Status tips', aliases: ['status tips off', 'status suggestions off', 'stop status tips'], next: [['status', 'Make a Status'], ['menu', 'Menu']], run: c => tips(c, false) },
  { id: 'tipson', hint: 'Status tips again', aliases: ['status tips on', 'status suggestions on'], next: [['status', 'Make a Status'], ['menu', 'Menu']], run: c => tips(c, true) },
  { id: 'order', hint: 'One order in full', run: viewOrder },
  { id: 'soldoutall', hint: 'Every option of a product sold out', next: [['soldout', 'Mark another'], ['products', 'My products'], ['menu', 'Menu']], async run(c) {
    const p = (await c.db.get(c.db.doc(C.products, c.arg ?? '-'))) as Product | null;
    if (!p || p.businessId !== c.business.id || p.deletedAt) return 'That product is gone.';
    await c.db.update(c.db.doc(C.products, p.id), { stock: 0, ...(p.variants?.length ? { variants: p.variants.map(v => ({ ...v, stock: 0 })) } : {}), updatedAt: new Date().toISOString() });
    return `✅ All of *${p.name}* is marked sold out.`;
  } },
  { id: 'msgcust', hint: 'Open the chat with an order\'s customer', run: messageCustomer },
  { id: 'ready', hint: 'Mark a paid order ready', async run(c) {
    const out = await runTool('updateFulfilment', { order: c.arg ?? '', status: 'ready' }, c);
    const o = await findOrder(c, c.arg);
    const step = o ? nextStep(o) : null;
    return typeof out === 'string' ? buttons(out, [...(step ? [step] : []), ['act:orders', 'To deliver'], ['act:menu', 'Menu']]) : out;
  } },
  { id: 'out', hint: 'This order has left the shop: add the rider and arrival time', run: outAsk },
  { id: 'outskip', hint: 'Out for delivery, without rider details', run: c => markOut(c, null) },
  { id: 'photo', hint: 'Add a photo to a product', async run(c) {
    const p = c.arg ? ((await c.db.get(c.db.doc(C.products, c.arg))) as Product | null) : null;
    if (!p || p.businessId !== c.business.id || p.deletedAt) return 'That product is gone.';
    await c.setAwaiting(`photo:${p.id}`);
    return waiting(`Send the photo of *${p.name}*.`);
  } },
];

export const actionById = (id: string) => ACTIONS.find(a => a.id === id) ?? null;

// "/sales", "Sales", "how much did I make today?", "soldout pink top" → the action (and its argument).
export function matchAction(raw: string): { action: OwnerAction; arg: string | null } | null {
  const t = raw.trim().replace(/^\//, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ').toLowerCase();
  if (!t) return null;
  if (GREETING.test(t)) return { action: actionById('menu')!, arg: null };
  for (const a of ACTIONS) if (a.command === t || a.aliases?.includes(t)) return { action: a, arg: null };
  // A command with something after it: "/receipt RLY-ABCDE", "soldout pink crop top", "close 3".
  const m = /^(\w+)\s+(.+)$/.exec(t);
  if (m) {
    const a = ACTIONS.find(x => x.command === m[1] && ['soldout', 'receipt', 'close'].includes(x.id));
    if (a) return { action: a, arg: a.id === 'receipt' ? m[2].toUpperCase() : a.id === 'close' ? (/^\d+$/.test(m[2]) ? m[2] : null) : raw.trim().replace(/^\/?\w+\s+/, '') };
  }
  return null;
}

// The LLM picked an admin tool: the action that means the same thing, if there is one.
export function actionForTool(name: string, args: Record<string, unknown>): OwnerAction | null {
  return ACTIONS.find(a => a.tool?.name === name && Object.entries(a.tool.args ?? {}).every(([k, v]) => args[k] === v || (args[k] === undefined && k === 'filter' && v === 'recent'))) ?? null;
}

// Up to 3 follow-up buttons; with three, the last is always Menu.
export function followUps(next: [string, string][] | undefined): [string, string][] {
  const items = (next ?? []).map(([id, title]) => [id.startsWith('act:') ? id : `act:${id}`, title] as [string, string]);
  if (!items.length) return [['act:menu', 'Menu']];
  const noMenu = items.filter(([id]) => id !== 'act:menu');
  if (noMenu.length >= 2) return [...noMenu.slice(0, 2), ['act:menu', 'Menu']];
  return [...noMenu, ['act:menu', 'Menu']];
}

// A reply with its follow-up buttons: text that fits in a button message gets them; anything that
// already has buttons, a list or a file keeps its own.
export function withFollowUps(out: Out, next: [string, string][] | undefined): Out {
  if (typeof out !== 'string') return out;
  return out.length <= 1000 ? buttons(out, followUps(next)) : out;
}

export async function runAction(a: OwnerAction, c: ActionCtx): Promise<void> {
  const out = await a.run(c);
  if (out === null) return;
  const all = Array.isArray(out) ? out : [out];
  for (let i = 0; i < all.length; i++) await c.reply(i === all.length - 1 ? withFollowUps(all[i], a.next) : all[i]);
}

// A tap on a menu row or follow-up button: act:<id>[:<arg>] or menu:<section>.
export async function handleActionTap(choiceId: string, c: Omit<ActionCtx, 'arg'>): Promise<boolean> {
  if (choiceId.startsWith('menu:')) {
    const s = SECTIONS.find(x => x === choiceId.slice(5));
    // Buttons still in the chat from the old menu go to the new screens.
    const ctx = { ...c, arg: null };
    const out = s === 'Orders' ? await ordersScreen(ctx) : s === 'Money' ? await moneyScreen(ctx) : s === 'Customers' ? reachHub() : await menu(ctx, s === 'Settings' || s === 'Help' ? s : null);
    await c.reply(out);
    return true;
  }
  if (!choiceId.startsWith('act:')) return false;
  const [, id, ...rest] = choiceId.split(':');
  const a = actionById(id);
  if (!a) return false;
  await runAction(a, { ...c, arg: rest.length ? rest.join(':') : null });
  return true;
}

// HELP: the commands, from this list.
// Short on purpose: the full list is the MENU (and "/" in WhatsApp). A few things to type, with this
// shop's own products.
export function helpText(business: Pick<Business, 'name' | 'category'>, products: { name: string; priceKobo: number }[] = []) {
  const name = example(business, products, { nameOnly: true });
  return `Tap *Menu* to see everything, or type / for the commands.\n\nOr just say it (voice notes work too):\n• add ${example(business, products)}\n• restock ${name} 5\n• RLY-ABCDE paid\n• how much did I make today?`;
}

// ── WhatsApp's own command list and ice breakers (npm run sync:commands) ──

// Shown on a brand-new chat with the Relay number, which is almost always a new owner: no
// "Open my menu" (they have no shop yet; owners already have MENU and the / commands).
export const ICE_BREAKERS = ['Set up my shop', 'See how Relay works', 'Talk to a person'];

const EMOJI = /\p{Extended_Pictographic}/u;
export function commandsPayload() {
  const problems: string[] = [];
  const commands = ACTIONS.filter(a => a.command).map(a => ({ command_name: a.command!, command_description: a.hint }));
  if (commands.length > 30) problems.push(`${commands.length} commands (WhatsApp allows 30)`);
  const seen = new Set<string>();
  for (const c of commands) {
    if (!/^[a-z0-9_]{1,32}$/.test(c.command_name)) problems.push(`/${c.command_name}: names are up to 32 letters, numbers or _`);
    if (seen.has(c.command_name)) problems.push(`/${c.command_name} is listed twice`);
    seen.add(c.command_name);
    if (c.command_description.length > 256) problems.push(`/${c.command_name}: hint is ${c.command_description.length} characters (256 max)`);
    if (EMOJI.test(c.command_description)) problems.push(`/${c.command_name}: no emojis in hints`);
  }
  if (ICE_BREAKERS.length > 4) problems.push(`${ICE_BREAKERS.length} ice breakers (4 max)`);
  for (const p of ICE_BREAKERS) {
    if (p.length > 80) problems.push(`ice breaker "${p}" is over 80 characters`);
    if (EMOJI.test(p)) problems.push(`ice breaker "${p}" has an emoji`);
  }
  if (problems.length) throw new Error(`COMMANDS_INVALID: ${problems.join('; ')}`);
  return { enable_welcome_message: false, commands, prompts: ICE_BREAKERS };
}
