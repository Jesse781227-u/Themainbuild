// A PDF receipt for every paid order, sent to the customer with the shop's thank-you and to the
// owner with their "Paid" alert. Built on request at /receipts/<token> (the token is unguessable and
// stored on the order), so nothing is kept in storage and a receipt always matches the order.
// The PDF's built-in fonts can't draw "₦", so amounts read "NGN 12,500".
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from 'pdf-lib';
import type { Business } from '../domain/business';
import type { Customer, Order } from '../domain/commerce';
import { prettyPhone } from '../bots/customers';

const INK = rgb(0.07, 0.11, 0.13);
const MUTED = rgb(0.4, 0.47, 0.51);
const LINE = rgb(0.88, 0.9, 0.92);
const BRAND = rgb(0.0, 0.66, 0.52);

export const receiptPath = (token: string) => `/receipts/${token}`;
export const receiptFilename = (order: Pick<Order, 'ref'>) => `Receipt-${order.ref}.pdf`;

// The standard PDF fonts only know Western characters: keep what they can draw.
export function pdfSafe(s: string) {
  return s.replace(/₦\s?/g, 'NGN ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E\xA0-\xFF•€]/g, '').replace(/\s{2,}/g, ' ').trim();
}

export const ngn = (kobo: number) => `NGN ${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: kobo % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

const lagos = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' });

function fit(text: string, font: PDFFont, size: number, max: number) {
  let t = pdfSafe(text);
  if (font.widthOfTextAtSize(t, size) <= max) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`.replace('…', '...'), size) > max) t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
}

export async function receiptPdf(input: {
  order: Order; business: Pick<Business, 'name' | 'area' | 'city'>; customer: Pick<Customer, 'name' | 'phone'> | null;
  logo?: { bytes: Uint8Array; mimeType: string } | null; test?: boolean;
}): Promise<Uint8Array> {
  const { order, business, customer } = input;
  const doc = await PDFDocument.create();
  doc.setTitle(`Receipt ${order.ref}`);
  doc.setAuthor(pdfSafe(business.name));
  doc.setProducer('Relay');
  const page = doc.addPage([420, 595]); // A5 portrait
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = page.getWidth(), M = 32, R = W - M;
  let y = page.getHeight() - M;

  const text = (s: string, x: number, size = 10, o: { font?: PDFFont; color?: ReturnType<typeof rgb>; right?: boolean; max?: number } = {}) => {
    const font = o.font ?? regular;
    const t = o.max ? fit(s, font, size, o.max) : pdfSafe(s);
    page.drawText(t, { x: o.right ? x - font.widthOfTextAtSize(t, size) : x, y, size, font, color: o.color ?? INK });
  };
  const rule = (yy = y) => page.drawLine({ start: { x: M, y: yy }, end: { x: R, y: yy }, thickness: 0.7, color: LINE });

  // Header: logo (if any), shop name and place; RECEIPT on the right.
  let logo: PDFImage | null = null;
  if (input.logo) {
    try { logo = /png/.test(input.logo.mimeType) ? await doc.embedPng(input.logo.bytes) : /jpe?g/.test(input.logo.mimeType) ? await doc.embedJpg(input.logo.bytes) : null; } catch { logo = null; }
  }
  const logoSize = 44;
  if (logo) page.drawImage(logo, { x: M, y: y - logoSize, width: logoSize, height: logoSize });
  const nameX = logo ? M + logoSize + 12 : M;
  y -= 18;
  text(business.name, nameX, 16, { font: bold, max: R - nameX - 90 });
  text('RECEIPT', R, 12, { font: bold, color: BRAND, right: true });
  y -= 16;
  const place = [business.area, business.city].filter(Boolean).join(', ');
  if (place) text(place, nameX, 9, { color: MUTED });
  text(order.ref, R, 10, { right: true });
  y = Math.min(y, page.getHeight() - M - logoSize) - 22;
  rule(); y -= 18;

  // Who and when.
  const row = (label: string, value: string) => { text(label, M, 9, { color: MUTED }); text(value, M + 90, 10, { max: R - M - 90 }); y -= 15; };
  row('Date paid', lagos(order.paidAt ?? order.updatedAt));
  if (customer?.name) row('Customer', customer.name);
  if (customer?.phone && customer.phone.startsWith('+')) row('Phone', prettyPhone(customer.phone));
  row(order.delivery?.address ? 'Deliver to' : 'Collection', order.delivery?.address ?? 'Pickup');
  y -= 6; rule(); y -= 16;

  // Items.
  const qtyX = R - 150, priceX = R - 75;
  text('Item', M, 9, { font: bold, color: MUTED }); text('Qty', qtyX, 9, { font: bold, color: MUTED, right: true });
  text('Price', priceX, 9, { font: bold, color: MUTED, right: true }); text('Amount', R, 9, { font: bold, color: MUTED, right: true });
  y -= 16;
  for (const l of order.items) {
    if (y < 150) { text(`+ ${order.items.length - order.items.indexOf(l)} more item(s)`, M, 9, { color: MUTED }); y -= 15; break; }
    text(l.name, M, 10, { max: qtyX - M - 30 });
    text(String(l.qty), qtyX, 10, { right: true });
    text(ngn(l.priceKobo), priceX, 10, { right: true });
    text(ngn(l.priceKobo * l.qty), R, 10, { right: true });
    y -= 16;
  }
  y -= 4; rule(); y -= 16;

  // Totals.
  const total = (label: string, kobo: number) => { text(label, priceX, 10, { color: MUTED, right: true }); text(ngn(kobo), R, 10, { right: true }); y -= 15; };
  total('Subtotal', order.subtotalKobo);
  if (order.deliveryFeeKobo) total('Delivery', order.deliveryFeeKobo);
  if (order.feeKobo) total('Service fee', order.feeKobo);
  y -= 10;
  page.drawRectangle({ x: R - 190, y: y - 8, width: 190, height: 26, color: rgb(0.93, 0.98, 0.96) });
  y += 1;
  text('Total paid', R - 180, 11, { font: bold });
  text(ngn(order.payAmountKobo), R - 8, 12, { font: bold, right: true });
  y -= 34;

  page.drawRectangle({ x: M, y: y - 4, width: 46, height: 16, color: BRAND });
  page.drawText('PAID', { x: M + 10, y: y, size: 9, font: bold, color: rgb(1, 1, 1) });
  if (input.test) text('Test payment: no real money moved.', M + 56, 9, { color: MUTED });

  // Footer.
  y = M + 28;
  rule(y + 14);
  text(`Thank you for shopping with ${business.name}!`, M, 10, { max: R - M });
  y -= 14;
  text('Receipt issued by Relay on behalf of the shop.', M, 8, { color: MUTED });
  return doc.save();
}
