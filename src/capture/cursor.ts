// Cursor: composer chats in the VS Code global-storage SQLite (composerData:<id> + bubbleId:<id>:<bubble>) and the Cursor Agent
// transcripts under ~/.cursor/projects/*/agent-transcripts. Adapted from Asymptote Labs agent-beacon (MIT).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ScanCtx, SessionUpdate, Source, Turn, Where } from './types.js';
import { MAX_TURNS, arr, asText, blockText, columns, dashDecode, iso, isObj, jsonlUpdate, normalizeDir, openDb, parseObj, str, stripReminders, toMs, userQuery, type Obj } from './util.js';

const MAX_DB_BYTES = 2 * 1024 ** 3;
const dbPath = (w: Where) => join(w.home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const projectsDir = (w: Where) => join(w.home, '.cursor', 'projects');

function dirFromContext(ctx: unknown): string {
  if (!isObj(ctx)) return '';
  const cands: unknown[] = [ctx.uri, ctx.path, ...arr(ctx.folderSelections), ...arr(ctx.fileSelections), ...arr(ctx.terminalFiles)];
  for (const c of cands) {
    const d = isObj(c) ? normalizeDir(c.uri) || normalizeDir(c.path) || normalizeDir(c.filePath) : normalizeDir(c);
    if (d) return d;
  }
  return '';
}

function dirFromBubble(b: Obj): string {
  for (const u of arr(b.workspaceUris)) { const d = normalizeDir(u); if (d) return d; }
  const fromCtx = dirFromContext(b.context);
  if (fromCtx) return fromCtx;
  const tf = isObj(b.toolFormerData) ? parseObj(str(b.toolFormerData.params)) : null;
  for (const k of ['targetFile', 'targetDirectory', 'filePath', 'file_path', 'path', 'directoryPath', 'absolutePath']) {
    const v = tf ? str(tf[k]) : '';
    if (v.startsWith('/')) return k.toLowerCase().includes('directory') ? v : v.replace(/\/[^/]*$/, '') || '/';
  }
  return '';
}

function scanDb(ctx: ScanCtx, path: string, found: { n: number }, seen: Set<string>, out: SessionUpdate[]): void {
  if (statSync(path).size > MAX_DB_BYTES) return;
  const db = openDb(path);
  if (!db) throw new Error('cursor db not readable');
  try {
    if (!columns(db, 'cursorDiskKV').has('value')) return;
    const rows = db.prepare(`SELECT key, json_extract(CAST(value AS TEXT),'$.lastUpdatedAt') AS u, json_extract(CAST(value AS TEXT),'$.createdAt') AS c,
        json_array_length(CAST(value AS TEXT),'$.fullConversationHeadersOnly') AS n FROM cursorDiskKV
      WHERE key >= 'composerData:' AND key < 'composerData;' AND length(value) > 10`).all();
    const cands: { id: string; t: number; n: number }[] = [];
    for (const r of rows) {
      const n = Number(r.n) || 0;
      if (!n) continue;
      const id = String(r.key).slice('composerData:'.length);
      seen.add(id); found.n++;
      const t = toMs(r.u) || toMs(r.c);
      const prev = ctx.sessions[`db:${id}`];
      if (prev ? prev.t === t && prev.n === n : t < ctx.sinceMs) continue;
      cands.push({ id, t, n });
    }
    cands.sort((a, b) => b.t - a.t);
    const one = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
    for (const c of cands) {
      if (ctx.expired()) break;
      try {
        const row = one.get(`composerData:${c.id}`);
        const comp = row ? parseObj(asText(row.value)) : null;
        if (!comp) continue;
        const headers = arr(comp.fullConversationHeadersOnly).filter(isObj);
        const turns: Turn[] = [];
        let cwd = dirFromContext(comp.context);
        for (let i = headers.length - 1, looked = 0; i >= 0 && turns.length < MAX_TURNS && looked < 800; i--, looked++) {
          const br = one.get(`bubbleId:${c.id}:${str(headers[i]!.bubbleId)}`);
          const b = br ? parseObj(asText(br.value)) : null;
          if (!b) continue;
          const text = stripReminders(str(b.text)).trim();
          if (!text) continue;
          const at = iso(toMs(b.createdAt));
          if (b.type === 1) turns.push({ role: 'user', text, ...(at ? { at } : {}) });
          else if (b.type === 2 && !b.toolFormerData) turns.push({ role: 'assistant', text, ...(at ? { at } : {}) });
        }
        if (!cwd) for (const h of headers.slice(0, 8)) { // earliest bubbles carry the workspace
          const br = one.get(`bubbleId:${c.id}:${str(h.bubbleId)}`);
          const b = br ? parseObj(asText(br.value)) : null;
          cwd = b ? dirFromBubble(b) : '';
          if (cwd) break;
        }
        out.push({ id: c.id, key: `db:${c.id}`, sig: { t: c.t, n: c.n }, title: str(comp.name), cwd, turns: turns.reverse(), updatedMs: c.t });
      } catch (e) { ctx.fail(e); }
    }
  } finally { db.close(); }
}

function transcriptTurns(objs: Obj[]): Turn[] {
  const turns: Turn[] = [];
  for (const o of objs) {
    const role = str(o.role);
    if (role !== 'user' && role !== 'assistant') continue;
    const msg = isObj(o.message) ? o.message : o;
    let text = stripReminders(blockText(msg.content)).trim();
    if (role === 'user') text = userQuery(text);
    if (text) turns.push({ role, text });
  }
  return turns;
}

function scanTranscripts(ctx: ScanCtx, dir: string, found: { n: number }, seen: Set<string>, out: SessionUpdate[]): void {
  for (const proj of readdirSync(dir, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const tdir = join(dir, proj.name, 'agent-transcripts');
    let entries;
    try { entries = readdirSync(tdir, { withFileTypes: true }); } catch { continue; }
    const cwd = dashDecode(proj.name);
    for (const e of entries) {
      const files = e.isDirectory() ? [[e.name, join(tdir, e.name, `${e.name}.jsonl`)]] : e.name.endsWith('.jsonl') ? [[e.name.slice(0, -6), join(tdir, e.name)]] : [];
      for (const [id, path] of files as [string, string][]) {
        if (seen.has(id)) continue; // the composer database already has this chat
        try {
          statSync(path); found.n++;
          const u = jsonlUpdate(ctx, { key: `tx:${path}`, id, path, cwd }, transcriptTurns);
          if (u) out.push(u);
        } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') ctx.fail(err); }
      }
    }
  }
}

export const cursor: Source = {
  id: 'cursor', harness: 'cursor', label: 'Cursor',
  exists: w => { try { statSync(dbPath(w)); return true; } catch { try { return statSync(projectsDir(w)).isDirectory(); } catch { return false; } } },
  scan(ctx) {
    const found = { n: 0 }, seen = new Set<string>(), updates: SessionUpdate[] = [];
    try { scanDb(ctx, dbPath(ctx), found, seen, updates); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') ctx.fail(e); }
    try { scanTranscripts(ctx, projectsDir(ctx), found, seen, updates); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') ctx.fail(e); }
    return { found: found.n, updates };
  },
};
