import assert from 'node:assert/strict';
import test from 'node:test';
import { extractActivity, type ActivityItem } from '../src/bridge/adapters.js';
import { parseActivity } from '../src/core/teams.js';
import { taskListView, type TaskRow } from '../src/core/tasks.js';
import { parseBridgeConfig } from '../src/bridge/config.js';
import { BridgeWorker } from '../src/bridge/worker.js';
import type { Task, ToolClient } from '../src/bridge/types.js';

test('extractActivity: claude stream-json transitions running -> done and running -> failed', () => {
  const claudeStream = [
    // 1. Tool use start via stream_event content_block_start
    JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }
      }
    }),
    // Assistant message updates input
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test\nand more' } }
        ]
      }
    }),
    // Tool 2: file_path (running)
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'src/core/teams.ts' } }
        ]
      }
    }),
    // Tool 3: command that will fail
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'npm run build' } }
        ]
      }
    })
  ].join('\n');

  // Verify running states
  const running = extractActivity('claude', claudeStream);
  assert.equal(running.length, 3);
  assert.deepEqual(running[0], {
    id: 'toolu_1',
    tool: 'Bash',
    label: 'Bash: npm test',
    state: 'running'
  });
  assert.deepEqual(running[1], {
    id: 'toolu_2',
    tool: 'Read',
    label: 'Read src/core/teams.ts',
    state: 'running'
  });
  assert.deepEqual(running[2], {
    id: 'toolu_3',
    tool: 'Bash',
    label: 'Bash: npm run build',
    state: 'running'
  });

  // Now append user tool results: toolu_1 success, toolu_3 error
  const withResults = claudeStream + '\n' + [
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'PASS' },
          { type: 'tool_result', tool_use_id: 'toolu_3', is_error: true, content: 'FAIL' }
        ]
      }
    })
  ].join('\n');

  const completed = extractActivity('claude', withResults);
  assert.equal(completed.length, 3);
  assert.equal(completed[0]!.state, 'done');
  assert.equal(completed[1]!.state, 'running');
  assert.equal(completed[2]!.state, 'failed');
});

test('extractActivity: claude input field priority and label formatting', () => {
  const inputs = [
    { name: 'Edit', input: { path: 'Mac-app/Sources/Teams/View.swift' }, expected: 'Edit Mac-app/Sources/Teams/View.swift' },
    { name: 'Grep', input: { pattern: 'function findUser' }, expected: 'Grep function findUser' },
    { name: 'Web', input: { url: 'https://example.com/api' }, expected: 'Web https://example.com/api' },
    { name: 'Plan', input: { description: 'Verify test results' }, expected: 'Plan Verify test results' },
    { name: 'CustomTool', input: {}, expected: 'CustomTool' }
  ];

  const lines = inputs.map((item, idx) => JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: `tool_${idx}`, name: item.name, input: item.input }]
    }
  })).join('\n');

  const activities = extractActivity('claude', lines);
  assert.equal(activities.length, inputs.length);
  for (let i = 0; i < inputs.length; i++) {
    assert.equal(activities[i]!.label, inputs[i]!.expected);
  }
});

test('extractActivity: codex --json transitions running -> done and running -> failed', () => {
  const codexLines = [
    // 1. command_execution started
    JSON.stringify({
      type: 'item.started',
      item: { id: 'item_1', type: 'command_execution', command: 'npm test\nsecond line' }
    }),
    // 2. file_change started
    JSON.stringify({
      type: 'item.started',
      item: { id: 'item_2', type: 'file_change', path: 'src/bridge/adapters.ts' }
    }),
    // 3. mcp_tool_call started
    JSON.stringify({
      type: 'item.started',
      item: { id: 'item_3', type: 'mcp_tool_call', server: 'github', tool: 'get_issue' }
    }),
    // 4. web_search started
    JSON.stringify({
      type: 'item.started',
      item: { id: 'item_4', type: 'web_search', query: 'swarma activity spec' }
    }),
    // 5. command_execution that will fail
    JSON.stringify({
      type: 'item.started',
      item: { id: 'item_5', type: 'command_execution', command: 'false' }
    })
  ].join('\n');

  const running = extractActivity('codex', codexLines);
  assert.equal(running.length, 5);
  assert.deepEqual(running[0], { id: 'item_1', tool: 'command_execution', label: 'Run: npm test', state: 'running' });
  assert.deepEqual(running[1], { id: 'item_2', tool: 'file_change', label: 'Edit src/bridge/adapters.ts', state: 'running' });
  assert.deepEqual(running[2], { id: 'item_3', tool: 'mcp_tool_call', label: 'github.get_issue', state: 'running' });
  assert.deepEqual(running[3], { id: 'item_4', tool: 'web_search', label: 'Web search: swarma activity spec', state: 'running' });
  assert.deepEqual(running[4], { id: 'item_5', tool: 'command_execution', label: 'Run: false', state: 'running' });

  // Complete items: item_1 success (exit_code: 0), item_5 failed (exit_code: 1), item_2 failed via status
  const completedLines = codexLines + '\n' + [
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'command_execution', exit_code: 0, status: 'completed' }
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_5', type: 'command_execution', exit_code: 1, status: 'completed' }
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_2', type: 'file_change', status: 'failed' }
    })
  ].join('\n');

  const completed = extractActivity('codex', completedLines);
  assert.equal(completed.length, 5);
  assert.equal(completed[0]!.state, 'done');
  assert.equal(completed[1]!.state, 'failed');
  assert.equal(completed[2]!.state, 'running');
  assert.equal(completed[3]!.state, 'running');
  assert.equal(completed[4]!.state, 'failed');
});

