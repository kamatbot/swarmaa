import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extractUsage } from '../src/bridge/adapters.js';
import { parseBridgeConfig } from '../src/bridge/config.js';
import { BridgeWorker } from '../src/bridge/worker.js';
import type { ProcessResult, Task, ToolClient } from '../src/bridge/types.js';

const claude = readFileSync(new URL('./fixtures/claude-stream-json.ndjson', import.meta.url), 'utf8');
// Contract-shaped Codex sample; no live provider call is needed for these parser tests.
const codex = '{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}\n{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":900,"output_tokens":42}}\n';
const expectedClaude = { input_tokens: 43588, cached_input_tokens: 23376, output_tokens: 7 };
const expectedCodex = { input_tokens: 1200, cached_input_tokens: 900, output_tokens: 42 };

test('token usage reads Codex terminal counters and recorded Claude result without counting intermediate usage twice', () => {
  assert.deepEqual(extractUsage('codex', codex), expectedCodex);
  assert.deepEqual(extractUsage('claude', claude), expectedClaude);
  const result = JSON.parse(claude.trim().split('\n').at(-1)!);
  assert.deepEqual(extractUsage('claude', JSON.stringify(result, null, 2)), expectedClaude);
});

test('token usage sums terminal events for both providers', () => {
  for (const [provider, sample, expected] of [['codex', codex, expectedCodex], ['claude', claude, expectedClaude]] as const) {
    assert.deepEqual(extractUsage(provider, sample.trim() + '\n' + sample), {
      input_tokens: expected.input_tokens * 2, cached_input_tokens: expected.cached_input_tokens * 2, output_tokens: expected.output_tokens * 2
    });
  }
});

test('token usage preserves zero and optional cache counters, and omits unsupported or missing usage', () => {
  assert.deepEqual(extractUsage('codex', '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}'), { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(extractUsage('claude', '{"type":"result","usage":{"input_tokens":2,"output_tokens":3,"cache_read_input_tokens":0}}'), { input_tokens: 2, cached_input_tokens: 0, output_tokens: 3 });
  assert.equal(extractUsage('antigravity', codex), undefined);
  assert.equal(extractUsage('claude', '{"type":"result"}'), undefined);
  assert.equal(extractUsage('codex', ''), undefined);
});

test('malformed usage drops the total, including valid events followed by bad counters', () => {
  for (const bad of [null, [], {}, { input_tokens: '1', output_tokens: 2 }, { input_tokens: -1, output_tokens: 2 }, { input_tokens: 1, output_tokens: 0.5 }, { input_tokens: 1, output_tokens: 2, cached_input_tokens: null }, { input_tokens: 1e100, output_tokens: 2 }]) {
    assert.equal(extractUsage('codex', codex + JSON.stringify({ type: 'turn.completed', usage: bad })), undefined);
  }
  // A stray non-JSON line (a provider warning) is skipped; the real usage events still count.
  assert.deepEqual(extractUsage('codex', 'warning: slow network\n' + codex + '{broken'), extractUsage('codex', codex));
  assert.equal(extractUsage('codex', codex + '{"type":"turn.completed"}'), undefined);
  assert.equal(extractUsage('codex', codex + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 } })), undefined);
  assert.equal(extractUsage('claude', '{"type":"result","usage":{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":"3"}}'), undefined);
});

for (const [provider, stdout, expected] of [
  ['codex', codex, expectedCodex], ['claude', claude, expectedClaude],
  ['claude', '{"type":"result","subtype":"success","usage":{"input_tokens":"bad","output_tokens":2}}', undefined],
  ['antigravity', '{"status":"SUCCESS","response":"Done","model":"test-model","usage":{"input_tokens":1,"output_tokens":2}}', undefined]
] as const) {
  test(`worker finishes ${provider} with ${expected ? 'usage' : 'usage omitted'}`, async () => {
    const cfg = parseBridgeConfig({ service_url: 'http://localhost:8080', agents: [{ id: provider, provider, binary: '/bin/test-provider', sandbox: provider === 'antigravity' }], projects: [{ scope: 'project:demo', root: '/projects/demo', agents: [provider] }] });
    const task: Task = { id: '11111111-1111-4111-8111-111111111111', scope: 'project:demo', kind: 'review', objective: 'Review', constraints: [], acceptance_criteria: [], resource_key: null, required_capability: `${provider}.read`, checkpoint: null, context_refs: [], version: 1 };
    let finish: Record<string, unknown> | undefined;
    const client: ToolClient = { async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      if (name === 'task_claim') return { task, lease_token: 'test-lease', lease_generation: 1 } as T;
      if (name === 'context_get') return { task } as T;
      if (name === 'artifact_put') return { artifact: { id: '22222222-2222-4222-8222-222222222222' } } as T;
      if (name === 'task_finish') finish = args;
      return {} as T;
    } };
    const result: ProcessResult = { exit_code: 0, signal: null, stdout, stderr: '', duration_ms: 1, stop_reason: null };
    await new BridgeWorker(cfg, client, () => {}, async () => result).claimAndRun(cfg.projects, new AbortController().signal);
    assert.equal(finish?.outcome, 'completed');
    const stored = finish!.result as Record<string, unknown>;
    assert.deepEqual(stored.usage, expected);
    assert.equal(Object.hasOwn(stored, 'usage'), expected !== undefined);
  });
}
