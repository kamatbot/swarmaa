import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, opendirSync, readSync, renameSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentConfig, Task } from './types.js';

/** Makes a worker run resumable from the native CLI by copying its transcript where that CLI looks for the project root. */
export interface NativePlan {
  harness: 'claude' | 'codex';
  home: string;
  /** Claude: the session id passed as --session-id. */
  id?: string;
  /** Claude patch: realpath of the worktree (the worker's cwd, hence its history slug). */
  worktreeReal?: string;
  /** Codex: per-task CODEX_HOME with a private copy of auth.json, never a link. */
  codexHome?: string;
  /** Used for compare-before-replace when Codex rotates its provider credential. */
  authSourceSha256?: string;
}
export interface NativeSession { harness: 'claude' | 'codex'; id: string; resume: string }

function real(p: string): string { try { return realpathSync(p); } catch { return p; } }
/** Claude's project-dir name: realpath with every non-alphanumeric character turned into '-'. */
export function slug(path: string): string { return real(path).replace(/[^A-Za-z0-9]/gu, '-'); }
/** The only transcript edit: the worktree path becomes the project-root path. */
export function rewriteTranscript(text: string, worktrees: string[], root: string): string {
  let out = text;
  for (const w of [...new Set(worktrees)].sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(w, (match: string, offset: number, whole: string) => {
      const next = whole[offset + w.length];
      return next === undefined || /[\/"'\s]/u.test(next) || next === '\\' ? root : match;
    });
  }
  return out;
}
const sh = (s: string): string => /^[\w@%+=:,./-]+$/u.test(s) ? s : `'${s.replace(/'/gu, `'\\''`)}'`;

/** Directory the sandbox opens read+write for a Claude patch worker (and nothing else under ~/.claude/projects). */
export function claudeWorkerDir(worktree: string, home = homedir()): string { return join(real(home), '.claude', 'projects', slug(worktree)); }

/** Before the run, outside the sandbox. Claude read tasks stay unpersisted (their cwd is the user's real project). */
export function prepareNative(agent: AgentConfig, task: Task, worktreeDir?: string, home = homedir(), tmp = process.env.TMPDIR ?? tmpdir()): NativePlan | undefined {
  if (agent.provider === 'claude' && task.kind === 'patch' && worktreeDir) {
    const plan: NativePlan = { harness: 'claude', home, id: randomUUID(), worktreeReal: real(worktreeDir) };
    mkdirSync(claudeWorkerDir(worktreeDir, home), { recursive: true, mode: 0o700 });
    return plan;
  }
  if (agent.provider === 'codex') {
    const codexHome = real(mkdtempSync(join(tmp, 'swarmaa-codex-')));
    chmodSync(codexHome, 0o700);
    const plan: NativePlan = { harness: 'codex', home: real(home), codexHome, ...(worktreeDir ? { worktreeReal: real(worktreeDir) } : {}) };
    try {
      const authPath = join(real(home), '.codex', 'auth.json');
      if (existsSync(authPath)) {
        const auth = readAuth(authPath);
        write0600(join(codexHome, 'auth.json'), auth);
        plan.authSourceSha256 = digest(auth);
      }
      // No interactive config, .env, MCP servers, history, skills or plugins cross
      // the boundary. An API-key environment or provider login supplies auth.
      return plan;
    } catch (error) {
      rmSync(codexHome, { recursive: true, force: true });
      throw error;
    }
  }
  return undefined;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
function readAuth(path: string): string {
  const text = readRegular(path, 64 * 1024);
  const auth: unknown = JSON.parse(text);
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('Provider auth must contain an object');
  return text;
}

/** Native outputs are untrusted files: never follow links out of the sandbox on export. */
function readRegular(path: string, limit: number): string {
  // A task may create a FIFO at the expected filename. Nonblocking open lets us
  // reject it by fstat instead of hanging the unsandboxed bridge before validation.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('Native file must be a bounded regular file without hard links');
    // Bound the actual read as well: a file may grow after the metadata check.
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > limit) throw new Error('Native file exceeds the export limit');
    return buffer.subarray(0, bytes).toString('utf8');
  } finally { closeSync(fd); }
}

function rollouts(dir: string): string[] {
  const out: string[] = [];
  let visited = 0;
  const walk = (d: string, depth: number): void => {
    if (depth > 12 || realpathSync(d) !== d) throw new Error('Native rollout tree is too deep or contains a directory link');
    const directory = opendirSync(d);
    try {
      for (let e = directory.readSync(); e; e = directory.readSync()) {
        if (++visited > 2048) throw new Error('Native rollout tree exceeds the export limit');
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && /^rollout-.*\.jsonl$/u.test(e.name)) out.push(p);
      }
    } finally { directory.closeSync(); }
  };
  if (existsSync(dir) && lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink()) walk(dir, 0);
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** Only the token refresh fields of the same existing account may be reconciled. */
function refreshedAuth(original: string, refreshed: string): string | undefined {
  const before = JSON.parse(original) as Record<string, unknown>;
  const after = JSON.parse(refreshed) as Record<string, unknown>;
  if (before.auth_mode !== after.auth_mode || before.OPENAI_API_KEY !== after.OPENAI_API_KEY) return undefined;
  const oldTokens = before.tokens, newTokens = after.tokens;
  if (!oldTokens || typeof oldTokens !== 'object' || Array.isArray(oldTokens) || !newTokens || typeof newTokens !== 'object' || Array.isArray(newTokens)) return undefined;
  const old = oldTokens as Record<string, unknown>, next = newTokens as Record<string, unknown>;
  if (typeof old.account_id !== 'string' || !old.account_id || old.account_id !== next.account_id) return undefined;
  const tokens = { ...old };
  for (const key of ['access_token', 'refresh_token', 'id_token']) {
    if (next[key] !== undefined) {
      if (typeof next[key] !== 'string' || !next[key]) return undefined;
      tokens[key] = next[key];
    }
  }
  const merged: Record<string, unknown> = { ...before, tokens };
  if (after.last_refresh !== undefined) {
    if (typeof after.last_refresh !== 'string' || !Number.isFinite(Date.parse(after.last_refresh))) return undefined;
    merged.last_refresh = after.last_refresh;
  }
  return JSON.stringify(merged, null, 2) + '\n';
}
function write0600(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const staged = `${file}.swarmaa-${randomUUID()}`;
  try {
    writeFileSync(staged, text, { mode: 0o600, flag: 'wx' });
    renameSync(staged, file);
  } finally { rmSync(staged, { force: true }); }
}

/** After the run, outside the sandbox. Always removes the temp dirs. Throws when no transcript could be installed. */
export function finishNative(plan: NativePlan, projectRoot: string, rawWorktree?: string): NativeSession {
  const root = real(projectRoot);
  const worktrees = [plan.worktreeReal, rawWorktree].filter((x): x is string => !!x);
  try {
    if (plan.harness === 'claude') {
      const history = claudeWorkerDir(plan.worktreeReal!, plan.home);
      if (realpathSync(history) !== history) throw new Error('Claude transcript directory must not be a link');
      const src = join(history, `${plan.id}.jsonl`);
      if (!existsSync(src)) throw new Error('claude wrote no transcript');
      write0600(join(real(plan.home), '.claude', 'projects', slug(root), `${plan.id}.jsonl`), rewriteTranscript(readRegular(src, 16 * 1024 * 1024), worktrees, root));
      return { harness: 'claude', id: plan.id!, resume: `cd ${sh(root)} && claude --resume ${plan.id}` };
    }
    if (realpathSync(plan.codexHome!) !== plan.codexHome) throw new Error('Codex private home must not be a link');
    const src = rollouts(join(plan.codexHome!, 'sessions'))[0];
    if (!src) throw new Error('codex wrote no rollout');
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(src)?.[1];
    if (!id) throw new Error('codex rollout has no thread id');
    write0600(join(plan.home, '.codex', 'sessions', relative(join(plan.codexHome!, 'sessions'), src)), rewriteTranscript(readRegular(src, 16 * 1024 * 1024), worktrees, root));
    return { harness: 'codex', id, resume: `cd ${sh(root)} && codex resume ${id}` };
  } finally {
    cleanupNative(plan);
  }
}

/** Idempotent; also the cleanup path when the run never produced a transcript. */
export function cleanupNative(plan: NativePlan): void {
  if (plan.codexHome) {
    // Preserve a provider refresh only if the interactive credential still has
    // the exact bytes copied at prepare time. Never overwrite a later login or
    // another concurrent run's refresh; never follow a task-created symlink.
    try {
      const source = join(plan.home, '.codex', 'auth.json');
      const original = readAuth(source);
      if (plan.authSourceSha256 && digest(original) === plan.authSourceSha256 && realpathSync(plan.codexHome) === plan.codexHome) {
        const candidate = readAuth(join(plan.codexHome, 'auth.json'));
        const refreshed = digest(candidate) !== plan.authSourceSha256 ? refreshedAuth(original, candidate) : undefined;
        if (refreshed) {
          const staged = `${source}.swarmaa-${randomUUID()}`;
          try {
            writeFileSync(staged, refreshed, { mode: 0o600, flag: 'wx' });
            // Recheck immediately before rename; this is conservative local
            // reconciliation, not a cross-process atomic credential service.
            if (digest(readAuth(source)) === plan.authSourceSha256) renameSync(staged, source);
          } finally { rmSync(staged, { force: true }); }
        }
      }
    } catch { /* Missing/invalid/concurrently changed credentials never replace the user's login. */ }
    rmSync(plan.codexHome, { recursive: true, force: true });
  }
  if (plan.harness === 'claude' && plan.worktreeReal) rmSync(claudeWorkerDir(plan.worktreeReal, plan.home), { recursive: true, force: true });
}
