import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseIntent, tidyTitle, validateLocalAction } from '../src/voice/intent.js';
import type { Intent, IntentInput } from '../src/voice/types.js';

const NY = 'America/New_York';
const BKK = 'Asia/Bangkok';
const FRI_10 = new Date('2026-11-20T15:00:00Z'); // Fri 10:00 EST
const FRI_18 = new Date('2026-11-20T23:00:00Z'); // Fri 18:00 EST
const SAT_BEFORE_FALLBACK = new Date('2026-10-31T20:00:00Z'); // Sat 16:00 EDT, DST ends 2026-11-01
const BKK_10 = new Date('2026-11-20T03:00:00Z'); // Fri 10:00 ICT
const BOTS = [
  { id: 'b-dev', name: 'Dev' },
  { id: 'b-devops', name: 'Dev Ops' },
  { id: 'b-assistant', name: 'Assistant' },
  { id: 'b-res1', name: 'Research' },
  { id: 'b-res2', name: 'research' },
  { id: 'b-cpp', name: 'C++ Bot' },
];

type Row = { t: string; ref?: Date; tz?: string; dur?: number; want: Intent };
const A = (hint: 'freeform' | 'multi' | 'unparsed_time' | 'meeting' | 'no_transcript'): Intent => ({ route: 'assistant', hint });
const rem = (title: string, due_at?: string, extra: Record<string, unknown> = {}): Intent =>
  ({ route: 'local', action: { type: 'reminder.create', title, ...(due_at ? { due_at } : {}), ...extra } as never });
const todo = (title: string, due_at?: string) => rem(title, due_at, { list: 'todo' });
const ev = (title: string, start_at: string, end_at: string): Intent => ({ route: 'local', action: { type: 'event.create', title, start_at, end_at } });
const note = (text: string): Intent => ({ route: 'local', action: { type: 'note.append', text, notebook: 'inbox' } });
const timer = (label: string, fire_at: string, kind: 'timer' | 'alarm' = 'timer'): Intent => ({ route: 'local', action: { type: 'timer.start', label, fire_at, kind } });
const del = (bot_id: string, body: string): Intent => ({ route: 'delegate', bot_id, body });

