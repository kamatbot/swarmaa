import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Task } from '../src/bridge/types.js';
import { createWorktree, finishWorktree, sanitizedEnv } from '../src/bridge/worktree.js';

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

test('sanitizedEnv strips COLLECTIVE_*, SWARMAA_*, and DATABASE_URL while keeping normal vars', () => {
  const env = sanitizedEnv({
    PATH: '/usr/bin',
    HOME: '/Users/tester',
    COLLECTIVE_WORKER_TOKEN: 'secret-1',
    SWARMAA_API_KEY: 'secret-2',
    DATABASE_URL: 'postgres://user:pass@localhost/db',
    GIT_TRACE: '0',
  }, { GIT_AUTHOR_NAME: 'Swarmaa' });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/Users/tester');
  assert.equal(env.GIT_TRACE, '0');
  assert.equal(env.GIT_AUTHOR_NAME, 'Swarmaa');
  assert.equal(env.COLLECTIVE_WORKER_TOKEN, undefined);
  assert.equal(env.SWARMAA_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test('worktree git operations disable repo hooks and external diff drivers', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wt-sec-')));
  const oldHome = process.env.HOME;
  process.env.HOME = join(dir, 'home');
  try {
    const root = join(dir, 'repo');
    const hooksDir = join(dir, 'evil-hooks');
    const hookMarker = join(dir, 'hook-ran.txt');
    const diffMarker = join(dir, 'ext-diff-ran.txt');
    mkdirSync(root, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });
    mkdirSync(process.env.HOME, { recursive: true });

    // Malicious post-checkout hook and external diff driver configured in the repo
    writeFileSync(join(hooksDir, 'post-checkout'), `#!/bin/sh\necho pwned > "${hookMarker}"\n`);
    chmodSync(join(hooksDir, 'post-checkout'), 0o755);
    const evilDiff = join(dir, 'evil-diff.sh');
    writeFileSync(evilDiff, `#!/bin/sh\necho pwned > "${diffMarker}"\n`);
    chmodSync(evilDiff, 0o755);

    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@t');
    git(root, 'config', 'user.name', 't');
    writeFileSync(join(root, 'a.txt'), 'one\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'init');
    git(root, 'config', 'core.hooksPath', hooksDir);
    git(root, 'config', 'diff.external', evilDiff);

    const task: Task = {
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      scope: 'project:sec',
      kind: 'patch',
      objective: 'Safe edit',
      constraints: [],
      acceptance_criteria: [],
      resource_key: null,
      required_capability: 'codex.patch',
      checkpoint: null,
      context_refs: [],
      version: 1,
    };

    const wt = await createWorktree(root, 'codex', task);
    writeFileSync(join(wt.dir, 'b.txt'), 'two\n');
    const out = await finishWorktree(root, 'codex', task, wt, 256 * 1024);

    assert.equal(out.changed_files, 1);
    assert.match(out.diff, /\+two/);
    assert.equal(existsSync(hookMarker), false, 'repo hooks must not execute');
    assert.equal(existsSync(diffMarker), false, 'external diff driver must not execute');
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
