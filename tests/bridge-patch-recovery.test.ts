import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseBridgeConfig } from '../src/bridge/config.js';
import type { ProcessResult, Task, ToolClient } from '../src/bridge/types.js';
import { BridgeWorker } from '../src/bridge/worker.js';
import { ARTIFACT_MAX_BYTES } from '../src/types.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
const ok: ProcessResult = { exit_code: 0, signal: null, stdout: '{"type":"turn.completed"}', stderr: '', duration_ms: 1, stop_reason: null };
const ID = '12345678-1111-4111-8111-111111111111';
const BRANCH = 'swarmaa/codex/12345678';
const LEGACY_BRANCH = 'swarma/codex/12345678';

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'patchrec-')));
  const root = join(dir, 'repo');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.email', 't@t'); git(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'a.txt'), 'one\n'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'one');
  const cfg = parseBridgeConfig({ service_url: 'http://localhost:8080', agents: [{ id: 'codex', provider: 'codex', binary: '/bin/codex', enable_patch: true, sandbox: false }],
    projects: [{ scope: 'project:demo', root, agents: ['codex'], allow_patch: true }] });
  const task: Task = { id: ID, scope: 'project:demo', kind: 'patch', objective: 'Edit things', constraints: [], acceptance_criteria: [], resource_key: null,
    required_capability: 'codex.patch', checkpoint: null, context_refs: [], version: 1 };
  /** Runs one attempt; `edit` plays the provider, `failDiffUpload` makes the diff artifact upload throw. */
  async function attempt(edit: (cwd: string) => void, failDiffUpload = false) {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client: ToolClient = { async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ name, args });
      if (name === 'task_claim') return { task, lease_token: 'l', lease_generation: 1 } as T;
      if (name === 'context_get') return { scope: task.scope, task, memories: [], conflicts: [] } as T;
      if (name === 'artifact_put') {
        if (failDiffUpload && String(args.name).endsWith('.diff')) throw Object.assign(new Error('Artifact exceeds 256 KiB'), { code: 'artifact_too_large' });
        return { artifact: { id: `${calls.length}`.padStart(8, '0') + '-2222-4222-8222-222222222222' } } as T;
      }
      return { task } as T;
    } };
    const home = process.env.HOME;
    process.env.HOME = join(dir, 'home');
    try {
      const worker = new BridgeWorker(cfg, client, (e, m) => { if (process.env.DBG) console.error(e, m); }, async req => { edit(req.cwd); return ok; });
      await worker.claimAndRun(cfg.projects[0]!, new AbortController().signal);
    } finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; }
    const finish = calls.find(c => c.name === 'task_finish')!.args;
    return { calls, finish, result: finish.result as Record<string, any> };
  }
  return { dir, root, attempt };
}

test('retry after a finalized patch continues the retained branch (both commits kept)', async () => {
  const s = setup();
  try {
    const first = await s.attempt(cwd => writeFileSync(join(cwd, 'b.txt'), 'b\n'));
    assert.equal(first.finish.outcome, 'completed');
    assert.equal(first.result.continued, undefined);
    const base = first.result.base_commit;
    const second = await s.attempt(cwd => writeFileSync(join(cwd, 'c.txt'), 'c\n'));
    assert.equal(second.finish.outcome, 'completed');
    assert.equal(second.result.continued, true);
    assert.equal(second.result.base_commit, base);
    assert.equal(second.result.changed_files, 2);
    assert.equal(git(s.root, 'rev-list', '--count', `${base}..${BRANCH}`), '2');
    assert.equal(git(s.root, 'show', `${BRANCH}:b.txt`), 'b');
    assert.equal(git(s.root, 'show', `${BRANCH}:c.txt`), 'c');
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('crash leaving an occupied worktree dir: retry reuses it and commits the uncommitted file', async () => {
  const s = setup();
  try {
    // Simulate the crash: the provider wrote a file, then the bridge died before finalizing.
    const dir = join(s.dir, 'home', '.swarma', 'worktrees', 'demo', ID);
    mkdirSync(join(dir, '..'), { recursive: true });
    git(s.root, 'worktree', 'add', '-b', BRANCH, dir, 'HEAD');
    writeFileSync(join(dir, 'crashed.txt'), 'left behind\n');
    const r = await s.attempt(cwd => writeFileSync(join(cwd, 'more.txt'), 'm\n'));
    assert.equal(r.finish.outcome, 'completed');
    assert.equal(r.result.continued, true);
    assert.equal(git(s.root, 'show', `${BRANCH}:crashed.txt`), 'left behind');
    assert.equal(git(s.root, 'show', `${BRANCH}:more.txt`), 'm');
    assert.ok(!existsSync(dir));
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('a >300 KiB diff is clipped to the artifact limit; upload failure keeps provenance', async () => {
  const s = setup();
  try {
    const big = 'é'.repeat(160 * 1024) + '\n'; // multi-byte, ~320 KiB
    const r = await s.attempt(cwd => writeFileSync(join(cwd, 'big.txt'), big));
    const diff = String(r.calls.find(c => c.name === 'artifact_put' && String(c.args.name).endsWith('.diff'))!.args.content);
    assert.ok(Buffer.byteLength(diff) <= ARTIFACT_MAX_BYTES, `${Buffer.byteLength(diff)} bytes`);
    assert.ok(!diff.includes('�'));
    assert.match(diff, /diff truncated/u);
    const f = await setup().attempt(cwd => writeFileSync(join(cwd, 'big.txt'), big), true);
    assert.equal(f.finish.outcome, 'completed');
    for (const k of ['branch', 'base_ref', 'base_commit', 'head_commit', 'changed_files', 'diffstat']) assert.ok(f.result[k] !== undefined && f.result[k] !== null, k);
    assert.match(f.result.diff_artifact_error, /artifact_too_large/u);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('finalization failure fails the task, keeps the worktree and reports recovery', async () => {
  const s = setup();
  try {
    // A required clean filter that always fails makes `git add` fail (shared by all worktrees of the repo).
    appendFileSync(join(s.root, '.git', 'info', 'attributes'), '*.txt filter=boom\n');
    git(s.root, 'config', 'filter.boom.smudge', 'cat'); git(s.root, 'config', 'filter.boom.clean', 'false'); git(s.root, 'config', 'filter.boom.required', 'true');
    const r = await s.attempt(cwd => writeFileSync(join(cwd, 'x.txt'), 'x\n'));
    assert.equal(r.finish.outcome, 'failed');
    assert.equal(r.result.execution_completed, false);
    assert.ok(existsSync(join(r.result.worktree_path, 'x.txt')));
    assert.equal(r.result.recovery, `edits kept in ${r.result.worktree_path} on branch ${BRANCH}; commit or remove manually`);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('recovery accepts legacy swarma/<provider>/<id> branch prefix', async () => {
  const s = setup();
  try {
    git(s.root, 'checkout', '-qb', LEGACY_BRANCH);
    writeFileSync(join(s.root, 'legacy.txt'), 'old\n');
    git(s.root, 'add', '-A');
    git(s.root, 'commit', '-qm', 'legacy');
    git(s.root, 'checkout', '-q', 'main');
    const r = await s.attempt(cwd => writeFileSync(join(cwd, 'new.txt'), 'n\n'));
    assert.equal(r.finish.outcome, 'completed');
    assert.equal(r.result.continued, true);
    assert.equal(r.result.branch, LEGACY_BRANCH);
    assert.equal(git(s.root, 'show', `${LEGACY_BRANCH}:legacy.txt`), 'old');
    assert.equal(git(s.root, 'show', `${LEGACY_BRANCH}:new.txt`), 'n');
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
