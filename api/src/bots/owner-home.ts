// The owner's home: one flat MENU (most jobs one tap away, nothing more than two), and the screens
// it opens: Orders (to deliver + today's), Money (what the shop keeps, with goods and delivery
// apart), Sold out / restock, Message customers, and the Settings / Help sub-lists.
// One money figure everywhere: "₦X to you" = goods + delivery, after Relay's fee when the shop pays it.
// WhatsApp's limits: ≤10 rows, row titles ≤24, descriptions ≤72, list and section titles ≤20/24.
import { C } from '../db';
import { formatKobo } from '../lib/money';
import { lagosDate } from '../lib/time';
import { hasStock, type Order } from '../domain/commerce';
import { listCategories, listProducts } from '../services/catalog';
import { recentOrders } from '../services/orders';
import { getKyc, getWallet } from '../services/wallet';
import { DAYS, type Hours } from '../services/hours';
import type { OutboundContent } from '../services/channel';
import { buttons, list, sectionList } from './common';
import type { ActionCtx } from './actions';

type Out = string | OutboundContent;
type Row = { id: string; title: string; description?: string };
const DAY = 86_400_000;
const isToDeliver = (o: Order) => o.status === 'paid' && !['delivered', 'picked_up'].includes(o.fulfilment);
const net = (o: Order) => o.payAmountKobo - (o.feeKobo ?? 0);       // what the shop keeps
const goods = (o: Order) => o.subtotalKobo - (o.discountKobo ?? 0);
const plural = (n: number, word: string, rest: string) => `${n} ${word}${n === 1 ? '' : 's'} ${rest}`;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const BACK: Row = { id: 'act:menu', title: '⬅ Back to menu' };

async function todayNumbers(c: ActionCtx) {
  const today = lagosDate();
  const orders = await recentOrders(c.db, [['businessId', '==', c.business.id]], 200);
  const paidToday = orders.filter(o => o.status === 'paid' && lagosDate(new Date(o.paidAt ?? o.createdAt)) === today);
  return {
    orders, paidToday,
    toDeliver: orders.filter(isToDeliver),
    today: orders.filter(o => lagosDate(new Date(o.createdAt)) === today),
    unpaid: orders.filter(o => o.status === 'awaiting_payment'),
    goodsKobo: paidToday.reduce((t, o) => t + goods(o), 0),
    deliveryKobo: paidToday.reduce((t, o) => t + o.deliveryFeeKobo, 0),
    netKobo: paidToday.reduce((t, o) => t + net(o), 0),
  };
}

export async function mainMenu(c: ActionCtx): Promise<Out> {
  const [n, wallet, products, customers] = await Promise.all([
    todayNumbers(c), getWallet(c.db, c.business.id), listProducts(c.db, c.business.id),
    c.db.query(C.customers, [['businessId', '==', c.business.id]], { limit: 5000 }),
  ]);
  const first = c.business.ownerName?.split(' ')[0];
  const notConnected = c.business.status === 'onboarding' ? "\n\nYour WhatsApp number isn't connected yet, so customers can't order. Send *CONNECT* to get the link." : '';
  const body = `Hi${first ? ` ${first}` : ''} 👋 *${c.business.name}* today: ${n.toDeliver.length} to deliver · ${formatKobo(n.netKobo)} to you · ${n.unpaid.length} unpaid${notConnected}`;
  const paused = c.business.pausedUntil;
  const buyers = customers.filter(x => Number(x.orderCount ?? 0) > 0).length;
  return sectionList(body, 'Open menu', [
    { title: 'Today', rows: [
      { id: 'act:orders', title: 'Orders', description: clip(`${n.toDeliver.length} to deliver · ${n.today.length} today`, 72) },
      { id: 'act:money', title: 'Money', description: clip(`${formatKobo(n.netKobo)} to you today · ${formatKobo(wallet.availableKobo)} to withdraw`, 72) },
    ] },
    { title: 'Shop', rows: [
      { id: 'act:add', title: 'Add product', description: 'Name and price, with a photo if you have one' },
      { id: 'act:soldout', title: 'Sold out / restock', description: 'Mark a product sold out or back in stock' },
      { id: 'act:products', title: 'My products', description: plural(products.filter(p => !p.deletedAt).length, 'product', 'and their prices') },
    ] },
    { title: 'Customers', rows: [
      { id: 'act:reachhub', title: 'Message customers', description: 'Status, broadcast or automatic updates' },
      { id: 'act:customers', title: 'My customers', description: plural(buyers, 'customer', '· who buys most') },
    ] },
    { title: 'More', rows: [
      paused ? { id: 'act:close', title: 'Reopen shop', description: paused === 'open' ? 'Paused until you reopen. Tap to reopen' : `Paused until ${whenLabel(new Date(paused))}. Tap to reopen` } : { id: 'act:close', title: 'Pause shop', description: 'Stop orders for a while' },
      { id: 'menu:Settings', title: 'Settings', description: 'Hours, delivery, messages, policies, tone, fee' },
      { id: 'menu:Help', title: 'Help', description: 'Try my shop, commands, talk to a person' },
    ] },
  ]);
}

