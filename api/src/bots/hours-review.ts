// Checking opening hours with the owner before saving, for signup and the HOURS command:
//   1. a doubtful range: "Mon–Fri 8am to 7pm, or open overnight until 7am?" [8am–7pm] [Overnight]
//   2. days not mentioned: "And Sunday?" [Closed] [Same as Mon–Fri] [Different hours]
//   3. "Mon–Fri 8am–7pm · Sat 10am–7pm · Sun closed. Correct?" [Yes] [Change]
// Nothing is saved until 3 is answered Yes. Text the rules can't read goes to the AI for per-day
// times, which are checked (validHours) and shown the same way: never saved unconfirmed.
// Choice ids: hrv:alt, hrv:night, hrv:change, hrv:closed, hrv:same, hrv:diff, hrv:ok.
import { DAYS, daysLabel, describeHours, rangeLabel, readWeek, timeLabel, validHours, type Day, type DayHours, type Doubt, type Hours, type WeekRead } from '../services/hours';
import type { LLMProvider } from '../services/ai';
import { log } from '../lib/logger';
import { buttons } from './common';

export interface HoursDraft { week: Partial<Record<Day, DayHours | null>>; doubts: Doubt[]; missing: Day[]; orphan: DayHours | null; asking?: 'missing' | null }
type Out = string | ReturnType<typeof buttons>;

export const draftFrom = (r: WeekRead): HoursDraft => ({ week: r.week, doubts: r.doubts, missing: r.missing, orphan: r.orphan, asking: null });

// The owner's text → a draft to check. The AI only when the rules can't read it.
export async function readHoursText(text: string, llm: LLMProvider | null | undefined): Promise<HoursDraft | null> {
  const r = readWeek(text);
  if (r) return draftFrom(r);
  if (!llm?.writeTexts || !/\d|noon|midnight/i.test(text)) return null;
  try {
    const out = await llm.writeTexts({
      prompt: [
        'A shop owner in Nigeria wrote their opening hours. For each day, give the hours as "HH:MM-HH:MM" (24-hour clock), "closed", or "unknown" if they didn\'t say.',
        'Read "7am" as 07:00 even if it looks wrong; never guess times that aren\'t written.',
        `Their words: """${text.slice(0, 400)}"""`,
      ].join('\n'),
      keys: DAYS,
    });
    const week: Partial<Record<Day, DayHours | null>> = {};
    for (const d of DAYS) {
      const v = String(out[d] ?? '').trim().toLowerCase();
      const m = /^(\d\d:\d\d)\s*-\s*(\d\d:\d\d)$/.exec(v);
      const real = (t: string) => { const [h, mm] = t.split(':').map(Number); return h < 24 && mm < 60; }; // not "25:00"
      if (v === 'closed') week[d] = null;
      else if (m && m[1] !== m[2] && real(m[1]) && real(m[2])) week[d] = { open: m[1], close: m[2] };
    }
    if (!Object.keys(week).length || !validHours({ ...Object.fromEntries(DAYS.map(d => [d, null])), ...week })) return null;
    // Overnight or very long days are still asked about.
    const doubts: Doubt[] = [];
    for (const d of DAYS) {
      const h = week[d];
      if (!h) continue;
      const span = (mins(h.close) - mins(h.open) + 1440) % 1440;
      if (mins(h.close) < mins(h.open) || span > 16 * 60) {
        const same = doubts.find(x => x.range.open === h.open && x.range.close === h.close);
        if (same) same.days.push(d); else doubts.push({ days: [d], range: h, alt: null });
      }
    }
    return { week, doubts, missing: DAYS.filter(d => !(d in week)), orphan: null, asking: null };
  } catch (e) {
    log('warn', 'hours_ai_failed', { error: String(e instanceof Error ? e.message : e).slice(0, 120) });
    return null;
  }
}

const mins = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// The most common range among the days already set: "Same as Mon–Fri".
function reference(d: HoursDraft): { days: Day[]; range: DayHours } | null {
  const groups = new Map<string, Day[]>();
  for (const day of DAYS) { const h = d.week[day]; if (h) groups.set(`${h.open}-${h.close}`, [...(groups.get(`${h.open}-${h.close}`) ?? []), day]); }
  const [best] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  return best ? { days: best[1], range: d.week[best[1][0]]! } : null;
}

