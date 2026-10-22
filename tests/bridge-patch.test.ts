import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseBridgeConfig } from '../src/bridge/config.js';
import type { ProcessResult, Task, ToolClient } from '../src/bridge/types.js';
import { BridgeWorker } from '../src/bridge/worker.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
const ok: ProcessResult = { exit_code: 0, signal: null, stdout: '{"type":"turn.completed"}', stderr: '', duration_ms: 1, stop_reason: null };
const ID = '12345678-1111-4111-8111-111111111111';

async function scenario(opts: { repo: boolean; baseRef?: string }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'patch-')));
  const home = process.env.HOME;
  process.env.HOME = join(dir, 'home');
  try {
    const root = join(dir, 'repo');
    execFileSync('mkdir', ['-p', root]);
    let first = '';
    if (opts.repo) {
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'config', 'user.email', 't@t'); git(root, 'config', 'user.name', 't');
      writeFileSync(join(root, 'a.txt'), 'one\n'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'one');
      first = git(root, 'rev-parse', 'HEAD');
      writeFileSync(join(root, 'a.txt'), 'two\n'); git(root, 'commit', '-qam', 'two');
      writeFileSync(join(root, 'dirty.txt'), 'untracked\n');
    }
    const cfg = parseBridgeConfig({ service_url: 'http://localhost:8080', agents: [{ id: 'codex', provider: 'codex', binary: '/bin/codex', enable_patch: true, sandbox: false }],
      projects: [{ scope: 'project:demo', root, agents: ['codex'], allow_patch: true }] });
    const task: Task = { id: ID, scope: 'project:demo', kind: 'patch', objective: 'Add b file\nsecond line', constraints: [], acceptance_criteria: [], resource_key: null,
      required_capability: 'auto.patch', checkpoint: null, context_refs: [], version: 1, ...(opts.baseRef ? { base_ref: opts.baseRef === 'FIRST' ? first : opts.baseRef } : {}) };
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client: ToolClient = { async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ name, args });
      if (name === 'task_claim') return { task, lease_token: 'l', lease_generation: 1, route: { provider: null, allowed: ['codex'] } } as T;
      if (name === 'context_get') return { scope: task.scope, task, memories: [], conflicts: [] } as T;
      if (name === 'artifact_put') return { artifact: { id: `${calls.length}`.padStart(8, '0') + '-2222-4222-8222-222222222222' } } as T;
      if (name === 'session_list') return { sessions: [] } as T;
      return { task } as T;
    } };
    let seen: { cwd: string; args: string[] } | undefined;
    const worker = new BridgeWorker(cfg, client, () => {}, async req => {
      seen = { cwd: req.cwd, args: req.args };
      writeFileSync(join(req.cwd, 'b.txt'), 'new\n');
      if (opts.baseRef === 'FIRST') assert.equal(readFileSync(join(req.cwd, 'a.txt'), 'utf8'), 'one\n');
      return ok;
    });
    await worker.claimAndRun(cfg.projects[0]!, new AbortController().signal);
    return { dir, root, calls, seen, first, finish: calls.find(c => c.name === 'task_finish')!.args };
  } finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; }
}

test('patch task: own branch + commit, worktree removed, user checkout untouched', async () => {
  const s = await scenario({ repo: true });
  try {
    const head = git(s.root, 'rev-parse', 'HEAD');
    const r = s.finish.result as Record<string, unknown>;
    assert.equal(s.finish.outcome, 'completed');
    assert.equal(r.branch, 'swarma/codex/12345678');
    assert.equal(r.commands_allowed, true);
    assert.equal(r.base_commit, head);
    assert.equal(r.base_ref, 'HEAD');
    assert.equal(r.changed_files, 1);
    assert.equal(r.head_commit, git(s.root, 'rev-parse', 'swarma/codex/12345678'));
    assert.equal(git(s.root, 'log', '-1', '--format=%s|%an|%ae', 'swarma/codex/12345678'), 'swarma(codex): Add b file|Swarmaa codex|noreply@swarmaa.com');
    assert.equal(git(s.root, 'show', 'swarma/codex/12345678:b.txt'), 'new');
    assert.equal(git(s.root, 'branch', '--show-current'), 'main');
    assert.equal(git(s.root, 'status', '--porcelain'), '?? dirty.txt');
    assert.ok(!existsSync(join(s.seen!.cwd)));
    assert.equal(git(s.root, 'worktree', 'list').split('\n').length, 1);
    assert.ok(!existsSync(join(s.root, 'b.txt')));
    const diff = s.calls.filter(c => c.name === 'artifact_put').find(c => c.args.name === 'codex-patch.diff')!;
    assert.equal(diff.args.media_type, 'text/x-diff');
    assert.match(String(diff.args.content), /\+new/u);
    assert.deepEqual(s.calls.find(c => c.name === 'task_claim')!.args.capabilities, ['codex.read', 'codex.patch', 'auto.read', 'auto.patch']);
    const rec = s.calls.find(c => c.name === 'session_record')!.args as { harness: string; cwd: string; turns: { text: string }[] };
    assert.equal(rec.harness, 'codex');
    assert.equal(rec.cwd, s.root);
    assert.equal(rec.turns.at(-1)!.text.split('\n').at(-1), `Branch: swarma/codex/12345678 @ ${String(r.head_commit).slice(0, 7)} (1 files)`);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('patch task honors base_ref', async () => {
  const s = await scenario({ repo: true, baseRef: 'FIRST' });
  try {
    const r = s.finish.result as Record<string, unknown>;
    assert.equal(r.base_commit, s.first);
    assert.equal(git(s.root, 'merge-base', '--is-ancestor', s.first, 'swarma/codex/12345678') || 'ok', 'ok');
    assert.equal(s.finish.outcome, 'completed');
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('patch task blocks on a bad base_ref and on a non-git root', async () => {
  const bad = await scenario({ repo: true, baseRef: 'no-such-ref' });
  const none = await scenario({ repo: false });
  try {
    assert.equal(bad.finish.outcome, 'blocked'); assert.equal((bad.finish.result as Record<string, unknown>).code, 'bad_base_ref');
    assert.equal(none.finish.outcome, 'blocked'); assert.equal((none.finish.result as Record<string, unknown>).code, 'not_a_git_repo');
    assert.equal(bad.seen, undefined);
  } finally { rmSync(bad.dir, { recursive: true, force: true }); rmSync(none.dir, { recursive: true, force: true }); }
});
