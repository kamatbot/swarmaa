// Deterministic spoken date/time parser for voice memos (docs/RING-AGENT.md §4.2). Pure: the reference instant and
// IANA zone come from the caller; zone math goes through Intl only (no dependency, DST-correct).

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }
export type DateTimeMode = 'reminder' | 'event' | 'timer';
export interface DateTimeOptions { mode: DateTimeMode; preferMorning?: boolean }
export interface DateTimeResult {
  /** Resolved instant (reminder due, event start, timer fire). */
  at?: Date;
  /** Spoken duration ("for 2 hours"); events only. */
  durationMs?: number;
  /** A clock time or sub-day offset was spoken (an event needs one). */
  hasClock: boolean;
  /** Input with every consumed phrase removed. */
  rest: string;
  /** Time-like words left over, conflicting phrases, or an unresolvable date: never drop a spoken time silently. */
  unparsed: boolean;
}

const MINUTE = 60_000;
const HOUR_MS = 60 * MINUTE;
const DAY_MS = 24 * HOUR_MS;
const MAX_AHEAD_MS = 366 * DAY_MS;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WD_SHORT: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    if (fmtCache.size > 64) fmtCache.clear();
    fmtCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try { formatter(timeZone); return true; } catch { return false; }
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(date)) p[part.type] = part.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24,
    minute: Number(p.minute), second: Number(p.second), weekday: WD_SHORT[p.weekday ?? ''] ?? 0,
  };
}

