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
const DAY_WORD = /\b(mon(day)?|tue(s(day)?)?|wed(s|nesday)?|thu(r(s(day)?)?)?|fri(day)?|sat(urday)?|sun(day)?|weekdays?|weekends?|every ?day|daily)\b/gi;
const LAGOS_OFFSET_MS = 3600_000;

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
  const s = segment.toLowerCase().replace(/[–—]/g, '-');
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
export function parseWeek(text: string): Hours | null {
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
