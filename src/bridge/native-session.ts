import { chmodSync, existsSync, lstatSync, renameSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentConfig, Task } from './types.js';

/** Makes a worker run resumable from the native CLI by copying its transcript where that CLI looks for the project root. */
export interface NativePlan {
  harness: 'claude' | 'codex';
  home: string;
  /** Claude: the session id passed as --session-id. */
  id?: string;
  /** Claude patch: realpath of the worktree (the worker's cwd, hence its history slug). */
  worktreeReal?: string;
  /** Codex: per-task CODEX_HOME holding only a link to auth.json. */
  codexHome?: string;
}
export interface NativeSession { harness: 'claude' | 'codex'; id: string; resume: string }

function real(p: string): string { try { return realpathSync(p); } catch { return p; } }
/** Claude's project-dir name: realpath with every non-alphanumeric character turned into '-'. */
export function slug(path: string): string { return real(path).replace(/[^A-Za-z0-9]/gu, '-'); }
/** The only transcript edit: the worktree path becomes the project-root path. */
export function rewriteTranscript(text: string, worktrees: string[], root: string): string {
  let out = text;
  for (const w of [...new Set(worktrees)].sort((a, b) => b.length - a.length)) out = out.split(w).join(root);
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
  // Codex and agy run with the user's own home and save their sessions natively; nothing to prepare.
  return undefined;
}

function rollouts(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/^rollout-.*\.jsonl$/u.test(e.name)) out.push(p); } };
  if (existsSync(dir)) walk(dir);
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}
function write0600(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** After the run, outside the sandbox. Always removes the temp dirs. Throws when no transcript could be installed. */
export function finishNative(plan: NativePlan, projectRoot: string, rawWorktree?: string): NativeSession {
  const root = real(projectRoot);
  const worktrees = [plan.worktreeReal, rawWorktree].filter((x): x is string => !!x);
  try {
    if (plan.harness === 'claude') {
      const src = join(claudeWorkerDir(plan.worktreeReal!, plan.home), `${plan.id}.jsonl`);
      if (!existsSync(src)) throw new Error('claude wrote no transcript');
      write0600(join(real(plan.home), '.claude', 'projects', slug(root), `${plan.id}.jsonl`), rewriteTranscript(readFileSync(src, 'utf8'), worktrees, root));
      return { harness: 'claude', id: plan.id!, resume: `cd ${sh(root)} && claude --resume ${plan.id}` };
    }
    const src = rollouts(join(plan.codexHome!, 'sessions'))[0];
    if (!src) throw new Error('codex wrote no rollout');
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(src)?.[1];
    if (!id) throw new Error('codex rollout has no thread id');
    write0600(join(plan.home, '.codex', 'sessions', relative(join(plan.codexHome!, 'sessions'), src)), rewriteTranscript(readFileSync(src, 'utf8'), worktrees, root));
    return { harness: 'codex', id, resume: `cd ${sh(root)} && codex resume ${id}` };
  } finally {
    cleanupNative(plan);
  }
}

/** Idempotent; also the cleanup path when the run never produced a transcript. */
export function cleanupNative(plan: NativePlan): void {
  if (plan.codexHome) {
    // Codex may refresh its login by replacing the auth.json link with a new file; keep that token
    // (refresh tokens rotate, so dropping it would sign the user out).
    const temp = join(plan.codexHome, 'auth.json');
    try {
      if (!lstatSync(temp).isSymbolicLink()) {
        const real = join(plan.home, '.codex', 'auth.json');
        const staged = `${real}.swarma-${process.pid}`;
        writeFileSync(staged, readFileSync(temp), { mode: 0o600 });
        renameSync(staged, real);
      }
    } catch { /* no auth.json: nothing to keep */ }
    rmSync(plan.codexHome, { recursive: true, force: true });
  }
  if (plan.harness === 'claude' && plan.worktreeReal) rmSync(claudeWorkerDir(plan.worktreeReal, plan.home), { recursive: true, force: true });
}
