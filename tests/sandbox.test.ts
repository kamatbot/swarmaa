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
  const patch = buildProfile({ ...base, patch: true, projectRoot: '/wt/a', gitDir: '/proj/.git' }).split('\n').find(l => l.startsWith('(allow file-write*'))!;
  for (const w of ['/wt/a', '/proj/.git', '/Users/tester/go', '/Users/tester/Library/Caches/go-build', '/Users/tester/.npm', '/Users/tester/.cache', '/Users/tester/Library/pnpm']) assert.ok(patch.includes(`(subpath "${w}")`), w);
  const ro = buildProfile({ ...base, patch: false, projectRoot: '/proj/a', gitDir: '/proj/.git' });
  assert.ok(!ro.includes('/proj/.git') && !ro.includes('go-build'));
  assert.ok(ro.includes('(subpath "/opt/homebrew")') && ro.includes('(subpath "/Users/tester/.nvm")'));
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

test('antigravity profile: agy state writable, config dir (MCP definitions) and other chats unreadable', () => {
  const p = buildProfile({ ...base, provider: 'antigravity', binary: '/Users/tester/.local/bin/agy' });
  const lines = p.trim().split('\n');
  const write = lines.find(l => l.startsWith('(allow file-write*'))!;
  for (const d of ['.gemini/antigravity-cli', '.gemini/antigravity', '.gemini/config/projects']) assert.ok(write.includes(`/Users/tester/${d}"`), d);
  assert.ok(!write.includes('(subpath "/tmp")'), 'project root is not writable');
  const reads = lines.find(l => l.startsWith('(allow file-read*'))!;
  assert.ok(!reads.includes('/Users/tester/.gemini/config"'), 'whole config dir (mcp_config.json holds tokens) is never readable');
  assert.ok(lines.some(l => l.startsWith('(deny file-read* (subpath') && l.includes('antigravity-cli/brain') && l.includes('antigravity/conversations')));
  assert.ok(lines.at(-1)!.includes('antigravity-cli/conversations') && lines.at(-1)!.includes('.ssh'));
  assert.ok(!p.includes('/.claude') && !p.includes('/.codex'));
});
