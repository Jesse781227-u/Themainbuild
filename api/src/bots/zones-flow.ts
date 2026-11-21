// "Send me your delivery list": the owner pastes it or sends a spreadsheet, document or photo;
// Relay reads every area and price, shows the full list with the spelling fixes, and saves only
// after [Save all] / [Replace my areas]. Used from DELIVERY and from signup's delivery step.
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore, DocRef } from '../lib/firestore';
import { formatKobo } from '../lib/money';
import { randomId } from '../lib/crypto';
import { log } from '../lib/logger';
import type { Business } from '../domain/business';
import { listZones, saveZone } from '../services/delivery';
import { csvToLines, isOldExcel, isSpreadsheet, parseZoneList, tidyArea, xlsxToLines, type ZoneRow } from '../services/zones-import';
import { buttons, fetchMedia, type BotDeps, type Input } from './common';
import { pdfText } from '../services/pdf-text';
import type { OutboundContent } from '../services/channel';

export interface ZonesCtx { db: Firestore; cfg: Config; deps: BotDeps; business: Business; convRef: DocRef }
type Out = string | OutboundContent;
interface Draft { zones: ZoneRow[]; at: string }

export const ZONES_ASK = 'Send your delivery areas and prices: paste the list (one area per line, e.g. *Yaba 3000*), or send a spreadsheet (Excel or CSV), a PDF or a photo of it.';

// When a file can't be read even after the retry: a way forward that always works.
export const PASTE_INSTEAD = "I couldn't read that one. Could you paste the list as text instead? e.g. *Yaba 3000*";

// Reads what the owner sent: the rows, a message to send instead (old Excel, unreadable), or null
// (nothing that looks like a delivery list; the caller carries on). A failed file read is tried once
// more on the server before the owner hears about it, and each failure is logged with its stage.
export async function readZoneList(z: ZonesCtx, input: Input, text: string, notify: (o: Out) => Promise<unknown>): Promise<ZoneRow[] | { say: Out } | null> {
  if (!input.document && !input.imageId) { const rows = parseZoneList(text); return rows ? tidyRows(rows) : null; }
  if (input.document && isOldExcel(input.document.mimeType, input.document.filename)) return { say: 'That looks like an old Excel file (.xls). Please save it as *.xlsx* or *CSV* and send it again, or paste the list.' };
  const token = z.cfg.ADMIN_BOT_ACCESS_TOKEN;
  if (!token) return { say: PASTE_INSTEAD };
  let told = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let stage = 'download';
    try {
      const media = await fetchMedia(z.cfg, z.deps, token, input.document?.id ?? input.imageId!);
      const mime = input.document?.mimeType ?? media.mimeType;
      stage = 'read';
      let rows: ZoneRow[] | null = null;
      if (isSpreadsheet(mime, input.document?.filename)) rows = parseZoneList(await xlsxToLines(media.bytes));
      else if (/^text\//.test(mime)) { const t = new TextDecoder().decode(media.bytes).slice(0, 200_000); rows = parseZoneList(/csv/.test(mime) || /\.csv$/i.test(input.document?.filename ?? '') ? csvToLines(t) : t); }
      else {
        // A PDF with text inside: read like a pasted list (no AI); if the rules can't, the text goes
        // to the AI (Groq can read text); only a photo or a scanned PDF needs the file reader (Gemini).
        const pdf = /pdf/.test(mime) ? await pdfText(media.bytes) : null;
        if (pdf) rows = parseZoneList(pdf);
        if (!rows && z.deps.llm?.readCatalog) {
          if (!told) { told = true; await notify('Reading it now…'); }
          stage = pdf ? 'ai_text' : 'ai_file';
          const fromText = pdf ? await z.deps.llm.readCatalog({ text: pdf, purpose: 'delivery' }).catch(() => []) : [];
          stage = 'ai_file';
          const items = fromText.length ? fromText : await z.deps.llm.readCatalog({ file: { mimeType: mime, bytes: media.bytes }, purpose: 'delivery' });
          const map = new Map<string, ZoneRow>();
          for (const it of items) {
            if (!it.name || it.price === null || it.price < 0 || it.price > 500_000) continue;
            const t = tidyArea(it.name);
            map.set(t.name.toLowerCase(), { name: t.name, feeKobo: Math.round(it.price * 100), was: t.was });
          }
          rows = map.size ? [...map.values()] : null;
        } else if (!rows) return { say: PASTE_INSTEAD };
      }
      if (rows) return tidyRows(rows);
      return { say: "I couldn't find areas with prices in that. Each line needs an area and a price, e.g. *Yaba 3000*." };
    } catch (e) {
      log('warn', 'zones_read_failed', { businessId: z.business.id, attempt, stage, mime: input.document?.mimeType ?? 'image', error: String(e instanceof Error ? e.message : e).slice(0, 160) });
      if (attempt === 1) await new Promise(r => setTimeout(r, 1500));
    }
  }
  return { say: PASTE_INSTEAD };
}
const tidyRows = (rows: ZoneRow[]) => rows.slice(0, 200).sort((a, b) => a.name.localeCompare(b.name));

