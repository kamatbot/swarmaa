import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runBoundedProcess } from '../src/bridge/process.js';
import { createWorktree, providerPidfile, worktreeDir } from '../src/bridge/worktree.js';
import type { Task } from '../src/bridge/types.js';

const alive = (pgid: number): boolean => { try { process.kill(-pgid, 0); return true; } catch { return false; } };

test('worktree reuse kills an orphaned provider group and clears its pidfile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orphan-fence-')), oldHome = process.env.HOME, root = join(dir, 'repo');
  const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  try {
    process.env.HOME = join(dir, 'home'); await mkdir(root, { recursive: true }); await mkdir(process.env.HOME);
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.invalid');
    await writeFile(join(root, 'a'), 'a'); git('add', 'a'); git('commit', '-qm', 'base');
    const task = { id: '12345678-1111-4111-8111-111111111111', scope: 'project:fence', kind: 'patch', objective: 'x', base_ref: 'main' } as unknown as Task;
    const wt = await createWorktree(root, 'claude', task);
    assert.equal(wt.dir, worktreeDir(task.scope, task.id));
    const pidfile = providerPidfile(wt.dir);
    // Real spawn path; the promise is deliberately left pending to simulate a bridge that died mid-run.
    const run = runBoundedProcess({ command: '/bin/sleep', args: ['60'], cwd: wt.dir, env: { PATH: process.env.PATH }, input: '', timeout_ms: 120_000, max_output_bytes: 4096, pidfile });
    for (let i = 0; i < 50 && !existsSync(pidfile); i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(existsSync(pidfile));
    const { pgid } = JSON.parse(execFileSync('/bin/cat', [pidfile], { encoding: 'utf8' })) as { pgid: number };
    assert.ok(alive(pgid));
    const logs: string[] = [];
    const again = await createWorktree(root, 'claude', task, e => logs.push(e));
    assert.equal(again.continued, true);
    assert.equal(alive(pgid), false);
    assert.equal(existsSync(pidfile), false);
    assert.deepEqual(logs, ['orphan_provider_killed']);
    await run; // settles once the group is dead; its own cleanup of the absent pidfile is a no-op
  } finally {
    process.env.HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  }
});