const rows: Row[] = [
  // reminders: every trigger
  { t: 'remind me to call mom at 5', want: rem('Call mom', '2026-11-20T22:00:00.000Z') },
  { t: 'remind me to call mom at 5', ref: FRI_18, want: rem('Call mom', '2026-11-21T22:00:00.000Z') },
  { t: 'Remind me to call mom at 5 p.m.', want: rem('Call mom', '2026-11-20T22:00:00.000Z') },
  { t: 'Remind me to call Mom at 5 PM.', want: rem('Call Mom', '2026-11-20T22:00:00.000Z') },
  { t: 'remind me at five to call mom', want: rem('Call mom', '2026-11-20T22:00:00.000Z') },
  { t: 'remind me about the dentist tomorrow', want: rem('The dentist', '2026-11-21T14:00:00.000Z') },
  { t: 'remind me tomorrow at 9 that the car needs oil', want: rem('The car needs oil', '2026-11-21T14:00:00.000Z') },
  { t: 'remind me to water the plants', want: rem('Water the plants') },
  { t: 'reminder: pay rent on December 1st', want: rem('Pay rent', '2026-12-01T14:00:00.000Z') },
  { t: 'set a reminder to stretch in 20 minutes', want: rem('Stretch', '2026-11-20T15:20:00.000Z') },
  { t: "don't let me forget to take my pills tonight", want: rem('Take my pills', '2026-11-21T01:00:00.000Z') },
  { t: 'Don’t let me forget the keys', want: rem('The keys') },
  { t: 'remind me in half an hour to check the oven', want: rem('Check the oven', '2026-11-20T15:30:00.000Z') },
  { t: 'remind me to stretch at five thirty pm', want: rem('Stretch', '2026-11-20T22:30:00.000Z') },
  { t: 'remind me on monday morning to submit the report', want: rem('Submit the report', '2026-11-23T14:00:00.000Z') },
  { t: 'remind me next friday to renew the passport', want: rem('Renew the passport', '2026-11-27T14:00:00.000Z') },
  { t: 'remind me about the meeting at 17:00', want: rem('The meeting', '2026-11-20T22:00:00.000Z') },
  { t: 'remind me to meet Sam at the cafe at noon', want: rem('Meet Sam at the cafe', '2026-11-20T17:00:00.000Z') },
  // fillers and wake words
  { t: 'Hey assistant, please remind me tomorrow to pay rent', want: rem('Pay rent', '2026-11-21T14:00:00.000Z') },
  { t: 'Um, so, can you remind me to call mom at 8?', want: rem('Call mom', '2026-11-21T01:00:00.000Z') },
  { t: 'ok assistant remind me to buy eggs please.', want: rem('Buy eggs') },
  // todo
  { t: 'todo buy milk', want: todo('Buy milk') },
  { t: 'To do: buy milk.', want: todo('Buy milk') },
  { t: 'task file the expense report', want: todo('File the expense report') },
  { t: 'add a task review PR by friday', want: todo('Review PR', '2026-11-27T14:00:00.000Z') }, // Friday 09:00 already past → next Friday
  { t: 'add a todo review the PR on friday', want: todo('Review the PR', '2026-11-27T14:00:00.000Z') },
  { t: 'add a task call the bank tomorrow at 2 pm', want: todo('Call the bank', '2026-11-21T19:00:00.000Z') },
  // events
  { t: 'schedule dentist tomorrow at 3pm for an hour', want: ev('Dentist', '2026-11-21T20:00:00.000Z', '2026-11-21T21:00:00.000Z') },
  { t: 'schedule a meeting with Bob at 3', want: ev('Meeting with Bob', '2026-11-20T20:00:00.000Z', '2026-11-20T20:30:00.000Z') },
  { t: 'add an event: team lunch on Friday at noon', want: ev('Team lunch', '2026-11-20T17:00:00.000Z', '2026-11-20T17:30:00.000Z') },
  { t: 'calendar yoga on monday at 7 am for 90 minutes', want: ev('Yoga', '2026-11-23T12:00:00.000Z', '2026-11-23T13:30:00.000Z') },
  { t: 'book a haircut on December 5th at 10 am', want: ev('Haircut', '2026-12-05T15:00:00.000Z', '2026-12-05T15:30:00.000Z') },
  { t: 'put lunch with Sam on my calendar on Friday at 1 pm', want: ev('Lunch with Sam', '2026-11-20T18:00:00.000Z', '2026-11-20T18:30:00.000Z') },
  { t: 'add dinner with Ana to my calendar tomorrow at 7 pm', want: ev('Dinner with Ana', '2026-11-22T00:00:00.000Z', '2026-11-22T00:30:00.000Z') },
  { t: 'schedule dentist tomorrow', want: A('unparsed_time') },
  { t: 'schedule dinner tonight', want: A('unparsed_time') },
  { t: 'schedule a call with Kim', want: A('unparsed_time') },
  { t: 'schedule at 3 pm', want: A('freeform') },
  // notes
  { t: 'note buy filters', want: note('Buy filters') },
  { t: 'Note: buy filters.', want: note('Buy filters') },
  { t: 'note to self the garage code is 4471', want: note('The garage code is 4471') },
  { t: 'take a note that the wifi is slow', want: note('The wifi is slow') },
  { t: 'jot down replace the air filter', want: note('Replace the air filter') },
  { t: 'remember that Sam likes oolong tea', want: note('Sam likes oolong tea') },
  { t: 'memo ask about the lease renewal', want: note('Ask about the lease renewal') },
  { t: 'idea: a ring that vibrates on calendar alerts', want: note('A ring that vibrates on calendar alerts') },
  { t: 'note call the vet tomorrow at 5', want: note('Call the vet tomorrow at 5') }, // a note keeps its words
  // timers
  { t: 'set a timer for 10 minutes', want: timer('Timer', '2026-11-20T15:10:00.000Z') },
  { t: 'timer 5 minutes for eggs', want: timer('Eggs', '2026-11-20T15:05:00.000Z') },
  { t: 'set a 15 minute timer for the pasta', want: timer('The pasta', '2026-11-20T15:15:00.000Z') },
  { t: 'alarm at 7', want: timer('Alarm', '2026-11-21T00:00:00.000Z', 'alarm') },
  { t: 'set an alarm for 6 am', want: timer('Alarm', '2026-11-21T11:00:00.000Z', 'alarm') },
  { t: 'wake me up at 6:30', want: timer('Wake up', '2026-11-21T11:30:00.000Z', 'alarm') },
  { t: 'wake me at 7 tomorrow', want: timer('Wake up', '2026-11-21T12:00:00.000Z', 'alarm') },
  { t: 'wake me at 7', want: timer('Wake up', '2026-11-21T12:00:00.000Z', 'alarm') }, // wake prefers the morning
  { t: 'timer for 5 minutes', want: timer('Timer', '2026-11-20T15:05:00.000Z') },
  { t: 'set a timer', want: A('unparsed_time') },
  { t: 'set a timer for 10', want: A('unparsed_time') },
  // delegate
  { t: 'ask dev ops to restart the staging server', want: del('b-devops', 'restart the staging server') },
  { t: 'Ask Dev to fix the login bug', want: del('b-dev', 'fix the login bug') },
  { t: 'tell dev that the build broke', want: del('b-dev', 'the build broke') },
  { t: 'have Dev, look at PR 42', want: del('b-dev', 'look at PR 42') },
  { t: 'get c++ bot to profile the parser', want: del('b-cpp', 'profile the parser') },
  { t: 'ask developer to deploy', want: A('freeform') }, // word boundary: "Dev" ≠ "developer"
  { t: 'ask research to find papers', want: A('freeform') }, // two bots share the name
  { t: 'ask assistant to plan my week', want: A('freeform') },
  { t: 'ask dev', want: A('freeform') },
  { t: 'ask siri to call mom', want: A('freeform') },
  // meeting
  { t: 'summarize the meeting', want: A('meeting') },
  { t: 'Recap: we agreed to ship Friday', want: A('meeting') },
  { t: 'meeting notes: budget approved', want: A('meeting') },
  { t: 'summary of the call', want: A('meeting') },
  { t: 'remind me to call mom', dur: 121, want: A('meeting') },
  { t: 'remind me to call mom', dur: 120, want: rem('Call mom') },
  // fail-safes
  { t: '', want: A('no_transcript') },
  { t: '   ', want: A('no_transcript') },
  { t: ' ... ', want: A('no_transcript') },
  { t: 'remind me to call mom and also schedule the dentist', want: A('multi') },
  { t: 'note buy milk and remind me to pay rent', want: A('multi') },
  { t: 'remind me to buy milk and eggs', want: rem('Buy milk and eggs') },
  { t: 'remind me to call mom next week', want: A('unparsed_time') },
  { t: 'remind me to call mom at 5 or 6', want: A('unparsed_time') },
  { t: 'remind me to call mom tomorrow and friday', want: A('unparsed_time') },
  { t: 'remind me to water plants every monday', want: A('unparsed_time') },
  { t: 'remind me to leave at half past five', want: A('unparsed_time') },
  { t: 'remind me to call mom in a few minutes', want: A('unparsed_time') },
  { t: 'remind me today to call mom', want: A('unparsed_time') }, // 09:00 default already past
  { t: 'remind me', want: A('freeform') },
  { t: 'remind me at 5', want: A('freeform') },
  { t: 'note', want: A('freeform') },
  { t: 'what is the weather like', want: A('freeform') },
  { t: 'call mom at 5', want: A('freeform') },
  // DST boundary (fall-back 2026-11-01, America/New_York)
  { t: 'remind me tomorrow at 9 am to change the clocks', ref: SAT_BEFORE_FALLBACK, want: rem('Change the clocks', '2026-11-01T14:00:00.000Z') },
  { t: 'remind me in 24 hours to check', ref: SAT_BEFORE_FALLBACK, want: rem('Check', '2026-11-01T20:00:00.000Z') },
  { t: 'wake me up tomorrow at 1:30 am', ref: SAT_BEFORE_FALLBACK, want: timer('Wake up', '2026-11-01T05:30:00.000Z', 'alarm') },
  { t: 'schedule brunch tomorrow at 11 am', ref: SAT_BEFORE_FALLBACK, want: ev('Brunch', '2026-11-01T16:00:00.000Z', '2026-11-01T16:30:00.000Z') },
  // Asia/Bangkok
  { t: 'remind me to call mom at 5', ref: BKK_10, tz: BKK, want: rem('Call mom', '2026-11-20T10:00:00.000Z') },
  { t: 'schedule standup tomorrow at 9:30 am', ref: BKK_10, tz: BKK, want: ev('Standup', '2026-11-21T02:30:00.000Z', '2026-11-21T03:00:00.000Z') },
  { t: 'set a timer for 3 minutes', ref: BKK_10, tz: BKK, want: timer('Timer', '2026-11-20T03:03:00.000Z') },
  // bad zone: no guessing at times
  { t: 'remind me to call mom at 5', tz: 'Not/AZone', want: A('unparsed_time') },
  { t: 'remind me to call mom', tz: 'Not/AZone', want: rem('Call mom') },
];

