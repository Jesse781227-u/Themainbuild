// Delivery areas and prices from a list the owner already has: pasted text (lines, a table with
// "│" or "|" borders, "Yaba - 3,000", "Lekki Phase 1: ₦4,000", "Ajah 6k"), a CSV or Excel file, or
// (through the AI) a PDF or photo. Names are tidied for customers (capitals, known Lagos spellings)
// and every fix is shown to the owner before anything is saved.
import { xlsxRows } from '../lib/xlsx';

export interface ZoneRow { name: string; feeKobo: number; was?: string | null }

// Lagos (and nearby) place names as they're usually written. Keys are lower case.
const SPELLING: Record<string, string> = {
  'ebutte metta': 'Ebute Metta', 'ebute-metta': 'Ebute Metta', 'ebutemetta': 'Ebute Metta',
  'illasamaja': 'Ilasamaja', 'illupeju': 'Ilupeju', 'ilupeju': 'Ilupeju', 'palm groove': 'Palm Grove',
  'obalende': 'Obalende', 'ikorodu': 'Ikorodu', 'iyana ipaja': 'Iyana Ipaja', 'iyana-ipaja': 'Iyana Ipaja',
  'sangotedo': 'Sangotedo', 'ajao estate': 'Ajao Estate', 'oworonshoki': 'Oworonshoki', 'oworoshoki': 'Oworonshoki',
  'ogudu': 'Ogudu', 'gbagada': 'Gbagada', 'surelere': 'Surulere', 'surulere': 'Surulere', 'festac town': 'Festac Town',
  'victoria iland': 'Victoria Island', 'victoria islad': 'Victoria Island', 'lekki phase one': 'Lekki Phase 1', 'lekki phase two': 'Lekki Phase 2',
};
// Short names written in capitals.
const CAPS = new Set(['vgc', 'gra', 'vi', 'fct', 'unilag', 'luth', 'lasu', 'lcc', 'cms', 'ui', 'oau', 'abu', 'uniben', 'unn', 'ph', 'lgea', 'nnpc']);
const SMALL = new Set(['of', 'and', 'by', 'the', 'on', 'in', 'at']);

export function tidyArea(raw: string): { name: string; was: string | null } {
  const clean = raw.replace(/\s+/g, ' ').replace(/^["'\s.,-]+|["'\s.,:-]+$/g, '').trim();
  const known = SPELLING[clean.toLowerCase()];
  const name = known ?? clean.split(' ').map((w, i) => {
    const l = w.toLowerCase();
    if (CAPS.has(l.replace(/[^a-z]/g, ''))) return w.toUpperCase();
    if (i > 0 && SMALL.has(l)) return l;
    if (/^\d/.test(w)) return w;
    return l.charAt(0).toUpperCase() + l.slice(1);
  }).join(' ');
  // Only a real change counts as a fix worth telling the owner (not "yaba" → "Yaba").
  return { name: name.slice(0, 60), was: known && known.toLowerCase() !== clean.toLowerCase() ? clean : CAPS_CHANGED(clean, name) ? clean : null };
}
const CAPS_CHANGED = (a: string, b: string) => a !== b && a.toLowerCase() === b.toLowerCase() && /[A-Z]{2,}/.test(b) && !/[A-Z]{2,}/.test(a);

const BORDER = /^[\s─━┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬+\-|│┃:=]*$/;
const PHONE = /(\+?234[\s-]?|\b0)[789][01]\d[\s-]?\d{3}[\s-]?\d{4}\b/;
const HEADER = /^(area|areas|location|locations|place|zone|zones|destination|delivery areas?)$/i;
const AMOUNT = /(?:₦|ngn|n)?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?\s*(?:naira)?$/i;

// "Name … amount" per line; null when fewer than 2 lines read.
export function parseZoneList(text: string): ZoneRow[] | null {
  const out = new Map<string, ZoneRow>();
  for (const raw of unsquash(text).split(/\r?\n/)) {
    if (BORDER.test(raw) || PHONE.test(raw)) continue;
    const line = raw.replace(/[│┃|\t]+/g, ' | ').replace(/\s+/g, ' ').trim().replace(/^\|\s*|\s*\|$/g, '');
    if (!line) continue;
    const free = /^(.+?)[\s|:=,;–—-]+free(\s+delivery)?$/i.exec(line);
    const m = free ? null : /^(.+?)[\s|:=,;–—-]+((?:₦|ngn|n)?\s*(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*k?\s*(?:naira)?)$/i.exec(line);
    const nameRaw = (free ?? m)?.[1]?.replace(/[|,;:=–—-]+$/, '').replace(/^"|"$/g, '').trim();
    if (!nameRaw || !/[a-z]{2,}/i.test(nameRaw) || HEADER.test(nameRaw) || /^(fee|price|cost|amount)/i.test(nameRaw)) continue;
    let feeKobo = 0;
    if (m) {
      const a = AMOUNT.exec(m[2].trim());
      if (!a) continue;
      const n = Number(a[1].replace(/,/g, '')) * (a[2] ? 1000 : 1);
      if (!Number.isFinite(n) || n < 0 || n > 500_000) continue;
      feeKobo = Math.round(n * 100);
    }
    const t = tidyArea(nameRaw);
    out.set(t.name.toLowerCase(), { name: t.name, feeKobo, was: t.was });
  }
  return out.size >= 2 ? [...out.values()] : null;
}

// A list pasted with its line breaks lost ("Abule Egba: ₦5,000 Ago Palace: ₦4,500 Ajah: ₦6,000"):
// a new line after every amount that is introduced by ":", "-", "=" or "₦" and followed by a name.
// ("Gbagada Phase 2: ₦1,000" keeps its 2: it isn't introduced that way.)
export function unsquash(text: string) {
  if (text.split(/\r?\n/).filter(l => l.trim()).length >= 3) return text;
  const AMT = /((?:[:=–—-]\s*(?:₦|NGN|N)?|₦)\s*\d+(?:,\d{3})*(?:\.\d+)?\s*k?|[:=–—-]\s*free)\s+(?=[A-Za-z])/gi;
  const lines = text.replace(AMT, '$1\n');
  return lines.split('\n').length >= 3 ? lines : text;
}

// A CSV file (quoted cells, "5,000" inside quotes) → "name | fee" lines.
export function csvToLines(text: string) {
  return text.split(/\r?\n/).map(line => {
    const cells: string[] = [];
    let cur = '', quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if ((ch === ',' || ch === ';') && !quoted) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map(c => c.trim()).filter(Boolean).join(' | ');
  }).join('\n');
}

export async function xlsxToLines(bytes: ArrayBuffer) {
  return (await xlsxRows(bytes)).map(r => r.filter(Boolean).join(' | ')).join('\n');
}

export const XLSX_MIME = /spreadsheetml\.sheet|application\/vnd\.ms-excel\.sheet\.macroenabled/i;
export const isSpreadsheet = (mime: string, filename = '') => XLSX_MIME.test(mime) || /\.xlsx$/i.test(filename);
export const isOldExcel = (mime: string, filename = '') => /application\/vnd\.ms-excel$/i.test(mime) || /\.xls$/i.test(filename);