// The next thing to ask (or the confirmation).
export function hoursQuestion(d: HoursDraft): Out {
  const doubt = d.doubts[0];
  if (doubt) {
    const days = daysLabel(doubt.days);
    const prefix = doubt.days.length === 7 ? '' : `${days}: `;
    if (doubt.alt) return buttons(`${prefix}${timeLabel(doubt.range.open)} to ${timeLabel(doubt.alt.close)}, or open overnight until ${timeLabel(doubt.range.close)}?`, [['hrv:alt', rangeLabel(doubt.alt)], ['hrv:night', 'Overnight']]);
    if (mins(doubt.range.close) < mins(doubt.range.open)) return buttons(`${prefix}open ${timeLabel(doubt.range.open)} until ${timeLabel(doubt.range.close)} the next morning?`, [['hrv:night', 'Yes, overnight'], ['hrv:change', 'Change']]);
    const h = Math.round(((mins(doubt.range.close) - mins(doubt.range.open) + 1440) % 1440) / 60);
    return buttons(`${prefix}${rangeLabel(doubt.range)}, that's ${h} hours. Correct?`, [['hrv:night', 'Yes'], ['hrv:change', 'Change']]);
  }
  if (d.missing.length) {
    const days = daysLabel(d.missing);
    if (d.asking === 'missing') return `What are your ${days} hours? e.g. *10am–4pm*`;
    const ref = d.orphan ? { label: rangeLabel(d.orphan) } : reference(d) ? { label: `Same as ${daysLabel(reference(d)!.days)}` } : null;
    return buttons(`And ${days}?`, [['hrv:closed', 'Closed'], ...(ref ? [['hrv:same', ref.label] as [string, string]] : []), ['hrv:diff', 'Different hours']]);
  }
  return buttons(`${describeHours(full(d))}. Correct?`, [['hrv:ok', 'Yes'], ['hrv:change', 'Change']]);
}

const full = (d: HoursDraft) => Object.fromEntries(DAYS.map(day => [day, d.week[day] ?? null])) as Hours;

// An answer. Returns the updated draft, the hours to save, or a restart (ask for the hours again).
export function answerHours(d: HoursDraft, choiceId: string | null, text: string): { draft: HoursDraft } | { done: Hours } | { restart: true } | null {
  const t = text.trim().toLowerCase();
  const next = { ...d, week: { ...d.week }, doubts: [...d.doubts], missing: [...d.missing] };
  if (choiceId === 'hrv:change' || (!choiceId && /^(change|no|wrong)\b/.test(t) && !d.missing.length)) return { restart: true };
  const doubt = next.doubts[0];
  if (doubt) {
    if (choiceId === 'hrv:alt' && doubt.alt) { for (const day of doubt.days) next.week[day] = { ...doubt.alt }; next.doubts.shift(); return { draft: next }; }
    if (choiceId === 'hrv:night' || (!choiceId && /^(yes|overnight)\b/.test(t))) { next.doubts.shift(); return { draft: next }; }
    if (!choiceId && doubt.alt && t.replace(/\s/g, '').includes(rangeLabel(doubt.alt).replace(/\s/g, '').split('–')[1])) { for (const day of doubt.days) next.week[day] = { ...doubt.alt }; next.doubts.shift(); return { draft: next }; }
    return null;
  }
  if (next.missing.length) {
    const fill = (h: DayHours | null) => { for (const day of next.missing) next.week[day] = h ? { ...h } : null; next.missing = []; next.asking = null; return { draft: next }; };
    if (choiceId === 'hrv:closed' || (!choiceId && /^closed?\b/.test(t))) return fill(null);
    if (choiceId === 'hrv:same') { const ref = next.orphan ?? reference(next)?.range ?? null; return ref ? fill(ref) : null; }
    if (choiceId === 'hrv:diff') { next.asking = 'missing'; return { draft: next }; }
    if (!choiceId && t) {
      // A time typed straight in ("10am-4pm"), with or without the button.
      const r = readWeek(t);
      if (r?.everyDay) {
        const range = r.week.mon!;
        const days = next.missing;
        const res = fill(range);
        if (r.doubts.length) res.draft.doubts.push({ ...r.doubts[0], days });
        return res;
      }
    }
    return null;
  }
  if (choiceId === 'hrv:ok' || (!choiceId && /^(yes|correct|right|ok(ay)?)\b/.test(t))) {
    const h = validHours(full(next));
    return h ? { done: h } : { restart: true };
  }
  return null;
}
