// Opening hours, in Africa/Lagos time (UTC+1, no daylight saving).
//   "8am - 9pm", "8 to 21", "Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed", "closed on Sunday"
// Times are stored as "HH:MM" (24-hour). A day is null when the shop is closed all day.
// A close time earlier than the open time means the shop closes after midnight.

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = typeof DAYS[number];
export interface DayHours { open: string; close: string }
export type Hours = Record<Day, DayHours | null>;

const DAY_LABEL: Record<Day, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const DAY_FULL: Record<Day, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const DAY_WORD = /\b(mon(day)?s?|tue(s(day)?)?s?|wed(s|nesday)?s?|thu(r(s(day)?)?)?s?|fri(day)?s?|sat(urday)?s?|sun(day)?s?|weekdays?|weekends?|every ?day|daily)\b/gi;
const LAGOS_OFFSET_MS = 3600_000;

// Small spelling slips in day words: "weedays", "wekends", "saturdy", "wednsday", "wkdays".
// Only words of 5+ letters, one letter off (two for 8+ letters), so "money" never reads as Monday.
const DAY_SPELLINGS = ['weekdays', 'weekday', 'weekends', 'weekend', 'everyday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_ALIASES: Record<string, string> = { wkdays: 'weekdays', wkday: 'weekday', wkends: 'weekends', wkend: 'weekend', wknds: 'weekends', wknd: 'weekend' };
function editDistance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
export function fixDayTypos(text: string): string {
  return text.replace(/[a-z]{4,}/gi, w => {
    const low = w.toLowerCase();
    if (DAY_ALIASES[low]) return DAY_ALIASES[low];
    const plural = low.endsWith('s') && !/(days|ends)$/.test(low) ? 's' : '';
    const stem = plural ? low.slice(0, -1) : low;
    if (stem.length < 5 || DAY_SPELLINGS.includes(stem)) return w;
    for (const word of DAY_SPELLINGS) if (editDistance(stem, word) <= (word.length >= 8 ? 2 : 1)) return word.endsWith('s') ? word : word + plural;
    return w;
  });
}

function dayOf(word: string): Day | null {
  const w = word.toLowerCase();
  return DAYS.find(d => w.startsWith(d)) ?? null;
}

const pad = (n: number) => String(n).padStart(2, '0');

// One time: "8", "8am", "8:30 pm", "21:00", "2100", "noon", "midnight".
function parseTime(raw: string): { h: number; m: number; meridiem: 'am' | 'pm' | null } | null {
  const t = raw.trim().toLowerCase().replace(/\./g, '');
  if (/^(12\s*)?noon$/.test(t)) return { h: 12, m: 0, meridiem: 'pm' };
  if (/^(12\s*)?midnight$/.test(t)) return { h: 0, m: 0, meridiem: 'am' };
  const m = /^(\d{1,2})(?:[:h]?(\d{2}))?\s*(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const meridiem = m[3] ? (m[3].startsWith('a') ? 'am' : 'pm') : null;
  if (min > 59 || h > 24 || (meridiem && (h < 1 || h > 12))) return null;
  if (meridiem === 'pm' && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  if (h === 24) h = 0;
  return { h, m: min, meridiem };
}

// "8am - 9pm" → { open: "08:00", close: "21:00" }.
export function parseRange(text: string): DayHours | null {
  const t = text.toLowerCase().replace(/[–—]/g, '-').replace(/\b(from|open|opens|opening|we|are|i|am)\b/g, ' ').trim();
  const m = /(\d{1,2}(?:[:.h]?\d{2})?\s*(?:am|pm|a\.?m\.?|p\.?m\.?|a|p)?|noon|midnight)\s*(?:-|to|till|til|until|and close at|close at|–)\s*(\d{1,2}(?:[:.h]?\d{2})?\s*(?:am|pm|a\.?m\.?|p\.?m\.?|a|p)?|noon|midnight)/.exec(t);
  if (!m) return null;
  const a = parseTime(m[1]), b = parseTime(m[2]);
  if (!a || !b) return null;
  let close = b.h * 60 + b.m;
  const open = a.h * 60 + a.m;
  // "8 - 9" or "8 - 6": no shop opens for an hour or two; read the second time as pm.
  if (!b.meridiem && b.h < 12 && (close <= open || close - open < 3 * 60)) close += 12 * 60;
  if (close === open) return null;
  close %= 24 * 60;
  return { open: `${pad(Math.floor(open / 60))}:${pad(open % 60)}`, close: `${pad(Math.floor(close / 60))}:${pad(close % 60)}` };
}

const everyDay = (h: DayHours | null): Hours => Object.fromEntries(DAYS.map(d => [d, h ? { ...h } : null])) as Hours;

// The days a segment like "Mon-Fri", "weekends", "Sat & Sun" or "daily" covers.
function daysIn(segment: string): Day[] {
  const s = fixDayTypos(segment).toLowerCase().replace(/[–—]/g, '-');
  if (/\b(every ?day|daily)\b/.test(s)) return [...DAYS];
  const out = new Set<Day>();
  if (/\bweekdays?\b/.test(s)) ['mon', 'tue', 'wed', 'thu', 'fri'].forEach(d => out.add(d as Day));
  if (/\bweekends?\b/.test(s)) ['sat', 'sun'].forEach(d => out.add(d as Day));
  const range = /\b([a-z]{3,9})\s*(?:-|to|till|through|thru)\s*([a-z]{3,9})\b/.exec(s);
  const [from, to] = range ? [dayOf(range[1]), dayOf(range[2])] : [null, null];
  if (from && to) {
    let i = DAYS.indexOf(from);
    for (let n = 0; n < 7; n++) { out.add(DAYS[i]); if (DAYS[i] === to) break; i = (i + 1) % 7; }
  }
  for (const w of s.match(DAY_WORD) ?? []) { const d = dayOf(w); if (d) out.add(d); }
  return DAYS.filter(d => out.has(d));
}

// A whole week from text with day names. Days not mentioned take the first range given
// ("Mon-Sat 8-6, Sun closed" → all seven set). Returns null without any day names.
export function parseWeek(raw: string): Hours | null {
  const text = fixDayTypos(raw);
  if (!(text.match(DAY_WORD) ?? []).length) return null;
  const segments = text.split(/[,;\n]|\band\b(?=\s*(?:mon|tue|wed|thu|fri|sat|sun|week))/i).map(s => s.trim()).filter(Boolean);
  const hours: Partial<Hours> = {};
  let first: DayHours | null = null;
  for (const seg of segments) {
    const days = daysIn(seg);
    if (!days.length) continue;
    if (/\bclosed?\b|\boff\b/i.test(seg)) { days.forEach(d => { hours[d] = null; }); continue; }
    const range = parseRange(seg);
    if (!range) continue;
    first ??= range;
    days.forEach(d => { hours[d] = range; });
  }
  if (!first && !Object.keys(hours).length) return null;
  return Object.fromEntries(DAYS.map(d => [d, d in hours ? hours[d] ?? null : first])) as Hours;
}

// ── Reading hours by position ──
// "8AM to 7AM on weekdays and 10am to 7am on saturdays" → each time range goes with the day words
// nearest to it in the same part of the sentence (before or after). Commas and "and" split the
// sentence, except between day words ("saturdays and sundays 10am-3pm"). Days that aren't mentioned
// stay unknown (missing): they're asked about, never filled in. Doubtful ranges (closing earlier
// than opening, or open more than 16 hours) are asked about too.
export interface Doubt { days: Day[]; range: DayHours; alt: DayHours | null }
export interface WeekRead { week: Partial<Record<Day, DayHours | null>>; everyDay: boolean; doubts: Doubt[]; missing: Day[]; orphan: DayHours | null }

const TIME = String.raw`(?:\d{1,2}(?:[:.h]?\d{2})?\s*(?:am|pm|a\.m\.?|p\.m\.?|a|p)?|noon|midnight)`;
const RANGE_RE = new RegExp(String.raw`(${TIME})\s*(?:-|to|till|til|until|and close at|close at)\s*(${TIME})`, 'gi');
const DNAME = String.raw`(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?`;
const DAY_RE = new RegExp(String.raw`\b(?:(${DNAME})\s*(?:-|to|till|through|thru)\s*(${DNAME})|(week\s?days?)|(week\s?ends?)|(every\s?day|daily|all week|7 days)|(${DNAME}))\b`, 'gi');
const CLOSED_RE = /\b(closed?|off|shut)\b(?!\s*(?:at|by)\b)/gi;
const SEP_RE = /[,;\n]|\band\b|&|\.(?=\s|$)/gi;

const minsOf = (t: { h: number; m: number }) => t.h * 60 + t.m;
const hhmm = (mins: number) => `${pad(Math.floor((mins % 1440) / 60))}:${pad(mins % 60)}`;

// One range, and whether it needs asking about: { range, alt } where alt is the likely meaning.
function rangeOf(aRaw: string, bRaw: string): { range: DayHours; doubt: boolean; alt: DayHours | null } | null {
  const a = parseTime(aRaw), b = parseTime(bRaw);
  if (!a || !b) return null;
  const open = minsOf(a);
  let close = minsOf(b);
  // "8 - 9" or "8 - 6": no shop opens for an hour or two; read the second time as pm.
  if (!b.meridiem && b.h < 12 && (close <= open || close - open < 3 * 60)) close += 12 * 60;
  if (close % 1440 === open) return null;
  const span = (close - open + 1440) % 1440;
  const overnight = close % 1440 < open;
  const range = { open: hhmm(open), close: hhmm(close) };
  // "8am to 7am": almost certainly 7pm.
  const alt = overnight && b.meridiem === 'am' && b.h < 12 && b.h * 60 + b.m + 720 > open ? { open: range.open, close: hhmm(b.h * 60 + b.m + 720) } : null;
  return { range, doubt: overnight || span > 16 * 60, alt };
}

function daysOfMatch(m: RegExpExecArray): Day[] {
  if (m[1] && m[2]) {
    const from = dayOf(m[1]), to = dayOf(m[2]);
    if (!from || !to) return [];
    const out: Day[] = [];
    let i = DAYS.indexOf(from);
    for (let n = 0; n < 7; n++) { out.push(DAYS[i]); if (DAYS[i] === to) break; i = (i + 1) % 7; }
    return out;
  }
  if (m[3]) return ['mon', 'tue', 'wed', 'thu', 'fri'];
  if (m[4]) return ['sat', 'sun'];
  if (m[5]) return [...DAYS];
  const d = m[6] ? dayOf(m[6]) : null;
  return d ? [d] : [];
}

type Tok = { kind: 'D'; days: Day[]; every: boolean; start: number; end: number } | { kind: 'T'; r: NonNullable<ReturnType<typeof rangeOf>>; start: number; end: number } | { kind: 'X'; start: number; end: number } | { kind: 'S'; start: number; end: number };

export function readWeek(text: string): WeekRead | null {
  const t = fixDayTypos(text).toLowerCase().replace(/[–—]/g, '-');
  const toks: Tok[] = [];
  const inside = (i: number) => toks.some(k => i >= k.start && i < k.end);
  for (const m of t.matchAll(RANGE_RE)) { const r = rangeOf(m[1], m[2]); if (r) toks.push({ kind: 'T', r, start: m.index!, end: m.index! + m[0].length }); }
  for (const m of t.matchAll(DAY_RE)) { if (inside(m.index!)) continue; const days = daysOfMatch(m); if (days.length) toks.push({ kind: 'D', days, every: !!m[5], start: m.index!, end: m.index! + m[0].length }); }
  for (const m of t.matchAll(CLOSED_RE)) if (!inside(m.index!)) toks.push({ kind: 'X', start: m.index!, end: m.index! + m[0].length });
  for (const m of t.matchAll(SEP_RE)) if (!inside(m.index!)) toks.push({ kind: 'S', start: m.index!, end: m.index! + m[0].length });
  toks.sort((a, b) => a.start - b.start);
  const values = toks.filter(k => k.kind === 'T' || k.kind === 'X');
  if (!toks.some(k => k.kind === 'T')) return null;
  const dayToks = toks.filter((k): k is Extract<Tok, { kind: 'D' }> => k.kind === 'D');

  // No day words: one range for every day.
  if (!dayToks.length) {
    const first = toks.find((k): k is Extract<Tok, { kind: 'T' }> => k.kind === 'T')!;
    return { week: Object.fromEntries(DAYS.map(d => [d, { ...first.r.range }])), everyDay: true, doubts: first.r.doubt ? [{ days: [...DAYS], range: first.r.range, alt: first.r.alt }] : [], missing: [], orphan: null };
  }

  // Parts of the sentence: a separator splits, unless it sits between two day words.
  const clauses: Tok[][] = [[]];
  toks.forEach((k, i) => {
    if (k.kind !== 'S') { clauses[clauses.length - 1].push(k); return; }
    const prev = [...toks.slice(0, i)].reverse().find(x => x.kind !== 'S');
    const next = toks.slice(i + 1).find(x => x.kind !== 'S');
    if (!(prev?.kind === 'D' && next?.kind === 'D')) clauses.push([]);
  });

  const week: Partial<Record<Day, DayHours | null>> = {};
  const doubtful = new Map<string, Doubt>();
  let orphan: DayHours | null = null;
  for (const clause of clauses) {
    // Day words next to each other are one group ("saturdays and sundays").
    const groups: { days: Day[]; start: number; end: number }[] = [];
    let prevKind: string | null = null;
    for (const k of clause) {
      if (k.kind === 'D') {
        if (prevKind === 'D') { const g = groups[groups.length - 1]; g.days = [...new Set([...g.days, ...k.days])]; g.end = k.end; } else groups.push({ days: [...k.days], start: k.start, end: k.end });
      }
      prevKind = k.kind;
    }
    const vals = clause.filter(k => k.kind === 'T' || k.kind === 'X') as Exclude<Tok, { kind: 'D' | 'S' }>[];
    if (!groups.length) { const tv = vals.find(v => v.kind === 'T') as Extract<Tok, { kind: 'T' }> | undefined; if (tv && !tv.r.doubt) orphan ??= tv.r.range; continue; }
    for (const g of groups) {
      const v = [...vals].sort((x, y) => Math.min(Math.abs(x.start - g.end), Math.abs(g.start - x.end)) - Math.min(Math.abs(y.start - g.end), Math.abs(g.start - y.end)))[0];
      if (!v) continue; // a day with no time next to it: asked about later
      for (const d of g.days) week[d] = v.kind === 'X' ? null : { ...v.r.range };
      if (v.kind === 'T' && v.r.doubt) {
        const key = `${v.r.range.open}-${v.r.range.close}`;
        const dbt = doubtful.get(key) ?? { days: [], range: v.r.range, alt: v.r.alt };
        dbt.days = DAYS.filter(d => dbt.days.includes(d) || g.days.includes(d));
        doubtful.set(key, dbt);
      }
    }
  }
  if (!Object.keys(week).length) return values.length ? null : null;
  const doubts = [...doubtful.values()];
  for (const dbt of doubts) dbt.days = dbt.days.filter(d => week[d] && week[d]!.open === dbt.range.open && week[d]!.close === dbt.range.close);
  const missing = DAYS.filter(d => !(d in week));
  // Named days, yet every day the same: something was misread.
  const specific = dayToks.some(k => !k.every);
  if (specific && !missing.length && DAYS.every(d => JSON.stringify(week[d]) === JSON.stringify(week.mon))) return null;
  return { week, everyDay: false, doubts: doubts.filter(d => d.days.length), missing, orphan };
}

// "Mon–Fri", "Sat & Sun", "Sunday".
export function daysLabel(days: Day[]) {
  if (days.length === 1) return DAY_FULL[days[0]];
  if (days.length === 7) return 'Every day';
  const runs: Day[][] = [];
  for (const d of DAYS.filter(x => days.includes(x))) {
    const last = runs[runs.length - 1];
    if (last && DAYS.indexOf(d) === DAYS.indexOf(last[last.length - 1]) + 1) last.push(d); else runs.push([d]);
  }
  return runs.map(r => (r.length > 2 ? `${DAY_LABEL[r[0]]}–${DAY_LABEL[r[r.length - 1]]}` : r.map(d => DAY_LABEL[d]).join(' & '))).join(', ');
}

export { fmt as timeLabel };

// "8am-9pm" (every day), or a full week. Returns null if nothing could be read.
export function parseHours(text: string): { hours: Hours; perDay: boolean } | null {
  const week = parseWeek(text);
  if (week) return { hours: week, perDay: true };
  const range = parseRange(text);
  return range ? { hours: everyDay(range), perDay: false } : null;
}

// "Sunday" / "Sat and Sun" → those days set to closed.
export function closeDays(hours: Hours, text: string): Hours | null {
  const days = daysIn(text);
  if (!days.length) return null;
  return Object.fromEntries(DAYS.map(d => [d, days.includes(d) ? null : hours[d]])) as Hours;
}

export const sameEveryDay = everyDay;

function fmt(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  if (h === 0 && m === 0) return 'midnight';
  if (h === 12 && m === 0) return 'noon';
  const hr = h % 12 || 12;
  return `${hr}${m ? `:${pad(m)}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

export const rangeLabel = (h: DayHours) => `${fmt(h.open)}–${fmt(h.close)}`;

// "Mon–Fri 8am–6pm · Sat 10am–4pm · Sun closed" (runs of identical days are joined).
export function describeHours(hours: Hours) {
  const label = (d: Day) => (hours[d] ? rangeLabel(hours[d]!) : 'closed');
  if (DAYS.every(d => label(d) === label('mon'))) return hours.mon ? `Every day ${label('mon')}` : 'Closed every day';
  const parts: string[] = [];
  let i = 0;
  while (i < 7) {
    let j = i;
    while (j + 1 < 7 && label(DAYS[j + 1]) === label(DAYS[i])) j++;
    parts.push(`${DAY_LABEL[DAYS[i]]}${j > i ? `–${DAY_LABEL[DAYS[j]]}` : ''} ${label(DAYS[i])}`);
    i = j + 1;
  }
  return parts.join(' · ');
}

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Is the shop open at this moment (Lagos time)? When closed, when it opens next ("8am", "8am tomorrow", "10am Saturday").
export function openNow(hours: Hours | null | undefined, now = new Date()): { open: boolean; next?: string } {
  if (!hours) return { open: true };
  const local = new Date(now.getTime() + LAGOS_OFFSET_MS);
  const today = DAYS[(local.getUTCDay() + 6) % 7];
  const yesterday = DAYS[(local.getUTCDay() + 5) % 7];
  const t = local.getUTCHours() * 60 + local.getUTCMinutes();
  const h = hours[today];
  if (h) {
    const [o, c] = [minutes(h.open), minutes(h.close)];
    if (c > o ? t >= o && t < c : t >= o || t < c) return { open: true };
  }
  // Still open from last night (closes after midnight).
  const y = hours[yesterday];
  if (y && minutes(y.close) < minutes(y.open) && t < minutes(y.close)) return { open: true };
  // Next opening.
  if (h && t < minutes(h.open)) return { open: false, next: fmt(h.open) };
  for (let n = 1; n <= 7; n++) {
    const d = DAYS[(DAYS.indexOf(today) + n) % 7];
    const dh = hours[d];
    if (dh) return { open: false, next: `${fmt(dh.open)} ${n === 1 ? 'tomorrow' : DAY_FULL[d]}` };
  }
  return { open: false };
}

export function validHours(raw: unknown): Hours | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown) => v === null || (!!v && typeof v === 'object' && /^\d\d:\d\d$/.test(String((v as DayHours).open)) && /^\d\d:\d\d$/.test(String((v as DayHours).close)));
  return DAYS.every(d => ok(r[d] ?? null)) ? (Object.fromEntries(DAYS.map(d => [d, (r[d] as DayHours | null) ?? null])) as Hours) : null;
}
