// Hermes: ~/.hermes/state.db (HERMES_HOME overrides): sessions + messages, message id cursor, float-second timestamps.
// ponytail: the default profile only; agent-beacon also follows an `active_profile` file into profiles/<name>. Add when needed.
// Adapted from Asymptote Labs agent-beacon (MIT).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ScanCtx, SessionUpdate, Source, Turn, Where } from './types.js';
import { MAX_TURNS, columns, iso, openDb, pick, str, stripReminders, toMs } from './util.js';

export function hermesDbPath(w: Where): string {
  let home = w.env.HERMES_HOME?.trim() || join(w.home, '.hermes');
  if (home === '~') home = w.home; else if (home.startsWith('~/')) home = join(w.home, home.slice(2));
  return join(home, 'state.db');
}

export const hermes: Source = {
  id: 'hermes', harness: 'hermes', label: 'Hermes',
  exists: w => existsSync(hermesDbPath(w)),
  scan(ctx: ScanCtx) {
    const updates: SessionUpdate[] = [];
    const db = openDb(hermesDbPath(ctx));
    if (!db) { ctx.fail(new Error('hermes db not readable')); return { found: 0, updates }; }
    try {
      const sc = columns(db, 'sessions'), mc = columns(db, 'messages');
      if (!sc.has('id') || !mc.has('session_id') || !mc.has('id')) return { found: 0, updates };
      const sessions = new Map(db.prepare(`SELECT id, ${pick(sc, 'cwd')}, ${pick(sc, 'title')}, ${pick(sc, 'archived')} FROM sessions`).all().map(r => [str(r.id), r]));
      const active = mc.has('active') ? 'WHERE active = 1' : '';
      const ts = mc.has('timestamp') ? 'max(timestamp)' : 'NULL';
      const groups = db.prepare(`SELECT session_id, max(id) AS m, ${ts} AS t FROM messages ${active} GROUP BY session_id`).all();
      let found = 0;
      for (const g of groups) {
        const id = str(g.session_id), s = sessions.get(id);
        if (!id || !s || Number(s.archived) === 1) continue;
        found++;
        const last = Number(g.m), t = toMs(g.t);
        const prev = ctx.sessions[id];
        if (prev ? Number(prev.id) >= last : t < ctx.sinceMs) continue;
        if (ctx.expired()) break;
        try {
          const rows = db.prepare(`SELECT role, content, ${pick(mc, 'timestamp')} FROM messages WHERE session_id = ? ${mc.has('active') ? 'AND active = 1' : ''}
            AND role IN ('user','assistant') AND trim(COALESCE(content,'')) != '' ORDER BY id DESC LIMIT ?`).all(id, MAX_TURNS * 2);
          const turns: Turn[] = [];
          for (const r of rows.reverse()) {
            const text = stripReminders(str(r.content));
            const at = iso(toMs(r.timestamp));
            if (text) turns.push({ role: r.role === 'user' ? 'user' : 'assistant', text, ...(at ? { at } : {}) });
          }
          updates.push({ id, key: id, sig: { id: last }, title: str(s.title), cwd: str(s.cwd), turns: turns.slice(-MAX_TURNS), updatedMs: t });
        } catch (e) { ctx.fail(e); }
      }
      return { found, updates };
    } finally { db.close(); }
  },
};
