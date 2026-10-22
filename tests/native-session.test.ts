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



