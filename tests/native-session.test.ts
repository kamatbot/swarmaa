import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildInvocation } from '../src/bridge/adapters.js';
import { parseBridgeConfig } from '../src/bridge/config.js';
import { claudeWorkerDir, cleanupNative, finishNative, prepareNative, rewriteTranscript, slug } from '../src/bridge/native-session.js';
import { buildProfile } from '../src/bridge/sandbox.js';
import type { Task } from '../src/bridge/types.js';

const tmpRoot = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'ns-')));
const task = (kind: 'patch' | 'research', cap: string): Task => ({ id: '12345678-1111-4111-8111-111111111111', scope: 'project:p', kind, objective: 'o', constraints: [], acceptance_criteria: [], resource_key: null, required_capability: cap, checkpoint: null, context_refs: [], version: 1 });
const cfg = (provider: string, sandbox: boolean) => parseBridgeConfig({ service_url: 'http://localhost:8080', agents: [{ id: provider, provider, binary: '/bin/true', enable_patch: true, sandbox }], projects: [{ scope: 'project:p', root: '/tmp', agents: [provider], allow_patch: true }] });
const argsFor = (provider: string, kind: 'patch' | 'research', native?: Parameters<typeof buildInvocation>[8], wt?: { dir: string; gitDir: string }) => {
  const c = cfg(provider, false);
  return buildInvocation(c.agents[0]!, c.projects[0]!, task(kind, `${provider}.${kind === 'patch' ? 'patch' : 'read'}`), {}, c, new AbortController().signal, {}, wt, native);
};

