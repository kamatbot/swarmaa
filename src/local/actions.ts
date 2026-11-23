// Local action executor (docs/RING-AGENT.md §5.1–5.3, §5.7, §7, §8.1). Reminders, Calendar and timers run the fixed
// JXA script in ./jxa.ts through /usr/bin/osascript (no shell, JSON on stdin); notes go to ./notebook.ts.
// Runs and undos go to one persistent osascript helper (the same script in loop mode, line-delimited JSON) so each
// action skips the 0.2–0.4 s osascript cold start; any helper failure falls back to a one-shot execFile for that request.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { redactSecrets } from '../safety/redact.js';
import { LIMITS, type LocalAction, type LocalActionCode, type LocalActionResult, type LocalActionRunner, type LocalActionRunnerOptions, type LocalActionRunOptions, type LocalApp, type LocalAppState } from '../voice/types.js';
import { JXA_SCRIPT } from './jxa.js';
import { appendNote, checkNotebook, NOTEBOOKS, NotebookError, notesRoot, removeNote, type Notebook } from './notebook.js';

export const OSASCRIPT = '/usr/bin/osascript';
export const RUN_TIMEOUT_MS = 8000;
/** `check` is the attended first run: osascript blocks while macOS shows the Automation prompt. */
export const CHECK_TIMEOUT_MS = 60000;
export const MAX_OUTPUT = 64 * 1024;
/** The helper exits after this long without a request. */
export const HELPER_IDLE_MS = 10 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/;
const CODES: readonly LocalActionCode[] = ['permission_denied', 'action_disabled', 'timeout', 'unavailable', 'failed'];
const APPS: readonly LocalApp[] = ['reminders', 'calendar', 'notes'];
const MAX_EVENT_MS = 31 * 86400000;

type Exec = NonNullable<LocalActionRunnerOptions['exec']>;
export interface LocalRunnerOptions extends LocalActionRunnerOptions {
  /** Defaults to process.platform; tests set it to exercise the darwin/non-darwin paths. */
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  checkTimeoutMs?: number;
  /**
   * Starts the persistent helper (`osascript … loop`). Default: the real osascript on darwin when no `exec` is injected;
   * with `exec` injected and no `spawn`, every request is one-shot. With both, `exec` is the one-shot fallback.
   */
  spawn?: () => ChildProcess;
  helperIdleMs?: number;
}

/** Thrown (or rejected) by an exec to say the subprocess was killed for running too long. */
export class ExecTimeout extends Error { constructor() { super('osascript timed out'); this.name = 'ExecTimeout'; } }

/** Real executor: no shell, minimal env (no service tokens), SIGKILL on timeout, bounded stdout. */
export function osascriptExec(timeoutMs: number): Exec {
  return (script, stdin) => new Promise((resolve, reject) => {
    const child = execFile(OSASCRIPT, ['-l', 'JavaScript', '-e', script], { env: { PATH: '/usr/bin:/bin' }, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, code: 0 });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: unknown };
      if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ stdout: '', code: 1 });
      if (e.killed || e.signal === 'SIGKILL') return reject(new ExecTimeout());
      // An uncaught osascript error (e.g. -1743 before our try/catch) only reaches stderr; keep its last line for classification.
      resolve({ stdout: stdout || String(stderr ?? '').trim().split('\n').pop()?.slice(0, 1024) || '', code: typeof e.code === 'number' ? e.code : 1 });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
  });
}

