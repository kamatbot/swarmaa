// Deterministic voice-memo intent parser and local-action validator (docs/RING-AGENT.md §4.1, §8.1). Pure: time
// comes only from input.spokenAt, the zone from input.timeZone. Transcripts are untrusted; anything ambiguous goes
// to the Assistant rather than guessing.
import { LIMITS, type Intent, type IntentInput, type LocalAction } from './types.js';
import { extractDateTime, hasTimeLike, isValidTimeZone, type DateTimeMode } from './datetime.js';

const MEETING_SECONDS = 120;
const DEFAULT_EVENT_MS = 30 * 60_000;

type Kind = 'reminder' | 'todo' | 'event' | 'note' | 'timer' | 'alarm' | 'wake';
interface Trigger { src: string; re: RegExp; kind: Kind }

const B = '(?=$|[\\s,.:;!?-])';
const T = (src: string, kind: Kind): Trigger => ({ src, re: new RegExp(`^(?:${src})${B}`, 'i'), kind });

// Longest/most specific first; connectors ("to", "about", "that") are stripped from the title afterwards.
const TRIGGERS: Trigger[] = [
  T(`set\\s+(?:a\\s+|an\\s+)?reminder`, 'reminder'),
  T(`(?:do\\s+not|don't|dont)\\s+let\\s+me\\s+forget`, 'reminder'),
  T(`remind\\s+me`, 'reminder'),
  T(`reminder`, 'reminder'),
  T(`add\\s+(?:a\\s+|an\\s+|to\\s+my\\s+)?(?:todo|to-do|to\\s+do|task)(?:\\s+list)?`, 'todo'),
  T(`(?:todo|to-do|to\\s+do|task)`, 'todo'),
  T(`(?:add|create|make)\\s+(?:a\\s+|an\\s+)?(?:new\\s+)?(?:calendar\\s+)?event`, 'event'),
  T(`schedule`, 'event'),
  T(`calendar`, 'event'),
  T(`book`, 'event'),
  T(`note\\s+to\\s+self`, 'note'),
  T(`(?:take|make)\\s+a\\s+note(?:\\s+that)?`, 'note'),
  T(`jot\\s+down`, 'note'),
  T(`remember\\s+that`, 'note'),
  T(`memo`, 'note'),
  T(`notes?`, 'note'),
  T(`idea`, 'note'),
  T(`(?:set|start)\\s+(?:a\\s+|an\\s+)?timer`, 'timer'),
  T(`timer`, 'timer'),
  T(`(?:set\\s+(?:an\\s+|a\\s+)?)?alarm`, 'alarm'),
  T(`wake\\s+me(?:\\s+up)?`, 'wake'),
];
// "put/add <title> on/to my calendar": the trigger wraps the title.
const CALENDAR_WRAP = /^(?:put|add)\s+(.+?)\s+(?:on|in|into|to)\s+(?:my|the)\s+calendar\b(.*)$/is;