test('slug: realpath, every non-alphanumeric becomes a dash', () => {
  const d = tmpRoot();
  try { assert.equal(slug(join(d, 'a b_c.d')), join(d, 'a b_c.d').replace(/[^A-Za-z0-9]/gu, '-')); assert.equal(slug('/x/.y_z'), '-x--y-z'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('rewrite changes only the worktree path', () => {
  const t = '{"cwd":"/w/t1","p":"/w/t1/src/a.ts","branch":"swarma/claude/12345678","other":"/w/t10x","keep":"/etc"}';
  assert.equal(rewriteTranscript(t, ['/w/t1'], '/proj'), '{"cwd":"/proj","p":"/proj/src/a.ts","branch":"swarma/claude/12345678","other":"/proj0x","keep":"/etc"}');
});

test('argv: claude patch persists under --session-id, read stays unpersisted; codex drops --ephemeral only with a CODEX_HOME', () => {
  const home = tmpRoot();
  try {
    const wt = join(home, 'wt'); mkdirSync(wt);
    const a = cfg('claude', false).agents[0]!;
    const plan = prepareNative(a, task('patch', 'claude.patch'), wt, home)!;
    const p = argsFor('claude', 'patch', plan, { dir: wt, gitDir: '/g' }).args;
    assert.ok(!p.includes('--no-session-persistence') && p[p.indexOf('--session-id') + 1] === plan.id);
    assert.ok(prepareNative(a, task('research', 'claude.read'), undefined, home) === undefined);
    const r = argsFor('claude', 'research').args;
    assert.ok(r.includes('--no-session-persistence') && !r.includes('--session-id'));
    assert.ok(argsFor('codex', 'research').args.includes('--ephemeral'));
    const cx = prepareNative(cfg('codex', false).agents[0]!, task('research', 'codex.read'), undefined, home)!;
    const req = argsFor('codex', 'research', cx);
    assert.ok(!req.args.includes('--ephemeral'));
    assert.equal(req.env.CODEX_HOME, cx.codexHome);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CODEX_HOME: 0700 dir holding only a link to auth.json; removed after the run', () => {
  const home = tmpRoot(), t = tmpRoot();
  try {
    mkdirSync(join(home, '.codex')); writeFileSync(join(home, '.codex', 'auth.json'), '{}');
    mkdirSync(join(home, '.codex/other')); writeFileSync(join(home, '.codex', 'config.toml'), '');
    const plan = prepareNative(cfg('codex', false).agents[0]!, task('research', 'codex.read'), undefined, home, t)!;
    assert.equal(statSync(plan.codexHome!).mode & 0o777, 0o700);
    assert.ok(lstatSync(join(plan.codexHome!, 'auth.json')).isSymbolicLink());
    assert.equal(readlinkSync(join(plan.codexHome!, 'auth.json')), join(home, '.codex', 'auth.json'));
    assert.deepEqual(spawnSync('/bin/ls', ['-A', plan.codexHome!], { encoding: 'utf8' }).stdout.trim().split('\n'), ['auth.json']);
    assert.throws(() => finishNative(plan, '/tmp')); // no rollout: fails, still cleans up
    assert.ok(!existsSync(plan.codexHome!));
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(t, { recursive: true, force: true }); }
});

test('copy step (temp HOME): claude transcript moves to the project slug, rewritten, 0600; worktree dir removed', () => {
  const home = tmpRoot(), root = join(home, 'proj'), wt = join(home, 'wt');
  try {
    mkdirSync(root); mkdirSync(wt);
    const plan = prepareNative(cfg('claude', false).agents[0]!, task('patch', 'claude.patch'), wt, home)!;
    const dir = claudeWorkerDir(wt, home);
    assert.ok(existsSync(dir));
    writeFileSync(join(dir, `${plan.id}.jsonl`), `{"cwd":"${wt}","file":"${wt}/a.ts"}\n`);
    const ns = finishNative(plan, root, wt);
    const dest = join(home, '.claude/projects', slug(root), `${plan.id}.jsonl`);
    assert.equal(readFileSync(dest, 'utf8'), `{"cwd":"${root}","file":"${root}/a.ts"}\n`);
    assert.equal(statSync(dest).mode & 0o777, 0o600);
    assert.ok(!existsSync(dir));
    assert.equal(ns.resume, `cd ${root} && claude --resume ${plan.id}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('copy step (temp HOME): codex rollout lands in ~/.codex/sessions with the same name, rewritten for patch, temp home removed', () => {
  const home = tmpRoot(), root = join(home, 'proj'), wt = join(home, 'wt'), t = tmpRoot();
  try {
    mkdirSync(root); mkdirSync(wt);
    const plan = prepareNative(cfg('codex', false).agents[0]!, task('patch', 'codex.patch'), wt, home, t)!;
    const id = '01a162ba-c992-7923-9438-cbf0ded17c47', rel = `sessions/2026/10/22/rollout-2026-10-22T15-29-31-${id}.jsonl`;
    mkdirSync(join(plan.codexHome!, 'sessions/2026/10/22'), { recursive: true });
    writeFileSync(join(plan.codexHome!, rel), `{"cwd":"${wt}"}\n`);
    const ns = finishNative(plan, root, wt);
    const dest = join(home, '.codex', rel);
    assert.equal(readFileSync(dest, 'utf8'), `{"cwd":"${root}"}\n`);
    assert.equal(statSync(dest).mode & 0o777, 0o600);
    assert.ok(!existsSync(plan.codexHome!));
    assert.equal(ns.id, id);
    assert.equal(ns.resume, `cd ${root} && codex resume ${id}`);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(t, { recursive: true, force: true }); }
});

test('profile: only the worker\'s own claude history dir is opened; other history stays denied; codex temp home uses the tmp tree', { skip: process.platform !== 'darwin' }, () => {
  const dir = tmpRoot();
  try {
    const home = join(dir, 'home'), own = join(home, '.claude/projects/-wt-own'), other = join(home, '.claude/projects/-other');
    mkdirSync(own, { recursive: true }); mkdirSync(other, { recursive: true });
    writeFileSync(join(own, 'a'), 'mine'); writeFileSync(join(other, 'b'), 'theirs');
    const profile = buildProfile({ provider: 'claude', binary: '/bin/cat', projectRoot: dir, home, tmp: join(dir, 't'), patch: true, ownHistoryDir: own });
    const run = (...a: string[]) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, ...a], { encoding: 'utf8' });
    assert.equal(run('/bin/cat', join(own, 'a')).stdout, 'mine');
    assert.equal(run('/bin/sh', '-c', `echo x > ${join(own, 'w')}`).status, 0);
    assert.notEqual(run('/bin/cat', join(other, 'b')).status, 0);
    assert.notEqual(run('/bin/sh', '-c', `echo x > ${join(other, 'w')}`).status, 0);
    assert.ok(!buildProfile({ provider: 'claude', binary: '/bin/cat', projectRoot: dir, home, tmp: join(dir, 't') }).includes('-wt-own'));
    // The credential denies are still the last deny of anything outside the one exempted dir.
    assert.ok(profile.trim().split('\n').at(-1) === `(allow file-read* file-write* (subpath "${realpathSync(own)}"))`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CODEX_HOME cleanup keeps a refreshed auth.json and leaves an unchanged link alone', () => {
  for (const refreshed of [true, false]) {
    const home = tmpRoot(), t = tmpRoot();
    try {
      mkdirSync(join(home, '.codex')); writeFileSync(join(home, '.codex', 'auth.json'), '{"v":1}');
      const plan = prepareNative(cfg('codex', false).agents[0]!, task('research', 'codex.read'), undefined, home, t)!;
      if (refreshed) { rmSync(join(plan.codexHome!, 'auth.json')); writeFileSync(join(plan.codexHome!, 'auth.json'), '{"v":2}'); }
      cleanupNative(plan);
      assert.equal(readFileSync(join(home, '.codex', 'auth.json'), 'utf8'), refreshed ? '{"v":2}' : '{"v":1}');
      assert.equal(statSync(join(home, '.codex', 'auth.json')).mode & 0o777, refreshed ? 0o600 : statSync(join(home, '.codex', 'auth.json')).mode & 0o777);
      assert.equal(existsSync(plan.codexHome!), false);
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(t, { recursive: true, force: true }); }
  }
});
