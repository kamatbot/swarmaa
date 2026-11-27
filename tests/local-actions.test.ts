import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalActionRunner, ExecTimeout, normalizeAction, type LocalRunnerOptions } from '../src/local/actions.js';
import { JXA_SCRIPT } from '../src/local/jxa.js';
import type { LocalAction } from '../src/voice/types.js';

const ID = '0b6f1c2e-6a3b-4c1d-9e7f-1234567890ab';
const NOW = new Date('2026-11-22T10:00:00Z'); // Sunday
const ENV = { SWARMAA_TIME_ZONE: 'Europe/London', SWARMAA_NOTES_DIR: '/nonexistent-notes-dir-for-tests' };
const reminder: LocalAction = { type: 'reminder.create', title: 'Call mom', due_at: '2026-11-22T17:00:00Z' };
const event: LocalAction = { type: 'event.create', title: 'Dentist', start_at: '2026-12-01T10:00:00Z', end_at: '2026-12-01T10:30:00Z' };
const timer: LocalAction = { type: 'timer.start', label: 'Tea', fire_at: '2026-11-22T17:05:00Z' };

type Call = { script: string; stdin: string };
function fake(reply: (req: any) => unknown, calls: Call[] = []): NonNullable<LocalRunnerOptions['exec']> {
  return async (script, stdin) => { calls.push({ script, stdin }); const r = reply(JSON.parse(stdin)); return typeof r === 'string' ? { stdout: r, code: 0 } : { stdout: JSON.stringify(r) + '\n', code: 0 }; };
}
const runner = (o: LocalRunnerOptions = {}) => createLocalActionRunner({ platform: 'darwin', now: () => NOW, ...o, env: { ...ENV, ...o.env } });

// ---------------------------------------------------------------- in-memory Reminders/Calendar for running the real JXA in vm
const denied = () => Object.assign(new Error('Error: Not authorized to send Apple events to Reminders.'), { errorNumber: -1743 });
const gone = () => Object.assign(new Error("Can't get object."), { errorNumber: -1728 });
function specs<T extends Record<string, any>>(items: T[], fields: string[]) {
  const s: any = { length: items.length };
  items.forEach((it, i) => { s[i] = Object.fromEntries([...fields.map(f => [f, () => it[f]]), ['delete', () => it.delete()]]); });
  for (const f of fields) s[f] = () => items.map(it => it[f]);
  return s;
}
function fakeApps(opts: { deny?: 'reminders' | 'calendar' } = {}) {
  const reminders: any[] = [], events: any[] = []; let n = 0;
  const guard = (app: string) => { if (opts.deny === app) throw denied(); };
  const remList = (name: string) => ({
    name,
    reminders: {
      whose(q: any) { guard('reminders'); return specs(reminders.filter(r => r.list === name && r.body.includes(q.body._contains)), ['id', 'body', 'name']); },
      push(r: any) { guard('reminders'); r.data.id = `x-apple-reminder://${++n}`; r.data.list = name; r.data.delete = () => reminders.splice(reminders.indexOf(r.data), 1); reminders.push(r.data); },
    },
  });
  const lists = ['Reminders', 'Errands'];
  const remindersApp = {
    lists: { whose(q: any) { guard('reminders'); return lists.includes(q.name) ? { length: 1, 0: remList(q.name) } : { length: 0 }; }, get length() { guard('reminders'); return lists.length; } },
    defaultList() { guard('reminders'); return remList('Reminders'); },
    Reminder(props: any) { const data = { ...props }; return { data, id: () => data.id }; },
    reminders: { byId(h: string) { return { body() { guard('reminders'); const r = reminders.find(x => x.id === h); if (!r) throw gone(); return r.body; }, delete() { const r = reminders.find(x => x.id === h); r.delete(); } }; } },
  };
  const cal = (name: string, writable: boolean) => ({
    name: () => name, writable: () => writable,
    events: {
      whose(q: any) {
        guard('calendar');
        const mine = events.filter(e => e.cal === name);
        if (q.uid) return specs(mine.filter(e => e.uid === q.uid), ['uid', 'description']);
        const [lo, hi, d] = q._and;
        return specs(mine.filter(e => e.startDate > lo.startDate._greaterThan && e.startDate < hi.startDate._lessThan && e.description.includes(d.description._contains)), ['uid', 'description']);
      },
      push(ev: any) { guard('calendar'); ev.data.uid = `UID-${++n}`; ev.data.cal = name; ev.data.delete = () => events.splice(events.indexOf(ev.data), 1); events.push(ev.data); },
    },
  });
  const cals = [cal('Birthdays', false), cal('Home', true)];
  const calendarApp = {
    calendars: Object.defineProperties(() => { guard('calendar'); return cals; }, {
      whose: { value: (q: any) => { guard('calendar'); const f = cals.filter(c => c.name() === q.name); return Object.assign({ length: f.length }, f); } },
      length: { get: () => { guard('calendar'); return cals.length; } },
    }),
    Event(props: any) { const data = { ...props }; return { data, uid: () => data.uid }; },
  };
  const exec: NonNullable<LocalRunnerOptions['exec']> = async (script, stdin) => {
    const $ = { NSFileHandle: { fileHandleWithStandardInput: { readDataToEndOfFile: stdin } }, NSString: { alloc: { initWithDataEncoding: (d: string) => d } }, NSUTF8StringEncoding: 4 };
    const ctx = vm.createContext({ ObjC: { import() {}, unwrap: (x: unknown) => x }, $, Application: (name: string) => name === 'Reminders' ? remindersApp : name === 'Calendar' ? calendarApp : undefined });
    new vm.Script(script).runInContext(ctx);
    return { stdout: String(ctx.run()) + '\n', code: 0 };
  };
  return { reminders, events, exec };
}

