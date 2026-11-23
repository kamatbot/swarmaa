import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractDateTime, hasTimeLike, isValidTimeZone, zonedParts, zonedTime, type DateTimeMode } from '../src/voice/datetime.js';

const NY = 'America/New_York';
const BKK = 'Asia/Bangkok';
const FRI_10 = new Date('2026-11-20T15:00:00Z'); // Fri 10:00 EST
const FRI_18 = new Date('2026-11-20T23:00:00Z'); // Fri 18:00 EST
const SAT_BEFORE_FALLBACK = new Date('2026-10-31T20:00:00Z'); // Sat 16:00 EDT, DST ends 2026-11-01 02:00
const BKK_10 = new Date('2026-11-20T03:00:00Z'); // Fri 10:00 ICT (UTC+7, no DST)

describe('zone math', () => {
  it('zonedParts reads wall clock and weekday', () => {
    assert.deepEqual(zonedParts(FRI_10, NY), { year: 2026, month: 11, day: 20, hour: 10, minute: 0, second: 0, weekday: 5 });
    assert.deepEqual(zonedParts(BKK_10, BKK), { year: 2026, month: 11, day: 20, hour: 10, minute: 0, second: 0, weekday: 5 });
    assert.equal(zonedParts(new Date('2026-11-20T23:30:00Z'), BKK).day, 21);
  });

  const cases: [string, [number, number, number, number, number, string], string][] = [
    ['EDT before fall-back', [2026, 10, 31, 9, 0, NY], '2026-10-31T13:00:00.000Z'],
    ['EST after fall-back', [2026, 11, 1, 9, 0, NY], '2026-11-01T14:00:00.000Z'],
    ['ambiguous 01:30 → earlier (EDT)', [2026, 11, 1, 1, 30, NY], '2026-11-01T05:30:00.000Z'],
    ['spring-forward gap 02:30 → 03:30 EDT', [2026, 3, 8, 2, 30, NY], '2026-03-08T07:30:00.000Z'],
    ['after spring-forward', [2026, 3, 8, 9, 0, NY], '2026-03-08T13:00:00.000Z'],
    ['Bangkok fixed +7', [2026, 11, 1, 9, 0, BKK], '2026-11-01T02:00:00.000Z'],
    ['day overflow normalizes', [2026, 12, 32, 9, 0, NY], '2027-01-01T14:00:00.000Z'],
    ['UTC', [2026, 6, 1, 0, 0, 'UTC'], '2026-06-01T00:00:00.000Z'],
  ];
  for (const [name, args, want] of cases) it(`zonedTime: ${name}`, () => assert.equal(zonedTime(...args).toISOString(), want));

  it('isValidTimeZone', () => {
    assert.equal(isValidTimeZone(NY), true);
    assert.equal(isValidTimeZone('Mars/Olympus'), false);
    assert.equal(isValidTimeZone(''), false);
    assert.equal(isValidTimeZone(7), false);
  });
});

