import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildProfile, sandboxAvailable, sbplString } from '../src/bridge/sandbox.js';

const base = { provider: 'claude' as const, binary: '/usr/bin/true', projectRoot: '/Users/tester/project', home: '/Users/tester', tmp: '/private/tmp/swarmaa-run-test' };

test('SBPL escapes path data and refuses controls', () => {
  assert.equal(sbplString('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
  for (const value of ['/a\nb', '/a\u0000b', '/a\u007fb']) assert.throws(() => sbplString(value));
});

test('profile is deny-by-default, requires private scratch and never grants shared git writes', () => {
  const profile = buildProfile({ ...base, patch: true, gitDir: '/Users/tester/main/.git' });
  assert.match(profile, /^\(version 1\)\n\(deny default\)/u);
  assert.doesNotMatch(profile, /\(allow default\)/u);
  assert.ok(profile.includes('(require-not (subpath "/Users/tester/project/.git"))'));
  assert.ok(profile.includes('(require-not (subpath "/Users/tester/main/.git"))'));
  assert.ok(profile.includes('(require-not (subpath "/Users/tester/project/.local"))'));
  for (const tmp of ['/tmp', '/private/tmp', '/', base.home]) assert.throws(() => buildProfile({ ...base, tmp }), /private invocation/u);
  assert.throws(() => buildProfile({ ...base, provider: 'codex' }), /private per-run home/u);
  assert.throws(() => buildProfile({ ...base, provider: 'codex', codexHome: '/Users/tester/.codex' }), /isolated/u);
  assert.ok(!buildProfile({ ...base, binary: '/Users/tester/claude' }).includes('(subpath "/Users/tester")'), 'a binary in HOME must not open the whole home directory');
});

test('macOS kernel enforces read, patch, scratch and unrelated-file boundaries', { skip: !sandboxAvailable() }, () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'swarmaa-boundary-')));
  const home = join(directory, 'home'), project = join(home, 'project'), worktree = join(directory, 'worktree');
  const scratch = join(directory, 'scratch'), otherScratch = join(directory, 'other-scratch'), gitDir = join(project, '.git');
  const q = (text: string): string => `'${text.replace(/'/gu, `'\\''`)}'`;
  try {
    for (const path of [home, project, worktree, scratch, otherScratch, gitDir, join(home, '.ssh'), join(project, '.local')]) mkdirSync(path, { recursive: true });
    writeFileSync(join(project, 'source.txt'), 'source');
    writeFileSync(join(project, '.env'), 'service secret');
    writeFileSync(join(project, '.local', 'worker.json'), 'service secret');
    writeFileSync(join(project, 'worker-token.json'), 'service secret');
    writeFileSync(join(home, '.ssh', 'id'), 'credential');
    writeFileSync(join(home, 'unrelated.txt'), 'private');
    writeFileSync(join(otherScratch, 'other.txt'), 'other task');
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main');
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}`);
    writeFileSync(join(worktree, 'source.txt'), 'source');
    symlinkSync(join(home, 'unrelated.txt'), join(project, 'escape-link'));
    const run = (patch: boolean, command: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', buildProfile({
      ...base, home, projectRoot: patch ? worktree : project, patch, gitDir, tmp: scratch, binary: '/bin/sh', protectedPaths: [join(project, 'worker-token.json')],
    }), '/bin/sh', '-c', command], { encoding: 'utf8', cwd: patch ? worktree : project, env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: scratch } });

    assert.equal(run(false, `cat ${q(join(project, 'source.txt'))}`).status, 0);
    for (const path of [join(home, 'unrelated.txt'), join(home, '.ssh', 'id'), join(project, '.env'), join(project, '.local', 'worker.json'), join(project, 'worker-token.json'), join(otherScratch, 'other.txt'), join(project, 'escape-link')]) {
      assert.notEqual(run(false, `cat ${q(path)}`).status, 0, `must not read ${path}`);
    }
    assert.notEqual(run(false, `echo changed >> ${q(join(project, 'source.txt'))}`).status, 0);
    assert.equal(run(false, `echo scratch > ${q(join(scratch, 'result.txt'))}`).status, 0);
    assert.equal(run(true, `echo changed >> ${q(join(worktree, 'source.txt'))}`).status, 0);
    assert.equal(run(true, `cat ${q(join(gitDir, 'HEAD'))}`).status, 0);
    for (const path of [join(project, 'source.txt'), join(gitDir, 'HEAD'), join(worktree, '.git'), join(worktree, '.env'), join(home, 'unrelated.txt')]) {
      assert.notEqual(run(true, `echo changed >> ${q(path)}`).status, 0, `must not write ${path}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