/** Real helper: same fixed script in loop mode, same minimal env, no shell; stderr discarded. */
export function spawnOsascriptHelper(): ChildProcess {
  return spawn(OSASCRIPT, ['-l', 'JavaScript', '-e', JXA_SCRIPT, 'loop'], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
}

/** The helper broke (spawn failure, exit, broken pipe, protocol error): the request falls back to one-shot. */
class HelperFailure extends Error { constructor(m: string) { super(m); this.name = 'HelperFailure'; } }

/** Request lines are ASCII-only JSON so the JXA side can split reads anywhere. */
const asciiJson = (v: unknown) => JSON.stringify(v).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/**
 * One persistent osascript child. Requests are serialized by the caller (one pending at a time). A request that runs
 * past its limit SIGKILLs the child (the next request respawns it); a child that sits idle is closed.
 */
function createHelper(start: () => ChildProcess, idleMs: number) {
  let child: ChildProcess | undefined, buf = Buffer.alloc(0), idle: NodeJS.Timeout | undefined;
  let pending: { resolve: (line: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | undefined;
  const settle = (fn: (p: NonNullable<typeof pending>) => void) => {
    const p = pending; if (!p) return;
    pending = undefined; clearTimeout(p.timer); fn(p);
    idle = setTimeout(close, idleMs); idle.unref?.();
  };
  const kill = (c: ChildProcess) => { try { c.kill('SIGKILL'); } catch { /* already gone */ } };
  function drop(c: ChildProcess | undefined, why: string, exited = false) {
    if (!c) return;
    if (child === c) { child = undefined; buf = Buffer.alloc(0); settle(p => p.reject(new HelperFailure(why))); }
    if (!exited) kill(c);
  }
  function close() {
    const c = child; if (!c || pending) return;
    child = undefined; buf = Buffer.alloc(0);
    try { c.stdin?.end(); } catch { /* ignore */ }
    const t = setTimeout(() => kill(c), 1000); t.unref?.();
  }
  function ensure(): ChildProcess {
    if (child) return child;
    const c = start();
    child = c; buf = Buffer.alloc(0);
    c.on('error', () => drop(c, 'helper error'));
    c.on('exit', () => drop(c, 'helper exited', true));
    c.stdin?.on('error', () => drop(c, 'helper stdin'));
    c.stdout?.on('data', (chunk: Buffer) => {
      if (child !== c) return;
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
      for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10)) {
        const line = buf.subarray(0, nl).toString('utf8').trim(); buf = buf.subarray(nl + 1);
        if (!line) continue;
        if (!pending) return drop(c, 'unsolicited output');
        settle(p => p.resolve(line));
      }
      if (buf.length > MAX_OUTPUT) drop(c, 'oversized output');
    });
    // The helper never keeps the service's event loop alive.
    c.unref?.(); (c.stdin as { unref?: () => void } | null)?.unref?.(); (c.stdout as { unref?: () => void } | null)?.unref?.();
    return c;
  }
  return {
    request(line: string, limitMs: number): Promise<string> {
      return new Promise((resolve, reject) => {
        if (pending) return reject(new HelperFailure('helper busy'));
        clearTimeout(idle);
        let c: ChildProcess;
        try { c = ensure(); } catch { return reject(new HelperFailure('helper spawn failed')); }
        const timer = setTimeout(() => {
          if (pending?.timer !== timer) return;
          pending = undefined;
          if (child === c) { child = undefined; buf = Buffer.alloc(0); }
          kill(c); // respawned by the next request
          reject(new ExecTimeout());
        }, limitMs);
        pending = { resolve, reject, timer };
        try { c.stdin!.write(line + '\n'); } catch { drop(c, 'helper stdin'); }
      });
    },
    /** Spawns the child ahead of the first request (osascript cold start off the action path). */
    prestart(): void {
      if (child) return;
      try { ensure(); } catch { return; }
      clearTimeout(idle); idle = setTimeout(close, idleMs); idle.unref?.();
    },
    reset(): void { drop(child, 'reset'); },
  };
}

// ---------------------------------------------------------------------------------------------------- validation
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const HAS_CONTROL = new RegExp(CONTROL.source);
const clean = (s: string) => redactSecrets(s.replace(CONTROL, '').replace(/\r\n?/g, '\n'));
const line = (s: string) => clean(s).replace(/\s+/g, ' ').trim();
function text(v: unknown, max: number, single: boolean, required: boolean): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || v.length > max * 2) throw new Error('invalid text');
  const out = single ? line(v) : clean(v).trim();
  if (out.length > max || (required && !out)) throw new Error('invalid text');
  return out || undefined;
}
function iso(v: unknown): string {
  if (typeof v !== 'string' || !ISO.test(v) || !Number.isFinite(Date.parse(v))) throw new Error('invalid time');
  return new Date(v).toISOString();
}
function keys(v: Record<string, unknown>, allowed: string[]) { for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new Error('extra key'); }

