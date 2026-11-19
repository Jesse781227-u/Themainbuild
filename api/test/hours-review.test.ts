import { answerHours, hoursQuestion, readHoursText, type HoursDraft } from '../src/bots/hours-review';
import { readWeek } from '../src/services/hours';
import type { LLMProvider } from '../src/services/ai';
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Q = { type: string; text?: string; interactive?: { body: { text: string }; action: { buttons: { reply: { id: string; title: string } }[] } } };
const ask = (d: HoursDraft) => { const q = hoursQuestion(d) as Q; return typeof q === 'string' ? { text: q, buttons: [] as string[] } : { text: q.interactive!.body.text, buttons: q.interactive!.action.buttons.map(b => `${b.reply.id}|${b.reply.title}`) }; };
const step = (d: HoursDraft, choice: string | null, text = '') => { const r = answerHours(d, choice, text); assert.ok(r && 'draft' in r, `expected another question after ${choice ?? text}`); return (r as { draft: HoursDraft }).draft; };
const read = async (t: string, llm: LLMProvider | null = null) => { const d = await readHoursText(t, llm); assert.ok(d, `couldn't read "${t}"`); return d!; };

test('hours: "8AM to 7AM on weekdays and 10am to 7am on saturdays" → 7pm?, then Sunday?, then confirm', async () => {
  let d = await read('8AM to 7AM on weekdays and 10am to 7am on saturdays');
  assert.deepEqual(ask(d), { text: 'Mon–Fri: 8am to 7pm, or open overnight until 7am?', buttons: ['hrv:alt|8am–7pm', 'hrv:night|Overnight'] });
  d = step(d, 'hrv:alt');
  assert.deepEqual(ask(d), { text: 'Saturday: 10am to 7pm, or open overnight until 7am?', buttons: ['hrv:alt|10am–7pm', 'hrv:night|Overnight'] });
  d = step(d, 'hrv:alt');
  assert.deepEqual(ask(d), { text: 'And Sunday?', buttons: ['hrv:closed|Closed', 'hrv:same|Same as Mon–Fri', 'hrv:diff|Different hours'] }, 'never filled in silently');
  d = step(d, 'hrv:closed');
  assert.equal(ask(d).text, 'Mon–Fri 8am–7pm · Sat 10am–7pm · Sun closed. Correct?');
  const done = answerHours(d, 'hrv:ok', '');
  assert.ok(done && 'done' in done);
  assert.deepEqual([done.done.mon, done.done.sat, done.done.sun], [{ open: '08:00', close: '19:00' }, { open: '10:00', close: '19:00' }, null]);
});

test('hours: whole weeks in different words go straight to the check', async () => {
  for (const t of ['8am-6pm on weekdays, 10am-4pm on saturdays, closed sundays', 'Mon-Fri 8am-6pm, Sat 10am-4pm, Sun closed']) {
    assert.equal(ask(await read(t)).text, 'Mon–Fri 8am–6pm · Sat 10am–4pm · Sun closed. Correct?', t);
  }
  assert.equal(ask(await read('weekdays 9 to 5, weekends 12 to 4')).text, 'Mon–Fri 9am–5pm · Sat–Sun noon–4pm. Correct?');
  const change = answerHours(await read('Mon-Fri 8am-6pm, Sat 10am-4pm, Sun closed'), 'hrv:change', '');
  assert.deepEqual(change, { restart: true });
});

test('hours: one time is every day (signup then asks "Same every day?")', () => {
  const r = readWeek('8am - 9pm')!;
  assert.equal(r.everyDay, true);
  assert.deepEqual(r.week.sun, { open: '08:00', close: '21:00' });
  assert.deepEqual(r.doubts, []);
});

test('hours: "6pm to 2am" is only kept as overnight when the owner says so', async () => {
  let d = await read('6pm to 2am');
  assert.deepEqual(ask(d), { text: 'open 6pm until 2am the next morning?', buttons: ['hrv:night|Yes, overnight', 'hrv:change|Change'] });
  d = step(d, 'hrv:night');
  assert.equal(ask(d).text, 'Every day 6pm–2am. Correct?');
});

test('hours: "saturdays and sundays 10am-3pm" alone → asks about Mon–Fri', async () => {
  let d = await read('saturdays and sundays 10am-3pm');
  assert.deepEqual(ask(d), { text: 'And Mon–Fri?', buttons: ['hrv:closed|Closed', 'hrv:same|Same as Sat & Sun', 'hrv:diff|Different hours'] });
  d = step(d, 'hrv:diff');
  assert.equal(ask(d).text, 'What are your Mon–Fri hours? e.g. *10am–4pm*');
  d = step(d, null, '9am-5pm');
  assert.equal(ask(d).text, 'Mon–Fri 9am–5pm · Sat–Sun 10am–3pm. Correct?');
});

test('hours: what the rules can\'t read goes to the AI, is checked, and still needs a Yes', async () => {
  // "Mon to Sun 9-5" names days but comes out the same for all 7: treated as unreadable by the rules.
  assert.equal(readWeek('Mon to Sun 9-5'), null);
  const asked: string[] = [];
  const llm = { async chooseTool() { return null; }, async writeTexts({ prompt }: { prompt: string }) { asked.push(prompt); return { mon: '09:00-17:00', tue: '09:00-17:00', wed: '09:00-17:00', thu: '09:00-17:00', fri: '09:00-17:00', sat: 'closed', sun: 'unknown' }; } } as LLMProvider;
  const d = await read('Mon to Sun 9-5', llm);
  assert.match(asked[0], /Mon to Sun 9-5/);
  assert.deepEqual(ask(d), { text: 'And Sunday?', buttons: ['hrv:closed|Closed', 'hrv:same|Same as Mon–Fri', 'hrv:diff|Different hours'] }, 'what the AI didn\'t know is asked');
  const bad = { ...llm, async writeTexts() { return { mon: '9 till late', tue: '25:00-26:00' }; } } as LLMProvider;
  assert.equal(await readHoursText('Mon to Sun 9-5', bad), null, 'nothing usable from the AI: ask again');
});
