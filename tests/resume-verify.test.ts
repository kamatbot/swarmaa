import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseBridgeConfig } from '../src/bridge/config.js';
import { slug } from '../src/bridge/native-session.js';
import { BridgeWorker } from '../src/bridge/worker.js';
import type { ProcessRequest, ProcessResult, Task, ToolClient } from '../src/bridge/types.js';

const SESSION = '5b3a1c2e-7d4f-4a6b-9c8d-0e1f2a3b4c5d';
const ok: ProcessResult = { exit_code: 0, signal: null, stdout: '{"type":"result","subtype":"success","is_error":false,"result":"done"}', stderr: '', duration_ms: 5, stop_reason: null };
const checkBin = '/usr/bin/true';

/** A temp git project plus a temp HOME so the Claude transcript copy never touches the real ~/.claude. */
async function harness(checkpoint: Record<string, unknown> | null, runner: (r: ProcessRequest) => ProcessResult, withChecks = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'resume-verify-')));
  const root = join(base, 'proj'), home = join(base, 'home');
  mkdirSync(root); mkdirSync(home);
  const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(root, 'a.txt'), 'x'); git('add', '.'); git('commit', '-qm', 'init');
  // The transcript a previous attempt left under the project root's slug.
  const saved = join(home, '.claude', 'projects', slug(root));
  mkdirSync(saved, { recursive: true }); writeFileSync(join(saved, `${SESSION}.jsonl`), `{"cwd":"${root}"}\n`);
  const oldHome = process.env.HOME; process.env.HOME = home;
  const task: Task = { id: '33333333-3333-4333-8333-333333333333', scope: 'project:demo', kind: 'patch', objective: 'Fix it', constraints: [], acceptance_criteria: [], resource_key: null,
    required_capability: 'claude.patch', checkpoint, context_refs: [], version: 1 };
  const calls: { name: string; args: Record<string, any> }[] = [];
  const client: ToolClient = { async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    calls.push({ name, args });
    if (name === 'task_claim') return { task, lease_token: 'lease', lease_generation: 1 } as T;
    if (name === 'context_get') return { scope: task.scope, memories: [], lessons: [], conflicts: [], omitted: [] } as T;
    if (name === 'artifact_put') return { artifact: { id: '22222222-2222-4222-8222-222222222222' } } as T;
    return { task } as T;
  } };
  const cfg = parseBridgeConfig({ service_url: 'http://localhost:8080', agents: [{ id: 'claude', provider: 'claude', binary: '/bin/claude', sandbox: false, enable_patch: true }],
    projects: [{ scope: 'project:demo', root, agents: ['claude'], allow_patch: true, ...(withChecks ? { checks: { tests_pass: { command: checkBin, args: [] } } } : {}) }] });
  const requests: ProcessRequest[] = [];
  const worker = new BridgeWorker(cfg, client, () => {}, async r => { requests.push(r); return runner(r); });
  await worker.claimAndRun(cfg.projects, new AbortController().signal);
  process.env.HOME = oldHome;
  rmSync(base, { recursive: true, force: true });
  return { calls, requests, finish: calls.find(c => c.name === 'task_finish')!.args };
}

const prior = { native_session: { provider: 'claude', id: SESSION }, last_failure: 'Configured checks failed:\ntests_pass (exit 1):\nboom' };

test('attempt 2 resumes the checkpointed claude session and tells it why it is retrying', async () => {
  const h = await harness(prior, () => ok);
  const args = h.requests[0]!.args;
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', SESSION]);
  assert.ok(!args.includes('--session-id'));
  assert.match(h.requests[0]!.prompt!, /RETRY_NOTE[\s\S]*tests_pass \(exit 1\)/);
  assert.equal(h.finish.outcome, 'completed');
  // The id is persisted in every checkpoint so a later attempt can resume again.
  assert.ok(h.calls.filter(c => c.name === 'task_checkpoint').every(c => c.args.checkpoint.native_session?.id === SESSION));
});

test('a first attempt starts a fresh claude session', async () => {
  const h = await harness(null, () => ok);
  assert.ok(h.requests[0]!.args.includes('--session-id') && !h.requests[0]!.args.includes('--resume'));
});

test('session-not-found on resume falls back to one fresh session in the same attempt', async () => {
  let n = 0;
  const h = await harness(prior, () => n++ === 0 ? { ...ok, exit_code: 1, stdout: '', stderr: `No conversation found with session ID: ${SESSION}` } : ok);
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests[0]!.args.includes('--resume'));
  assert.ok(h.requests[1]!.args.includes('--session-id') && !h.requests[1]!.args.includes('--resume'));
  assert.equal(h.finish.outcome, 'completed');
});

test('a patch task whose configured check fails finishes as a retryable failure carrying the output', async () => {
  const h = await harness(null, r => r.command === checkBin ? { ...ok, exit_code: 1, stdout: 'FAIL: 2 tests', stderr: 'AssertionError' } : ok, true);
  const result = h.finish.result;
  assert.equal(h.finish.outcome, 'failed');
  assert.equal(result.failure.retry, true);
  assert.equal(result.checks_passed, false);
  assert.equal(result.checks[0].name, 'tests_pass');
  assert.equal(result.checks[0].exit_code, 1);
  assert.match(result.checks[0].output_tail, /FAIL: 2 tests/);
  assert.equal(result.acceptance_criteria_verified, false);
  const last = h.calls.filter(c => c.name === 'task_checkpoint').at(-1)!.args.checkpoint;
  assert.match(last.last_failure, /Configured checks failed[\s\S]*FAIL: 2 tests/);
});

test('a passing configured check records checks_passed true and completes', async () => {
  const h = await harness(null, () => ok, true);
  assert.equal(h.finish.outcome, 'completed');
  assert.equal(h.finish.result.checks_passed, true);
  assert.equal(h.finish.result.checks[0].passed, true);
});

test('codex resumes by thread id via `exec resume`, and the id is read from thread.started', async () => {
  const { buildInvocation, codexThreadId } = await import('../src/bridge/adapters.js');
  const cfg = parseBridgeConfig({ service_url: 'http://localhost:8080', agents: [{ id: 'codex', provider: 'codex', binary: '/bin/codex', sandbox: false }],
    projects: [{ scope: 'project:demo', root: '/projects/demo', agents: ['codex'], allow_patch: false }] });
  const task: Task = { id: 'x', scope: 'project:demo', kind: 'research', objective: 'o', constraints: [], acceptance_criteria: [], resource_key: null, required_capability: 'codex.read', checkpoint: null, context_refs: [], version: 1 };
  const args = buildInvocation(cfg.agents[0]!, cfg.projects[0]!, task, { memories: [] }, cfg, new AbortController().signal, {}, undefined, undefined, undefined, { id: SESSION }).args;
  assert.deepEqual(args.slice(0, 3), ['--search', 'exec', 'resume']);
  assert.deepEqual(args.slice(-2), [SESSION, '-']);
  assert.ok(!args.includes('--color'));
  assert.equal(codexThreadId(`{"type":"thread.started","thread_id":"${SESSION}"}\n{"type":"turn.completed"}`), SESSION);
});

test('files a configured check creates are not committed with the patch', async () => {
  const h = await harness(null, r => {
    writeFileSync(join(r.cwd!, r.command === checkBin ? 'build.out' : 'agent.txt'), 'x');
    return ok;
  }, true);
  assert.equal(h.finish.outcome, 'completed');
  const diff = h.calls.filter(c => c.name === 'artifact_put').map(c => JSON.stringify(c.args)).join('\n');
  assert.match(diff, /agent\.txt/);
  assert.doesNotMatch(diff, /build\.out/);
});
