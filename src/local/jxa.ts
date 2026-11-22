// The one fixed JXA program run by `/usr/bin/osascript -l JavaScript -e` (docs/RING-AGENT.md §5.2, §8.1).
// Input is JSON on stdin; every field is treated as data (no eval, no doShellScript, nothing concatenated into code).
// Output is exactly one JSON line: {"ok":true,"handle":…} | {"ok":false,"code":…,"detail"?,"error_number"?} | check: {"ok":true,"apps":{…}}.
// Request: {"op":"run"|"undo"|"check","id":…,"action":…,"handle":…,"config":{reminders_list,todo_list,calendar},"apps":[…]}.
export const JXA_SCRIPT = String.raw`
ObjC.import('Foundation');
var MARK = 'swarmaa:';
var ID = /^[A-Za-z0-9_-]{1,64}$/;
var WINDOW_MS = 36 * 3600 * 1000;

function Fail(code, detail) { this.code = code; this.detail = detail; }
function str(v, max) { if (typeof v !== 'string' || v.length > max) throw new Fail('failed', 'bad_input'); return v; }
function opt(v, max) { return v === undefined || v === null || v === '' ? '' : str(v, max); }
function when(v) { var d = new Date(str(v, 40)); if (isNaN(d.getTime())) throw new Fail('failed', 'bad_input'); return d; }
function errno(e) { return e && typeof e.errorNumber === 'number' ? e.errorNumber : 0; }
function classify(e) {
  if (e instanceof Fail) return e.detail ? { ok: false, code: e.code, detail: e.detail } : { ok: false, code: e.code };
  var n = errno(e), m = String((e && e.message) || '');
  if (n === -1743 || /not (allowed|authori[sz]ed)/i.test(m)) return { ok: false, code: 'permission_denied', error_number: -1743 };
  if (n === -1712) return { ok: false, code: 'timeout', error_number: n };
  return { ok: false, code: 'failed', error_number: n };
}
function missing(e) { var n = errno(e); return n === -1728 || n === -1719; }
// True when text carries swarmaa:<id> not followed by another id character (so id "ab" never matches "abc").
function hasMarker(text, id) {
  var s = String(text || ''), m = MARK + id, i = s.indexOf(m);
  while (i >= 0) { var c = s.charAt(i + m.length); if (!c || !/[A-Za-z0-9_-]/.test(c)) return true; i = s.indexOf(m, i + 1); }
  return false;
}
function withMarker(notes, id) { return (notes ? notes + '\n\n' : '') + MARK + id; }
function readInput() {
  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return JSON.parse(ObjC.unwrap(text));
}

// Reminders ------------------------------------------------------------------
function reminderList(app, name) {
  if (name) { var found = app.lists.whose({ name: name }); if (found.length < 1) throw new Fail('failed', 'list_not_found'); return found[0]; }
  return app.defaultList();
}
function createReminder(listName, id, props) {
  var app = Application('Reminders'), list = reminderList(app, listName);
  var hits = list.reminders.whose({ body: { _contains: MARK + id } });
  if (hits.length > 0) {
    var bodies = hits.body(), ids = hits.id();
    for (var i = 0; i < ids.length; i++) if (hasMarker(bodies[i], id)) return { ok: true, handle: ids[i], existed: true };
  }
  var r = app.Reminder(props);
  list.reminders.push(r);
  return { ok: true, handle: r.id() };
}
function deleteReminder(id, handle) {
  var app = Application('Reminders'), r = app.reminders.byId(handle), body;
  try { body = r.body(); } catch (e) { if (missing(e)) return { ok: true, handle: handle, gone: true }; throw e; }
  if (!hasMarker(body, id)) throw new Fail('failed', 'handle_mismatch');
  r.delete();
  return { ok: true, handle: handle };
}

// Calendar -------------------------------------------------------------------
function pickCalendar(app, name) {
  if (name) { var found = app.calendars.whose({ name: name }); if (found.length < 1) throw new Fail('failed', 'calendar_not_found'); return found[0]; }
  var all = app.calendars();
  for (var i = 0; i < all.length; i++) if (all[i].writable()) return all[i];
  throw new Fail('failed', 'no_writable_calendar');
}
function createEvent(calName, id, a) {
  var app = Application('Calendar'), cal = pickCalendar(app, calName);
  var start = when(a.start_at), end = when(a.end_at);
  if (end.getTime() < start.getTime()) throw new Fail('failed', 'bad_input');
  var hits = cal.events.whose({ _and: [
    { startDate: { _greaterThan: new Date(start.getTime() - WINDOW_MS) } },
    { startDate: { _lessThan: new Date(start.getTime() + WINDOW_MS) } },
    { description: { _contains: MARK + id } }
  ] });
  if (hits.length > 0) {
    var descs = hits.description(), uids = hits.uid();
    for (var i = 0; i < uids.length; i++) if (hasMarker(descs[i], id)) return { ok: true, handle: uids[i], existed: true };
  }
  var props = { summary: str(a.title, 200), startDate: start, endDate: end, alldayEvent: a.all_day === true, description: withMarker(opt(a.notes, 4000), id) };
  var location = opt(a.location, 200); if (location) props.location = location;
  var ev = app.Event(props);
  cal.events.push(ev);
  return { ok: true, handle: ev.uid() };
}
function deleteEvent(calName, id, handle) {
  var app = Application('Calendar'), cals = [];
  if (calName) { var named = app.calendars.whose({ name: calName }); if (named.length > 0) cals.push(named[0]); }
  var all = app.calendars(); for (var i = 0; i < all.length; i++) cals.push(all[i]);
  for (var j = 0; j < cals.length; j++) {
    var hits = cals[j].events.whose({ uid: handle });
    if (hits.length < 1) continue;
    var ev = hits[0];
    if (!hasMarker(ev.description(), id)) throw new Fail('failed', 'handle_mismatch');
    ev.delete();
    return { ok: true, handle: handle };
  }
  return { ok: true, handle: handle, gone: true };
}

// Dispatch -------------------------------------------------------------------
function check(apps) {
  var out = {};
  for (var i = 0; i < apps.length; i++) {
    var name = apps[i];
    if (name !== 'reminders' && name !== 'calendar') continue;
    try {
      if (name === 'reminders') Application('Reminders').lists.length; else Application('Calendar').calendars.length;
      out[name] = 'ok';
    } catch (e) { out[name] = classify(e).code === 'permission_denied' ? 'permission_denied' : 'failed'; }
  }
  return { ok: true, apps: out };
}
function handle(req) {
  if (!req || typeof req !== 'object') throw new Fail('failed', 'bad_input');
  var config = req.config && typeof req.config === 'object' ? req.config : {};
  var remindersList = opt(config.reminders_list, 200), todoList = opt(config.todo_list, 200), calendar = opt(config.calendar, 200);
  if (req.op === 'check') return check(Array.isArray(req.apps) ? req.apps : []);
  var id = str(req.id, 64); if (!ID.test(id)) throw new Fail('failed', 'bad_input');
  var a = req.action; if (!a || typeof a !== 'object') throw new Fail('failed', 'bad_input');
  if (req.op === 'undo') {
    var h = str(req.handle, 512); if (!h) throw new Fail('failed', 'bad_input');
    if (a.type === 'reminder.create' || a.type === 'timer.start') return deleteReminder(id, h);
    if (a.type === 'event.create') return deleteEvent(calendar, id, h);
    throw new Fail('failed', 'bad_input');
  }
  if (req.op !== 'run') throw new Fail('failed', 'bad_input');
  if (a.type === 'reminder.create') {
    var props = { name: str(a.title, 200), body: withMarker(opt(a.notes, 4000), id) };
    if (a.due_at) { props.dueDate = when(a.due_at); props.remindMeDate = when(a.due_at); }
    return createReminder(a.list === 'todo' ? (todoList || remindersList) : remindersList, id, props);
  }
  if (a.type === 'timer.start') {
    var fire = when(a.fire_at);
    return createReminder(remindersList, id, { name: '⏱ ' + str(a.label, 200), body: withMarker('', id), dueDate: fire, remindMeDate: fire });
  }
  if (a.type === 'event.create') return createEvent(calendar, id, a);
  throw new Fail('failed', 'bad_input');
}
function run() {
  var out;
  try { out = handle(readInput()); } catch (e) { out = classify(e); }
  return JSON.stringify(out);
}
`;