export function subList(title: string, intro: string, rows: Row[]): Out {
  return list(intro, 'Choose', [...rows.slice(0, 9), BACK], title);
}

// Orders: to deliver first, then today's others; the shop's take today, the same as Money.
export async function ordersScreen(c: ActionCtx): Promise<Out> {
  const n = await todayNumbers(c);
  const line = (o: Order) => `• ${o.ref}: ${formatKobo(o.payAmountKobo)} · ${o.items.map(l => `${l.qty}× ${l.name}`).join(', ').slice(0, 50)}`;
  const others = n.today.filter(o => !isToDeliver(o));
  const parts = [
    n.toDeliver.length ? `🚚 *To deliver (${n.toDeliver.length})*\n${n.toDeliver.slice(0, 10).map(o => `${line(o)} · ${o.fulfilment.replace(/_/g, ' ')}`).join('\n')}` : '🚚 Nothing to deliver right now. 👍',
    others.length ? `📋 *Today's other orders (${others.length})*\n${others.slice(0, 10).map(o => `${line(o)} · ${o.status === 'awaiting_payment' ? 'waiting for payment' : o.status === 'paid' ? `paid, ${o.fulfilment.replace(/_/g, ' ')}` : o.status}`).join('\n')}` : '',
    `Paid today: ${n.paidToday.length} order${n.paidToday.length === 1 ? '' : 's'}, *${formatKobo(n.netKobo)} to you*.`,
  ].filter(Boolean).join('\n\n');
  const actions: [string, string][] = [...(n.toDeliver.length ? [['act:deliverpick', 'Mark delivered'] as [string, string]] : []), ['act:receipt', 'Resend receipt'], ['act:menu', 'Menu']];
  return buttons(parts.slice(0, 1024), actions);
}

// Which order went out (Orders → Mark delivered).
export async function deliverPick(c: ActionCtx): Promise<Out> {
  const n = await todayNumbers(c);
  if (!n.toDeliver.length) return buttons('Nothing to deliver right now. 👍', [['act:orders', 'Orders'], ['act:menu', 'Menu']]);
  return list('Which order was delivered or picked up?', 'Choose', [...n.toDeliver.slice(0, 9).map(o => ({ id: `act:delivered:${o.ref}`, title: o.ref, description: clip(`${formatKobo(o.payAmountKobo)} · ${o.items.map(l => l.name).join(', ')}`, 72) })), BACK], 'To deliver');
}

