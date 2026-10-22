// Poll-based chat capture: scan every installed source once, send changed sessions to the local Swarmaa service, save cursors.
// No daemon: scripts/capture.ts runs this and exits (a LaunchAgent re-runs it on an interval).
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveScope } from '../../clients/hooks/swarmaa-journal.mjs';
import { redactSecrets } from '../safety/redact.js';
import { cline, roo } from './cline.js';
import { copilot } from './copilot.js';
import { cursor } from './cursor.js';
import { devin } from './devin.js';
import { factory } from './factory.js';
import { hermes } from './hermes.js';
import { opencode } from './opencode.js';
import { pi } from './pi.js';
import type { ScanCtx, SessionUpdate, Source, SourceState, Where } from './types.js';
import { DAY_MS, MAX_TURNS, firstPrompt } from './util.js';

export const SOURCES: readonly Source[] = [cursor, opencode, copilot, cline, roo, devin, hermes, factory, pi];
export const SOURCE_IDS = SOURCES.map(s => s.id);

const MAX_TEXT = 8000, MAX_BODY = 120 * 1024, WINDOW_DAYS = 14, LOCK_STALE_MS = 5 * 60_000;

/** Ids of the sources whose app data exists on this machine (used by setup). */
export function detectSources(w: Where = { home: homedir(), env: process.env }): string[] {
  return SOURCES.filter(s => { try { return s.exists(w); } catch { return false; } }).map(s => s.id);
}

export interface SourceReport { id: string; label: string; present: boolean; found: number; changed: number; sent: number; errors: string[] }
export interface RunOptions {
  root: string; home?: string; env?: NodeJS.ProcessEnv; dry?: boolean; only?: string[]; now?: number; budgetMs?: number;
  /** Overrides http://127.0.0.1:<PORT from .env>. */
  serviceUrl?: string; fetchFn?: typeof fetch; sources?: readonly Source[];
}

const readJson = (p: string): unknown => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function readPort(envText: string): number {
  for (const raw of envText.split(/\r?\n/)) {
    const m = raw.trim().match(/^(?:export\s+)?PORT\s*=\s*["']?(\d{1,5})["']?\s*$/);
    if (m) return Number(m[1]);
  }
  return 8787;
}

export const statePath = (root: string, id: string) => join(root, '.local', 'capture', `${id}.json`);
export function loadState(root: string, id: string): SourceState {
  const v = readJson(statePath(root, id));
  return isObj(v) && v.version === 1 && isObj(v.sessions) ? { version: 1, sessions: v.sessions as SourceState['sessions'] } : { version: 1, sessions: {} };
}
export function saveState(root: string, id: string, state: SourceState): void {
  const file = statePath(root, id), tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Status words only: never chat text, paths with content, tokens or error messages. */
function logWord(root: string, source: string, word: string): void {
  try {
    const dir = join(root, '.local', 'logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, 'capture.log'), `${new Date().toISOString()} ${source} ${word}\n`, { mode: 0o600 });
  } catch { /* ignore */ }
}
const errWord = (e: unknown): string => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return `error ${(e as Error | undefined)?.name ?? 'Error'}${typeof code === 'string' ? ` ${code.replace(/[^A-Z0-9_]/g, '')}` : ''}`;
};

/** session_record body: scope by cwd, redacted, clipped, <=40 turns, <=MAX_BODY bytes (oldest turns drop first). */
export function buildBody(harness: string, u: SessionUpdate, projects: unknown): Record<string, unknown> {
  const turns = u.turns.slice(-MAX_TURNS).map(t => ({ role: t.role, text: redactSecrets(t.text).slice(0, MAX_TEXT), ...(t.at ? { at: t.at } : {}) })).filter(t => t.text.trim());
  const title = redactSecrets(u.title?.trim() || firstPrompt(u.turns)).replace(/\s+/g, ' ').trim().slice(0, 120);
  const body: { turns: typeof turns } & Record<string, unknown> = {
    harness, session_id: u.id.slice(0, 200), scope: resolveScope(u.cwd ?? '', projects),
    ...(title ? { title } : {}), ...(u.cwd ? { cwd: u.cwd.slice(0, 1024) } : {}), turns, ended: false,
  };
  while (body.turns.length > 1 && Buffer.byteLength(JSON.stringify(body)) > MAX_BODY) body.turns.shift();
  return body;
}

function takeLock(root: string): (() => void) | null {
  const file = join(root, '.local', 'capture', '.lock');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try { writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 }); return () => rmSync(file, { force: true }); } catch {
      try { if (Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS) rmSync(file, { force: true }); else return null; } catch { /* raced; retry */ }
    }
  }
  return null;
}

