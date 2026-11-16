// "Today", "this week" and the 20:00 summary all mean Africa/Lagos time (WAT, UTC+1, no DST).
// The offset is read from Intl rather than hard-coded so this stays right if that ever changes.
export const LAGOS = 'Africa/Lagos';

const parts = (date: Date) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: LAGOS, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), s: Number(p.second) };
};

// Minutes Lagos is ahead of UTC at this instant.
export function lagosOffsetMinutes(date = new Date()) {
  const p = parts(date);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

// "YYYY-MM-DD" in Lagos.
export function lagosDate(date = new Date()) {
  const p = parts(date);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// UTC instants bounding the Lagos calendar day that contains `date`: [start, end).
export function lagosDayBounds(date = new Date()) {
  const [y, m, d] = lagosDate(date).split('-').map(Number);
  const offset = lagosOffsetMinutes(date) * 60_000;
  const start = new Date(Date.UTC(y, m - 1, d) - offset);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

// Monday-start week in Lagos.
export function lagosWeekBounds(date = new Date()) {
  const { start } = lagosDayBounds(date);
  const [y, m, d] = lagosDate(date).split('-').map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
  const weekStart = new Date(start.getTime() - weekday * 86_400_000);
  return { start: weekStart, end: new Date(weekStart.getTime() + 7 * 86_400_000) };
}

export const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);
