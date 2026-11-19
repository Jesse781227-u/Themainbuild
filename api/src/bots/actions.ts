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
import { getOwner } from '../services/owners';
import { openTicket } from '../services/support';
import { matchProduct } from '../services/match';
import { example } from '../services/shop-type';
import { DAYS, describeHours } from '../services/hours';
import { confirmPosted, loadPost, MENTIONS, nextMentions, prepareStatus, type StatusPost } from '../services/status-posts';
import { flowId, flowMessage } from '../services/flows';
import { listCategories } from '../services/catalog';
import { helpFor, runTool, type AdminToolName, type ToolCtx } from './admin-tools';
import { buttons, findProducts, list, sectionList } from './common';
import { messagesMenu } from './messages-flow';
import { payoutHistory, startVerify, startWithdraw, walletView } from './wallet-flow';
import { handleShops } from './shops';
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

async function salesReport(c: ActionCtx): Promise<Out> {
  const today = lagosDate();
  const month = lastDays(31).filter(d => d.slice(0, 7) === today.slice(0, 7));
  const week = lastDays(7);
  const days = [...new Set([...month, ...week])];
  const stats = await c.db.getAll(days.map(d => c.db.doc(C.dailyStats, `${c.business.id}_${d}`)));
  const by = new Map(days.map((d, i) => [d, stats[i]]));
  const sum = (ds: string[]) => ds.reduce((t, d) => ({ orders: t.orders + Number(by.get(d)?.ordersPaid ?? 0), sales: t.sales + Number(by.get(d)?.salesKobo ?? 0) }), { orders: 0, sales: 0 });
  const line = (label: string, s: { orders: number; sales: number }) => `${label}: ${formatKobo(s.sales)} from ${s.orders} paid order${s.orders === 1 ? '' : 's'}`;
  const unpaid = await recentOrders(c.db, [['businessId', '==', c.business.id], ['status', '==', 'awaiting_payment']], 50);
  return [`📊 Sales for ${c.business.name}`, line('Today', sum([today])), line('Last 7 days', sum(week)), line('This month', sum(month)), '', `${unpaid.length} order${unpaid.length === 1 ? '' : 's'} waiting for payment.`].join('\n');
}

// Paid, not yet delivered or picked up.
async function pendingOrders(c: ActionCtx): Promise<Out> {
  const paid = await recentOrders(c.db, [['businessId', '==', c.business.id], ['status', '==', 'paid']], 50);
  const open = paid.filter(o => !['delivered', 'picked_up'].includes(o.fulfilment));
  if (!open.length) return 'No paid orders waiting to go out. 👍';
  return `Paid, still to deliver or hand over (${open.length}):\n${open.slice(0, 15).map(o => `${orderLine(o)} · ${o.fulfilment.replace(/_/g, ' ')}`).join('\n')}\n\nWhen one is ready, send e.g. *${open[0].ref} ready* or *${open[0].ref} delivered*.`;
}