// DELIVERY (any time): read, then the full list to check with [Save all] / [Replace my areas].
export async function startZoneImport(z: ZonesCtx, input: Input, text: string, notify: (o: Out) => Promise<unknown>): Promise<Out[] | null> {
  const got = await readZoneList(z, input, text, notify);
  if (!got) return null;
  if ('say' in got) return [got.say];
  await z.db.set(z.convRef, { zoneDraft: { zones: got, at: new Date().toISOString() } satisfies Draft }, { merge: true });
  return review(z, got);
}

// Signup: saved straight away, and one line back ("Saved 66 areas, ₦1,000–₦7,000. I fixed 4 spellings
// (like Ebutte Metta → Ebute Metta)."). DELIVERY shows the full list.
export async function importZonesNow(z: ZonesCtx, input: Input, text: string, notify: (o: Out) => Promise<unknown>): Promise<{ saved: ZoneRow[]; line: string } | { say: Out } | null> {
  const got = await readZoneList(z, input, text, notify);
  if (!got || 'say' in got) return got;
  await saveRows(z, got, 'add');
  const fees = got.map(r => r.feeKobo);
  const [lo, hi] = [Math.min(...fees), Math.max(...fees)];
  const money = (k: number) => (k ? formatKobo(k) : 'free');
  const fixes = got.filter(r => r.was);
  const line = `Saved ${got.length} areas, ${lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`}.${fixes.length ? ` I fixed ${fixes.length} spelling${fixes.length === 1 ? '' : 's'} (like ${fixes[0].was} → ${fixes[0].name}).` : ''} Send *DELIVERY* anytime to check or edit them.`;
  return { saved: got, line };
}

async function review(z: ZonesCtx, rows: ZoneRow[]): Promise<Out[]> {
  const fees = rows.map(r => r.feeKobo);
  const range = Math.min(...fees) === Math.max(...fees) ? formatKobo(fees[0]) : `${formatKobo(Math.min(...fees))} to ${formatKobo(Math.max(...fees))}`;
  const fixes = rows.filter(r => r.was);
  const list = rows.map(r => `• ${r.name}: ${r.feeKobo ? formatKobo(r.feeKobo) : 'free'}`).join('\n');
  const existing = (await listZones(z.db, z.business.id)).length;
  const out: Out[] = [`📍 *${rows.length} delivery areas*, ${range}:\n${list}`.slice(0, 4000)];
  if (fixes.length) out.push(`✏️ I tidied ${fixes.length} name${fixes.length === 1 ? '' : 's'} customers will see:\n${fixes.map(r => `• ${r.was} → ${r.name}`).join('\n')}`.slice(0, 1500));
  out.push(buttons(existing ? `You have ${existing} delivery price${existing === 1 ? '' : 's'} already. Replace them with this list, or add these to them?` : 'Save these delivery prices?',
    existing ? [['zimp:replace', 'Replace my areas'], ['zimp:add', 'Add to them'], ['zimp:cancel', 'Cancel']] : [['zimp:add', 'Save all'], ['zimp:cancel', 'Cancel']]));
  return out;
}

// [Save all] / [Replace my areas] / [Add to them] / [Cancel]. null: not one of these taps.
export async function answerZoneImport(z: ZonesCtx, choiceId: string | null): Promise<{ out: Out[]; saved: number } | null> {
  if (!choiceId?.startsWith('zimp:')) return null;
  const draft = ((await z.db.get(z.convRef))?.zoneDraft ?? null) as Draft | null;
  await z.db.set(z.convRef, { zoneDraft: null }, { merge: true });
  if (choiceId === 'zimp:cancel') return { out: ['OK, nothing was saved.'], saved: 0 };
  if (!draft?.zones?.length) return { out: ['That list has expired. Please send it again.'], saved: 0 };
  await saveRows(z, draft.zones, choiceId === 'zimp:replace' ? 'replace' : 'add');
  log('info', 'zones_imported', { businessId: z.business.id, count: draft.zones.length, mode: choiceId });
  return { out: [`✅ Saved ${draft.zones.length} delivery areas. Customers get the right price when they type their area. Send *DELIVERY* to see them.`], saved: draft.zones.length };
}

// Replace: the old areas are switched off (kept for past orders). Add: same names are updated.
async function saveRows(z: ZonesCtx, rows: ZoneRow[], mode: 'add' | 'replace') {
  const now = await listZones(z.db, z.business.id);
  const batch = z.db.batch();
  for (const old of now) {
    const same = rows.some(r => r.name.toLowerCase() === old.name.toLowerCase());
    if (mode === 'replace' || same) batch.set(z.db.doc(C.deliveryZones, old.id), { active: false }, { merge: true });
  }
  await batch.commit();
  for (const r of rows) {
    // Uploaded areas are more specific than "anywhere in my area / city" (priority 3).
    await saveZone(z.db, { id: `${z.business.id}_z${randomId(6).replace(/[^A-Za-z0-9]/g, 'x')}`, businessId: z.business.id, name: r.name, match: r.name.toLowerCase(), feeKobo: r.feeKobo, timeframe: '', active: true, priority: 3 });
  }
}