/** Defensive re-validation (the service validated too): closed keys, bounded text, canonical UTC times. */
export function normalizeAction(value: unknown): LocalAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid action');
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'reminder.create': {
      keys(v, ['type', 'title', 'due_at', 'notes', 'list']);
      if (v.list !== undefined && v.list !== 'default' && v.list !== 'todo') throw new Error('invalid list');
      const a: LocalAction = { type: 'reminder.create', title: text(v.title, LIMITS.title, true, true)! };
      if (v.due_at !== undefined) a.due_at = iso(v.due_at);
      const notes = text(v.notes, LIMITS.notes, false, false); if (notes) a.notes = notes;
      if (v.list) a.list = v.list as 'default' | 'todo';
      return a;
    }
    case 'event.create': {
      keys(v, ['type', 'title', 'start_at', 'end_at', 'all_day', 'location', 'notes']);
      if (v.all_day !== undefined && typeof v.all_day !== 'boolean') throw new Error('invalid all_day');
      const a: LocalAction = { type: 'event.create', title: text(v.title, LIMITS.title, true, true)!, start_at: iso(v.start_at), end_at: iso(v.end_at) };
      const span = Date.parse(a.end_at) - Date.parse(a.start_at);
      if (span < 0 || span > MAX_EVENT_MS) throw new Error('invalid span');
      if (v.all_day !== undefined) a.all_day = v.all_day as boolean;
      const location = text(v.location, LIMITS.title, true, false); if (location) a.location = location;
      const notes = text(v.notes, LIMITS.notes, false, false); if (notes) a.notes = notes;
      return a;
    }
    case 'note.append': {
      keys(v, ['type', 'text', 'notebook', 'title']);
      if (v.notebook !== undefined && !NOTEBOOKS.includes(v.notebook as Notebook)) throw new Error('invalid notebook');
      const a: LocalAction = { type: 'note.append', text: text(v.text, LIMITS.text, false, true)! };
      if (v.notebook) a.notebook = v.notebook as Notebook;
      const title = text(v.title, LIMITS.title, true, false); if (title) a.title = title;
      return a;
    }
    case 'timer.start':
    {
      // kind (timer|alarm) only matters on the iPhone; JXA always makes a reminder due at fire_at.
      keys(v, ['type', 'label', 'fire_at', 'kind']);
      if (v.kind !== undefined && v.kind !== 'timer' && v.kind !== 'alarm') throw new Error('invalid kind');
      const a: LocalAction = { type: 'timer.start', label: text(v.label, LIMITS.title, true, true)!, fire_at: iso(v.fire_at) };
      if (v.kind) a.kind = v.kind as 'timer' | 'alarm';
      return a;
    }
    default: throw new Error('invalid type');
  }
}

// ---------------------------------------------------------------------------------------------------- summaries
const APP_OF: Record<LocalAction['type'], LocalApp> = { 'reminder.create': 'reminders', 'timer.start': 'reminders', 'event.create': 'calendar', 'note.append': 'notes' };
const APP_NAME: Record<LocalApp, string> = { reminders: 'Reminders', calendar: 'Calendar', notes: 'Notes' };
const VERB: Record<LocalAction['type'], [run: string, undo: string]> = {
  'reminder.create': ['set the reminder', 'remove the reminder'],
  'event.create': ['add the event', 'remove the event'],
  'note.append': ['save the note', 'remove the note'],
  'timer.start': ['set the timer', 'cancel the timer'],
};
const DETAIL: Record<string, string> = {
  list_not_found: 'the configured Reminders list was not found',
  calendar_not_found: 'the configured calendar was not found',
  no_writable_calendar: 'no writable calendar was found',
  handle_mismatch: 'the item no longer matches this action',
  bad_input: 'the request was invalid',
};
const clip = (s: string, n = 80) => s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function validZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); return zone; } catch { return undefined; }
}
function ymd(d: Date, timeZone?: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function nextDay(key: string): string { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10); }
function hm(d: Date, timeZone?: string): string { return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d); }
function day(d: Date, now: Date, timeZone?: string): string {
  const key = ymd(d, timeZone), today = ymd(now, timeZone);
  if (key === today) return 'Today';
  if (key === nextDay(today)) return 'Tomorrow';
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(d).replace(/,/g, '');
}
const at = (d: Date, now: Date, tz?: string) => `${day(d, now, tz)} ${hm(d, tz)}`;