describe('parseIntent', () => {
  for (const r of rows) {
    const label = `${JSON.stringify(r.t)}${r.tz ? ` ${r.tz}` : ''}${r.ref ? ` @${r.ref.toISOString()}` : ''}${r.dur ? ` ${r.dur}s` : ''}`;
    it(label, () => {
      const input: IntentInput = { transcript: r.t, spokenAt: r.ref ?? FRI_10, timeZone: r.tz ?? NY, bots: BOTS, durationSeconds: r.dur };
      assert.deepEqual(parseIntent(input), r.want);
    });
  }

  it('does not mutate input and is deterministic', () => {
    const input: IntentInput = { transcript: 'remind me to call mom at 5', spokenAt: new Date(FRI_10), timeZone: NY, bots: [...BOTS] };
    const snap = JSON.stringify(input);
    assert.deepEqual(parseIntent(input), parseIntent(input));
    assert.equal(JSON.stringify(input), snap);
  });

  it('every local result passes validateLocalAction', () => {
    for (const r of rows) {
      const got = parseIntent({ transcript: r.t, spokenAt: r.ref ?? FRI_10, timeZone: r.tz ?? NY, bots: BOTS, durationSeconds: r.dur });
      if (got.route === 'local') assert.equal(typeof validateLocalAction(got.action), 'object', r.t);
    }
  });

  it('long reminder titles are bounded, full text kept in notes', () => {
    const long = `remind me to ${'buy many groceries '.repeat(20)}`;
    const got = parseIntent({ transcript: long, spokenAt: FRI_10, timeZone: NY, bots: [] });
    assert.equal(got.route, 'local');
    const a = (got as { action: { title: string; notes?: string } }).action;
    assert.ok(a.title.length <= 200 && a.title.endsWith('…'));
    assert.ok(a.notes!.startsWith('Buy many groceries'));
  });

  it('tidyTitle', () => {
    assert.equal(tidyTitle('  to call mom  .'), 'Call mom');
    assert.equal(tidyTitle('call mom ,  ,'), 'Call mom');
    assert.equal(tidyTitle('a meeting with Bob', { articles: true }), 'Meeting with Bob');
    assert.equal(tidyTitle(' about that '), '');
  });
});

