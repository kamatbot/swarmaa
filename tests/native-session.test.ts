import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeWorkerDir, cleanupNative, finishNative, prepareNative, rewriteTranscript, slug } from '../src/bridge/native-session.js';
import type { AgentConfig, Provider, Task } from '../src/bridge/types.js';

const tmpRoot = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'ns-')));
const task = (kind: 'patch' | 'research', provider: Provider): Task => ({ id: '12345678-1111-4111-8111-111111111111', scope: 'project:p', kind, objective: 'o', constraints: [], acceptance_criteria: [], resource_key: null, required_capability: `${provider}.${kind === 'patch' ? 'patch' : 'read'}`, checkpoint: null, context_refs: [], version: 1 });
const agent = (provider: Provider): AgentConfig => ({ id: provider, provider, binary: '/usr/bin/true', enable_patch: true, sandbox: true });
const AUTH = '{"tokens":{"access_token":"original","refresh_token":"refresh","account_id":"account"}}';

test('native path rewriting preserves neighboring path prefixes', () => {
  assert.equal(slug('/x/.y_z'), '-x--y-z');
  const text = '{"cwd":"/w/t1","file":"/w/t1/src/a.ts","other":"/w/t10x"}';
  assert.equal(rewriteTranscript(text, ['/w/t1'], '/proj'), '{"cwd":"/proj","file":"/proj/src/a.ts","other":"/w/t10x"}');
});