async function soldOut(c: ActionCtx): Promise<Out> {
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

async function receipt(c: ActionCtx): Promise<Out> {
  if (c.arg) return runTool('orderReceipt', { order: c.arg }, c);
  const paid = await recentOrders(c.db, [['businessId', '==', c.business.id], ['status', '==', 'paid']], 10);
  if (!paid.length) return 'No paid orders yet, so there are no receipts to send.';
  return list('Which order\'s receipt?', 'Pick order', paid.map(o => ({ id: `act:receipt:${o.ref}`, title: o.ref, description: `${formatKobo(o.payAmountKobo)} · ${o.items.map(l => l.name).join(', ')}` })), 'Paid orders');
}

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
    ? [[`act:ready:${o.ref}`, 'Mark ready'], [`act:msgcust:${o.ref}`, 'Message customer'], ['act:menu', 'Menu']]
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
  const choose = buttons('Pause your shop? Customers can still look, but can\'t order until you reopen.', [['act:close:1', 'Until tomorrow'], ['act:close:3', 'For 3 days'], ['act:close:open', 'Until I reopen']]);
  if (!c.arg) {
    if (paused) return buttons(`Your shop is paused${paused === 'open' ? '' : ` until ${new Date(paused).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' })}`}. Reopen now?`, [['act:reopen', 'Reopen now'], ['act:menu', 'Menu']]);
    return choose;
  }
  const days = c.arg === 'open' ? null : Number(c.arg);
  if (c.arg !== 'open' && !(days && days > 0 && days <= 30)) return choose;
  // Reopens at 8am Lagos time on the day.
  const until = days ? new Date(`${lagosDate(new Date(Date.now() + days * 86_400_000))}T07:00:00Z`).toISOString() : 'open';
  await c.db.update(c.db.doc(C.businesses, c.business.id), { pausedUntil: until, updatedAt: new Date().toISOString() });
  c.business.pausedUntil = until;
  return `⏸️ Paused. Customers can look but can't order${days ? ` until ${days === 1 ? 'tomorrow' : `${days} days from now`}, 8am` : ' until you reopen'}. Send *reopen* any time.`;
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
  return `${h ? `Your opening hours: ${describeHours(h)}.` : 'No opening hours set: customers can order any time.'}\n\nTo change them send e.g. *hours Mon–Sat 8am–9pm, Sun closed*, or *hours 8am–9pm* for every day.`;
}

async function delivery(c: ActionCtx): Promise<Out> {
  const zones = (await listZones(c.db, c.business.id)).sort(byPriority);
  const form = flowId(c.cfg, 'delivery');
  if (form) return flowMessage('delivery', form, c.business.id, `${zones.length ? `You deliver to ${zones.map(z => z.name).join(', ')}.` : 'No delivery prices yet.'} Tap below to add areas and prices.`);
  const how = c.business.fulfilment === 'pickup' ? 'Pickup only.' : zones.length ? `Delivery prices:\n${zones.map(z => `• ${z.name}: ${z.feeKobo ? formatKobo(z.feeKobo) : 'free'}${z.timeframe ? `, ${z.timeframe}` : ''}`).join('\n')}${c.business.shipsInterstate && c.business.interstatePricing === 'quote' ? '\n• Other states: you quote per order' : ''}` : 'No delivery prices yet.';
  return `${how}\n\nTo add or change one send e.g. *delivery zone Lekki, 1500, same day*.`;
}

// ── Status posts (services/status-posts.ts) ──
async function makeStatus(c: ActionCtx): Promise<Out | Out[] | null> {
  if (!c.arg) {
    // What should it be about: the newest products, then the sections.
    const products = (await listProducts(c.db, c.business.id)).filter(p => p.available && hasStock(p)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!products.length) return 'Add a product first, then I can make a Status for it.';
    const cats = (await listCategories(c.db, c.business.id)).filter(x => products.some(p => p.categoryId === x.id));
    const rows = [
      ...products.slice(0, cats.length > 1 ? 6 : 10).map(p => ({ id: `act:status:p:${p.id}`, title: p.name, description: formatKobo(p.priceKobo) })),
      ...(cats.length > 1 ? cats.slice(0, 4).map(x => ({ id: `act:status:c:${x.id}`, title: `All of ${x.name}`, description: 'A Status for the whole section' })) : []),
    ];
    return list('What should the Status be about? I\'ll make the picture and pick the customers to mention.', 'Pick one', rows, 'Make a Status');
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
  return `Type the message for those ${post.wider.length} customers, e.g. "${post.title} is here! Reply to order." You'll see how many opted in and the cost before anything is sent.`;
}

async function tips(c: ActionCtx, on: boolean): Promise<Out> {
  await c.db.update(c.db.doc(C.businesses, c.business.id), { statusTips: on, updatedAt: new Date().toISOString() });
  return on ? '✅ I\'ll suggest a Status when you add products, restock, or drop a price (at most once a day).' : '🔕 OK, no more Status tips. Send */status* any time to make one, or *status tips on* to get tips again.';
}

export const ACTIONS: OwnerAction[] = [
  { id: 'menu', command: 'menu', hint: 'Everything Relay can do for your shop, to tap', aliases: ['menu', 'main menu', 'options', 'home', 'start', 'open my menu', 'set up my shop'], run: c => menu(c) },
  { id: 'help', hint: 'Every command, with what it does', aliases: ['help', 'commands', 'what can you do', 'what can you do?', '?', 'see how relay works'], next: [['menu', 'Menu']], async run(c) { return helpText(c.business, await listProducts(c.db, c.business.id)); } },
  // Shop
  { id: 'add', command: 'add', hint: 'Add a product: send its name and price, with a photo if you have one', menu: { section: 'Shop', title: 'Add product' }, aliases: ['add', 'add product', 'add a product', 'new product'],
    async run(c) {
      const form = flowId(c.cfg, 'add');
      if (form) return flowMessage('add', form, c.business.id, 'Tap below to add a product: name, price, category and stock in one form.', { categories: (await listCategories(c.db, c.business.id)).map(x => ({ id: x.id, title: x.name })) });
      await c.setAwaiting('add'); return `Send the product's name and price, e.g. *${example(c.business, await listProducts(c.db, c.business.id))}*. Add a photo with it as the caption if you have one. Add a number at the end if you count stock.`; } },
  { id: 'products', command: 'products', hint: 'See all your products and prices', menu: { section: 'Shop', title: 'My products' }, aliases: ['products', 'my products', 'product list', 'list products', 'stock', 'inventory', 'catalogue', 'catalog'], tool: { name: 'listProducts' }, next: [['add', 'Add product'], ['soldout', 'Mark sold out'], ['menu', 'Menu']], run: tool('listProducts') },
  { id: 'soldout', command: 'soldout', hint: 'Mark a product as sold out', menu: { section: 'Shop', title: 'Mark sold out' }, aliases: ['soldout', 'sold out', 'mark sold out', 'out of stock'], next: [['soldout', 'Mark another'], ['products', 'My products'], ['menu', 'Menu']], run: soldOut },
  // Orders
  { id: 'orders', command: 'orders', hint: "Today's orders", menu: { section: 'Orders', title: "Today's orders" }, aliases: ['orders', "today's orders", 'todays orders', 'orders today', 'recent orders', 'my orders'], tool: { name: 'listOrders', args: { filter: 'today' } }, next: [['pending', 'To deliver'], ['owing', 'Who owes me'], ['menu', 'Menu']], run: tool('listOrders', { filter: 'today' }) },
  { id: 'pending', hint: 'Paid orders still to deliver or hand over', menu: { section: 'Orders', title: 'Pending orders', description: 'Paid, still to deliver or hand over' }, aliases: ['pending', 'pending orders', 'to deliver', 'paid orders'], next: [['orders', "Today's orders"], ['owing', 'Who owes me'], ['menu', 'Menu']], run: pendingOrders },
  { id: 'receipt', command: 'receipt', hint: 'Send the PDF receipt of a paid order again', menu: { section: 'Orders', title: 'Resend a receipt' }, aliases: ['receipt', 'receipts', 'resend receipt'], next: [['orders', "Today's orders"], ['menu', 'Menu']], run: receipt },
  // Money
  { id: 'sales', command: 'sales', hint: 'Sales today, this week and this month', menu: { section: 'Money', title: 'Sales report' }, aliases: ['sales', 'sales today', 'sales report', 'report', 'today', 'how much did i make', 'how much did i make today', 'how much have i made', 'how much did i sell today', 'how much have i sold today', 'how much i make today'], tool: { name: 'salesToday' }, next: [['owing', 'Who owes me'], ['orders', "Today's orders"], ['menu', 'Menu']], run: salesReport },
  { id: 'wallet', command: 'wallet', hint: 'Your Relay wallet: balance, withdrawals and where payouts go', menu: { section: 'Money', title: 'Wallet' }, aliases: ['wallet', 'my wallet', 'balance', 'my balance'], run: walletView },
  { id: 'withdraw', command: 'withdraw', hint: 'Send money from your wallet to your bank account, no fee', aliases: ['withdraw', 'withdrawal', 'payout', 'cash out'], run: startWithdraw },
  { id: 'verify', hint: 'Verify your account once to withdraw', aliases: ['verify', 'verify me', 'verify account', 'kyc'], run: startVerify },
  { id: 'payouts', hint: 'Your last withdrawals', aliases: ['payouts', 'payout history', 'withdrawals'], next: [['wallet', 'My wallet'], ['menu', 'Menu']], run: payoutHistory },
  { id: 'owing', command: 'owing', hint: 'Orders still waiting for payment', menu: { section: 'Money', title: 'Who owes me' }, aliases: ['owing', 'who owes me', 'unpaid', 'unpaid orders', 'awaiting payment', 'debtors'], tool: { name: 'listOrders', args: { filter: 'unpaid' } }, next: [['sales', 'Sales report'], ['orders', "Today's orders"], ['menu', 'Menu']], run: tool('listOrders', { filter: 'unpaid' }) },
  // Customers
  { id: 'customers', command: 'customers', hint: 'Your top customers: who buys most and what they like', menu: { section: 'Customers', title: 'Top customers' }, aliases: ['customers', 'my customers', 'top customers', 'customer list'], tool: { name: 'listCustomers', args: { sort: 'top' } }, next: [['campaign', 'Send a campaign'], ['menu', 'Menu']], run: tool('listCustomers', { sort: 'top' }) },
  { id: 'status', command: 'status', hint: 'Make a WhatsApp Status for a product and see which customers to mention', menu: { section: 'Customers', title: 'Make a Status' }, aliases: ['status', 'make a status', 'make status', 'status post', 'post a status'], next: [['menu', 'Menu']], run: makeStatus },
  { id: 'campaign', command: 'campaign', hint: 'Send an update to customers who opted in; you see the cost first', menu: { section: 'Customers', title: 'Send a campaign' }, aliases: ['campaign', 'broadcast', 'send a campaign', 'send campaign'],
    async run(c) { await c.setAwaiting('campaign'); return 'Type the message to send to your customers who opted in to updates. You\'ll see how many people and the cost before anything is sent.'; } },
  // Settings
  { id: 'hours', command: 'hours', hint: 'See or change your opening hours', menu: { section: 'Settings', title: 'Opening hours' }, aliases: ['hours', 'opening hours', 'my hours'], next: [['delivery', 'Delivery'], ['menu', 'Menu']], run: hours },
  { id: 'delivery', command: 'delivery', hint: 'See or change your delivery areas and prices', menu: { section: 'Settings', title: 'Delivery' }, aliases: ['delivery', 'delivery prices', 'delivery zones', 'zones'], next: [['hours', 'Opening hours'], ['menu', 'Menu']], run: delivery },
  { id: 'messages', command: 'messages', hint: 'Choose the messages customers get from your shop', menu: { section: 'Settings', title: 'Messages' }, aliases: ['messages', 'my messages', 'customer messages'], async run() { return messagesMenu(); } },
  { id: 'close', command: 'close', hint: 'Pause your shop for a while: customers can look but not order', menu: { section: 'Settings', title: 'Pause my shop' }, aliases: ['close', 'close shop', 'close my shop', 'pause', 'pause shop', 'pause my shop'], run: pause,
    hidden: c => !!c.business.pausedUntil },
  { id: 'reopen', hint: 'Open your shop for orders again', menu: { section: 'Settings', title: 'Reopen my shop' }, aliases: ['reopen', 'open shop', 'reopen shop', 'unpause'], next: [['menu', 'Menu']], run: reopen, hidden: c => !c.business.pausedUntil },
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
  { id: 'ready', hint: 'Mark a paid order ready', next: [['pending', 'To deliver'], ['menu', 'Menu']], async run(c) { return runTool('updateFulfilment', { order: c.arg ?? '', status: 'ready' }, c); } },
  { id: 'photo', hint: 'Add a photo to a product', async run(c) {
    const p = c.arg ? ((await c.db.get(c.db.doc(C.products, c.arg))) as Product | null) : null;
    if (!p || p.businessId !== c.business.id || p.deletedAt) return 'That product is gone.';
    await c.setAwaiting(`photo:${p.id}`);
    return `Send the photo of *${p.name}*.`;
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
    await c.reply(await menu({ ...c, arg: null }, s ?? null));
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
export function helpText(business: Pick<Business, 'name' | 'category'>, products: { name: string; priceKobo: number }[] = []) {
  const lines = ACTIONS.filter(a => a.command).map(a => `/${a.command} · ${a.hint}`);
  // Then things to type with details (prices, stock, orders…), using this shop's own products.
  const typed = helpFor(business, products).split('\n').slice(1).filter(l => !/^• (messages|customers|call|connect|products · orders|test)/.test(l));
  return `Here's what I can do for ${business.name}. Tap *Menu*, or type a command:\n${lines.join('\n')}\n\nYou can also type (or say in a voice note):\n${typed.join('\n')}`;
}

// ── WhatsApp's own command list and ice breakers (npm run sync:commands) ──

export const ICE_BREAKERS = ['Set up my shop', 'See how Relay works', 'Talk to a person', 'Open my menu'];

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