// Money: each period's "to you", with goods and delivery apart (only here), then the wallet.
export async function moneyScreen(c: ActionCtx): Promise<Out> {
  const today = lagosDate();
  const days = Array.from({ length: 31 }, (_, i) => lagosDate(new Date(Date.now() - i * DAY)));
  const week = days.slice(0, 7), month = days.filter(d => d.slice(0, 7) === today.slice(0, 7));
  const [n, stats, wallet, kyc] = await Promise.all([todayNumbers(c), c.db.getAll(days.map(d => c.db.doc(C.dailyStats, `${c.business.id}_${d}`))), getWallet(c.db, c.business.id), getKyc(c.db, c.business.id)]);
  const by = new Map(days.map((d, i) => [d, stats[i]]));
  const sum = (ds: string[], k: string) => ds.reduce((t, d) => t + Number(by.get(d)?.[k] ?? 0), 0);
  const ownerPays = c.business.feePayer === 'owner';
  const ownerFee = ownerPays ? n.paidToday.reduce((t, o) => t + (o.feeKobo ?? 0), 0) : 0;
  const breakdown = (g: number, d: number, fee: number) => `${formatKobo(g)} goods + ${formatKobo(d)} delivery${fee ? ` − ${formatKobo(fee)} Relay fee` : ''}`;
  const period = (label: string, ds: string[]) => {
    const g = sum(ds, 'salesKobo'), d = sum(ds, 'deliveryKobo'), fee = ownerPays ? sum(ds, 'relayFeeKobo') : 0;
    return `${label}: *${formatKobo(g + d - fee)}* to you (${breakdown(g, d, fee)})`;
  };
  const lines = [
    `💰 *Money* · ${c.business.name}`,
    `Today: *${formatKobo(n.netKobo)}* to you (${breakdown(n.goodsKobo, n.deliveryKobo, ownerFee)}), ${n.paidToday.length} paid order${n.paidToday.length === 1 ? '' : 's'}`,
    period('Last 7 days', week),
    period('This month', month),
    '',
    `Wallet: *${formatKobo(wallet.availableKobo)}* available.${n.unpaid.length ? ` ${n.unpaid.length} order${n.unpaid.length === 1 ? '' : 's'} waiting for payment.` : ''}`,
  ];
  const verified = kyc?.status === 'verified';
  return buttons(lines.join('\n').slice(0, 1024), [[verified ? 'act:withdraw' : 'act:verify', verified ? 'Withdraw' : 'Verify now'], ['act:owing', 'Who owes me'], ['act:menu', 'Menu']]);
}

export function reachHub(): Out {
  return subList('Message customers', 'How do you want to reach your customers?', [
    { id: 'act:status', title: 'Post a Status', description: 'A picture for your WhatsApp Status, and who to mention' },
    { id: 'act:campaign', title: 'Send a broadcast', description: 'One message to everyone or a group; you see the cost first' },
    { id: 'act:reach', title: 'Automatic updates', description: 'Back in stock, left in cart, price drops and more' },
  ]);
}