test('Claude patch transcript export is private and preserves native continuation', () => {
  const home = tmpRoot(), root = join(home, 'project'), wt = join(home, 'worktree');
  try {
    mkdirSync(root); mkdirSync(wt);
    const plan = prepareNative(agent('claude'), task('patch', 'claude'), wt, home)!;
    const dir = claudeWorkerDir(wt, home);
    writeFileSync(join(dir, `${plan.id}.jsonl`), `{"cwd":"${wt}","file":"${wt}/a.ts"}\n`);
    const native = finishNative(plan, root, wt);
    const destination = join(home, '.claude/projects', slug(root), `${plan.id}.jsonl`);
    assert.equal(readFileSync(destination, 'utf8'), `{"cwd":"${root}","file":"${root}/a.ts"}\n`);
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    assert.equal(existsSync(dir), false);
    assert.equal(native.resume, `cd ${root} && claude --resume ${plan.id}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex private home copies only auth and exports its own rollout before cleanup', () => {
  const home = tmpRoot(), root = join(home, 'project'), wt = join(home, 'worktree');
  try {
    mkdirSync(root); mkdirSync(wt); mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex/auth.json'), AUTH, { mode: 0o600 });
    writeFileSync(join(home, '.codex/config.toml'), 'secret MCP configuration');
    writeFileSync(join(home, '.codex/.env'), 'SECRET=not-for-worker');
    const plan = prepareNative(agent('codex'), task('patch', 'codex'), wt, home, home)!;
    const isolated = plan.codexHome!;
    assert.equal(statSync(isolated).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(isolated, 'auth.json')).isSymbolicLink(), false);
    assert.equal(readFileSync(join(isolated, 'auth.json'), 'utf8'), AUTH);
    assert.equal(existsSync(join(isolated, 'config.toml')), false);
    assert.equal(existsSync(join(isolated, '.env')), false);
    const sessionId = '12345678-1111-4111-8111-111111111111';
    const name = `rollout-2026-10-24-${sessionId}.jsonl`;
    mkdirSync(join(isolated, 'sessions/2026/10/24'), { recursive: true });
    writeFileSync(join(isolated, 'sessions/2026/10/24', name), `{"cwd":"${wt}"}\n`);
    const native = finishNative(plan, root, wt);
    assert.equal(native.id, sessionId);
    assert.equal(readFileSync(join(home, '.codex/sessions/2026/10/24', name), 'utf8'), `{"cwd":"${root}"}\n`);
    assert.equal(existsSync(isolated), false);
    cleanupNative(plan);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex credential refresh never overwrites an intervening login', () => {
  const home = tmpRoot();
  try {
    mkdirSync(join(home, '.codex'));
    const authPath = join(home, '.codex/auth.json');
    writeFileSync(authPath, AUTH, { mode: 0o600 });
    const plan = prepareNative(agent('codex'), task('research', 'codex'), undefined, home, home)!;
    const newer = AUTH.replace('original', 'interactive-newer');
    writeFileSync(authPath, newer);
    writeFileSync(join(plan.codexHome!, 'auth.json'), AUTH.replace('original', 'worker-refreshed'));
    cleanupNative(plan);
    assert.equal(readFileSync(authPath, 'utf8'), newer);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex refresh preserves the account and never imports new auth configuration', () => {
  const home = tmpRoot();
  try {
    mkdirSync(join(home, '.codex'));
    const authPath = join(home, '.codex/auth.json');
    writeFileSync(authPath, AUTH, { mode: 0o600 });
    const same = prepareNative(agent('codex'), task('research', 'codex'), undefined, home, home)!;
    const candidate = { ...JSON.parse(AUTH.replace('original', 'worker-refreshed')), untrusted_setting: 'not copied' };
    writeFileSync(join(same.codexHome!, 'auth.json'), JSON.stringify(candidate));
    cleanupNative(same);
    const refreshed = JSON.parse(readFileSync(authPath, 'utf8'));
    assert.equal(refreshed.tokens.access_token, 'worker-refreshed');
    assert.equal(refreshed.tokens.account_id, 'account');
    assert.equal(refreshed.untrusted_setting, undefined);
    assert.equal(statSync(authPath).mode & 0o777, 0o600);
    const unchanged = readFileSync(authPath, 'utf8');
    const changed = prepareNative(agent('codex'), task('research', 'codex'), undefined, home, home)!;
    writeFileSync(join(changed.codexHome!, 'auth.json'), AUTH.replace('"account"', '"other-account"'));
    cleanupNative(changed);
    assert.equal(readFileSync(authPath, 'utf8'), unchanged);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('native export refuses an over-limit transcript and a replaced transcript directory', () => {
  for (const kind of ['oversize', 'directory-link'] as const) {
    const home = tmpRoot(), root = join(home, 'project'), wt = join(home, 'worktree');
    try {
      mkdirSync(root); mkdirSync(wt);
      const plan = prepareNative(agent('claude'), task('patch', 'claude'), wt, home)!;
      const history = claudeWorkerDir(wt, home);
      if (kind === 'oversize') writeFileSync(join(history, `${plan.id}.jsonl`), 'x'.repeat(16 * 1024 * 1024 + 1));
      else {
        const privateDirectory = join(home, 'private'); mkdirSync(privateDirectory);
        writeFileSync(join(privateDirectory, `${plan.id}.jsonl`), 'must not be exported');
        rmSync(history, { recursive: true }); symlinkSync(privateDirectory, history);
      }
      assert.throws(() => finishNative(plan, root, wt));
      assert.equal(existsSync(join(home, '.claude/projects', slug(root), `${plan.id}.jsonl`)), false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

test('native export refuses links that would read host files outside the sandbox', () => {
  for (const kind of ['symlink', 'hardlink'] as const) {
    const home = tmpRoot(), root = join(home, 'project'), wt = join(home, 'worktree');
    try {
      mkdirSync(root); mkdirSync(wt);
      const secret = join(home, 'private.txt'); writeFileSync(secret, 'must not be exported');
      const plan = prepareNative(agent('claude'), task('patch', 'claude'), wt, home)!;
      const output = join(claudeWorkerDir(wt, home), `${plan.id}.jsonl`);
      if (kind === 'symlink') symlinkSync(secret, output); else linkSync(secret, output);
      assert.throws(() => finishNative(plan, root, wt));
      assert.equal(existsSync(join(home, '.claude/projects', slug(root), `${plan.id}.jsonl`)), false);
      assert.equal(readFileSync(secret, 'utf8'), 'must not be exported');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

test('Codex source auth symlinks are not copied into the worker', () => {
  const home = tmpRoot();
  try {
    mkdirSync(join(home, '.codex'));
    const privateFile = join(home, 'private.json'); writeFileSync(privateFile, '{"secret":"outside"}');
    symlinkSync(privateFile, join(home, '.codex/auth.json'));
    assert.throws(() => prepareNative(agent('codex'), task('research', 'codex'), undefined, home, home));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
