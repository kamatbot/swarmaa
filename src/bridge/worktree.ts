import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ARTIFACT_MAX_BYTES } from '../types.js';
import type { Task } from './types.js';

const run = promisify(execFile);
const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export interface Worktree { dir: string; gitDir: string; branch: string; baseRef: string; baseCommit: string; continued: boolean }
export interface PatchOutcome { branch: string; base_ref: string; base_commit: string; head_commit: string | null; changed_files: number; diffstat: string; diff: string; continued: boolean }

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, maxBuffer = 64 * 1024 * 1024): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { env: { ...process.env, ...env }, maxBuffer, encoding: 'utf8' });
  return stdout;
}

// ponytail: in-process, one bridge per host. Serializes only git add/commit/remove per repo, never the provider run.
const tails = new Map<string, Promise<unknown>>();
function serialized<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const next = (tails.get(root) ?? Promise.resolve()).then(fn, fn);
  tails.set(root, next.catch(() => undefined));
  return next;
}

/** ~/.swarma/worktrees/<scope minus "project:">/<task id>; scope characters are flattened so it cannot escape. */
export function worktreeDir(scope: string, taskId: string): string {
  const name = scope.replace(/^project:/u, '').replace(/[^a-z0-9_.-]/gu, '_').replace(/^\.+/u, '_');
  return join(homedir(), '.swarma', 'worktrees', name, taskId);
}

/** Creates the task's own worktree + branch off base_ref (default HEAD). Never touches the user's checkout. */
/** Gitignored dependency folders a fresh worktree lacks, so agents can build and test without installing. */
const DEPENDENCY_DIRS = ['node_modules'];

/**
 * Copy-on-write clones (APFS `cp -c`: near-instant, no extra disk until written) rather than symlinks, so an
 * agent's `npm install` never writes into the main checkout and `git add -A` never commits a link. Best effort:
 * a worktree without them still works, it just has to install.
 */
async function seedDependencies(root: string, dir: string): Promise<void> {
  for (const name of DEPENDENCY_DIRS) {
    if (!existsSync(join(root, name)) || existsSync(join(dir, name))) continue;
    try { await run('/bin/cp', ['-cR', join(root, name), join(dir, name)], { timeout: 60_000 }); } catch { /* not APFS, or no room */ }
  }
}

export async function createWorktree(root: string, provider: string, task: Task): Promise<Worktree> {
  let gitDir: string;
  try { gitDir = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(); }
  catch { throw fail('not_a_git_repo', 'Project root is not a git repository'); }
  const requested = typeof task.base_ref === 'string' && task.base_ref.trim() ? task.base_ref.trim() : '';
  const baseRef = requested || 'HEAD';
  if (baseRef.startsWith('-') || /[\x00-\x1f]/u.test(baseRef)) throw fail('bad_base_ref', 'Invalid base_ref');
  let baseCommit: string;
  try { baseCommit = (await git(root, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`])).trim(); }
  catch { throw fail('bad_base_ref', 'base_ref does not resolve to a commit'); }
  const branch = `swarma/${provider}/${task.id.slice(0, 8)}`;
  const dir = worktreeDir(task.scope, task.id);
  await mkdir(dirname(dir), { recursive: true });
  // Attempt-aware: reuse a surviving worktree (keeps a crashed run's edits), else continue the retained branch, else branch fresh.
  // Branch from the resolved commit, not the ref name, so a moving ref cannot change what the diff is against.
  return serialized(root, async () => {
    await git(root, ['worktree', 'prune']);
    const real = (d: string): string => { try { return realpathSync(d); } catch { return d; } };
    const registered = (await git(root, ['worktree', 'list', '--porcelain'])).split('\n').some(l => l.startsWith('worktree ') && real(l.slice(9)) === real(dir));
    const branchExists = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
    if (existsSync(dir) && !registered) throw fail('worktree_dir_occupied', 'Worktree directory exists but is not a registered worktree of this repository');
    if (registered || branchExists) {
      if (!registered) await git(root, ['worktree', 'add', dir, branch]);
      const base = (await git(root, ['merge-base', branch, baseCommit])).trim();
      await seedDependencies(root, dir);
      return { dir, gitDir, branch, baseRef, baseCommit: base, continued: true };
    }
    await git(root, ['worktree', 'add', '-b', branch, dir, baseCommit]);
    await seedDependencies(root, dir);
    return { dir, gitDir, branch, baseRef, baseCommit, continued: false };
  });
}

/** Clip to maxBytes of UTF-8 without splitting a character. */
function clipUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text);
  let end = Math.min(buf.length, maxBytes);
  while (end > 0 && end < buf.length && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/** Commits whatever the provider left, captures the diff, removes the worktree (branch kept). Never pushes. */
export async function finishWorktree(root: string, provider: string, task: Task, wt: Worktree, maxBytes: number): Promise<PatchOutcome> {
  const who = `Swarmaa ${provider}`;
  const env = { GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: 'noreply@swarmaa.com', GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: 'noreply@swarmaa.com' };
  const subject = task.objective.split('\n')[0]!.trim().slice(0, 72);
  return serialized(root, async () => {
    // On any git failure the worktree is left in place (not removed) so the provider's work is not lost.
    {
      if ((await git(wt.dir, ['status', '--porcelain'])).trim()) {
        await git(wt.dir, ['add', '-A']);
        await git(wt.dir, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', `swarma(${provider}): ${subject}`], env);
      }
      const head = (await git(wt.dir, ['rev-parse', 'HEAD'])).trim();
      const range = `${wt.baseCommit}..${head}`;
      const unchanged = head === wt.baseCommit;
      let diff = '', files = 0, stat = '';
      if (!unchanged) {
        files = (await git(wt.dir, ['diff', '--name-only', range])).split('\n').filter(Boolean).length;
        stat = Buffer.from(await git(wt.dir, ['diff', '--stat', range])).subarray(0, 4096).toString('utf8');
        try { diff = await git(wt.dir, ['diff', range]); } catch { diff = '(diff too large to capture; see the branch)\n'; }
        // Content plus note must fit what the service will store, so the upload cannot fail on size.
        const limit = Math.min(maxBytes, ARTIFACT_MAX_BYTES);
        if (Buffer.byteLength(diff) > limit) {
          const note = `\n[diff truncated at ${limit} bytes; full change is on branch ${wt.branch}]\n`;
          diff = clipUtf8(diff, limit - Buffer.byteLength(note)) + note;
        }
      }
      await git(root, ['worktree', 'remove', '--force', wt.dir]);
      return { branch: wt.branch, base_ref: wt.baseRef, base_commit: wt.baseCommit, head_commit: unchanged ? null : head, changed_files: files, diffstat: stat, diff, continued: wt.continued };
    }
  });
}