test('JXA script parses as JavaScript and avoids shell/eval primitives', () => {
  assert.doesNotThrow(() => new vm.Script(JXA_SCRIPT));
  assert.doesNotMatch(JXA_SCRIPT, /doShellScript|\beval\s*\(|new Function|`/);
});

test('reminder: payload goes on stdin only, script is the constant, summary formatted in zone', async () => {
  const calls: Call[] = [];
  const r = await runner({ exec: fake(() => ({ ok: true, handle: 'x-apple-reminder://A' }), calls), env: { SWARMAA_REMINDERS_LIST: 'Errands' } }).run(ID, { ...reminder, notes: 'secret plan' });
  assert.deepEqual(r, { ok: true, handle: 'x-apple-reminder://A', summary: 'Reminder set: Call mom · Today 17:00' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, JXA_SCRIPT);
  assert.ok(!calls[0].script.includes('Call mom') && !calls[0].script.includes('secret plan'));
  const req = JSON.parse(calls[0].stdin);
  assert.equal(req.op, 'run'); assert.equal(req.id, ID); assert.equal(req.action.title, 'Call mom');
  assert.deepEqual(req.config, { reminders_list: 'Errands' });
});

test('real JXA against fake Reminders: marker in body, idempotent rerun, undo deletes', async () => {
  const apps = fakeApps(), r = runner({ exec: apps.exec });
  const first = await r.run(ID, { ...reminder, notes: 'bring cake' });
  assert.equal(first.ok, true);
  assert.equal(apps.reminders.length, 1);
  assert.equal(apps.reminders[0].name, 'Call mom');
  assert.equal(apps.reminders[0].body, `bring cake\n\nswarmaa:${ID}`);
  assert.equal(new Date(apps.reminders[0].dueDate).toISOString(), '2026-11-22T17:00:00.000Z');
  assert.equal(new Date(apps.reminders[0].remindMeDate).toISOString(), '2026-11-22T17:00:00.000Z');
  const again = await r.run(ID, reminder);
  assert.equal(again.handle, first.handle);
  assert.equal(apps.reminders.length, 1, 'rerun must not duplicate');
  const other = await r.run(ID.slice(0, -1), reminder); // id prefix must not match
  assert.notEqual(other.handle, first.handle);
  const undone = await r.undo(ID, reminder, first.handle!);
  assert.deepEqual(undone, { ok: true, handle: first.handle, summary: 'Reminder removed: Call mom' });
  assert.equal(apps.reminders.length, 1);
  assert.equal((await r.undo(ID, reminder, first.handle!)).ok, true, 'undo of a gone reminder is ok');
  const mismatch = await r.undo(ID, reminder, other.handle!);
  assert.equal(mismatch.ok, false); assert.equal(mismatch.code, 'failed');
  assert.match(mismatch.summary, /no longer matches/);
});

test('real JXA: todo list, missing list, timer', async () => {
  const apps = fakeApps();
  const r = runner({ exec: apps.exec, env: { SWARMAA_TODO_LIST: 'Errands' } });
  const todo = await r.run(ID, { type: 'reminder.create', title: 'Buy milk', list: 'todo' });
  assert.equal(todo.summary, 'To-do added: Buy milk');
  assert.equal(apps.reminders[0].list, 'Errands');
  assert.equal(apps.reminders[0].dueDate, undefined);
  const t = await r.run('timer-1', timer);
  assert.equal(t.summary, 'Timer set: Tea · 17:05');
  assert.equal(apps.reminders[1].name, '⏱ Tea');
  assert.equal(apps.reminders[1].list, 'Reminders');
  assert.equal((await r.undo('timer-1', timer, t.handle!)).summary, 'Timer cancelled: Tea');
  const missing = await runner({ exec: apps.exec, env: { SWARMAA_REMINDERS_LIST: 'Nope' } }).run('x1', reminder);
  assert.equal(missing.code, 'failed');
  assert.equal(missing.summary, "Couldn't set the reminder: the configured Reminders list was not found");
});

test('real JXA against fake Calendar: first writable calendar, idempotent, undo by uid', async () => {
  const apps = fakeApps(), r = runner({ exec: apps.exec });
  const ev = await r.run(ID, { ...event, location: 'Main St', notes: 'x-ray' });
  assert.equal(ev.summary, 'Event added: Dentist · Tue 1 Dec 10:00–10:30');
  assert.equal(apps.events.length, 1);
  assert.equal(apps.events[0].cal, 'Home');
  assert.equal(apps.events[0].summary, 'Dentist');
  assert.equal(apps.events[0].location, 'Main St');
  assert.equal(apps.events[0].alldayEvent, false);
  assert.equal(apps.events[0].description, `x-ray\n\nswarmaa:${ID}`);
  assert.equal((await r.run(ID, event)).handle, ev.handle);
  assert.equal(apps.events.length, 1);
  assert.equal((await r.undo(ID, event, ev.handle!)).summary, 'Event removed: Dentist');
  assert.equal(apps.events.length, 0);
});

test('permission denied (-1743) maps to permission_denied with where-to-enable text', async () => {
  const apps = fakeApps({ deny: 'reminders' });
  const r = await runner({ exec: apps.exec }).run(ID, reminder);
  assert.equal(r.ok, false); assert.equal(r.code, 'permission_denied');
  assert.equal(r.summary, "Couldn't set the reminder: Swarmaa needs Reminders access (System Settings › Privacy & Security › Automation)");
  const viaNumber = await runner({ exec: fake(() => ({ ok: false, code: 'failed', error_number: -1743 })) }).run(ID, event);
  assert.equal(viaNumber.code, 'permission_denied');
  assert.match(viaNumber.summary, /Calendar access/);
  const viaStderr = await runner({ exec: async () => ({ stdout: 'execution error: Not authorized to send Apple events to Reminders. (-1743)', code: 1 }) }).run(ID, reminder);
  assert.equal(viaStderr.code, 'permission_denied');
});

test('timeout: killed exec and a hung exec both map to timeout, queue keeps moving', async () => {
  const killed = await runner({ exec: async () => { throw new ExecTimeout(); } }).run(ID, reminder);
  assert.equal(killed.code, 'timeout');
  assert.equal(killed.summary, "Couldn't set the reminder: Reminders didn't respond in time");
  const sig = await runner({ exec: async () => { throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }); } }).run(ID, reminder);
  assert.equal(sig.code, 'timeout');
  let calls = 0;
  const r = runner({ timeoutMs: 10, exec: (s, i) => ++calls === 1 ? new Promise(() => {}) : fake(() => ({ ok: true, handle: 'h' }))(s, i) });
  const [hung, next] = await Promise.all([r.run(ID, reminder), r.run(ID, timer)]);
  assert.equal(hung.code, 'timeout');
  assert.equal(next.ok, true);
});

test('runs are serialized one at a time', async () => {
  let active = 0, peak = 0;
  const exec: NonNullable<LocalRunnerOptions['exec']> = async () => { active++; peak = Math.max(peak, active); await new Promise(res => setTimeout(res, 5)); active--; return { stdout: '{"ok":true,"handle":"h"}', code: 0 }; };
  const r = runner({ exec });
  const out = await Promise.all([r.run('a', reminder), r.run('b', event), r.run('c', timer), r.undo('d', reminder, 'h')]);
  assert.ok(out.every(o => o.ok));
  assert.equal(peak, 1);
});

test('disabled and non-darwin', async () => {
  let called = 0;
  const exec = fake(() => { called++; return { ok: true, handle: 'h' }; });
  const off = runner({ exec, env: { SWARMAA_LOCAL_ACTIONS: 'notes' } });
  const d = await off.run(ID, reminder);
  assert.equal(d.code, 'action_disabled');
  assert.equal(d.summary, "Couldn't set the reminder: Reminders actions are turned off (SWARMAA_LOCAL_ACTIONS)");
  assert.equal((await off.run(ID, event)).code, 'action_disabled');
  assert.deepEqual((await runner({ exec, env: { SWARMAA_LOCAL_ACTIONS: '' } }).check()), { reminders: 'disabled', calendar: 'disabled', notes: 'disabled' });
  const linux = runner({ exec, platform: 'linux' });
  const u = await linux.run(ID, event);
  assert.equal(u.code, 'unavailable');
  assert.match(u.summary, /^Couldn't add the event: Calendar actions need the Swarmaa service running on a Mac$/);
  assert.equal((await linux.undo(ID, timer, 'h')).code, 'unavailable');
  assert.equal(called, 0);
});

test('non-darwin still appends notes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'swarmaa-la-'));
  try {
    const r = runner({ platform: 'linux', env: { SWARMAA_NOTES_DIR: path.join(dir, 'notes') } });
    const n = await r.run(ID, { type: 'note.append', text: 'Buy filters' });
    assert.deepEqual(n, { ok: true, handle: 'inbox/2026-11-22.md', summary: 'Noted in Inbox: Buy filters' });
    assert.equal((await r.undo(ID, { type: 'note.append', text: 'Buy filters' }, n.handle!)).summary, 'Note removed from Inbox: Buy filters');
    assert.deepEqual(await r.check(), { reminders: 'disabled', calendar: 'disabled', notes: 'ok' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('check reports per app and passes only enabled apps', async () => {
  const calls: Call[] = [];
  const r = runner({ exec: fake(() => ({ ok: true, apps: { reminders: 'ok', calendar: 'permission_denied' } }), calls), env: { SWARMAA_LOCAL_ACTIONS: 'reminders,calendar' } });
  assert.deepEqual(await r.check(), { reminders: 'ok', calendar: 'permission_denied', notes: 'disabled' });
  assert.deepEqual(JSON.parse(calls[0].stdin).apps, ['reminders', 'calendar']);
  const apps = fakeApps({ deny: 'calendar' });
  assert.deepEqual(await runner({ exec: apps.exec, env: { SWARMAA_LOCAL_ACTIONS: 'reminders , CALENDAR' } }).check(), { reminders: 'ok', calendar: 'permission_denied', notes: 'disabled' });
});

test('defensive validation: bounded, closed keys, canonical times, nothing executed', async () => {
  let called = 0;
  const r = runner({ exec: fake(() => { called++; return { ok: true, handle: 'h' }; }) });
  for (const bad of [
    { ...reminder, title: 'x'.repeat(201) },
    { ...reminder, title: '   ' },
    { ...reminder, list: 'Secret list' },
    { ...reminder, extra: 1 },
    { ...reminder, due_at: 'tomorrow' },
    { ...event, end_at: '2026-11-30T10:00:00Z' },
    { type: 'note.append', text: 'x', notebook: '../etc' },
    { type: 'shell.run', cmd: 'rm -rf /' },
    null,
  ]) {
    const out = await r.run(ID, bad as LocalAction);
    assert.equal(out.ok, false, JSON.stringify(bad)); assert.equal(out.code, 'failed');
  }
  assert.equal((await r.run('bad id!', reminder)).code, 'failed');
  assert.equal((await r.undo(ID, reminder, '')).code, 'failed');
  assert.equal(called, 0);
  assert.deepEqual(normalizeAction({ type: 'timer.start', label: ' Tea\n\u0007time ', fire_at: '2026-11-22T18:05:00+01:00' }), { type: 'timer.start', label: 'Tea time', fire_at: '2026-11-22T17:05:00.000Z' });
  const redacted = normalizeAction({ type: 'note.append', text: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
  assert.ok(redacted.type === 'note.append' && !redacted.text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
});

test('unparseable or oversized output is a plain failure', async () => {
  assert.equal((await runner({ exec: async () => ({ stdout: 'garbage', code: 0 }) }).run(ID, reminder)).code, 'failed');
  assert.equal((await runner({ exec: async () => ({ stdout: '{"ok":true}', code: 0 }) }).run(ID, reminder)).code, 'failed', 'success without handle');
  assert.equal((await runner({ exec: async () => ({ stdout: '{"ok":true,"handle":"h"}', code: 1 }) }).run(ID, reminder)).code, 'failed');
  assert.equal((await runner({ exec: async () => ({ stdout: '{"ok":false,"code":"evil"}', code: 0 }) }).run(ID, reminder)).code, 'failed');
});

test('summaries: tomorrow, other days, all-day, cross-day', async () => {
  const r = runner({ exec: fake(() => ({ ok: true, handle: 'h' })) });
  assert.equal((await r.run('a', { ...reminder, due_at: '2026-11-23T08:00:00Z' })).summary, 'Reminder set: Call mom · Tomorrow 08:00');
  assert.equal((await r.run('a', { type: 'reminder.create', title: 'Call mom' })).summary, 'Reminder set: Call mom');
  assert.equal((await r.run('a', { ...event, start_at: '2026-12-03T10:00:00Z', end_at: '2026-12-03T10:30:00Z' })).summary, 'Event added: Dentist · Thu 3 Dec 10:00–10:30');
  assert.equal((await r.run('a', { ...event, start_at: '2027-01-05T00:00:00Z', end_at: '2027-01-06T00:00:00Z', all_day: true })).summary, 'Event added: Dentist · Tue 5 Jan 2027 (all day)');
  assert.equal((await r.run('a', { ...event, start_at: '2026-11-22T22:00:00Z', end_at: '2026-11-23T01:00:00Z' })).summary, 'Event added: Dentist · Today 22:00 – Tomorrow 01:00');
  assert.equal((await r.run('a', { ...timer, fire_at: '2026-11-23T07:00:00Z' })).summary, 'Timer set: Tea · Tomorrow 07:00');
  const bkk = runner({ exec: fake(() => ({ ok: true, handle: 'h' })), env: { SWARMAA_TIME_ZONE: 'Asia/Bangkok' } });
  assert.equal((await bkk.run('a', reminder)).summary, 'Reminder set: Call mom · Tomorrow 00:00');
});

// ---------------------------------------------------------------- latency review F5–F7, F18: helper, warm, fresh, zone
type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; requests: any[]; lines: string[]; killedWith?: string; kill(sig?: string): boolean };
/** A fake `osascript … loop` child: answers each stdin line with reply(req); 'hang' never answers, 'die' exits. */
function fakeHelper(reply: (req: any, child: FakeChild) => unknown) {
  const spawned: FakeChild[] = [];
  const spawn = () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), requests: [] as any[], lines: [] as string[] }) as FakeChild;
    child.kill = (sig?: string) => { child.killedWith = sig; setImmediate(() => child.emit('exit', null, sig)); return true; };
    let buf = '';
    child.stdin.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        child.lines.push(line); const req = JSON.parse(line); child.requests.push(req);
        const r = reply(req, child);
        if (r === 'hang') continue;
        if (r === 'die') { child.emit('exit', 1, null); continue; }
        child.stdout.write(typeof r === 'string' ? r + '\n' : JSON.stringify(r) + '\n');
      }
    });
    spawned.push(child);
    return child as unknown as ChildProcess;
  };
  return { spawn, spawned };
}

test('fresh: attempt 1 sends fresh:true, a rerun sends fresh:false; zone override formats the card', async () => {
  const calls: Call[] = [];
  const r = runner({ exec: fake(() => ({ ok: true, handle: 'h' }), calls) });
  const first = await r.run(ID, reminder, { fresh: true, timeZone: 'Asia/Bangkok' });
  await r.run(ID, reminder);
  await r.run(ID, reminder, { fresh: false });
  assert.deepEqual(calls.map(c => JSON.parse(c.stdin).fresh), [true, false, false]);
  assert.equal(first.summary, 'Reminder set: Call mom · Tomorrow 00:00', 'phone zone, not SWARMAA_TIME_ZONE');
  assert.equal((await r.run(ID, reminder, { timeZone: 'Not/AZone' })).summary, 'Reminder set: Call mom · Today 17:00', 'bad zone falls back');
});

test('real JXA: fresh skips the marker scan, a rerun keeps it', async () => {
  const apps = fakeApps(), r = runner({ exec: apps.exec });
  const first = await r.run(ID, reminder, { fresh: true });
  const rerun = await r.run(ID, reminder, { fresh: false });
  assert.equal(rerun.handle, first.handle);
  assert.equal(apps.reminders.length, 1);
  await r.run(ID, reminder, { fresh: true }); // only ever sent on attempt 1: proves no lookup happened
  assert.equal(apps.reminders.length, 2);
  const ev = await r.run('ev1', event, { fresh: true });
  assert.equal((await r.run('ev1', event)).handle, ev.handle);
  assert.equal(apps.events.length, 1);
});

test('JXA loop mode: one response line per request line, reads split mid-line, exits on EOF', () => {
  const chunks = ['{"op":"run","id":"a1","action":{"type":"reminder.create","title":"Caf\\u00e9"},"fresh":true,"con', 'fig":{}}\n\n{"op":"nope","id":"a2","action":{}}\n', ''];
  const written: string[] = [], made: any[] = [];
  const $ = {
    NSFileHandle: { fileHandleWithStandardInput: { get availableData() { return chunks.shift() ?? ''; } }, fileHandleWithStandardOutput: { writeData: (d: string) => { written.push(d); } } },
    NSString: { alloc: { initWithDataEncoding: (d: string) => d, initWithUTF8String: (s: string) => ({ dataUsingEncoding: () => s }) } },
    NSUTF8StringEncoding: 4,
  };
  const list = { reminders: { whose() { throw new Error('fresh must not scan'); }, push(r: any) { r.data.id = 'x-apple-reminder://1'; made.push(r.data); } } };
  const ctx = vm.createContext({ ObjC: { import() {}, unwrap: (x: unknown) => x }, $, Application: () => ({ defaultList: () => list, Reminder: (p: any) => { const data = { ...p }; return { data, id: () => data.id }; } }) });
  new vm.Script(JXA_SCRIPT).runInContext(ctx);
  assert.equal(ctx.run(['loop']), '');
  assert.equal(written.length, 2);
  assert.ok(written.every(w => w.endsWith('\n') && /^[\x00-\x7f]*$/.test(w)));
  assert.deepEqual(JSON.parse(written[0]!), { ok: true, handle: 'x-apple-reminder://1' });
  assert.deepEqual(JSON.parse(written[1]!), { ok: false, code: 'failed', detail: 'bad_input' });
  assert.equal(made[0].name, 'Café');
});

test('helper: two runs share one spawn, payload is ASCII JSON on stdin, script and argv fixed', async () => {
  const h = fakeHelper(() => ({ ok: true, handle: 'x-apple-reminder://H' }));
  let oneShots = 0;
  const r = runner({ spawn: h.spawn, exec: async () => { oneShots++; return { stdout: '', code: 1 }; } });
  const a = await r.run(ID, { ...reminder, title: 'Café ☕' }, { fresh: true });
  const b = await r.run('second', timer);
  assert.ok(a.ok && b.ok);
  assert.equal(a.summary, 'Reminder set: Café ☕ · Today 17:00');
  assert.equal(h.spawned.length, 1);
  assert.equal(oneShots, 0);
  const [first, second] = h.spawned[0]!.requests;
  assert.equal(first.op, 'run'); assert.equal(first.fresh, true); assert.equal(first.action.title, 'Café ☕');
  assert.equal(second.fresh, false);
  assert.ok(h.spawned[0]!.lines.every(l => /^[\x20-\x7e]*$/.test(l)), 'request lines are ASCII');
});

test('helper: a timeout SIGKILLs the child and the next request respawns; no one-shot retry of a timed-out run', async () => {
  let n = 0;
  const h = fakeHelper(() => ++n === 1 ? 'hang' : { ok: true, handle: 'h2' });
  let oneShots = 0;
  const r = runner({ spawn: h.spawn, timeoutMs: 20, exec: async () => { oneShots++; return { stdout: '{"ok":true,"handle":"x"}', code: 0 }; } });
  const hung = await r.run(ID, reminder, { fresh: true });
  assert.equal(hung.code, 'timeout');
  assert.equal(h.spawned[0]!.killedWith, 'SIGKILL');
  assert.equal(oneShots, 0, 'the timed-out run may have reached Reminders');
  const next = await r.run('next', reminder);
  assert.equal(next.ok, true); assert.equal(next.handle, 'h2');
  assert.equal(h.spawned.length, 2);
});

test('helper: a crash, a garbage line or a spawn failure falls back to one-shot with the marker lookup', async () => {
  const oneShot: any[] = [];
  const exec: NonNullable<LocalRunnerOptions['exec']> = async (_s, stdin) => { oneShot.push(JSON.parse(stdin)); return { stdout: '{"ok":true,"handle":"one-shot"}', code: 0 }; };
  const dies = fakeHelper(() => 'die');
  const r1 = await runner({ spawn: dies.spawn, exec }).run(ID, reminder, { fresh: true });
  assert.equal(r1.handle, 'one-shot');
  assert.equal(oneShot[0].fresh, undefined, 'fallback never skips the marker scan');
  const garbage = fakeHelper(() => 'osascript: something odd');
  const r2 = runner({ spawn: garbage.spawn, exec });
  assert.equal((await r2.run(ID, reminder)).handle, 'one-shot');
  assert.equal(garbage.spawned[0]!.killedWith, 'SIGKILL');
  assert.equal((await r2.run(ID, reminder)).handle, 'one-shot');
  assert.equal(garbage.spawned.length, 2, 'a broken helper is replaced');
  const r3 = await runner({ spawn: () => { throw new Error('ENOENT'); }, exec }).run(ID, event);
  assert.equal(r3.handle, 'one-shot');
  assert.equal(oneShot.length, 4);
});

test('helper: exits after the idle period', async () => {
  const h = fakeHelper(() => ({ ok: true, handle: 'h' }));
  const r = runner({ spawn: h.spawn, helperIdleMs: 10, exec: async () => ({ stdout: '', code: 1 }) });
  await r.run(ID, reminder);
  let ended = false; h.spawned[0]!.stdin.on('finish', () => { ended = true; });
  await new Promise(res => setTimeout(res, 40));
  assert.ok(ended, 'stdin closed: osascript sees EOF and exits');
  await r.run('again', reminder);
  assert.equal(h.spawned.length, 2);
});

test('check is one-shot on its own queue: an attended prompt never blocks a run', async () => {
  let release!: () => void;
  const prompt = new Promise<void>(res => { release = res; });
  const h = fakeHelper(() => ({ ok: true, handle: 'h' }));
  const checks: any[] = [];
  const exec: NonNullable<LocalRunnerOptions['exec']> = async (_s, stdin) => { checks.push(JSON.parse(stdin)); await prompt; return { stdout: '{"ok":true,"apps":{"reminders":"ok","calendar":"ok"}}', code: 0 }; };
  const r = runner({ spawn: h.spawn, exec, env: { SWARMAA_LOCAL_ACTIONS: 'reminders,calendar' } });
  const check = r.check();
  await new Promise(res => setImmediate(res));
  const run = await Promise.race([r.run(ID, reminder), new Promise<'blocked'>(res => setTimeout(() => res('blocked'), 200))]);
  assert.notEqual(run, 'blocked');
  assert.equal(checks.length, 1); assert.equal(checks[0].op, 'check');
  assert.ok(h.spawned[0]!.requests.every(q => q.op !== 'check'), 'check never goes to the helper');
  release();
  assert.deepEqual(await check, { reminders: 'ok', calendar: 'ok', notes: 'disabled' });
  // Same without a helper (injected exec only): the check queue is separate from the run queue.
  let release2!: () => void;
  const prompt2 = new Promise<void>(res => { release2 = res; });
  const r2 = runner({ exec: async (_s, stdin) => JSON.parse(stdin).op === 'check' ? (await prompt2, { stdout: '{"ok":true,"apps":{}}', code: 0 }) : { stdout: '{"ok":true,"handle":"h"}', code: 0 } });
  const c2 = r2.check();
  assert.equal((await r2.run(ID, reminder)).ok, true);
  release2(); await c2;
});

test('warm launches only enabled apps whose last check or run was ok', async () => {
  const seen: any[] = [];
  let apps: Record<string, string> = { reminders: 'ok', calendar: 'permission_denied' };
  const exec: NonNullable<LocalRunnerOptions['exec']> = async (_s, stdin) => { const q = JSON.parse(stdin); seen.push(q); return { stdout: JSON.stringify(q.op === 'check' ? { ok: true, apps: Object.fromEntries((q.apps as string[]).map(a => [a, apps[a]])) } : { ok: true, handle: 'h' }), code: 0 }; };
  const r = runner({ exec });
  await r.warm!();
  assert.equal(seen.length, 0, 'nothing known to work yet: no app is touched');
  await r.check(); seen.length = 0;
  await r.warm!();
  assert.deepEqual(seen.map(q => [q.op, q.apps]), [['check', ['reminders']]], 'calendar was not ok: never touched');
  // The owner grants Calendar; a successful run marks it reachable.
  apps = { reminders: 'ok', calendar: 'ok' };
  await r.run('ev', event); seen.length = 0;
  await r.warm!();
  assert.deepEqual(seen.map(q => q.apps), [['reminders'], ['calendar']]);
  apps = { reminders: 'permission_denied', calendar: 'ok' }; seen.length = 0;
  await r.warm!(); seen.length = 0;
  await r.warm!();
  assert.deepEqual(seen.map(q => q.apps), [['calendar']], 'a warm read that is denied unmarks the app');
  const off = runner({ exec, env: { SWARMAA_LOCAL_ACTIONS: 'notes' } }); seen.length = 0;
  await off.check(); await off.warm!();
  assert.equal(seen.length, 0);
  await runner({ exec, platform: 'linux' }).warm!();
  assert.equal(seen.length, 0);
});

test('warm pre-spawns the helper without touching an app', async () => {
  const h = fakeHelper(() => ({ ok: true, handle: 'h' }));
  const r = runner({ spawn: h.spawn, exec: async () => ({ stdout: '', code: 1 }) });
  await r.warm!();
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0]!.requests.length, 0);
  await r.run(ID, reminder);
  assert.equal(h.spawned.length, 1, 'the first run reuses the warmed helper');
});

test('timer kind (docs/RING-AGENT.md §11.3): accepted and kept, JXA still makes a reminder, alarm wording', async () => {
  const alarm: LocalAction = { type: 'timer.start', label: 'Wake up', fire_at: '2026-11-23T07:00:00Z', kind: 'alarm' };
  assert.deepEqual(normalizeAction(alarm), { ...alarm, fire_at: '2026-11-23T07:00:00.000Z' });
  assert.deepEqual(normalizeAction({ ...alarm, kind: 'timer' }), { ...alarm, kind: 'timer', fire_at: '2026-11-23T07:00:00.000Z' });
  assert.throws(() => normalizeAction({ ...alarm, kind: 'stopwatch' }));
  const apps = fakeApps();
  const r = runner({ exec: apps.exec });
  const out = await r.run('alarm-1', alarm);
  assert.equal(out.ok, true);
  assert.equal(out.summary, 'Alarm set: Wake up · Tomorrow 07:00');
  assert.equal(apps.reminders[0].name, '⏱ Wake up');
  assert.equal((await r.undo('alarm-1', alarm, out.handle!)).summary, 'Alarm cancelled: Wake up');
});

test('note.append uses per-call runOpts.timeZone rather than falling back to env timeZone', async () => {
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'swarmaa-note-tz-'));
  try {
    // 2026-11-22T20:00:00Z is 2026-11-22 in UTC, but 2026-11-23 03:00 in Asia/Bangkok (+7).
    const r = runner({
      now: () => new Date('2026-11-22T20:00:00Z'),
      env: { SWARMAA_TIME_ZONE: 'UTC', SWARMAA_NOTES_DIR: dir, SWARMAA_LOCAL_ACTIONS: 'notes' },
    });
    const out = await r.run('note-tz-1', { type: 'note.append', text: 'Late night thought' }, { timeZone: 'Asia/Bangkok' });
    assert.equal(out.ok, true);
    assert.equal(out.handle, 'inbox/2026-11-23.md');
    assert.equal(existsSync(join(dir, 'inbox', '2026-11-23.md')), true, 'must write to local date in per-call timeZone');
    assert.equal(existsSync(join(dir, 'inbox', '2026-11-22.md')), false, 'must not use env UTC date');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