const SECOND_TRIGGER = new RegExp(
  `\\b(?:and|also)\\s+(?:also\\s+|then\\s+)?(?:${TRIGGERS.map((t) => t.src).join('|')}|put\\s.+\\s(?:on|in)\\s+(?:my|the)\\s+calendar)${B}`,
  'i',
);
const TIMER_FIRST = /^(?:(?:set|start)\s+(?:a\s+|an\s+)?)?([\w]+)[- ](second|minute|hour)s?\s+timer(?=$|[\s,.:;!?-])/i;
const MEETING = /^(?:summari[sz]e|summary|recap|meeting\s+notes|notes\s+(?:from|of|for)\s+(?:the|my|this|today's)\s+meeting)(?=$|[\s,.:;!?-])/i;
const DELEGATE = /^(?:ask|tell|have|get)\s+(.+)$/is;
const LEAD = /^(?:(?:hey|ok|okay)\s+(?:assistant|swarmaa)\b|(?:can|could|would|will)\s+you|please|um+|uh+|er+|so|ok|okay|well|alright|all\s+right|hey)(?=$|[\s,.:;!?-])[\s,.:;!?-]*/i;
const ASSISTANT_NAME = 'assistant';

const assistant = (hint: 'freeform' | 'multi' | 'unparsed_time' | 'meeting' | 'no_transcript'): Intent => ({ route: 'assistant', hint });

function normalize(s: string): string {
  return s
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\b([ap])\.\s?m\b\.?/gi, (_m, p: string) => `${p.toLowerCase()}m`)
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLead(s: string): string {
  let prev: string;
  do { prev = s; s = s.replace(LEAD, ''); } while (s !== prev && s);
  return s.replace(/[\s,]+please[.!]*$/i, '').trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Title cleanup: drop leftover connectors and punctuation from consumed phrases, capitalize the first letter. */
export function tidyTitle(raw: string, opts: { articles?: boolean } = {}): string {
  let t = raw.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])(?:\s*[,;:])+/g, '$1');
  const lead = opts.articles
    ? /^(?:[\s,.;:!?"'\-–—]+|(?:to|about|that|for|and|then|also|is|a|an)\b\s*)/i
    : /^(?:[\s,.;:!?"'\-–—]+|(?:to|about|that|for|and|then|also|is)\b\s*)/i;
  const trail = /(?:[\s,.;:!?"'\-–—]+|\s+(?:to|at|on|for|by|and|about|that|in|from|the))$/i;
  let prev: string;
  do { prev = t; t = t.replace(lead, ''); } while (t !== prev && t);
  do { prev = t; t = t.replace(trail, ''); } while (t !== prev && t);
  t = t.trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : '';
}

function delegate(body: string, bots: IntentInput['bots']): Intent | undefined {
  const lower = body.toLowerCase();
  if (new RegExp(`^${ASSISTANT_NAME}${B}`, 'i').test(body)) return assistant('freeform');
  const named = bots
    .map((b) => ({ id: b.id, name: typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '' }))
    .filter((b) => b.name && b.name.toLowerCase() !== ASSISTANT_NAME && typeof b.id === 'string' && b.id)
    .filter((b) => new RegExp(`^${escapeRe(b.name.toLowerCase())}${B}`).test(lower))
    .sort((a, b) => b.name.length - a.name.length);
  if (!named.length) return undefined;
  const longest = named.filter((b) => b.name.length === named[0]!.name.length);
  if (longest.length !== 1) return assistant('freeform');
  const rest = body.slice(longest[0]!.name.length).replace(/^[\s,.:;!?-]+/, '').replace(/^(?:to|that)\s+/i, '').trim();
  if (!rest || rest.length > LIMITS.text) return assistant('freeform');
  return { route: 'delegate', bot_id: longest[0]!.id, body: rest };
}

function boundTitle(title: string): { title: string; notes?: string } | undefined {
  if (title.length <= LIMITS.title) return { title };
  if (title.length > LIMITS.notes) return undefined;
  const cut = title.slice(0, LIMITS.title - 1);
  const sp = cut.lastIndexOf(' ');
  return { title: `${(sp > LIMITS.title / 2 ? cut.slice(0, sp) : cut).trimEnd()}…`, notes: title };
}

export function parseIntent(input: IntentInput): Intent {
  const transcript = typeof input.transcript === 'string' ? normalize(input.transcript.slice(0, LIMITS.text * 2)) : '';
  if (!transcript.replace(/[\s\p{P}]+/gu, '')) return assistant('no_transcript');
  if (typeof input.durationSeconds === 'number' && input.durationSeconds > MEETING_SECONDS) return assistant('meeting');

  // "set a 15 minute timer for X" → "timer for 15 minutes for X"
  const text = stripLead(transcript).replace(TIMER_FIRST, (_m, n: string, u: string) => `timer for ${n} ${u}s`);
  if (!text) return assistant('freeform');
  if (MEETING.test(text)) return assistant('meeting');

  const dm = DELEGATE.exec(text);
  if (dm) {
    const d = delegate(dm[1]!, Array.isArray(input.bots) ? input.bots : []);
    if (d) return d;
  }

  let kind: Kind | undefined;
  let rest = '';
  const wrap = CALENDAR_WRAP.exec(text);
  if (wrap) { kind = 'event'; rest = `${wrap[1]} ${wrap[2]}`; }
  else {
    for (const t of TRIGGERS) {
      const m = t.re.exec(text);
      if (m) { kind = t.kind; rest = text.slice(m[0].length); break; }
    }
  }
  if (!kind) return assistant('freeform');
  if (SECOND_TRIGGER.test(rest)) return assistant('multi');

  let action: LocalAction | undefined;
  if (kind === 'note') {
    const body = tidyTitle(rest);
    if (!body) return assistant('freeform');
    action = { type: 'note.append', text: body, notebook: 'inbox' };
  } else {
    const mode: DateTimeMode = kind === 'event' ? 'event' : kind === 'reminder' || kind === 'todo' ? 'reminder' : 'timer';
    const ref = input.spokenAt instanceof Date ? input.spokenAt : new Date(NaN);
    if (!isValidTimeZone(input.timeZone) || !Number.isFinite(ref.getTime())) {
      if (mode !== 'reminder' || hasTimeLike(rest, mode)) return assistant('unparsed_time');
    }
    const dt = isValidTimeZone(input.timeZone) && Number.isFinite(ref.getTime())
      ? extractDateTime(rest, ref, input.timeZone, { mode, preferMorning: kind === 'wake' })
      : { rest, unparsed: false, hasClock: false, at: undefined, durationMs: undefined };
    if (dt.unparsed) return assistant('unparsed_time');
    const title = tidyTitle(dt.rest, { articles: kind === 'event' });

    if (mode === 'reminder') {
      const b = boundTitle(title);
      if (!title || !b) return assistant('freeform');
      action = { type: 'reminder.create', title: b.title, ...(dt.at ? { due_at: dt.at.toISOString() } : {}), ...(b.notes ? { notes: b.notes } : {}), ...(kind === 'todo' ? { list: 'todo' as const } : {}) };
    } else if (mode === 'event') {
      if (!dt.at || !dt.hasClock) return assistant('unparsed_time');
      if (!title || title.length > LIMITS.title) return assistant('freeform');
      action = { type: 'event.create', title, start_at: dt.at.toISOString(), end_at: new Date(dt.at.getTime() + (dt.durationMs ?? DEFAULT_EVENT_MS)).toISOString() };
    } else {
      if (!dt.at) return assistant('unparsed_time');
      const label = title || (kind === 'wake' ? 'Wake up' : kind === 'alarm' ? 'Alarm' : 'Timer');
      if (label.length > LIMITS.title) return assistant('freeform');
      // "wake me (up) at" / "alarm at|for" → a fixed-time alarm; timers count down (docs/RING-AGENT.md §11.3).
      action = { type: 'timer.start', label, fire_at: dt.at.toISOString(), kind: kind === 'timer' ? 'timer' : 'alarm' };
    }
  }
  const checked = validateLocalAction(action);
  return typeof checked === 'string' ? assistant('freeform') : { route: 'local', action: checked };
}

// ---- validation (model and client output are untrusted) ----

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_ML = /[\u0000-\u0008\u000b-\u001f\u007f]/;

const KEYS: Record<LocalAction['type'], { required: string[]; optional: string[] }> = {
  'reminder.create': { required: ['title'], optional: ['due_at', 'notes', 'list'] },
  'event.create': { required: ['title', 'start_at', 'end_at'], optional: ['all_day', 'location', 'notes'] },
  'note.append': { required: ['text'], optional: ['notebook', 'title'] },
  'timer.start': { required: ['label', 'fire_at'], optional: ['kind'] },
};

type Field = { ok: true; value: unknown } | { ok: false; reason: string };

function str(o: Record<string, unknown>, key: string, max: number, multiline = false): Field {
  const v = o[key];
  if (typeof v !== 'string') return { ok: false, reason: `${key}_not_string` };
  const s = v.trim();
  if (!s) return { ok: false, reason: `${key}_empty` };
  if (s.length > max) return { ok: false, reason: `${key}_too_long` };
  if ((multiline ? CONTROL_ML : CONTROL).test(s)) return { ok: false, reason: `${key}_control_chars` };
  return { ok: true, value: s };
}

function time(o: Record<string, unknown>, key: string): Field {
  const v = o[key];
  if (typeof v !== 'string' || !ISO_UTC.test(v) || !Number.isFinite(Date.parse(v))) return { ok: false, reason: `${key}_not_iso_utc` };
  const d = new Date(v);
  // Reject calendar-invalid dates that Date.parse would roll over (2026-02-30).
  if (d.toISOString().slice(0, 19) !== v.slice(0, 19)) return { ok: false, reason: `${key}_not_iso_utc` };
  return { ok: true, value: d.toISOString() };
}

function oneOf(o: Record<string, unknown>, key: string, values: readonly string[]): Field {
  return typeof o[key] === 'string' && values.includes(o[key] as string) ? { ok: true, value: o[key] } : { ok: false, reason: `${key}_invalid` };
}

/** Closed-schema check of a local action from any source. Returns a normalized copy, or a refusal reason. */
export function validateLocalAction(value: unknown): LocalAction | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not_object';
  const o = value as Record<string, unknown>;
  if (typeof o.type !== 'string' || !Object.hasOwn(KEYS, o.type)) return 'unknown_type';
  const type = o.type as LocalAction['type'];
  const spec = KEYS[type];
  for (const k of Object.keys(o)) {
    if (k !== 'type' && !spec.required.includes(k) && !spec.optional.includes(k)) return `unknown_key:${k.slice(0, 40)}`;
  }
  for (const k of spec.required) if (o[k] === undefined) return `${k}_required`;
  const has = (k: string) => o[k] !== undefined;
  const out: Record<string, unknown> = { type };
  const take = (k: string, f: Field): string | undefined => {
    if (!f.ok) return f.reason;
    out[k] = f.value;
    return undefined;
  };
  let err: string | undefined;
  switch (type) {
    case 'reminder.create':
      err = take('title', str(o, 'title', LIMITS.title))
        ?? (has('due_at') ? take('due_at', time(o, 'due_at')) : undefined)
        ?? (has('notes') ? take('notes', str(o, 'notes', LIMITS.notes, true)) : undefined)
        ?? (has('list') ? take('list', oneOf(o, 'list', ['default', 'todo'])) : undefined);
      break;
    case 'event.create':
      err = take('title', str(o, 'title', LIMITS.title))
        ?? take('start_at', time(o, 'start_at'))
        ?? take('end_at', time(o, 'end_at'))
        ?? (has('all_day') ? (typeof o.all_day === 'boolean' ? take('all_day', { ok: true, value: o.all_day }) : 'all_day_not_boolean') : undefined)
        ?? (has('location') ? take('location', str(o, 'location', LIMITS.title)) : undefined)
        ?? (has('notes') ? take('notes', str(o, 'notes', LIMITS.notes, true)) : undefined);
      if (!err && Date.parse(out.end_at as string) <= Date.parse(out.start_at as string)) err = 'end_before_start';
      break;
    case 'note.append':
      err = take('text', str(o, 'text', LIMITS.text, true))
        ?? (has('notebook') ? take('notebook', oneOf(o, 'notebook', ['daily', 'inbox', 'meetings'])) : undefined)
        ?? (has('title') ? take('title', str(o, 'title', LIMITS.title)) : undefined);
      break;
    case 'timer.start':
      err = take('label', str(o, 'label', LIMITS.title)) ?? take('fire_at', time(o, 'fire_at'))
        ?? (has('kind') ? take('kind', oneOf(o, 'kind', ['timer', 'alarm'])) : undefined);
      break;
  }
  return err ?? (out as unknown as LocalAction);
}
