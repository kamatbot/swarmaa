import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Task } from './types.js';

const run = promisify(execFile);
const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export interface Worktree { dir: string; gitDir: string; branch: string; baseRef: string; baseCommit: string }
export interface PatchOutcome { branch: string; base_ref: string; base_commit: string; head_commit: string | null; changed_files: number; diffstat: string; diff: string }

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
  // Branch from the resolved commit, not the ref name, so a moving ref cannot change what the diff is against.
  await serialized(root, () => git(root, ['worktree', 'add', '-b', branch, dir, baseCommit]));
  return { dir, gitDir, branch, baseRef, baseCommit };
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
        if (Buffer.byteLength(diff) > maxBytes) diff = Buffer.from(diff).subarray(0, maxBytes).toString('utf8') + `\n[diff truncated at ${maxBytes} bytes; full change is on branch ${wt.branch}]\n`;
      }
      await git(root, ['worktree', 'remove', '--force', wt.dir]);
      return { branch: wt.branch, base_ref: wt.baseRef, base_commit: wt.baseCommit, head_commit: unchanged ? null : head, changed_files: files, diffstat: stat, diff };
    }
  });
}