// ── Pause: reopens at the shop's own opening time ──
// When a pause of n days ends: that day's opening time, or the next open day's (8am without hours).
export function reopenAt(hours: Hours | null | undefined, days: number, now = new Date()): Date {
  for (let k = days; k < days + 8; k++) {
    const day = new Date(now.getTime() + k * DAY + 3_600_000); // Lagos calendar day
    const h = hours ? hours[DAYS[(day.getUTCDay() + 6) % 7]] : { open: '08:00', close: '20:00' };
    if (!h) continue;
    const [hh, mm] = h.open.split(':').map(Number);
    return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh - 1, mm));
  }
  return new Date(now.getTime() + days * DAY);
}
// "Sat 8am", "Mon 10:30am" (Lagos).
export function whenLabel(d: Date) {
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Africa/Lagos' });
  const [h, m] = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Lagos' }).split(':').map(Number);
  return `${day} ${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

export function pauseChoice(paused: string | null | undefined, hours?: Hours | null): Out {
  if (paused) return buttons(`Your shop is paused${paused === 'open' ? '' : ` until ${whenLabel(new Date(paused))}`}. Reopen now?`, [['act:reopen', 'Reopen now'], ['act:menu', 'Menu']]);
  return list("Pause your shop? Customers can still look, but can't order until you reopen.", 'Choose', [
    { id: 'act:close:1', title: 'Until tomorrow', description: `Reopens ${whenLabel(reopenAt(hours, 1))}` },
    { id: 'act:close:3', title: 'For 3 days', description: `Reopens ${whenLabel(reopenAt(hours, 3))}` },
    { id: 'act:close:open', title: 'Until I reopen', description: 'You reopen it yourself' },
    { id: 'act:close:cancel', title: 'Cancel', description: 'Keep the shop open' },
  ], 'Pause shop');
}

// ── Sold out / restock: a section first, then its products (9 at a time with "More…") ──
export async function soldOutPicker(c: ActionCtx): Promise<Out> {
  const [products, cats] = await Promise.all([listProducts(c.db, c.business.id), listCategories(c.db, c.business.id)]);
  const live = products.filter(p => p.available && !p.deletedAt);
  const out = live.filter(p => !hasStock(p));
  const rows: Row[] = cats.map(k => ({ k, n: live.filter(p => p.categoryId === k.id && hasStock(p)).length })).filter(x => x.n)
    .map(({ k, n }) => ({ id: `act:soldout:cat:${k.id}`, title: k.name, description: `${n} in stock` }));
  const loose = live.filter(p => hasStock(p) && (!p.categoryId || !cats.some(k => k.id === p.categoryId))).length;
  if (loose) rows.push({ id: 'act:soldout:cat:none', title: 'Other products', description: `${loose} in stock` });
  const intro = out.length
    ? 'Pick a section to mark something sold out, or *Sold out* to put something back in stock.'
    : 'Pick a section to mark something sold out.\n\nNothing is sold out right now. When something is, it shows under *Sold out* here so you can restock it.';
  return list(intro, 'Choose', [...rows.slice(0, 8), ...(out.length ? [{ id: 'act:soldout:out', title: `Sold out (${out.length})`, description: 'Put something back in stock' }] : []), BACK], 'Sold out / restock');
}

export async function soldOutSection(c: ActionCtx, catId: string, page: number): Promise<Out> {
  const [products, cats] = await Promise.all([listProducts(c.db, c.business.id), listCategories(c.db, c.business.id)]);
  const inStock = products.filter(p => p.available && !p.deletedAt && hasStock(p) && (catId === 'none' ? !p.categoryId || !cats.some(k => k.id === p.categoryId) : p.categoryId === catId));
  const name = catId === 'none' ? 'Other products' : cats.find(k => k.id === catId)?.name ?? 'That section';
  if (!inStock.length) return buttons(`Everything in ${name} is already sold out.`, [['act:soldout', 'Sold out / restock'], ['act:menu', 'Menu']]);
  return pageList(`Which *${name}* item is sold out?`, inStock.map(p => ({ id: `act:soldout:${p.id}`, title: p.name, description: `${formatKobo(p.priceKobo)}${p.stock !== null ? ` · ${p.stock} left` : ''}` })), page, `act:soldout:cat:${catId}`, name);
}

export async function restockList(c: ActionCtx, page: number): Promise<Out> {
  const out = (await listProducts(c.db, c.business.id)).filter(p => p.available && !p.deletedAt && !hasStock(p));
  if (!out.length) return buttons('Nothing is sold out right now. 👍', [['act:soldout', 'Sold out / restock'], ['act:menu', 'Menu']]);
  return pageList('Which one is back in stock?', out.map(p => ({ id: `act:restock:${p.id}`, title: p.name, description: formatKobo(p.priceKobo) })), page, 'act:soldout:out', 'Sold out');
}

// Nine rows, then "More…" for the next nine (or ⬅ Back to menu on the last page).
function pageList(intro: string, rows: Row[], page: number, base: string, title: string): Out {
  const slice = rows.slice(page * 9, page * 9 + 9);
  const more = rows.length > (page + 1) * 9;
  const range = rows.length > 9 ? ` (${page * 9 + 1}–${page * 9 + slice.length} of ${rows.length})` : '';
  return list(`${intro}${range}`, 'Choose', [...slice, more ? { id: `${base}:${page + 1}`, title: 'More…', description: `The next ${Math.min(9, rows.length - (page + 1) * 9)}` } : BACK], title);
}

// A message that waits for the owner to type something: always a way out.
export const waiting = (text: string): Out => buttons(text, [['act:cancel', 'Cancel'], ['act:menu', 'Menu']]);
