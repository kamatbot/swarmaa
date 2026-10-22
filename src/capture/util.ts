// Shared readers for the capture sources: read-only SQLite, partial-line-safe JSONL windows, text cleaning.
// Adapted from Asymptote Labs agent-beacon (MIT): sqliteuri read-only opening, column probing, dash-encoded project dirs.
import { closeSync, existsSync, openSync, readSync, statSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ScanCtx, SessionUpdate, Turn } from './types.js';

export const MAX_TURNS = 40;
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
const WINDOW_BYTES = 9 * 1024 * 1024; // must exceed MAX_LINE_BYTES so a maximal line still fits
const HEAD_BYTES = 64 * 1024;
export const DAY_MS = 86_400_000;

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const asText = (v: unknown): string => (typeof v === 'string' ? v : v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : '');

export function parseObj(text: string): Obj | null {
  try { const v: unknown = JSON.parse(text); return isObj(v) ? v : null; } catch { return null; }
}

/** Epoch milliseconds from a number (seconds or ms), numeric string or ISO string; 0 when unknown. */
export function toMs(v: unknown): number {
  if (typeof v === 'string' && v.trim() !== '' && !/^-?\d+(\.\d+)?$/.test(v.trim())) { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; }
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}
export const iso = (ms: number): string | undefined => (ms > 0 ? new Date(ms).toISOString() : undefined);

export const firstPrompt = (turns: Turn[]): string => turns.find(t => t.role === 'user')?.text.replace(/\s+/g, ' ').trim() ?? '';

// ---------- text cleaning ----------
export function stripReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}
export function userQuery(text: string): string {
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return (m ? m[1]! : text).trim();
}
/** Text of Anthropic-style content: a string, or blocks of the given types. Tool use/results and thinking are never included. */
export function blockText(content: unknown, types: readonly string[] = ['text']): string {
  if (typeof content === 'string') return content;
  return arr(content).filter((b): b is Obj => isObj(b) && types.includes(str(b.type)) && typeof b.text === 'string').map(b => b.text as string).join('\n\n');
}

// ---------- paths ----------
/** A directory from a path or file: URI. An existing file maps to its directory. '' when relative or unusable. */
export function normalizeDir(value: unknown): string {
  let v = str(value).trim();
  if (!v) return '';
  if (v.startsWith('file://')) { try { v = fileURLToPath(v); } catch { return ''; } }
  if (!v.startsWith('/')) return '';
  try { if (statSync(v).isFile()) return dirname(v); } catch { /* may be gone; keep the path */ }
  return v;
}

/** Cursor / Factory encode a cwd as dash-separated components; walk the filesystem to find the real directory. */
export function dashDecode(name: string): string {
  const parts = name.replace(/^-+/, '').split('-').filter(Boolean);
  if (!parts.length) return '';
  const seen = new Set<string>();
  const walk = (root: string, idx: number): string => {
    const k = `${root}\0${idx}`;
    if (seen.has(k)) return '';
    seen.add(k);
    for (let end = parts.length; end > idx; end--) {
      const cand = `${root === '/' ? '' : root}/${parts.slice(idx, end).join('-')}`;
      try { if (!statSync(cand).isDirectory()) continue; } catch { continue; }
      if (end === parts.length) return cand;
      const nested = walk(cand, end);
      if (nested) return nested;
    }
    return '';
  };
  return walk('/', 0);
}

// ---------- SQLite (read-only) ----------
/** Opens a database read-only via a file: URI with a busy timeout; null when it cannot be opened. */
export function openDb(path: string): DatabaseSync | null {
  try {
    const db = new DatabaseSync(`${pathToFileURL(path).href}?mode=ro`, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 1000; PRAGMA query_only = 1');
    return db;
  } catch { return null; }
}
/** Column names of a table (empty set when the table is missing). */
export function columns(db: DatabaseSync, table: string): Set<string> {
  try { return new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(r => String(r.name))); } catch { return new Set(); }
}
/** `name` when the column exists, else `NULL AS name`, so older schemas still query. */
export const pick = (cols: Set<string>, name: string): string => (cols.has(name) ? name : `NULL AS ${name}`);