export async function runCapture(o: RunOptions): Promise<{ reports: SourceReport[]; skipped?: string }> {
  const started = Date.now(), now = o.now ?? started, dry = o.dry === true;
  const budgetMs = o.budgetMs ?? 60_000;
  const where: Where = { home: o.home ?? homedir(), env: o.env ?? process.env };
  const expired = () => Date.now() - started > budgetMs;
  const chosen = (o.sources ?? SOURCES).filter(s => !o.only?.length || o.only.includes(s.id));
  const release = dry ? () => undefined : takeLock(o.root);
  if (!release) return { reports: [], skipped: 'another capture run is active' };

  const token = (readJson(join(o.root, '.local', 'capture.json')) as { token?: unknown } | null)?.token;
  let url = o.serviceUrl;
  if (!url) { let port = 8787; try { port = readPort(readFileSync(join(o.root, '.env'), 'utf8')); } catch { /* default */ } url = `http://127.0.0.1:${port}`; }
  const projects = (readJson(join(o.root, '.local', 'setup.json')) as { projects?: unknown } | null)?.projects;
  const doFetch = o.fetchFn ?? fetch;
  const reports: SourceReport[] = [];
  let abort = '';

  try {
    for (const src of chosen) {
      const rep: SourceReport = { id: src.id, label: src.label, present: false, found: 0, changed: 0, sent: 0, errors: [] };
      reports.push(rep);
      try { rep.present = src.exists(where); } catch { /* treated as absent */ }
      if (!rep.present) continue;
      const state = loadState(o.root, src.id);
      let dirty = false;
      const ctx: ScanCtx = { ...where, now, sinceMs: now - WINDOW_DAYS * DAY_MS, sessions: state.sessions, expired, fail: e => { rep.errors.push(errWord(e)); } };
      let updates: SessionUpdate[] = [];
      try { const r = src.scan(ctx); rep.found = r.found; updates = r.updates; } catch (e) { rep.errors.push(errWord(e)); }
      updates.sort((a, b) => b.updatedMs - a.updatedMs);
      for (const u of updates) {
        if (!u.turns.length) { if (!dry) { state.sessions[u.key] = u.sig; dirty = true; } continue; } // nothing to send; still advance the cursor
        rep.changed++;
        if (dry || abort) continue;
        if (expired()) { rep.errors.push('budget'); break; }
        if (typeof token !== 'string' || !token) { abort = 'no-token'; rep.errors.push('no-token'); continue; }
        try {
          const res = await doFetch(`${url}/api/tools/session_record`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(buildBody(src.harness, u, projects)), signal: AbortSignal.timeout(5000),
          });
          await res.arrayBuffer().catch(() => undefined);
          if (res.ok) { state.sessions[u.key] = u.sig; dirty = true; rep.sent++; continue; }
          rep.errors.push(`http-${res.status}`);
          if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) abort = `http-${res.status}`; // credentials or service trouble: stop sending
          else { state.sessions[u.key] = u.sig; dirty = true; } // the service rejected this content; do not resend it every run
        } catch (e) { abort = 'unreachable'; rep.errors.push(`send ${(e as Error).name}`); }
      }
      if (dirty && !dry) saveState(o.root, src.id, state);
      if (!dry) for (const w of new Set(rep.errors)) logWord(o.root, src.id, w);
    }
  } finally { release(); }
  return { reports };
}