export function successSummary(a: LocalAction, now: Date, tz?: string): string {
  switch (a.type) {
    case 'reminder.create': return `${a.list === 'todo' ? 'To-do added' : 'Reminder set'}: ${clip(a.title)}${a.due_at ? ' · ' + at(new Date(a.due_at), now, tz) : ''}`;
    case 'timer.start': {
      const f = new Date(a.fire_at);
      return `${a.kind === 'alarm' ? 'Alarm' : 'Timer'} set: ${clip(a.label)} · ${ymd(f, tz) === ymd(now, tz) ? hm(f, tz) : at(f, now, tz)}`;
    }
    case 'event.create': {
      const s = new Date(a.start_at), e = new Date(a.end_at);
      if (a.all_day) {
        const last = new Date(Math.max(s.getTime(), e.getTime() - 1));
        return `Event added: ${clip(a.title)} · ${day(s, now, tz)}${ymd(last, tz) !== ymd(s, tz) ? '–' + day(last, now, tz) : ''} (all day)`;
      }
      const span = ymd(s, tz) === ymd(e, tz) ? `${at(s, now, tz)}–${hm(e, tz)}` : `${at(s, now, tz)} – ${at(e, now, tz)}`;
      return `Event added: ${clip(a.title)} · ${span}`;
    }
    case 'note.append': return `Noted in ${capital(a.notebook ?? 'inbox')}: ${clip(a.title || a.text.replace(/\s+/g, ' ').trim())}`;
  }
}
export function undoSummary(a: LocalAction): string {
  switch (a.type) {
    case 'reminder.create': return `${a.list === 'todo' ? 'To-do removed' : 'Reminder removed'}: ${clip(a.title)}`;
    case 'timer.start': return `${a.kind === 'alarm' ? 'Alarm' : 'Timer'} cancelled: ${clip(a.label)}`;
    case 'event.create': return `Event removed: ${clip(a.title)}`;
    case 'note.append': return `Note removed from ${capital(a.notebook ?? 'inbox')}: ${clip(a.title || a.text.replace(/\s+/g, ' ').trim())}`;
  }
}
function reason(code: LocalActionCode, app: LocalApp, detail?: string): string {
  const name = APP_NAME[app];
  switch (code) {
    case 'permission_denied': return `Swarmaa needs ${name} access (System Settings › Privacy & Security › Automation)`;
    case 'action_disabled': return `${name} actions are turned off (SWARMAA_LOCAL_ACTIONS)`;
    case 'timeout': return `${name} didn't respond in time`;
    case 'unavailable': return `${name} actions need the Swarmaa service running on a Mac`;
    case 'failed': return (detail && DETAIL[detail]) || `${name} reported an error`;
  }
}
const failure = (type: LocalAction['type'] | undefined, undo: boolean, code: LocalActionCode, detail?: string): LocalActionResult => ({
  ok: false, code,
  summary: type ? `Couldn't ${VERB[type][undo ? 1 : 0]}: ${reason(code, APP_OF[type], detail)}` : `Couldn't run that action: ${detail ?? 'the request was invalid'}`,
});

// ---------------------------------------------------------------------------------------------------- runner
interface Parsed { ok: boolean; code: LocalActionCode; handle?: string; detail?: string; apps?: Record<string, string> }
function parseOutput(stdout: string, exitCode: number): Parsed {
  const last = stdout.trim().split('\n').pop() ?? '';
  let v: any;
  try { v = JSON.parse(last); } catch { v = undefined; }
  if (!v || typeof v !== 'object' || typeof v.ok !== 'boolean') {
    return { ok: false, code: /-1743|not (allowed|authori[sz]ed)/i.test(last) ? 'permission_denied' : 'failed' };
  }
  if (v.ok && exitCode === 0) {
    const handle = typeof v.handle === 'string' && v.handle.length > 0 && v.handle.length <= 512 ? v.handle : undefined;
    const apps = v.apps && typeof v.apps === 'object' ? v.apps : undefined;
    return { ok: true, code: 'failed', handle, apps };
  }
  let code: LocalActionCode = CODES.includes(v.code) ? v.code : 'failed';
  if (v.error_number === -1743) code = 'permission_denied';
  return { ok: false, code, detail: typeof v.detail === 'string' && v.detail in DETAIL ? v.detail : undefined };
}

