import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeWorker } from '../src/bridge/worker.js';
import { parseBridgeConfig } from '../src/bridge/config.js';
import {
  buildInvocation,
  buildTurnPrompt,
  extractDelegate,
  extractPartialText,
  extractServed,
  finalAnswer,
  providerSucceeded
} from '../src/bridge/adapters.js';
import type { ProcessResult, Task, ToolClient } from '../src/bridge/types.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const baseConfig = () => parseBridgeConfig({
  service_url: 'http://127.0.0.1:8080',
  agents: [{
    id: 'claude',
    provider: 'claude',
    binary: '/bin/claude',
    model: 'claude-opus-5-5',
    turn_model: 'claude-haiku-5-5',
    turn_effort: 'low',
    enable_patch: true,
    sandbox: false
  }],
  projects: [{
    scope: 'project:demo',
    root: '/projects/demo',
    agents: ['claude'],
    allow_patch: true
  }]
});

const makeTurnTask = (extra: Partial<Task> = {}): Task => ({
  id: '33333333-3333-4333-8333-333333333333',
  scope: 'project:demo',
  kind: 'turn',
  objective: 'Explain the bridge architecture',
  constraints: [],
  acceptance_criteria: [],
  resource_key: null,
  required_capability: 'claude.read',
  checkpoint: null,
  context_refs: [],
  version: 1,
  ...extra
});

test('a fake stream wakes the worker within 300 ms', { timeout: 3000 }, async () => {
  const cfg = baseConfig();
  cfg.poll_seconds = 10; // High poll time so wakeup is clearly from stream
  cfg.usage_seconds = 0;

  let claims = 0;
  const firstClaimMade = deferred();
  const secondClaimMade = deferred<number>();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    }
  });

  const fakeFetch: typeof fetch = async (url, init) => {
    assert.ok(String(url).includes('/api/stream?after=now'));
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  };

  const client: ToolClient = {
    async call<T>(name: string): Promise<T> {
      if (name === 'task_claim') {
        claims++;
        if (claims === 1) {
          firstClaimMade.resolve();
        } else if (claims === 2) {
          secondClaimMade.resolve(performance.now());
        }
        return { task: null } as T;
      }
      return {} as T;
    }
  };

  const stop = new AbortController();
  const worker = new BridgeWorker(cfg, client, () => {}, undefined, undefined, fakeFetch);
  const runPromise = worker.run(stop.signal);

  try {
    // Wait for the first empty claim to finish and worker to enter pollWait
    await firstClaimMade.promise;
    // Small pause to ensure worker is sleeping in pollWait
    await new Promise(r => setTimeout(r, 50));

    const wakeSentAt = performance.now();
    streamController.enqueue(
      Buffer.from('event: task.submitted\ndata: {"scope":"project:demo"}\n\n')
    );

    const wakeArrivedAt = await secondClaimMade.promise;
    const duration = wakeArrivedAt - wakeSentAt;
    assert.ok(duration < 300, `Worker woke in ${duration} ms (must be < 300 ms)`);
    assert.equal(claims, 2);
  } finally {
    worker.drain();
    stop.abort();
    try { streamController.close(); } catch {}
    await runPromise;
  }
});

test('stream loss falls back to polling', { timeout: 3000 }, async () => {
  const cfg = baseConfig();
  cfg.poll_seconds = 0.05; // 50 ms polling
  cfg.usage_seconds = 0;

  let claims = 0;
  const thirdClaim = deferred();

  const fakeFetch: typeof fetch = async () => {
    // Return a stream that immediately errors out
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error('Connection terminated abruptly'));
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  };

  const client: ToolClient = {
    async call<T>(name: string): Promise<T> {
      if (name === 'task_claim') {
        claims++;
        if (claims >= 3) thirdClaim.resolve();
        return { task: null } as T;
      }
      return {} as T;
    }
  };

  const stop = new AbortController();
  const worker = new BridgeWorker(cfg, client, () => {}, undefined, undefined, fakeFetch);
  const runPromise = worker.run(stop.signal);

  try {
    // The stream fails, but polling must continue
    await thirdClaim.promise;
    assert.ok(claims >= 3, `Expected at least 3 claims via fallback polling, got ${claims}`);
  } finally {
    worker.drain();
    stop.abort();
    await runPromise;
  }
});

