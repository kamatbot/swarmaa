// Devin CLI: ~/.local/share/devin/cli/sessions.db (sessions + message_nodes, row_id cursor, read in pages from the newest end).
// Devin re-inserts history on resume/compaction, so rows are de-duplicated by message_id. Adapted from Asymptote Labs agent-beacon (MIT).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ScanCtx, SessionUpdate, Source, Turn, Where } from './types.js';
import { MAX_TURNS, columns, isObj, iso, openDb, parseObj, pick, str, stripReminders, toMs } from './util.js';

const PAGE = 200, MAX_PAGES = 5;
const INTERNAL_MODELS = new Set(['compactor', 'summarizer']);

export function devinDbPath(w: Where): string {
  const xdg = w.env.XDG_DATA_HOME?.trim();
  if (xdg) { const c = join(xdg, 'devin', 'cli', 'sessions.db'); if (existsSync(c)) return c; }
  return join(w.home, '.local', 'share', 'devin', 'cli', 'sessions.db');
}

export const devin: Source = {
  id: 'devin', harness: 'devin', label: 'Devin CLI',
  exists: w => existsSync(devinDbPath(w)),
  scan(ctx: ScanCtx) {
    const updates: SessionUpdate[] = [];
    const db = openDb(devinDbPath(ctx));
    if (!db) { ctx.fail(new Error('devin db not readable')); return { found: 0, updates }; }
    try {
      const sc = columns(db, 'sessions'), nc = columns(db, 'message_nodes');
      if (!sc.has('id') || !nc.has('row_id') || !nc.has('chat_message')) return { found: 0, updates };
      const sessions = db.prepare(`SELECT id, ${pick(sc, 'working_directory')}, ${pick(sc, 'title')}, ${pick(sc, 'hidden')}, ${pick(sc, 'last_activity_at')}, ${pick(sc, 'created_at')} FROM sessions`).all();
      const maxRows = new Map(db.prepare('SELECT session_id, max(row_id) AS m FROM message_nodes GROUP BY session_id').all().map(r => [str(r.session_id), Number(r.m)]));
      let found = 0;
      for (const s of sessions) {
        const id = str(s.id);
        if (!id || Number(s.hidden) === 1) continue;
        const last = maxRows.get(id) ?? 0;
        if (!last) continue;
        found++;
        const t = toMs(s.last_activity_at) || toMs(s.created_at);
        const prev = ctx.sessions[id];
        if (prev ? Number(prev.row) >= last : t < ctx.sinceMs) continue;
        if (ctx.expired()) break;
        try {
          const turns: Turn[] = [];
          const seenIds = new Set<string>();
          let before = last + 1;
          for (let page = 0; page < MAX_PAGES && turns.length < MAX_TURNS; page++) {
            const rows = db.prepare('SELECT row_id, chat_message, created_at FROM message_nodes WHERE session_id = ? AND row_id < ? ORDER BY row_id DESC LIMIT ?').all(id, before, PAGE);
            if (!rows.length) break;
            for (const r of rows) {
              before = Number(r.row_id);
              const m = parseObj(str(r.chat_message));
              if (!m) continue;
              const role = str(m.role).toLowerCase(), meta = isObj(m.metadata) ? m.metadata : {};
              if (role !== 'user' && role !== 'assistant') continue;
              if (role === 'user' && meta.is_user_input !== true) continue; // compactor and keepalive rows carry no is_user_input
              if (role === 'assistant' && INTERNAL_MODELS.has(str(meta.generation_model).toLowerCase())) continue;
              const mid = str(m.message_id);
              if (mid) { if (seenIds.has(mid)) continue; seenIds.add(mid); }
              const text = stripReminders(str(m.content));
              const at = iso(toMs(r.created_at));
              if (text) turns.push({ role, text, ...(at ? { at } : {}) });
            }
          }
          updates.push({ id, key: id, sig: { row: last }, title: str(s.title), cwd: str(s.working_directory), turns: turns.reverse().slice(-MAX_TURNS), updatedMs: t });
        } catch (e) { ctx.fail(e); }
      }
      return { found, updates };
    } finally { db.close(); }
  },
};
