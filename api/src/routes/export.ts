// GET /export/:token/orders.csv · customers.csv · relay-export.xlsx — a shop's orders and customers.
// The token is long, random and only sent to the owner, so the link is the permission; a new link
// replaces the token and the old ones stop working. Google Sheets reads the CSVs with =IMPORTDATA().
import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env } from '../env';
import { csv, xlsxFile } from '../lib/xlsx-write';
import { EXPORT_FILES, businessForToken, exportTables, type ExportFile } from '../services/export';

export function exportRoutes() {
  const r = new Hono<{ Bindings: Env }>();
  r.get('/:token/:file', async c => {
    const file = c.req.param('file') as ExportFile;
    if (!EXPORT_FILES.includes(file)) return c.body(null, 404);
    const db = getDb(c.env);
    const businessId = await businessForToken(db, c.req.param('token'));
    if (!businessId) return c.body(null, 404);
    const t = await exportTables(db, businessId);
    const headers = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' };
    if (file === 'relay-export.xlsx') {
      const bytes = xlsxFile([t.orders, t.customers]);
      return c.body(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 200, { ...headers, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename="relay-export.xlsx"' });
    }
    return c.body(csv((file === 'orders.csv' ? t.orders : t.customers).rows), 200, { ...headers, 'content-type': 'text/csv; charset=utf-8' });
  });
  return r;
}