test('extractActivity: caps at 20 newest entries and redacts secrets', () => {
  // 25 entries for claude with a token
  const entries: string[] = [];
  for (let i = 1; i <= 25; i++) {
    entries.push(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: `call_${i}`,
          name: 'Bash',
          input: { command: `echo step_${i} token=secret_token_12345` }
        }]
      }
    }));
  }

  const result = extractActivity('claude', entries.join('\n'));
  assert.equal(result.length, 20);
  // Oldest should be call_6, newest call_25
  assert.equal(result[0]!.id, 'call_6');
  assert.equal(result[19]!.id, 'call_25');

  // Verify secret redaction
  for (const item of result) {
    assert.ok(!item.label.includes('secret_token_12345'), 'Secrets must be redacted');
    assert.ok(item.label.includes('[REDACTED]') || !item.label.includes('token='));
    assert.ok(item.label.length <= 120, 'Label must be capped at 120 chars');
  }
});

test('extractActivity: antigravity returns empty array', () => {
  const agyOutput = JSON.stringify({
    status: 'SUCCESS',
    response: 'I ran the tool',
    tool_calls: [{ name: 'bash', input: { command: 'ls' } }]
  });
  assert.deepEqual(extractActivity('antigravity', agyOutput), []);
});

test('BridgeWorker: checkpoints include activity for running claude task and omit for antigravity', async () => {
  const cfg = parseBridgeConfig({
    service_url: 'http://localhost:8080',
    agents: [
      { id: 'claude', provider: 'claude', binary: '/bin/echo', sandbox: false },
      { id: 'antigravity', provider: 'antigravity', binary: '/bin/echo', sandbox: true }
    ],
    projects: [{ scope: 'project:demo', root: '/tmp', agents: ['claude', 'antigravity'] }]
  });

  const claudeCheckpoints: any[] = [];
  let claimedClaude = false;

  const claudeClient: ToolClient = {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      if (name === 'task_claim') {
        if (claimedClaude) return { task: null } as T;
        claimedClaude = true;
        return {
          task: {
            id: 'task-claude-1',
            scope: 'project:demo',
            kind: 'turn',
            required_capability: 'claude.read',
            permission_envelope: { local_patch: false }
          } as unknown as Task,
          lease_token: 'lease-tok',
          lease_generation: 1
        } as T;
      }
      if (name === 'context_get') return { scope: 'project:demo', memories: [], conflicts: [] } as T;
      if (name === 'artifact_put') return { artifact: { id: 'art-1' } } as T;
      if (name === 'task_checkpoint') {
        claudeCheckpoints.push(args.checkpoint);
        return {} as T;
      }
      if (name === 'task_finish') return {} as T;
      return {} as T;
    }
  };

  const toolLine = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'npm test' } }]
    }
  }) + '\n';

  const claudeWorker = new BridgeWorker(cfg, claudeClient, () => {}, async request => {
    request.on_progress?.({ output_bytes: toolLine.length, stdout_tail: toolLine });
    await new Promise(r => setTimeout(r, 10));
    return {
      exit_code: 0,
      signal: null,
      stdout: toolLine + '{"type":"result","subtype":"success","result":"Done","model":"haiku"}\n',
      stderr: '',
      duration_ms: 20,
      stop_reason: null
    };
  });

  await claudeWorker.claimAndRun(cfg.projects, new AbortController().signal);

  const runningWithActivity = claudeCheckpoints.filter(c => Array.isArray(c.activity) && c.activity.length > 0);
  assert.ok(runningWithActivity.length >= 1, 'Expected checkpoint to include activity');
  assert.equal(runningWithActivity[0].activity[0].label, 'Bash: npm test');
  assert.equal(runningWithActivity[0].activity[0].state, 'running');

  // Verify antigravity worker never emits activity
  const agyCheckpoints: any[] = [];
  let claimedAgy = false;

  const agyClient: ToolClient = {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      if (name === 'task_claim') {
        if (claimedAgy) return { task: null } as T;
        claimedAgy = true;
        return {
          task: {
            id: 'task-agy-1',
            scope: 'project:demo',
            kind: 'turn',
            required_capability: 'antigravity.read',
            permission_envelope: { local_patch: false }
          } as unknown as Task,
          lease_token: 'lease-tok-agy',
          lease_generation: 1
        } as T;
      }
      if (name === 'context_get') return { scope: 'project:demo', memories: [], conflicts: [] } as T;
      if (name === 'artifact_put') return { artifact: { id: 'art-2' } } as T;
      if (name === 'task_checkpoint') {
        agyCheckpoints.push(args.checkpoint);
        return {} as T;
      }
      if (name === 'task_finish') return {} as T;
      return {} as T;
    }
  };

  const agyWorker = new BridgeWorker(cfg, agyClient, () => {}, async request => {
    request.on_progress?.({ output_bytes: 50, stdout_tail: '{"tool":"call"}\n' });
    return {
      exit_code: 0,
      signal: null,
      stdout: JSON.stringify({ status: 'SUCCESS', response: 'Completed' }),
      stderr: '',
      duration_ms: 20,
      stop_reason: null
    };
  });

  await agyWorker.claimAndRun(cfg.projects, new AbortController().signal);
  for (const cp of agyCheckpoints) {
    assert.equal(cp.activity, undefined, 'Antigravity checkpoint must omit activity');
  }
});