test('turn_model only for non-edit turns without a runner model', () => {
  const cfg = baseConfig();
  const agent = cfg.agents[0]!;
  const project = cfg.projects[0]!;

  // 1. Non-edit turn without runner model -> uses turn_model, adds DELEGATE instruction
  const nonEditTask = makeTurnTask({
    kind: 'turn',
    required_capability: 'claude.read',
    permission_envelope: { local_patch: false }
  } as any);
  const req1 = buildInvocation(agent, project, nonEditTask, {}, cfg, new AbortController().signal);
  const modelIdx1 = req1.args.indexOf('--model');
  assert.ok(modelIdx1 >= 0);
  assert.equal(req1.args[modelIdx1 + 1], 'claude-haiku-5-5');
  const effortIdx1 = req1.args.indexOf('--effort');
  assert.ok(effortIdx1 >= 0);
  assert.equal(req1.args[effortIdx1 + 1], 'low');
  assert.ok(req1.args.includes('--output-format') && req1.args[req1.args.indexOf('--output-format') + 1] === 'stream-json');
  assert.ok(req1.args.includes('--verbose'));
  assert.ok(req1.input.includes('DELEGATE: <one-line objective>'));

  // 2. Non-edit turn WITH runner model in envelope -> runner.model wins, no DELEGATE instruction
  const delegatedTask = makeTurnTask({
    kind: 'turn',
    required_capability: 'claude.read',
    permission_envelope: {
      local_patch: false,
      runner: { model: 'claude-sonnet-4-6', delegated: true }
    }
  } as any);
  const req2 = buildInvocation(agent, project, delegatedTask, {}, cfg, new AbortController().signal);
  const modelIdx2 = req2.args.indexOf('--model');
  assert.ok(modelIdx2 >= 0);
  assert.equal(req2.args[modelIdx2 + 1], 'claude-sonnet-4-6');
  assert.ok(!req2.input.includes('DELEGATE: <one-line objective>'));

  // 3. Edit turn -> keeps agent.model ('claude-opus-5-5'), no DELEGATE instruction
  const editTurnTask = makeTurnTask({
    kind: 'turn',
    required_capability: 'claude.patch',
    permission_envelope: { local_patch: true }
  } as any);
  const req3 = buildInvocation(agent, project, editTurnTask, {}, cfg, new AbortController().signal);
  const modelIdx3 = req3.args.indexOf('--model');
  assert.ok(modelIdx3 >= 0);
  assert.equal(req3.args[modelIdx3 + 1], 'claude-opus-5-5');
  assert.ok(!req3.input.includes('DELEGATE: <one-line objective>'));

  // 4. Patch task -> keeps agent.model, uses output-format json (not stream-json)
  const patchTask = makeTurnTask({
    kind: 'patch',
    required_capability: 'claude.patch',
    permission_envelope: { local_patch: true }
  } as any);
  const req4 = buildInvocation(agent, project, patchTask, {}, cfg, new AbortController().signal);
  const modelIdx4 = req4.args.indexOf('--model');
  assert.ok(modelIdx4 >= 0);
  assert.equal(req4.args[modelIdx4 + 1], 'claude-opus-5-5');
  assert.ok(req4.args.includes('--output-format') && req4.args[req4.args.indexOf('--output-format') + 1] === 'json');
  assert.ok(!req4.args.includes('--verbose'));

  // 5. Review task -> keeps agent.model
  const reviewTask = makeTurnTask({
    kind: 'review',
    required_capability: 'claude.read'
  });
  const req5 = buildInvocation(agent, project, reviewTask, {}, cfg, new AbortController().signal);
  const modelIdx5 = req5.args.indexOf('--model');
  assert.ok(modelIdx5 >= 0);
  assert.equal(req5.args[modelIdx5 + 1], 'claude-opus-5-5');
});

