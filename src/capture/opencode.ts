// OpenCode: ~/.local/share/opencode/opencode.db (session/message/part, columns probed) plus the legacy storage/ JSON tree.
// Adapted from Asymptote Labs agent-beacon (MIT).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ScanCtx, SessionUpdate, Source, Turn, Where } from './types.js';
import { MAX_TURNS, columns, iso, isObj, openDb, parseObj, pick, str, stripReminders, toMs, type Obj } from './util.js';

const LIMIT = 10_000;
const MSG_WINDOW = 400;

function dataDir(w: Where): string {
  return w.env.XDG_DATA_HOME ? join(w.env.XDG_DATA_HOME, 'opencode') : join(w.home, '.local', 'share', 'opencode');
}
function dbPath(w: Where): string {
  const name = w.env.OPENCODE_DB;
  if (!name || name === ':memory:') return join(dataDir(w), 'opencode.db');
  return isAbsolute(name) ? name : join(dataDir(w), name);
}

/** Visible text of one OpenCode message's parts: text parts only (no reasoning, tool, file, synthetic or ignored parts). */
function partsText(parts: Obj[]): string {
  return parts.filter(p => p.type === 'text' && !p.synthetic && !p.ignored).map(p => str(p.text)).join('\n\n').trim();
}
function turnOf(msg: Obj, text: string, createdMs: number): Turn | null {
  const role = str(msg.role);
  if ((role !== 'user' && role !== 'assistant') || (role === 'assistant' && msg.summary === true)) return null;
  const t = stripReminders(text);
  const at = iso(createdMs);
  return t ? { role, text: t, ...(at ? { at } : {}) } : null;
}

function scanDb(ctx: ScanCtx, db: DatabaseSync, found: { n: number }, seen: Set<string>, out: SessionUpdate[]): void {
  const sc = columns(db, 'session');
  if (!sc.has('id')) return;
  const rows = db.prepare(`SELECT id, ${pick(sc, 'title')}, ${pick(sc, 'directory')}, ${pick(sc, 'project_worktree')}, ${pick(sc, 'time_created')},
      ${pick(sc, 'time_updated')}, ${pick(sc, 'parent_id')} FROM session ORDER BY COALESCE(time_updated, time_created, 0) DESC LIMIT ${LIMIT}`).all();
  const hasMsgs = columns(db, 'message').has('data') && columns(db, 'part').has('data');
  const mc = columns(db, 'message'), pc = columns(db, 'part');
  for (const r of rows) {
    const id = str(r.id);
    if (!id) continue;
    seen.add(id);
    if (r.parent_id) continue; // sub-agent sessions are not top-level chats
    found.n++;
    const t = toMs(r.time_updated) || toMs(r.time_created);
    const prev = ctx.sessions[`db:${id}`];
    if (!hasMsgs || (prev ? prev.t === t : t < ctx.sinceMs) || ctx.expired()) continue;
    try {
      const msgs = db.prepare(`SELECT id, data, ${pick(mc, 'time_created')} FROM message WHERE session_id = ? ORDER BY ${mc.has('time_created') ? 'COALESCE(time_created,0)' : '0'} DESC, id DESC LIMIT ${MSG_WINDOW}`).all(id).reverse();
      const byMsg = new Map<string, Obj[]>();
      if (msgs.length) {
        const ids = msgs.map(m => str(m.id));
        for (const p of db.prepare(`SELECT message_id, data FROM part WHERE session_id = ? AND message_id IN (${ids.map(() => '?').join(',')}) ORDER BY COALESCE(${pc.has('time_created') ? 'time_created' : '0'},0), id`).all(id, ...ids)) {
          const d = parseObj(str(p.data));
          if (d) byMsg.set(str(p.message_id), [...(byMsg.get(str(p.message_id)) ?? []), d]);
        }
      }
      const turns: Turn[] = [];
      for (const m of msgs) {
        const d = parseObj(str(m.data));
        const tm = d ? turnOf(d, partsText(byMsg.get(str(m.id)) ?? []), toMs(m.time_created)) : null;
        if (tm) turns.push(tm);
      }
      out.push({ id, key: `db:${id}`, sig: { t }, title: str(r.title), cwd: str(r.directory) || str(r.project_worktree), turns: turns.slice(-MAX_TURNS), updatedMs: t });
    } catch (e) { ctx.fail(e); }
  }
}

const readJson = (p: string): Obj | null => { try { return parseObj(readFileSync(p, 'utf8')); } catch { return null; } };
const names = (d: string, ext = '.json') => { try { return readdirSync(d).filter(n => n.endsWith(ext)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); } catch { return []; } };

function scanLegacy(ctx: ScanCtx, storage: string, found: { n: number }, seen: Set<string>, out: SessionUpdate[]): void {
  for (const proj of names(join(storage, 'session'), '')) {
    const projFile = readJson(join(storage, 'project', `${proj}.json`));
    const projDir = str(projFile?.worktree) || str(projFile?.directory);
    for (const f of names(join(storage, 'session', proj))) {
      const s = readJson(join(storage, 'session', proj, f));
      const id = str(s?.id) || f.slice(0, -5);
      if (!s || seen.has(id) || (isObj(s.time) && s.time.archived)) continue;
      seen.add(id);
      if (s.parentID) continue;
      found.n++;
      const msgDir = join(storage, 'message', id);
      let mt = 0;
      try { mt = Math.floor(statSync(msgDir).mtimeMs); } catch { /* no messages */ }
      const t = Math.max(mt, isObj(s.time) ? toMs(s.time.updated) || toMs(s.time.created) : 0);
      const prev = ctx.sessions[`legacy:${id}`];
      if ((prev ? prev.t === t : t < ctx.sinceMs) || ctx.expired()) continue;
      const turns: Turn[] = [];
      const msgs = names(msgDir).map(n => readJson(join(msgDir, n))).filter((m): m is Obj => !!m && !!str(m.id));
      msgs.sort((a, b) => toMs(isObj(a.time) ? a.time.created : 0) - toMs(isObj(b.time) ? b.time.created : 0) || str(a.id).localeCompare(str(b.id)));
      for (const m of msgs.slice(-MSG_WINDOW)) {
        const parts = names(join(storage, 'part', str(m.id))).map(n => readJson(join(storage, 'part', str(m.id), n))).filter((p): p is Obj => !!p);
        const tm = turnOf(m, partsText(parts), isObj(m.time) ? toMs(m.time.created) : 0);
        if (tm) turns.push(tm);
      }
      out.push({ id, key: `legacy:${id}`, sig: { t }, title: str(s.title), cwd: projDir || str(s.directory), turns: turns.slice(-MAX_TURNS), updatedMs: t });
    }
  }
}

export const opencode: Source = {
  id: 'opencode', harness: 'opencode', label: 'OpenCode',
  exists: w => existsSync(dbPath(w)) || existsSync(join(dataDir(w), 'storage', 'session')),
  scan(ctx) {
    const found = { n: 0 }, seen = new Set<string>(), updates: SessionUpdate[] = [];
    if (existsSync(dbPath(ctx))) {
      const db = openDb(dbPath(ctx));
      if (!db) ctx.fail(new Error('opencode db not readable'));
      else try { scanDb(ctx, db, found, seen, updates); } catch (e) { ctx.fail(e); } finally { db.close(); }
    }
    try { scanLegacy(ctx, join(dataDir(ctx), 'storage'), found, seen, updates); } catch (e) { ctx.fail(e); }
    return { found: found.n, updates };
  },
};