type Row = { text: string; ref?: Date; tz?: string; mode?: DateTimeMode; morning?: boolean; at?: string; dur?: number; rest?: string; unparsed?: boolean; clock?: boolean };
const rows: Row[] = [
  // relative
  { text: 'in 10 minutes', at: '2026-11-20T15:10:00.000Z', clock: true },
  { text: 'in ten minutes', at: '2026-11-20T15:10:00.000Z' },
  { text: 'in an hour', at: '2026-11-20T16:00:00.000Z' },
  { text: 'in half an hour', at: '2026-11-20T15:30:00.000Z' },
  { text: 'in an hour and a half', at: '2026-11-20T16:30:00.000Z' },
  { text: 'in 2 days', at: '2026-11-22T14:00:00.000Z', clock: false },
  { text: 'in 1 week at 5 pm', at: '2026-11-27T22:00:00.000Z' },
  { text: 'in twenty five minutes', unparsed: true },
  { text: 'in 0 minutes', unparsed: true },
  // clock forms
  { text: 'at 5', at: '2026-11-20T22:00:00.000Z', rest: ' ' },
  { text: 'at five', at: '2026-11-20T22:00:00.000Z' },
  { text: 'at 8', at: '2026-11-21T01:00:00.000Z' }, // 08:00 past → 20:00 today
  { text: 'at 11', at: '2026-11-20T16:00:00.000Z' }, // 11:00 still ahead
  { text: 'at 5 pm', at: '2026-11-20T22:00:00.000Z' },
  { text: '5 PM', at: '2026-11-20T22:00:00.000Z' },
  { text: 'at 5pm', at: '2026-11-20T22:00:00.000Z' },
  { text: '5:30 pm', at: '2026-11-20T22:30:00.000Z' },
  { text: 'five thirty pm', at: '2026-11-20T22:30:00.000Z' },
  { text: '7 am', at: '2026-11-21T12:00:00.000Z' }, // past → tomorrow
  { text: '17:00', at: '2026-11-20T22:00:00.000Z' },
  { text: '09:15', at: '2026-11-21T14:15:00.000Z' },
  { text: 'at noon', at: '2026-11-20T17:00:00.000Z' },
  { text: 'at midnight', at: '2026-11-21T05:00:00.000Z' },
  { text: "at 6 o'clock", at: '2026-11-20T23:00:00.000Z' },
  { text: '13 pm', unparsed: true },
  { text: 'at 25', unparsed: true },
  // dates and defaults
  { text: 'today', unparsed: true }, // 09:00 already past and "today" is explicit
  { text: 'today at 3 pm', at: '2026-11-20T20:00:00.000Z' },
  { text: 'today at 8', at: '2026-11-21T01:00:00.000Z' },
  { text: 'tomorrow', at: '2026-11-21T14:00:00.000Z', clock: false },
  { text: 'tomorrow at 6', at: '2026-11-21T23:00:00.000Z' },
  { text: 'tomorrow at 6', morning: true, at: '2026-11-21T11:00:00.000Z' },
  { text: 'tomorrow morning', at: '2026-11-21T14:00:00.000Z' },
  { text: 'tomorrow evening at 7', at: '2026-11-22T00:00:00.000Z' },
  { text: 'day after tomorrow', at: '2026-11-22T14:00:00.000Z' },
  { text: 'tonight', at: '2026-11-21T01:00:00.000Z' },
  { text: 'tonight at 9', at: '2026-11-21T02:00:00.000Z' },
  { text: 'this afternoon', at: '2026-11-20T20:00:00.000Z' },
  { text: 'this evening', at: '2026-11-21T00:00:00.000Z' },
  { text: 'this morning', ref: FRI_18, at: '2026-11-21T14:00:00.000Z' }, // standalone part of day rolls
  { text: 'on monday', at: '2026-11-23T14:00:00.000Z' },
  { text: 'friday at 3 pm', at: '2026-11-20T20:00:00.000Z' }, // today, still ahead
  { text: 'friday at 9 am', at: '2026-11-27T14:00:00.000Z' }, // today but past → next week
  { text: 'next friday', at: '2026-11-27T14:00:00.000Z' },
  { text: 'next saturday', at: '2026-11-21T14:00:00.000Z' },
  { text: 'on March 3rd', at: '2027-03-03T14:00:00.000Z' },
  { text: '3 March', at: '2027-03-03T14:00:00.000Z' },
  { text: 'December the fifth at 10 am', at: '2026-12-05T15:00:00.000Z' },
  { text: 'on the 25th of december', at: '2026-12-25T14:00:00.000Z' },
  { text: 'February 30', unparsed: true },
  { text: 'on March 3rd 2020', unparsed: true },
  // rollover
  { text: 'at 5', ref: FRI_18, at: '2026-11-21T22:00:00.000Z' },
  { text: 'at 5:30 pm', ref: FRI_18, at: '2026-11-21T22:30:00.000Z' },
  // DST boundary (America/New_York, fall-back 2026-11-01)
  { text: 'tomorrow at 9 am', ref: SAT_BEFORE_FALLBACK, at: '2026-11-01T14:00:00.000Z' },
  { text: 'tomorrow at 1:30 am', ref: SAT_BEFORE_FALLBACK, at: '2026-11-01T05:30:00.000Z' },
  { text: 'tomorrow at 4 pm', ref: SAT_BEFORE_FALLBACK, at: '2026-11-01T21:00:00.000Z' },
  { text: 'in 24 hours', ref: SAT_BEFORE_FALLBACK, at: '2026-11-01T20:00:00.000Z' },
  { text: 'in 1 day', ref: SAT_BEFORE_FALLBACK, at: '2026-11-01T14:00:00.000Z' },
  // Asia/Bangkok
  { text: 'at 5', ref: BKK_10, tz: BKK, at: '2026-11-20T10:00:00.000Z' },
  { text: 'tomorrow at 9 am', ref: BKK_10, tz: BKK, at: '2026-11-21T02:00:00.000Z' },
  { text: 'tonight', ref: BKK_10, tz: BKK, at: '2026-11-20T13:00:00.000Z' },
  // durations, timers
  { text: 'tomorrow at 3 pm for 2 hours', mode: 'event', at: '2026-11-21T20:00:00.000Z', dur: 7_200_000 },
  { text: 'at 3 pm for half an hour', mode: 'event', dur: 1_800_000 },
  { text: 'at 3 pm for 2 days', mode: 'event', unparsed: true },
  { text: 'for 10 minutes', mode: 'timer', at: '2026-11-20T15:10:00.000Z' },
  { text: '5 minute', mode: 'timer', at: '2026-11-20T15:05:00.000Z' },
  { text: 'for 90 seconds', mode: 'timer', at: '2026-11-20T15:01:30.000Z' },
  { text: 'for 10', mode: 'timer', unparsed: true },
  { text: 'for 10 minutes at 5', mode: 'timer', unparsed: true },
  { text: 'stretch for 10 minutes', mode: 'reminder', rest: 'stretch for 10 minutes' },
  // conflicts and leftovers
  { text: 'in 10 minutes at 5', unparsed: true },
  { text: 'tomorrow and friday', unparsed: true },
  { text: 'next week', unparsed: true },
  { text: 'every monday', unparsed: true },
  { text: 'half past five', unparsed: true },
  { text: 'by 5', unparsed: true },
  { text: 'call one client', rest: 'call one client', unparsed: false },
];