function enabledApps(env: NodeJS.ProcessEnv): Set<LocalApp> {
  const raw = env.SWARMAA_LOCAL_ACTIONS;
  if (raw === undefined) return new Set(APPS);
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter((s): s is LocalApp => (APPS as readonly string[]).includes(s)));
}
const bounded = (v: string | undefined) => { const s = v?.trim(); return s && s.length <= 200 ? s : undefined; };

export function createLocalActionRunner(opts: LocalRunnerOptions = {}): LocalActionRunner {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS, checkTimeoutMs = opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  const exec = opts.exec ?? osascriptExec(timeoutMs);
  const checkExec = opts.exec ?? osascriptExec(checkTimeoutMs);
  const spawnHelper = opts.spawn ?? (!opts.exec && platform === 'darwin' ? spawnOsascriptHelper : undefined);
  const helper = spawnHelper ? createHelper(spawnHelper, opts.helperIdleMs ?? HELPER_IDLE_MS) : undefined;
  const enabled = enabledApps(env);
  const tz = validZone(env.SWARMAA_TIME_ZONE);
  const config = { reminders_list: bounded(env.SWARMAA_REMINDERS_LIST), todo_list: bounded(env.SWARMAA_TODO_LIST), calendar: bounded(env.SWARMAA_CALENDAR_NAME) };
  /** Apps whose last check (or last run) was ok: the only ones warm() may launch. */
  const reachable = new Set<LocalApp>();
  const note = (app: LocalApp, ok: boolean) => { if (ok) reachable.add(app); else reachable.delete(app); };

  // One run/undo at a time through the helper; notebook writes have their own queue so a slow Apple app never delays
  // a note, and `check` (up to 60 s while macOS shows the Automation prompt) has its own so it never holds runs.
  const queue = () => { let tail: Promise<unknown> = Promise.resolve(); return <T>(fn: () => Promise<T>): Promise<T> => { const p = tail.then(fn, fn); tail = p.catch(() => {}); return p; }; };
  const jxaQueue = queue(), noteQueue = queue(), checkQueue = queue();

  async function oneShot(request: object, limitMs: number, run: Exec): Promise<Parsed> {
    let timer: NodeJS.Timeout | undefined;
    // Backstop for an exec that never settles (the real one SIGKILLs at limitMs): keeps the queue moving.
    const backstop = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ExecTimeout()), limitMs + 1000); });
    try {
      const out = await Promise.race([run(JXA_SCRIPT, JSON.stringify(request)), backstop]);
      return parseOutput(String(out.stdout ?? '').slice(0, MAX_OUTPUT), out.code);
    } catch (e: any) {
      const timedOut = e instanceof ExecTimeout || e?.killed || e?.signal === 'SIGKILL' || e?.code === 'ETIMEDOUT';
      return { ok: false, code: timedOut ? 'timeout' : 'failed' } as Parsed;
    } finally { clearTimeout(timer); }
  }

  /** Runs/undos (and warm reads): helper first; a helper failure retries one-shot, a helper timeout is final. */
  function jxa(request: { op: string; fresh?: boolean } & Record<string, unknown>): Promise<Parsed> {
    return jxaQueue(async () => {
      if (helper) {
        try {
          const line = await helper.request(asciiJson(request), timeoutMs);
          let v: unknown; try { v = JSON.parse(line); } catch { v = undefined; }
          if (v && typeof v === 'object' && typeof (v as { ok?: unknown }).ok === 'boolean') return parseOutput(line, 0);
          helper.reset();
        } catch (e) {
          // A timed-out run may have reached the app: no second attempt here (the sweep retries, with the marker lookup).
          if (e instanceof ExecTimeout) return { ok: false, code: 'timeout' } as Parsed;
        }
        // The request may have reached the helper before it broke: the fallback always does the marker lookup.
        const { fresh: _fresh, ...rest } = request;
        return oneShot(rest, timeoutMs, exec);
      }
      return oneShot(request, timeoutMs, exec);
    });
  }

  async function notebook(type: LocalAction['type'], undo: boolean, fn: (root: string) => Promise<LocalActionResult>): Promise<LocalActionResult> {
    try { return await noteQueue(() => fn(notesRoot(env))); }
    catch (e) {
      const detail = e instanceof NotebookError ? (e.reason === 'unsafe' ? 'the notes folder or file is not owner-only or is a symlink' : e.reason === 'too_large' ? 'the notes file is too large' : 'the notes location is invalid') : 'the notes file could not be written';
      return { ok: false, code: 'failed', summary: `Couldn't ${VERB[type][undo ? 1 : 0]}: ${detail}` };
    }
  }

  function gate(id: string, value: unknown, undo: boolean): { action: LocalAction } | { result: LocalActionResult } {
    let action: LocalAction;
    try { if (!ID.test(id)) throw new Error('invalid id'); action = normalizeAction(value); }
    catch { return { result: failure((value as any)?.type in APP_OF ? (value as any).type : undefined, undo, 'failed', 'bad_input') }; }
    const app = APP_OF[action.type];
    if (!enabled.has(app)) return { result: failure(action.type, undo, 'action_disabled') };
    if (app !== 'notes' && platform !== 'darwin') return { result: failure(action.type, undo, 'unavailable') };
    return { action };
  }

  let warming: Promise<void> | undefined;
  async function warmApps(): Promise<void> {
    if (platform !== 'darwin') return;
    helper?.prestart();
    // One cheap read per app, each its own queue entry, so a run that arrives meanwhile goes before the next launch.
    for (const app of ['reminders', 'calendar'] as const) {
      if (!enabled.has(app) || !reachable.has(app)) continue;
      const out = await jxa({ op: 'check', apps: [app], config });
      if (!out.ok || (out.apps?.[app] !== undefined && out.apps[app] !== 'ok')) note(app, false);
    }
  }

  return {
    async run(id, value, runOpts?: LocalActionRunOptions) {
      const g = gate(id, value, false); if ('result' in g) return g.result;
      const action = g.action, at = now(), zone = validZone(runOpts?.timeZone) ?? tz;
      if (action.type === 'note.append') {
        return notebook(action.type, false, async root => {
          const r = await appendNote(root, id, action, at, tz);
          return { ok: true, handle: r.handle, summary: successSummary(action, at, zone) };
        });
      }
      const out = await jxa({ op: 'run', id, action, fresh: runOpts?.fresh === true, config });
      if (out.ok || out.code === 'permission_denied') note(APP_OF[action.type], out.ok);
      if (!out.ok) return failure(action.type, false, out.code, out.detail);
      if (!out.handle) return failure(action.type, false, 'failed');
      return { ok: true, handle: out.handle, summary: successSummary(action, at, zone) };
    },
    async undo(id, value, handle) {
      const g = gate(id, value, true); if ('result' in g) return g.result;
      const action = g.action;
      if (typeof handle !== 'string' || !handle || handle.length > 512 || HAS_CONTROL.test(handle)) return failure(action.type, true, 'failed', 'bad_input');
      if (action.type === 'note.append') {
        return notebook(action.type, true, async root => { await removeNote(root, id, handle); return { ok: true, handle, summary: undoSummary(action) }; });
      }
      const out = await jxa({ op: 'undo', id, action, handle, config });
      if (!out.ok) return failure(action.type, true, out.code, out.detail);
      return { ok: true, handle, summary: undoSummary(action) };
    },
    async check() {
      const result: Record<LocalApp, LocalAppState> = { reminders: 'disabled', calendar: 'disabled', notes: 'disabled' };
      if (enabled.has('notes')) {
        try { await noteQueue(() => checkNotebook(notesRoot(env))); result.notes = 'ok'; } catch { result.notes = 'permission_denied'; }
      }
      const apps = (['reminders', 'calendar'] as const).filter(a => enabled.has(a));
      if (apps.length && platform === 'darwin') {
        // Always one-shot with the long timeout, on its own queue: the attended prompt never blocks a spoken action.
        const out = await checkQueue(() => oneShot({ op: 'check', apps, config }, checkTimeoutMs, checkExec));
        // LocalAppState has no "failed": anything but a confirmed ok means the owner must look at Automation settings.
        for (const a of apps) { result[a] = out.ok && out.apps?.[a] === 'ok' ? 'ok' : 'permission_denied'; note(a, result[a] === 'ok'); }
      }
      return result;
    },
    warm() {
      return warming ??= warmApps().catch(() => {}).finally(() => { warming = undefined; });
    },
  };
}
