// Sync Claude Code file memories (~/.claude/projects/<cwd>/memory/*.md) into the shared Swarmaa memory store. Never logs content.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readPort } from './index.js';

const MAX_BYTES = 32768, GENERAL = 'project:general';
const enc = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-');

export function scopeForProjectDir(dirName: string, projects: unknown): string {
  let best = '', scope = GENERAL;
  if (Array.isArray(projects)) for (const p of projects) {
    if (!p || typeof p.scope !== 'string' || typeof p.root !== 'string') continue;
    const e = enc(p.root);
    if ((dirName === e || dirName.startsWith(e + '-')) && e.length > best.length) { best = e; scope = p.scope; }
  }
  return scope;
}

/** Project roots from setup.json plus every bridge config (projects added to a bridge by hand are not in setup.json). */
export function loadProjects(root: string): { scope: string; root: string }[] {
  const all: unknown[] = [...(readJson(join(root, '.local', 'setup.json'))?.projects ?? [])];
  let names: string[] = []; try { names = readdirSync(join(root, '.local')); } catch { /* none */ }
  for (const n of names) if (/^bridge-[a-z0-9-]+\.json$/.test(n)) all.push(...(readJson(join(root, '.local', n))?.projects ?? []));
  const seen = new Map<string, { scope: string; root: string }>();
  for (const p of all as any[]) if (p && typeof p.scope === 'string' && typeof p.root === 'string' && p.scope !== GENERAL && !seen.has(p.root)) seen.set(p.root, { scope: p.scope, root: p.root });
  return [...seen.values()];
}

interface Entry { scope: string; key: string; hash: string; version?: number; status?: 'ok' | 'expired' | 'retracted' }
type State = Record<string, Entry>;

const readJson = (p: string): any => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const statePath = (root: string) => join(root, '.local', 'capture', 'claude-memory.json');
function saveState(root: string, s: State): void {
  const file = statePath(root), tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(tmp, JSON.stringify({ version: 1, files: s }), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function clip(s: string): string {
  const b = Buffer.from(s, 'utf8');
  return b.length <= MAX_BYTES ? s : b.subarray(0, MAX_BYTES).toString('utf8').replace(/�+$/, '');
}

export async function syncClaudeMemories(o: { root: string; home?: string; dry?: boolean; fetchImpl?: typeof fetch; max?: number }) {
  const out = { found: 0, sent: 0, expired: 0, errors: [] as string[] };
  const dry = o.dry === true, max = o.max ?? 60, doFetch = o.fetchImpl ?? fetch;
  const token = readJson(join(o.root, '.local', 'capture.json'))?.token;
  let port = 8787; try { port = readPort(readFileSync(join(o.root, '.env'), 'utf8')); } catch { /* default */ }
  const origin = `http://127.0.0.1:${port}`;
  const projects = loadProjects(o.root);
  const base = join(o.home ?? homedir(), '.claude', 'projects');
  const loaded = readJson(statePath(o.root));
  const state: State = loaded?.version === 1 && loaded.files && typeof loaded.files === 'object' ? loaded.files : {};

  const files: { path: string; scope: string; key: string; mtime: number }[] = [];
  let dirs: string[] = []; try { dirs = readdirSync(base); } catch { /* none */ }
  for (const d of dirs) {
    let names: string[] = []; try { names = readdirSync(join(base, d, 'memory')); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.md') || n === 'MEMORY.md') continue;
      const path = join(base, d, 'memory', n);
      try { files.push({ path, scope: scopeForProjectDir(d, projects), key: `claude-memory/${n.slice(0, -3)}`.slice(0, 240), mtime: statSync(path).mtimeMs }); } catch { /* vanished */ }
    }
  }
  out.found = files.length;
  files.sort((a, b) => b.mtime - a.mtime);
  const taken = new Set<string>();
  const winners = files.filter(f => { const k = `${f.scope}\0${f.key}`; if (taken.has(k)) return false; taken.add(k); return true; });

  const post = async (body: Record<string, unknown>): Promise<{ ok: true; version?: number; conflict?: boolean } | { ok: false; code: string }> => {
    let r: Response;
    try {
      r = await doFetch(`${origin}/api/tools/memory_propose`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    } catch { return { ok: false, code: 'unreachable' }; }
    const j: any = await r.json().catch(() => null);
    if (r.ok) return { ok: true, version: j?.result?.memory?.version, conflict: j?.result?.conflict === true };
    return { ok: false, code: j?.error?.code ?? `http_${r.status}` };
  };
  // ponytail: one retry on version_conflict; unreachable aborts the whole run.
  const send = async (body: Record<string, unknown>) => {
    let r = await post(body);
    if (!r.ok && r.code === 'version_conflict' && body.expected_version !== undefined) { const { expected_version: _, ...rest } = body; r = await post(rest); }
    // The file is the source of truth for claude-memory/* keys: a stale or missing version is retried once at the current one.
    if (r.ok && r.conflict && typeof r.version === 'number') r = await post({ ...body, expected_version: r.version });
    return r;
  };

  let http = 0, stop = false;
  const live = new Set(files.map(f => f.path));
  if (!dry && (typeof token !== 'string' || !token)) { out.errors.push('no-token'); stop = true; }

  for (const f of winners) {
    if (stop) break;
    let content: string; try { content = readFileSync(f.path, 'utf8'); } catch { continue; }
    const hash = createHash('sha256').update(content).digest('hex');
    const prev = state[f.path];
    if (prev?.status === 'retracted' || (prev && prev.hash === hash && prev.status !== 'expired')) continue;
    if (http >= max) break;
    out.sent++;
    if (dry) continue;
    http++;
    const body: Record<string, unknown> = { scope: f.scope, kind: 'note', key: f.key, content: clip(content), source: { type: 'agent', reference: f.path, observed_at: new Date(f.mtime).toISOString() } };
    if (prev?.version !== undefined && prev.status !== 'expired') body.expected_version = prev.version;
    const r = await send(body);
    if (r.ok) state[f.path] = { scope: f.scope, key: f.key, hash, version: r.version, status: 'ok' };
    else if (r.code === 'unreachable') { out.sent--; out.errors.push('unreachable'); stop = true; }
    else { out.sent--; if (r.code === 'memory_retracted') state[f.path] = { scope: f.scope, key: f.key, hash, status: 'retracted' }; else out.errors.push(r.code); }
  }

  for (const [path, e] of Object.entries(state)) {
    if (stop || live.has(path) || e.status === 'expired' || e.status === 'retracted') continue;
    out.expired++;
    if (dry) continue;
    const body: Record<string, unknown> = { scope: e.scope, kind: 'note', key: e.key, content: '(deleted from Claude memory)', source: { type: 'agent', reference: path, observed_at: new Date().toISOString() }, expires_at: new Date().toISOString() };
    if (e.version !== undefined) body.expected_version = e.version;
    const r = await send(body);
    if (r.ok) state[path] = { ...e, version: r.version, status: 'expired' };
    else { out.expired--; if (r.code === 'unreachable') { out.errors.push('unreachable'); stop = true; } else if (r.code === 'memory_retracted') state[path] = { ...e, status: 'retracted' }; else out.errors.push(r.code); }
  }

  if (!dry) saveState(o.root, state);
  return out;
}