// ---------- JSONL windows ----------
export interface Window { size: number; mtimeMs: number; offset: number; lastLine: number; objs: Obj[]; head: Obj[] }

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  const n = readSync(fd, buf, 0, len, pos);
  return buf.subarray(0, n);
}
function parseLines(buf: Buffer): Obj[] {
  const out: Obj[] = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim() || line.length > MAX_LINE_BYTES) continue; // skip oversized lines
    const o = parseObj(line);
    if (o) out.push(o);
  }
  return out;
}
function countNewlines(fd: number, upTo: number): number {
  let n = 0;
  for (let pos = 0; pos < upTo;) {
    const b = readAt(fd, pos, Math.min(1 << 20, upTo - pos));
    if (!b.length) break;
    for (let i = 0; i < b.length; i++) if (b[i] === 10) n++;
    pos += b.length;
  }
  return n;
}

/**
 * The newest complete lines of a JSONL file (up to ~9 MiB) plus its first lines. A trailing line without a newline is a
 * write in progress: it is not parsed and `offset` stops before it, so the next run sees it once it is finished.
 */
export function readWindow(path: string, st: Stats): Window {
  const fd = openSync(path, 'r');
  try {
    const start = Math.max(0, st.size - WINDOW_BYTES);
    const buf = readAt(fd, start, st.size - start);
    const lastNl = buf.lastIndexOf(10);
    const firstNl = buf.indexOf(10);
    const from = start > 0 ? (firstNl < 0 ? buf.length : firstNl + 1) : 0; // the first line of a mid-file window is partial
    const body = lastNl >= from && lastNl >= 0 ? buf.subarray(from, lastNl) : Buffer.alloc(0);
    const offset = lastNl >= 0 ? start + lastNl + 1 : 0;
    const objs = parseLines(body);
    let head = objs;
    if (start > 0) {
      const h = readAt(fd, 0, Math.min(HEAD_BYTES, st.size));
      const nl = h.lastIndexOf(10);
      head = nl > 0 ? parseLines(h.subarray(0, nl)) : [];
    }
    return { size: st.size, mtimeMs: Math.floor(st.mtimeMs), offset, lastLine: countNewlines(fd, offset), objs, head };
  } finally { closeSync(fd); }
}

export interface FileMeta { id?: string; cwd?: string; title?: string }
/**
 * One JSONL file as a session update: null when unchanged (size+mtime) or, without a cursor, older than the first-run window.
 * `extract` turns parsed lines into text turns; `header` reads id/cwd/title from the first lines.
 */
export function jsonlUpdate(ctx: ScanCtx, f: { key: string; id: string; path: string; cwd?: string; title?: string }, extract: (objs: Obj[]) => Turn[], header?: (head: Obj[]) => FileMeta): SessionUpdate | null {
  const st = statSync(f.path);
  const prev = ctx.sessions[f.key];
  const mtime = Math.floor(st.mtimeMs);
  if (prev ? prev.size === st.size && prev.mtime === mtime : mtime < ctx.sinceMs) return null;
  const w = readWindow(f.path, st);
  const hdr = header?.(w.head) ?? {};
  const turns = extract(w.objs).slice(-MAX_TURNS);
  return {
    id: hdr.id || f.id, key: f.key,
    sig: { size: w.size, mtime: w.mtimeMs, offset: w.offset, last_line: w.lastLine },
    title: hdr.title || f.title || firstPrompt(extract(w.head).slice(0, 5)),
    cwd: hdr.cwd || f.cwd || '', turns, updatedMs: mtime,
  };
}

export const exists = (p: string): boolean => existsSync(p);