describe('extractDateTime', () => {
  for (const r of rows) {
    const label = `${r.mode ?? 'reminder'} ${JSON.stringify(r.text)}${r.tz ? ` ${r.tz}` : ''}${r.ref ? ` @${r.ref.toISOString()}` : ''}`;
    it(label, () => {
      const got = extractDateTime(r.text, r.ref ?? FRI_10, r.tz ?? NY, { mode: r.mode ?? 'reminder', preferMorning: r.morning });
      assert.equal(got.unparsed, r.unparsed ?? false, `unparsed for ${label}: ${JSON.stringify(got)}`);
      if (r.at) assert.equal(got.at?.toISOString(), r.at);
      if (r.dur !== undefined) assert.equal(got.durationMs, r.dur);
      if (r.rest !== undefined) assert.equal(got.rest, r.rest);
      if (r.clock !== undefined) assert.equal(got.hasClock, r.clock);
    });
  }

  it('is pure: same input, same output; result never before the reference', () => {
    const a = extractDateTime('at 5', FRI_10, NY, { mode: 'reminder' });
    const b = extractDateTime('at 5', FRI_10, NY, { mode: 'reminder' });
    assert.deepEqual(a, b);
    assert.ok(a.at!.getTime() > FRI_10.getTime());
  });

  it('hasTimeLike', () => {
    for (const t of ['at 5', '5pm', 'tomorrow', 'on Monday', 'in a few minutes', '10 minutes from now', 'March 3rd', '12/25', 'this weekend'])
      assert.equal(hasTimeLike(t), true, t);
    for (const t of ['call mom', 'buy one apple', 'meet at the cafe', 'march for rights']) assert.equal(hasTimeLike(t), false, t);
    assert.equal(hasTimeLike('for 10', 'timer'), true);
    assert.equal(hasTimeLike('for 10'), false);
  });
});
