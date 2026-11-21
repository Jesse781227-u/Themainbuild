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

// Reads what the owner sent. null: nothing that looks like a delivery list (the caller carries on).
export async function startZoneImport(z: ZonesCtx, input: Input, text: string, notify: (o: Out) => Promise<unknown>): Promise<Out[] | null> {
  let rows: ZoneRow[] | null = null;
  const token = z.cfg.ADMIN_BOT_ACCESS_TOKEN;
  try {
    if (!input.document && !input.imageId) rows = parseZoneList(text);
    else if (input.document && isOldExcel(input.document.mimeType, input.document.filename)) return ['That looks like an old Excel file (.xls). Please save it as *.xlsx* or *CSV* and send it again, or paste the list.'];
    else if (token) {
      const id = input.document?.id ?? input.imageId!;
      const media = await fetchMedia(z.cfg, z.deps, token, id);
      const mime = input.document?.mimeType ?? media.mimeType;
      if (isSpreadsheet(mime, input.document?.filename)) rows = parseZoneList(await xlsxToLines(media.bytes));
      else if (/^text\//.test(mime)) { const t = new TextDecoder().decode(media.bytes).slice(0, 200_000); rows = parseZoneList(/csv/.test(mime) || /\.csv$/i.test(input.document?.filename ?? '') ? csvToLines(t) : t); }
      else {
        // A PDF with text inside: read like a pasted list (no AI); if the rules can't, the text goes
        // to the AI (Groq can read text); only a photo or a scanned PDF needs the file reader (Gemini).
        const pdf = /pdf/.test(mime) ? await pdfText(media.bytes) : null;
        if (pdf) rows = parseZoneList(pdf);
        if (!rows && z.deps.llm?.readCatalog) {
          await notify(input.document ? `📄 Reading ${input.document.filename}…` : '📷 Reading your delivery list…');
          const fromText = pdf ? await z.deps.llm.readCatalog({ text: pdf, purpose: 'delivery' }).catch(() => []) : [];
          const items = fromText.length ? fromText : await z.deps.llm.readCatalog({ file: { mimeType: mime, bytes: media.bytes }, purpose: 'delivery' });
          const map = new Map<string, ZoneRow>();
          for (const it of items) {
            if (!it.name || it.price === null || it.price < 0 || it.price > 500_000) continue;
            const t = tidyArea(it.name);
            map.set(t.name.toLowerCase(), { name: t.name, feeKobo: Math.round(it.price * 100), was: t.was });
          }
          rows = map.size ? [...map.values()] : null;
        } else if (!rows) return ["I can't read files or photos right now. Paste the list as a message instead, e.g. *Yaba 3000*, one area per line."];
      }
    }
  } catch (e) {
    log('warn', 'zones_read_failed', { businessId: z.business.id, error: String(e instanceof Error ? e.message : e).slice(0, 160) });
    return ["Sorry, I couldn't read that file. Try a CSV or Excel file, a clear photo, or paste the list."];
  }
  if (!rows) return input.document || input.imageId ? ["I couldn't find areas with prices in that. Each line needs an area and a price, e.g. *Yaba 3000*."] : null;
  rows = rows.slice(0, 200).sort((a, b) => a.name.localeCompare(b.name));
  await z.db.set(z.convRef, { zoneDraft: { zones: rows, at: new Date().toISOString() } satisfies Draft }, { merge: true });
  return review(z, rows);
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
  const now = await listZones(z.db, z.business.id);
  const batch = z.db.batch();
  // Replace: the old areas are switched off (kept for past orders). Add: same names are updated.
  for (const old of now) {
    const same = draft.zones.some(r => r.name.toLowerCase() === old.name.toLowerCase());
    if (choiceId === 'zimp:replace' || same) batch.set(z.db.doc(C.deliveryZones, old.id), { active: false }, { merge: true });
  }
  await batch.commit();
  for (const r of draft.zones) {
    // Uploaded areas are more specific than "anywhere in my area / city" (priority 3).
    await saveZone(z.db, { id: `${z.business.id}_z${randomId(6).replace(/[^A-Za-z0-9]/g, 'x')}`, businessId: z.business.id, name: r.name, match: r.name.toLowerCase(), feeKobo: r.feeKobo, timeframe: '', active: true, priority: 3 });
  }
  log('info', 'zones_imported', { businessId: z.business.id, count: draft.zones.length, mode: choiceId });
  return { out: [`✅ Saved ${draft.zones.length} delivery areas. Customers get the right price when they type their area. Send *DELIVERY* to see them.`], saved: draft.zones.length };
}
