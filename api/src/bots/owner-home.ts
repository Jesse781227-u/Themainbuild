// The owner's home: one flat MENU (most jobs one tap away, nothing more than two), and the screens
// it opens: Orders (to deliver + today's), Money (sales with goods and delivery apart, and the
// wallet), Message customers, and the Settings / Help sub-lists. WhatsApp's limits: ≤10 rows,
// row titles ≤24, descriptions ≤72, list and section titles ≤20/24.
import { C } from '../db';
import { formatKobo } from '../lib/money';
import { lagosDate } from '../lib/time';
import type { Order } from '../domain/commerce';
import { listProducts } from '../services/catalog';
import { recentOrders } from '../services/orders';
import { getKyc, getWallet } from '../services/wallet';
import type { OutboundContent } from '../services/channel';
import { buttons, list, sectionList } from './common';
import type { ActionCtx } from './actions';

type Out = string | OutboundContent;
const DAY = 86_400_000;
const isToDeliver = (o: Order) => o.status === 'paid' && !['delivered', 'picked_up'].includes(o.fulfilment);
const net = (o: Order) => o.payAmountKobo - (o.feeKobo ?? 0);       // what the shop keeps
const goods = (o: Order) => o.subtotalKobo - (o.discountKobo ?? 0);
const plural = (n: number, word: string, rest: string) => `${n} ${word}${n === 1 ? '' : 's'} ${rest}`;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

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
  const body = `Hi${first ? ` ${first}` : ''} 👋 *${c.business.name}* today: ${n.toDeliver.length} to deliver · ${formatKobo(n.goodsKobo)} in sales · ${n.unpaid.length} unpaid${notConnected}`;
  const paused = c.business.pausedUntil;
  const pausedLabel = paused && paused !== 'open' ? new Date(paused).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' }) : null;
  const buyers = customers.filter(x => Number(x.orderCount ?? 0) > 0).length;
  return sectionList(body, 'Open menu', [
    { title: 'Today', rows: [
      { id: 'act:orders', title: 'Orders', description: clip(`${n.toDeliver.length} to deliver · ${n.today.length} today`, 72) },
      { id: 'act:money', title: 'Money', description: clip(`${formatKobo(n.goodsKobo)} today · ${formatKobo(wallet.availableKobo)} to withdraw`, 72) },
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
      paused ? { id: 'act:close', title: 'Reopen shop', description: pausedLabel ? `Paused until ${pausedLabel}. Tap to reopen` : 'Paused until you reopen. Tap to reopen' } : { id: 'act:close', title: 'Pause shop', description: 'Stop orders for a while' },
      { id: 'menu:Settings', title: 'Settings', description: 'Hours, delivery, messages, policies, tone, fee' },
      { id: 'menu:Help', title: 'Help', description: 'Try my shop, commands, talk to a person' },
    ] },
  ]);
}

const BACK = { id: 'act:menu', title: '⬅ Back to menu' };

export function subList(title: string, intro: string, rows: { id: string; title: string; description?: string }[]): Out {
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
    `Paid today: ${n.paidToday.length} order${n.paidToday.length === 1 ? '' : 's'}, ${formatKobo(n.netKobo)} to you.`,
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

// Money: sales with goods and delivery apart (they add up to what the shop keeps), then the wallet.
export async function moneyScreen(c: ActionCtx): Promise<Out> {
  const today = lagosDate();
  const days = Array.from({ length: 31 }, (_, i) => lagosDate(new Date(Date.now() - i * DAY)));
  const week = days.slice(0, 7), month = days.filter(d => d.slice(0, 7) === today.slice(0, 7));
  const [n, stats, wallet, kyc] = await Promise.all([todayNumbers(c), c.db.getAll(days.map(d => c.db.doc(C.dailyStats, `${c.business.id}_${d}`))), getWallet(c.db, c.business.id), getKyc(c.db, c.business.id)]);
  const by = new Map(days.map((d, i) => [d, stats[i]]));
  const sum = (ds: string[], k: string) => ds.reduce((t, d) => t + Number(by.get(d)?.[k] ?? 0), 0);
  const ownerFee = c.business.feePayer === 'owner' ? n.paidToday.reduce((t, o) => t + (o.feeKobo ?? 0), 0) : 0;
  const lines = [
    `💰 *Money* · ${c.business.name}`,
    `Today: ${formatKobo(n.goodsKobo)} goods + ${formatKobo(n.deliveryKobo)} delivery${ownerFee ? ` − ${formatKobo(ownerFee)} Relay fee` : ''} = *${formatKobo(n.netKobo)}* (${n.paidToday.length} paid order${n.paidToday.length === 1 ? '' : 's'})`,
    `Last 7 days: ${formatKobo(sum(week, 'salesKobo'))} goods + ${formatKobo(sum(week, 'deliveryKobo'))} delivery`,
    `This month: ${formatKobo(sum(month, 'salesKobo'))} goods + ${formatKobo(sum(month, 'deliveryKobo'))} delivery`,
    '',
    `Wallet: *${formatKobo(wallet.availableKobo)}* available.${n.unpaid.length ? ` ${n.unpaid.length} order${n.unpaid.length === 1 ? '' : 's'} waiting for payment.` : ''}`,
  ];
  const verified = kyc?.status === 'verified';
  return buttons(lines.join('\n').slice(0, 1024), [[verified ? 'act:withdraw' : 'act:verify', verified ? 'Withdraw' : 'Verify now'], ['act:owing', 'Who owes me'], ['act:menu', 'Menu']]);
}

export function reachHub(): Out {
  return subList('Message customers', 'How do you want to reach your customers?', [
    { id: 'act:status', title: 'Post a Status', description: 'A picture for your WhatsApp Status, and who to mention' },
    { id: 'act:campaign', title: 'Send a broadcast', description: 'One message to your customers; you see the cost first' },
    { id: 'act:reach', title: 'Automatic updates', description: 'Back in stock, left in cart, price drops and more' },
  ]);
}

// Pause: how long, or Cancel. Already paused: reopen.
export function pauseChoice(paused: string | null | undefined): Out {
  if (paused) {
    const when = paused === 'open' ? '' : ` until ${new Date(paused).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' })}`;
    return buttons(`Your shop is paused${when}. Reopen now?`, [['act:reopen', 'Reopen now'], ['act:menu', 'Menu']]);
  }
  return list("Pause your shop? Customers can still look, but can't order until you reopen.", 'Choose', [
    { id: 'act:close:1', title: 'Until tomorrow', description: 'Reopens tomorrow at 8am' },
    { id: 'act:close:3', title: 'For 3 days', description: 'Reopens in 3 days at 8am' },
    { id: 'act:close:open', title: 'Until I reopen', description: 'You reopen it yourself' },
    { id: 'act:cancel', title: 'Cancel', description: 'Keep the shop open' },
  ], 'Pause shop');
}

// A message that waits for the owner to type something: always a way out.
export const waiting = (text: string): Out => buttons(text, [['act:cancel', 'Cancel'], ['act:menu', 'Menu']]);