test('a DELEGATE: line becomes result.delegate and is stripped', async () => {
  // Unit test extractDelegate
  const raw = 'I will look into this.\nDELEGATE: Investigate database query bottleneck';
  const parsed = extractDelegate(raw, false);
  assert.equal(parsed.cleanAnswer, 'I will look into this.');
  assert.deepEqual(parsed.delegate, { objective: 'Investigate database query bottleneck' });

  // With trailing newlines
  const withTrailing = 'Sure, on it.\n\nDELEGATE: Add index on users.email\n\n';
  const parsedTrailing = extractDelegate(withTrailing, false);
  assert.equal(parsedTrailing.cleanAnswer, 'Sure, on it.');
  assert.deepEqual(parsedTrailing.delegate, { objective: 'Add index on users.email' });

  // Only DELEGATE line
  const onlyDelegate = 'DELEGATE: Run migration script';
  const parsedOnly = extractDelegate(onlyDelegate, false);
  assert.equal(parsedOnly.cleanAnswer, '');
  assert.deepEqual(parsedOnly.delegate, { objective: 'Run migration script' });

  // Longer than 500 characters
  const longObjective = 'A'.repeat(600);
  const parsedLong = extractDelegate(`Reply\nDELEGATE: ${longObjective}`, false);
  assert.equal(parsedLong.delegate?.objective.length, 500);

  // When envelope names a model, never emit delegate and do not strip
  const withModel = extractDelegate(raw, true);
  assert.equal(withModel.cleanAnswer, raw);
  assert.equal(withModel.delegate, undefined);

  // End-to-end integration via worker
  const cfg = baseConfig();
  const finishCalls: any[] = [];
  const client: ToolClient = {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      if (name === 'task_claim') {
        return {
          task: makeTurnTask({
            kind: 'turn',
            required_capability: 'claude.read',
            permission_envelope: { local_patch: false }
          } as any),
          lease_token: 'lease-tok',
          lease_generation: 1
        } as T;
      }
      if (name === 'context_get') return { scope: 'project:demo', memories: [], conflicts: [] } as T;
      if (name === 'artifact_put') return { artifact: { id: 'art-1' } } as T;
      if (name === 'session_list') return { sessions: [] } as T;
      if (name === 'task_finish') {
        finishCalls.push(args);
        return {} as T;
      }
      return {} as T;
    }
  };

  const fastAnswer = 'I can answer the first part.\nDELEGATE: Deep dive into the legacy codebase';
  const result: ProcessResult = {
    exit_code: 0,
    signal: null,
    stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: fastAnswer }),
    stderr: '',
    duration_ms: 10,
    stop_reason: null
  };

  const worker = new BridgeWorker(cfg, client, () => {}, async () => result);
  const claimed = await worker.claimAndRun(cfg.projects, new AbortController().signal);
  assert.equal(claimed, true);
  assert.equal(finishCalls.length, 1);
  const res = finishCalls[0].result;
  assert.equal(res.answer, 'I can answer the first part.');
  assert.deepEqual(res.delegate, { objective: 'Deep dive into the legacy codebase' });
});

test('stream-json parsing yields partial_text and an unchanged final answer', async () => {
  const claudeStreamOutput = [
    '{"type":"system","subtype":"init"}',
    '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The "}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"bridge connects "}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"agents to durable tasks."}}}',
    '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
    '{"type":"result","subtype":"success","result":"The bridge connects agents to durable tasks.","model":"claude-haiku-5-5"}'
  ].join('\n');

  // 1. Unit parsing tests
  const partial = extractPartialText('claude', claudeStreamOutput);
  assert.equal(partial, 'The bridge connects agents to durable tasks.');

  const finalAns = finalAnswer('claude', claudeStreamOutput);
  assert.equal(finalAns, 'The bridge connects agents to durable tasks.');

  const succeeded = providerSucceeded('claude', {
    exit_code: 0,
    signal: null,
    stdout: claudeStreamOutput,
    stderr: '',
    duration_ms: 10,
    stop_reason: null
  });
  assert.equal(succeeded, true);

  const served = extractServed('claude', {
    exit_code: 0,
    signal: null,
    stdout: claudeStreamOutput,
    stderr: '',
    duration_ms: 10,
    stop_reason: null
  });
  assert.equal(served.model, 'claude-haiku-5-5');

  // 2. Codex agent_message parsing test
  const codexOutput = [
    '{"type":"thread.started"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Codex response so far"}}',
    '{"type":"turn.completed"}'
  ].join('\n');
  assert.equal(extractPartialText('codex', codexOutput), 'Codex response so far');
  assert.equal(finalAnswer('codex', codexOutput), 'Codex response so far');

  // 3. Antigravity omits partial_text
  assert.equal(extractPartialText('antigravity', '{"status":"SUCCESS","response":"hi"}'), '');

  // 4. End-to-end worker stream test: verify partial_text in checkpoints
  const cfg = baseConfig();
  const checkpoints: any[] = [];
  let finishResult: any;

  const client: ToolClient = {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      if (name === 'task_claim') {
        return {
          task: makeTurnTask({
            kind: 'turn',
            required_capability: 'claude.read',
            permission_envelope: { local_patch: false }
          } as any),
          lease_token: 'lease-tok',
          lease_generation: 1
        } as T;
      }
      if (name === 'context_get') return { scope: 'project:demo', memories: [], conflicts: [] } as T;
      if (name === 'artifact_put') return { artifact: { id: 'art-1' } } as T;
      if (name === 'session_list') return { sessions: [] } as T;
      if (name === 'task_checkpoint') {
        checkpoints.push(args.checkpoint);
        return {} as T;
      }
      if (name === 'task_finish') {
        finishResult = args.result;
        return {} as T;
      }
      return {} as T;
    }
  };

  const chunk1 = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Chunk 1"}}}\n';
  const chunk2 = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":" Chunk 2"}}}\n';

  const worker = new BridgeWorker(cfg, client, () => {}, async request => {
    // Deliver chunk 1
    request.on_progress?.({ output_bytes: chunk1.length, stdout_tail: chunk1 });
    // Small delay to allow schedulePartialCheckpoint
    await new Promise(r => setTimeout(r, 20));
    // Deliver chunk 2
    const total = chunk1 + chunk2;
    request.on_progress?.({ output_bytes: total.length, stdout_tail: total });
    await new Promise(r => setTimeout(r, 20));

    return {
      exit_code: 0,
      signal: null,
      stdout: total + '{"type":"result","subtype":"success","result":"Chunk 1 Chunk 2","model":"claude-haiku-5-5"}\n',
      stderr: '',
      duration_ms: 50,
      stop_reason: null
    };
  });

  await worker.claimAndRun(cfg.projects, new AbortController().signal);

  // Checkpoints during running or provider_finished must carry partial_text
  const textCheckpoints = checkpoints.filter(c => typeof c.partial_text === 'string' && c.partial_text.length > 0);
  assert.ok(textCheckpoints.length >= 1, 'Expected at least one checkpoint with partial_text');
  assert.ok(textCheckpoints[textCheckpoints.length - 1].partial_text.includes('Chunk 1'));

  // Final answer in task_finish is unchanged
  assert.equal(finishResult.answer, 'Chunk 1 Chunk 2');
});

