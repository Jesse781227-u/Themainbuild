// Export a shop's orders and customers: an Excel file the owner opens from WhatsApp, and CSV links
// that Google Sheets keeps up to date with =IMPORTDATA(). Every link carries the shop's export token
// (long and random): the link is the permission, so it's only ever sent to the owner, and "New
// private link" replaces the token, which retires every old link at once.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';
import { randomId } from '../lib/crypto';
import { lagosDate } from '../lib/time';
import type { Cell, Sheet } from '../lib/xlsx-write';
import type { Customer, Order } from '../domain/commerce';
import { recentOrders } from './orders';

export const EXPORT_FILES = ['orders.csv', 'customers.csv', 'relay-export.xlsx'] as const;
export type ExportFile = typeof EXPORT_FILES[number];
const MAX_ROWS = 5000;
export const TOKEN_RE = /^[A-Za-z0-9]{24,48}$/;

export async function exportToken(db: Firestore, businessId: string, fresh = false): Promise<string> {
  const ref = db.doc(C.businesses, businessId);
  const current = ((await db.get(ref)) as { exportToken?: string | null } | null)?.exportToken;
  if (current && !fresh) return current;
  const token = randomId(24).replace(/[^A-Za-z0-9]/g, 'x');
  await db.update(ref, { exportToken: token, exportTokenAt: new Date().toISOString() });
  return token;
}

export async function businessForToken(db: Firestore, token: string): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [b] = (await db.query(C.businesses, [['exportToken', '==', token]], { limit: 1 })) as unknown as { id: string }[];
  return b?.id ?? null;
}

const naira = (kobo: number) => Math.round(kobo) / 100;
const lagos = (iso: string | null | undefined, part: 'date' | 'time') => {
  if (!iso) return '';
  const d = new Date(iso);
  return part === 'date' ? lagosDate(d) : new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' }).format(d);
};
// +234 803 000 0001: spaced so spreadsheets keep it as text (no lost "+", no 2.3E+12).
const phone = (p: string | undefined) => {
  const d = (p ?? '').replace(/\D/g, '');
  return d.length === 13 && d.startsWith('234') ? `+234 ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}` : p ?? '';
};
const STATUS: Record<string, string> = { awaiting_payment: 'Waiting for payment', paid: 'Paid', expired: 'Expired', cancelled: 'Cancelled' };
const FULFIL: Record<string, string> = { pending: 'Not sent yet', ready: 'Ready', out_for_delivery: 'Out for delivery', delivered: 'Delivered', picked_up: 'Picked up' };

export async function exportTables(db: Firestore, businessId: string): Promise<{ orders: Sheet; customers: Sheet }> {
  const [orders, customers] = await Promise.all([
    recentOrders(db, [['businessId', '==', businessId]], MAX_ROWS),
    db.query(C.customers, [['businessId', '==', businessId]], { limit: MAX_ROWS }) as unknown as Promise<Customer[]>,
  ]);
  const byId = new Map(customers.map(c => [c.id, c]));
  const orderRows: Cell[][] = [['Order', 'Date', 'Time', 'Customer', 'Phone', 'Items', 'Goods (₦)', 'Delivery (₦)', 'Customer paid (₦)', 'To you (₦)', 'Payment', 'Delivery status', 'Address']];
  for (const o of orders as Order[]) {
    const c = byId.get(o.customerId);
    const paid = o.status === 'paid';
    orderRows.push([
      o.ref, lagos(o.createdAt, 'date'), lagos(o.createdAt, 'time'), c?.name ?? '', phone(c?.phone),
      o.items.map(i => `${i.qty} × ${i.name}`).join('; '),
      naira(o.subtotalKobo - (o.discountKobo ?? 0)), naira(o.deliveryFeeKobo), paid ? naira(o.payAmountKobo) : '', paid ? naira(o.payAmountKobo - (o.feeKobo ?? 0)) : '',
      STATUS[o.status] ?? o.status, paid ? FULFIL[o.fulfilment] ?? o.fulfilment : '', o.delivery?.method === 'pickup' ? 'Pickup' : o.delivery?.address ?? '',
    ]);
  }
  const customerRows: Cell[][] = [['Name', 'Phone', 'Paid orders', 'Total spent (₦)', 'Last order', 'Gets updates', 'Customer since']];
  for (const c of [...customers].sort((a, b) => (b.totalSpentKobo ?? 0) - (a.totalSpentKobo ?? 0))) {
    customerRows.push([c.name ?? '', phone(c.phone), c.orderCount ?? 0, naira(c.totalSpentKobo ?? 0), lagos(c.lastOrderAt, 'date'), c.marketingOptIn ? 'Yes' : 'No', lagos(c.createdAt, 'date')]);
  }
  return {
    orders: { name: 'Orders', rows: orderRows, widths: [13, 11, 7, 20, 18, 40, 11, 12, 16, 11, 20, 16, 30] },
    customers: { name: 'Customers', rows: customerRows, widths: [22, 18, 11, 15, 12, 13, 15] },
  };
}

export const exportFilename = (shopName: string, now = new Date()) =>
  `${shopName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'shop'}-orders-${lagosDate(now)}.xlsx`;