test('thread_read parseActivity: validates 4 string fields, drops invalid, caps 20, clips 120, redacts secrets', () => {
  // Empty / non-array inputs
  assert.deepEqual(parseActivity(null), []);
  assert.deepEqual(parseActivity(undefined), []);
  assert.deepEqual(parseActivity('hello'), []);
  assert.deepEqual(parseActivity({}), []);

  // Valid items and invalid items mixed
  const raw = [
    null,
    123,
    'string_item',
    { id: 1, tool: 'Bash', label: 'test', state: 'running' }, // id not string
    { id: '1', tool: 2, label: 'test', state: 'running' }, // tool not string
    { id: '2', tool: 'Bash', label: 3, state: 'running' }, // label not string
    { id: '3', tool: 'Bash', label: 'test', state: 'invalid_state' }, // invalid state
    { id: 'valid_1', tool: 'Bash', label: 'Run command token=supersecret123', state: 'running', extra_key: 'danger' },
    { id: 'valid_2', tool: 'Read', label: 'x'.repeat(200), state: 'done' },
    { id: 'valid_3', tool: 'Edit', label: 'Edit file.ts', state: 'failed' }
  ];

  const parsed = parseActivity(raw);
  assert.equal(parsed.length, 3);

  // Extra keys dropped, secrets redacted
  assert.deepEqual(parsed[0], {
    id: 'valid_1',
    tool: 'Bash',
    label: 'Run command token=[REDACTED]',
    state: 'running'
  });
  assert.equal((parsed[0] as any).extra_key, undefined);

  // Label clipped to 120
  assert.equal(parsed[1]!.label.length, 120);
  assert.equal(parsed[1]!.state, 'done');

  // Failed state preserved
  assert.equal(parsed[2]!.state, 'failed');

  // Cap at 20 newest items
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `item_${i}`,
    tool: 'tool',
    label: `label_${i}`,
    state: 'done'
  }));
  const capped = parseActivity(many);
  assert.equal(capped.length, 20);
  assert.equal(capped[0]!.id, 'item_10');
  assert.equal(capped[19]!.id, 'item_29');
});

test('taskListView: strips activity from checkpoint alongside partial_output and partial_text', () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    tenant_id: 'tenant-1',
    scope: 'project:demo',
    kind: 'turn',
    objective: 'Do task',
    flow_id: null,
    flow: null,
    constraints: [],
    acceptance_criteria: [],
    permission_envelope: {},
    required_capability: 'claude.read',
    resource_key: null,
    base_ref: null,
    context_refs: [],
    context_versions: {},
    status: 'running',
    version: 1,
    created_by: 'user-1',
    idempotency_key: 'idem-1',
    request_hash: 'hash-1',
    attempt_count: 1,
    max_attempts: 3,
    continuation_count: 0,
    lease_generation: 1,
    lease_owner: 'worker-1',
    lease_hash: 'hash',
    lease_expires_at: new Date(),
    checkpoint: {
      phase: 'running',
      partial_output: 'huge raw stdout output',
      partial_text: 'streaming text so far',
      activity: [
        { id: '1', tool: 'Bash', label: 'Bash: npm test', state: 'running' }
      ],
      custom_metric: 42
    },
    result: null,
    artifact_ids: [],
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null
  } as unknown as TaskRow;

  const view = taskListView(row);
  assert.deepEqual(view.checkpoint, {
    phase: 'running',
    custom_metric: 42
  });
  assert.equal((view.checkpoint as any).activity, undefined);
  assert.equal((view.checkpoint as any).partial_text, undefined);
  assert.equal((view.checkpoint as any).partial_output, undefined);
});