function offsetMs(t: number, timeZone: string): number {
  const p = zonedParts(new Date(t), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/** Wall-clock time in `timeZone` → instant. Day/month overflow normalizes. Ambiguous (fall-back) → earlier
 *  instant; nonexistent (spring-forward gap) → shifted forward by the gap. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const cands = [...new Set([wall - offsetMs(wall - DAY_MS, timeZone), wall - offsetMs(wall + DAY_MS, timeZone)])]
    .filter((t) => t + offsetMs(t, timeZone) === wall).sort((a, b) => a - b);
  return new Date(cands[0] ?? wall - offsetMs(wall - DAY_MS, timeZone));
}

// ---- vocabulary ----

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const TENS: Record<string, number> = { thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
  'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];
const ORDINALS = new Map<string, number>();
ORD.forEach((w, i) => ORDINALS.set(w, i + 1));
ORD.slice(0, 9).forEach((w, i) => ORDINALS.set(`twenty ${w}`, 21 + i));
ORDINALS.set('thirtieth', 30);
ORDINALS.set('thirty first', 31);

const alt = (words: Iterable<string>) => [...words].sort((a, b) => b.length - a.length).map((w) => w.replace(/ /g, '[- ]')).join('|');
const HOUR_W = `\\d{1,2}|${alt(SMALL.slice(1, 13))}`;
const COUNT_W = `\\d{1,3}|${alt([...SMALL.slice(1), ...Object.keys(TENS), 'forty five'])}`;
const MIN_W = `fifteen|thirty|forty[- ]five`;
const MONTH_W = `(?:${alt(MONTHS)}|${alt(Object.keys(MONTH_ABBR))})\\.?`;
const DAY_W = `\\d{1,2}(?:st|nd|rd|th)?|${alt(ORDINALS.keys())}`;
const WD_W = WEEKDAYS.join('|');
const POD_W = 'morning|afternoon|evening|night';
const UNIT_W = 'seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?';

const RX = (s: string) => new RegExp(s, 'i');

function wordNum(raw: string): number | undefined {
  const s = raw.toLowerCase().replace(/[- ]+/g, ' ').trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (s === 'a' || s === 'an') return 1;
  if (s === 'forty five') return 45;
  const i = SMALL.indexOf(s);
  if (i >= 0) return i;
  return TENS[s];
}

function monthNum(raw: string): number {
  const s = raw.toLowerCase().replace(/\.$/, '');
  const i = MONTHS.indexOf(s);
  return i >= 0 ? i + 1 : (MONTH_ABBR[s] ?? 0);
}

function dayNum(raw: string): number {
  const s = raw.toLowerCase().replace(/[- ]+/g, ' ');
  return ORDINALS.get(s) ?? Number(s.replace(/(st|nd|rd|th)$/, ''));
}

function unitMs(unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith('s')) return 1000;
  if (u.startsWith('m')) return MINUTE;
  if (u.startsWith('h')) return HOUR_MS;
  if (u.startsWith('d')) return DAY_MS;
  return 7 * DAY_MS;
}

// ---- leftover detector ----

const TIME_LIKE: RegExp[] = [
  /\b\d{1,2}:\d{2}\b/,
  RX(`\\b(?:${HOUR_W})\\s*(?:am|pm)\\b`),
  RX(`(?:\\b(?:at|by|until|till|til|before|after|around|from|between|or)\\s+|@\\s*)(?:${HOUR_W}|noon|midnight)\\b`),
  /\b(?:noon|midday|midnight|today|tonight|tonite|tomorrow|tmrw|yesterday|o'?clock|weekend)\b/i,
  RX(`\\b(?:${WD_W})s?\\b`),
  /\b(?:this|next|last|coming)\s+(?:week|month|year)\b/i,
  RX(`\\b(?:this|in\\s+the|at)\\s+(?:${POD_W})\\b`),
  RX(`\\bin\\s+(?:\\S+\\s+){1,3}?(?:${UNIT_W}|months?|years?)\\b`),
  RX(`\\b(?:${UNIT_W})\\s+(?:from\\s+now|later)\\b`),
  /\b(?:half|quarter)\s+(?:past|to|after)\b/i,
  /\bend\s+of\s+(?:the\s+)?(?:day|week|month)\b/i,
  /\blater\s+(?:today|tonight|this)\b/i,
  RX(`\\b${MONTH_W}\\s+(?:the\\s+)?(?:${DAY_W})\\b`),
  RX(`\\b(?:${DAY_W})\\s+(?:of\\s+)?${MONTH_W}(?=$|[\\s,.;:!?])`),
  /\bthe\s+\d{1,2}(?:st|nd|rd|th)\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
];
// Recurrence is not a one-shot time: checked on the raw text before anything is consumed.
const RECURRING = RX(`\\b(?:every|each)\\s+(?:other\\s+)?(?:day|morning|afternoon|evening|night|week|month|year|weekday|weekend|${WD_W})s?\\b|\\b(?:${WD_W})s\\b|\\b(?:daily|weekly|monthly|hourly)\\b`);
const TIMER_LIKE = [RX(`\\bfor\\s+(?:${COUNT_W})\\b`)];

/** True when the text still contains a word or phrase that reads as a date or time. */
export function hasTimeLike(text: string, mode: DateTimeMode = 'reminder'): boolean {
  return TIME_LIKE.some((r) => r.test(text)) || RECURRING.test(text) || (mode === 'timer' && TIMER_LIKE.some((r) => r.test(text)));
}

// ---- extraction ----

type DateSpec =
  | { kind: 'offset'; days: number }
  | { kind: 'weekday'; wd: number; next: boolean }
  | { kind: 'md'; month: number; day: number; year?: number };
type Pod = 'morning' | 'afternoon' | 'evening' | 'night';
const POD_HOUR: Record<Pod, number> = { morning: 9, afternoon: 15, evening: 19, night: 20 };

interface Clock { hour: number; minute: number; exact: boolean }

const REL_RX = [
  { re: /\bin\s+(?:an|one)\s+hour\s+and\s+a\s+half\b/i, ms: () => 90 * MINUTE },
  { re: /\bin\s+(?:a\s+)?half\s+(?:an?\s+)?hour\b/i, ms: () => 30 * MINUTE },
  { re: RX(`\\bin\\s+(${COUNT_W}|an?)\\s+(${UNIT_W})\\b`), ms: (m: RegExpExecArray) => mul(m[1], m[2]) },
];
const DUR_RX = [
  { re: /\bfor\s+(?:an|one)\s+hour\s+and\s+a\s+half\b/i, ms: () => 90 * MINUTE },
  { re: /\bfor\s+(?:a\s+)?half\s+(?:an?\s+)?hour\b/i, ms: () => 30 * MINUTE },
  { re: RX(`\\bfor\\s+(${COUNT_W}|an?)\\s+(${UNIT_W})\\b`), ms: (m: RegExpExecArray) => mul(m[1], m[2]) },
];
const TIMER_BARE_RX = RX(`\\b(${COUNT_W}|an?)[- ](seconds?|secs?|minutes?|mins?|hours?|hrs?)\\b`);

function mul(n: string | undefined, unit: string | undefined): number | undefined {
  const k = wordNum(n ?? '');
  return k && k > 0 && unit ? k * unitMs(unit) : undefined;
}

const DATE_RX: { re: RegExp; spec: (m: RegExpExecArray) => { date?: DateSpec; pod?: Pod } | undefined }[] = [
  { re: RX(`\\b(?:the\\s+)?day\\s+after\\s+tomorrow(?:\\s+(${POD_W}))?\\b`), spec: (m) => ({ date: { kind: 'offset', days: 2 }, pod: m[1]?.toLowerCase() as Pod | undefined }) },
  { re: RX(`\\btomorrow(?:\\s+(${POD_W}))?\\b`), spec: (m) => ({ date: { kind: 'offset', days: 1 }, pod: m[1]?.toLowerCase() as Pod | undefined }) },
  { re: /\btonight\b/i, spec: () => ({ date: { kind: 'offset', days: 0 }, pod: 'night' }) },
  { re: /\btoday\b/i, spec: () => ({ date: { kind: 'offset', days: 0 } }) },
  {
    re: RX(`\\b(?:on\\s+)?(?:(next|this|coming)\\s+)?(${WD_W})(?:\\s+(${POD_W}))?\\b`),
    spec: (m) => ({ date: { kind: 'weekday', wd: WEEKDAYS.indexOf(m[2]!.toLowerCase()), next: m[1]?.toLowerCase() === 'next' }, pod: m[3]?.toLowerCase() as Pod | undefined }),
  },
  {
    re: RX(`\\b(?:on\\s+)?(?:the\\s+)?(${MONTH_W})\\s+(?:the\\s+)?(${DAY_W})(?:,?\\s+(\\d{4}))?(?=$|[\\s,.;:!?])`),
    spec: (m) => md(m[1]!, m[2]!, m[3]),
  },
  {
    re: RX(`\\b(?:on\\s+)?(?:the\\s+)?(${DAY_W})\\s+(?:of\\s+)?(${MONTH_W})(?:,?\\s+(\\d{4}))?(?=$|[\\s,.;:!?])`),
    spec: (m) => md(m[2]!, m[1]!, m[3]),
  },
];

function md(month: string, day: string, year: string | undefined): { date: DateSpec } | undefined {
  const mo = monthNum(month);
  const d = dayNum(day);
  if (!mo || !Number.isInteger(d) || d < 1 || d > 31) return undefined;
  return { date: { kind: 'md', month: mo, day: d, year: year ? Number(year) : undefined } };
}

const POD_RX = RX(`\\b(?:this|in\\s+the)\\s+(${POD_W})\\b|\\bat\\s+(night)\\b`);

function clockRx(): { re: RegExp; clock: (m: RegExpExecArray) => Clock | undefined }[] {
  return [
    {
      // explicit meridiem: "at 5 pm", "5:30 pm", "five thirty pm", "5 30 PM"
      re: RX(`(?:\\b(?:at|for)\\s+|@\\s*|\\b)(${HOUR_W})(?::(\\d{2})|\\s+(\\d{2})|\\s+(${MIN_W}))?\\s*(am|pm)\\b(?:\\s+o'?clock\\b)?`),
      clock: (m) => {
        const h = wordNum(m[1]!);
        const min = m[2] ?? m[3] ? Number(m[2] ?? m[3]) : m[4] ? wordNum(m[4]) : 0;
        if (h === undefined || h < 1 || h > 12 || min === undefined || min > 59) return undefined;
        return { hour: (h % 12) + (m[5]!.toLowerCase() === 'pm' ? 12 : 0), minute: min, exact: true };
      },
    },
    {
      re: /(?:\b(?:at)\s+|@\s*|\b)(?:(noon|midday)|(midnight))\b/i,
      clock: (m) => ({ hour: m[1] ? 12 : 0, minute: 0, exact: true }),
    },
    {
      re: /(?:\b(?:at)\s+|@\s*|\b)(\d{1,2}):(\d{2})\b(?:\s+o'?clock\b)?/i,
      clock: (m) => {
        const h = Number(m[1]);
        const min = Number(m[2]);
        if (h > 23 || min > 59) return undefined;
        return { hour: h, minute: min, exact: h === 0 || h > 12 || m[1]!.startsWith('0') };
      },
    },
    {
      re: RX(`(?:\\b(?:at)\\s+|@\\s*)(${HOUR_W})(?:\\s+(${MIN_W}))?(?:\\s+o'?clock)?\\b`),
      clock: (m) => bare(m[1]!, m[2]),
    },
    {
      re: RX(`\\b(${HOUR_W})(?:\\s+(${MIN_W}))?\\s+o'?clock\\b`),
      clock: (m) => bare(m[1]!, m[2]),
    },
  ];
}
const CLOCK_RX = clockRx();

function bare(hour: string, minute: string | undefined): Clock | undefined {
  const h = wordNum(hour);
  const min = minute ? wordNum(minute) : 0;
  if (h === undefined || h > 23 || min === undefined) return undefined;
  return { hour: h, minute: min, exact: h === 0 || h > 12 };
}

function hourChoices(c: Clock, pod: Pod | undefined, preferMorning: boolean): number[] {
  if (c.exact) return [c.hour];
  const h = c.hour % 12;
  if (pod === 'morning') return [h];
  if (pod) return [h + 12];
  if (preferMorning) return [h];
  const set = [h, h + 12];
  const inWindow = set.filter((x) => x >= 7 && x <= 22);
  return inWindow.length ? inWindow : set;
}

function consume(work: string, m: RegExpExecArray): string {
  return `${work.slice(0, m.index)} ${work.slice(m.index + m[0].length)}`;
}

export function extractDateTime(text: string, ref: Date, timeZone: string, opts: DateTimeOptions): DateTimeResult {
  let work = text;
  let unparsed = RECURRING.test(text);
  const fail = () => { unparsed = true; };

  let relMs: number | undefined;
  let relDays = false;
  for (const r of REL_RX) {
    const m = r.re.exec(work);
    if (!m) continue;
    relMs = r.ms(m);
    relDays = /^(?:d|w)/i.test(m[2] ?? '');
    if (relMs === undefined) fail();
    work = consume(work, m);
    break;
  }

  let durationMs: number | undefined;
  if (opts.mode !== 'reminder') {
    for (const r of DUR_RX) {
      const m = r.re.exec(work);
      if (!m) continue;
      durationMs = r.ms(m);
      if (durationMs === undefined) fail();
      work = consume(work, m);
      break;
    }
    if (opts.mode === 'timer' && durationMs === undefined && relMs === undefined) {
      const m = TIMER_BARE_RX.exec(work);
      if (m) { durationMs = mul(m[1], m[2]); work = consume(work, m); }
    }
  }

  let date: DateSpec | undefined;
  let pod: Pod | undefined;
  for (const r of DATE_RX) {
    const m = r.re.exec(work);
    if (!m) continue;
    const s = r.spec(m);
    if (!s) fail();
    else { date = s.date; pod = s.pod; }
    work = consume(work, m);
    break;
  }
  if (!pod) {
    const m = POD_RX.exec(work);
    if (m) { pod = (m[1] ?? m[2])!.toLowerCase() as Pod; work = consume(work, m); }
  }

  let clock: Clock | undefined;
  for (const r of CLOCK_RX) {
    const m = r.re.exec(work);
    if (!m) continue;
    clock = r.clock(m);
    if (!clock) fail();
    work = consume(work, m);
    break;
  }

  if (hasTimeLike(work, opts.mode)) fail();

  const result = (at: Date | undefined, hasClock: boolean): DateTimeResult => {
    if (at && (!Number.isFinite(at.getTime()) || at.getTime() <= ref.getTime() || at.getTime() - ref.getTime() > MAX_AHEAD_MS)) {
      unparsed = true;
      at = undefined;
    }
    return { at, durationMs: opts.mode === 'event' ? durationMs : undefined, hasClock, rest: work, unparsed };
  };

  // Timer: a spoken length is the fire offset.
  if (opts.mode === 'timer' && durationMs !== undefined) {
    if (relMs !== undefined || date || pod || clock) fail();
    return result(new Date(ref.getTime() + durationMs), true);
  }
  if (opts.mode === 'event' && durationMs !== undefined && (durationMs < MINUTE || durationMs > DAY_MS)) fail();

  if (relMs !== undefined) {
    if (!relDays) {
      if (date || pod || clock) fail();
      return result(new Date(ref.getTime() + relMs), true);
    }
    if (date) fail();
    date = { kind: 'offset', days: relMs / DAY_MS };
  }

  if (!date && !pod && !clock) return result(undefined, false);

  const hours = clock ? hourChoices(clock, pod, opts.preferMorning === true) : [pod ? POD_HOUR[pod] : 9];
  const minute = clock?.minute ?? 0;
  const now = zonedParts(ref, timeZone);
  const day = (n: number) => {
    const d = new Date(Date.UTC(now.year, now.month - 1, now.day + n));
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
  };
  const pick = (ymd: { y: number; mo: number; d: number }): Date | undefined =>
    hours.map((h) => zonedTime(ymd.y, ymd.mo, ymd.d, h, minute, timeZone)).filter((t) => t.getTime() > ref.getTime())
      .sort((a, b) => a.getTime() - b.getTime())[0];

  let at: Date | undefined;
  if (!date) {
    // Bare time (or "in the evening"): next occurrence, rolling a past time forward one day.
    at = pick(day(0)) ?? pick(day(1));
  } else if (date.kind === 'offset') {
    at = pick(day(date.days));
  } else if (date.kind === 'weekday') {
    let d = (date.wd - now.weekday + 7) % 7;
    if (date.next && d === 0) d = 7;
    at = pick(day(d)) ?? (d === 0 ? pick(day(7)) : undefined);
  } else {
    const valid = (y: number) => date.kind === 'md' && date.day <= new Date(Date.UTC(y, date.month, 0)).getUTCDate();
    const y0 = date.year ?? now.year;
    at = valid(y0) ? pick({ y: y0, mo: date.month, d: date.day }) : undefined;
    if (!at && date.year === undefined && valid(y0 + 1)) at = pick({ y: y0 + 1, mo: date.month, d: date.day });
  }
  if (!at) fail();
  return result(at, clock !== undefined);
}