describe('validateLocalAction', () => {
  const T0 = '2026-11-20T15:00:00.000Z';
  const T1 = '2026-11-20T15:30:00.000Z';
  const ok: [string, unknown, unknown][] = [
    ['reminder minimal', { type: 'reminder.create', title: 'Call mom' }, { type: 'reminder.create', title: 'Call mom' }],
    ['reminder full, trimmed', { type: 'reminder.create', title: '  Call mom ', due_at: '2026-11-20T15:00:00Z', notes: 'line 1\nline 2', list: 'todo' },
      { type: 'reminder.create', title: 'Call mom', due_at: T0, notes: 'line 1\nline 2', list: 'todo' }],
    ['event', { type: 'event.create', title: 'Lunch', start_at: T0, end_at: T1, all_day: false, location: 'Cafe' },
      { type: 'event.create', title: 'Lunch', start_at: T0, end_at: T1, all_day: false, location: 'Cafe' }],
    ['note', { type: 'note.append', text: 'x', notebook: 'meetings', title: 'Standup' }, { type: 'note.append', text: 'x', notebook: 'meetings', title: 'Standup' }],
    ['timer', { type: 'timer.start', label: 'Eggs', fire_at: T0 }, { type: 'timer.start', label: 'Eggs', fire_at: T0 }],
    ['alarm kind', { type: 'timer.start', label: 'Wake up', fire_at: T0, kind: 'alarm' }, { type: 'timer.start', label: 'Wake up', fire_at: T0, kind: 'alarm' }],
    ['timer kind', { type: 'timer.start', label: 'Eggs', fire_at: T0, kind: 'timer' }, { type: 'timer.start', label: 'Eggs', fire_at: T0, kind: 'timer' }],
    ['undefined optional ignored', { type: 'reminder.create', title: 'x', due_at: undefined }, { type: 'reminder.create', title: 'x' }],
  ];
  for (const [name, input, want] of ok) it(`accepts: ${name}`, () => assert.deepEqual(validateLocalAction(input), want));

  const bad: [string, unknown, string][] = [
    ['null', null, 'not_object'],
    ['array', [], 'not_object'],
    ['string', 'reminder.create', 'not_object'],
    ['unknown type', { type: 'mail.send', to: 'x' }, 'unknown_type'],
    ['missing type', { title: 'x' }, 'unknown_type'],
    ['extra key', { type: 'reminder.create', title: 'x', script: 'rm -rf' }, 'unknown_key:script'],
    ['key from another type', { type: 'timer.start', label: 'x', fire_at: T0, title: 'y' }, 'unknown_key:title'],
    ['missing title', { type: 'reminder.create' }, 'title_required'],
    ['empty title', { type: 'reminder.create', title: '   ' }, 'title_empty'],
    ['title not string', { type: 'reminder.create', title: 5 }, 'title_not_string'],
    ['title too long', { type: 'reminder.create', title: 'x'.repeat(201) }, 'title_too_long'],
    ['title newline', { type: 'reminder.create', title: 'a\nb' }, 'title_control_chars'],
    ['notes too long', { type: 'reminder.create', title: 'x', notes: 'n'.repeat(4001) }, 'notes_too_long'],
    ['null optional', { type: 'reminder.create', title: 'x', notes: null }, 'notes_not_string'],
    ['bad list', { type: 'reminder.create', title: 'x', list: 'Groceries' }, 'list_invalid'],
    ['local time', { type: 'reminder.create', title: 'x', due_at: '2026-11-20T15:00:00' }, 'due_at_not_iso_utc'],
    ['offset time', { type: 'reminder.create', title: 'x', due_at: '2026-11-20T10:00:00-05:00' }, 'due_at_not_iso_utc'],
    ['impossible date', { type: 'reminder.create', title: 'x', due_at: '2026-02-30T10:00:00Z' }, 'due_at_not_iso_utc'],
    ['time as number', { type: 'timer.start', label: 'x', fire_at: 1763650800000 }, 'fire_at_not_iso_utc'],
    ['event end == start', { type: 'event.create', title: 'x', start_at: T0, end_at: T0 }, 'end_before_start'],
    ['event end < start', { type: 'event.create', title: 'x', start_at: T1, end_at: T0 }, 'end_before_start'],
    ['event missing end', { type: 'event.create', title: 'x', start_at: T0 }, 'end_at_required'],
    ['all_day not boolean', { type: 'event.create', title: 'x', start_at: T0, end_at: T1, all_day: 'yes' }, 'all_day_not_boolean'],
    ['empty note text', { type: 'note.append', text: '' }, 'text_empty'],
    ['note text too long', { type: 'note.append', text: 'x'.repeat(16385) }, 'text_too_long'],
    ['bad notebook', { type: 'note.append', text: 'x', notebook: '../etc' }, 'notebook_invalid'],
    ['empty label', { type: 'timer.start', label: '', fire_at: T0 }, 'label_empty'],
    ['bad timer kind', { type: 'timer.start', label: 'x', fire_at: T0, kind: 'stopwatch' }, 'kind_invalid'],
    ['kind on a reminder', { type: 'reminder.create', title: 'x', kind: 'alarm' }, 'unknown_key:kind'],
  ];
  for (const [name, input, want] of bad) it(`refuses: ${name}`, () => assert.equal(validateLocalAction(input), want));
});
