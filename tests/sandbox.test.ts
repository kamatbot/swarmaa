import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildProfile, sbplString } from '../src/bridge/sandbox.js';

const base = { provider: 'claude' as const, binary: '/opt/claude/bin/claude', projectRoot: '/tmp', home: '/Users/tester', tmp: '/private/var/folders/xx/T' };

test('sbplString escapes quotes and backslashes and refuses control characters', () => {
  assert.equal(sbplString('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
  assert.throws(() => sbplString('/a\nb'));
});

test('profile: read default-deny, credential denies come last, patch vs read write rules', () => {
  const read = buildProfile({ ...base, projectRoot: '/proj/a"b' });
  assert.ok(read.includes('(deny file-read* file-write*)'));
  assert.ok(read.includes('(subpath "/proj/a\\"b")'));
  const lines = read.trim().split('\n');
  const last = lines[lines.length - 1]!;
  for (const p of ['.ssh', '.aws', '.config/gh', '.netrc', '.gnupg', '.claude/projects']) assert.ok(last.includes(`/Users/tester/${p}"`), p);
  assert.ok(last.startsWith('(deny file-read* file-write*'));
  const writeRule = lines.find(l => l.startsWith('(allow file-write*'))!;
  assert.ok(!writeRule.includes('/proj/a'));
  assert.ok(writeRule.includes('/Users/tester/.claude'));
  assert.ok(buildProfile({ ...base, patch: true, projectRoot: '/proj/a' }).split('\n').find(l => l.startsWith('(allow file-write*'))!.includes('(subpath "/proj/a")'));
  const codex = buildProfile({ ...base, provider: 'codex', patch: false });
  assert.ok(codex.includes('/Users/tester/.codex') && !codex.includes('(subpath "/Users/tester/.claude")'));
});

test('profile actually confines a real process', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbx-'));
  try {
    const project = join(dir, 'proj'), other = join(dir, 'other');
    mkdirSync(project); mkdirSync(other); mkdirSync(join(dir, 't'));
    writeFileSync(join(project, 'ok.txt'), 'ok'); writeFileSync(join(other, 'secret.txt'), 's');
    const profile = buildProfile({ provider: 'codex', binary: '/bin/cat', projectRoot: project, patch: false, tmp: join(dir, 't') });
    const run = (...a: string[]) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, ...a], { encoding: 'utf8' });
    assert.equal(run('/bin/cat', join(project, 'ok.txt')).stdout, 'ok');
    assert.notEqual(run('/bin/cat', join(other, 'secret.txt')).status, 0);
    assert.notEqual(run('/bin/sh', '-c', `echo x > ${join(project, 'w.txt')}`).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