test('fake stream wakes at most once per 200 ms under a flood of events', { timeout: 3000 }, async () => {
  const cfg = baseConfig();
  cfg.poll_seconds = 10;
  cfg.usage_seconds = 0;

  const claimTimes: number[] = [];
  const firstClaim = deferred();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; }
  });

  const fakeFetch: typeof fetch = async () => new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });

  const client: ToolClient = {
    async call<T>(name: string): Promise<T> {
      if (name === 'task_claim') {
        claimTimes.push(performance.now());
        if (claimTimes.length === 1) firstClaim.resolve();
        return { task: null } as T;
      }
      return {} as T;
    }
  };

  const stop = new AbortController();
  const worker = new BridgeWorker(cfg, client, () => {}, undefined, undefined, fakeFetch);
  const runPromise = worker.run(stop.signal);

  try {
    await firstClaim.promise;
    await new Promise(r => setTimeout(r, 50));

    // Flood with 5 events over 10 ms
    for (let i = 0; i < 5; i++) {
      streamController.enqueue(Buffer.from('event: task.submitted\ndata: {"scope":"project:demo"}\n\n'));
    }

    // Wait 350 ms for any throttled wakes to finish
    await new Promise(r => setTimeout(r, 350));

    // Claims:
    // 1st claim: initial claim
    // 2nd claim: immediate wake from event 1
    // 3rd claim: coalesced wake at ~200 ms
    // No 4th or 5th claims within this window!
    assert.ok(claimTimes.length >= 2 && claimTimes.length <= 3, `Expected 2 or 3 claims, got ${claimTimes.length}`);
    if (claimTimes.length >= 3) {
      const interval = claimTimes[2]! - claimTimes[1]!;
      assert.ok(interval >= 180, `Wake interval between consecutive stream claims must be >= 180 ms, was ${interval} ms`);
    }
  } finally {
    worker.drain();
    stop.abort();
    try { streamController.close(); } catch {}
    await runPromise;
  }
});


test('a delegated turn without a runner model uses the full model and carries its objective as untrusted text', () => {
  const cfg = baseConfig();
  const agent = cfg.agents[0]!;
  const task = makeTurnTask({
    kind: 'turn', required_capability: 'claude.read', objective: 'Compare the three pricing pages in depth',
    permission_envelope: { local_patch: false, runner: { delegated: true } }
  } as any);
  const req = buildInvocation(agent, cfg.projects[0]!, task, {}, cfg, new AbortController().signal);
  const i = req.args.indexOf('--model');
  assert.notEqual(i >= 0 ? req.args[i + 1] : undefined, agent.turn_model, 'never the fast model for a delegated turn');
  assert.ok(!req.input.includes('DELEGATE: <one-line objective>'));
  const at = req.input.indexOf('Compare the three pricing pages in depth');
  assert.ok(at > 0, 'the objective reaches the model');
  assert.equal(req.input.lastIndexOf('Compare the three pricing pages in depth'), at, 'only once: not also as trusted instructions');
  const before = req.input.slice(0, at);
  assert.match(before.slice(before.lastIndexOf('<<<UNTRUSTED_CONTENT_')), /^<<<UNTRUSTED_CONTENT_[0-9a-f]{16}>>>\n$/, 'inside the untrusted delimiters');
});
