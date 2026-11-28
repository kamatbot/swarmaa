import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { BridgeWorker, cleanText } from '../src/bridge/worker.js';
import { RemoteError } from '../src/bridge/client.js';
import { parseBridgeConfig } from '../src/bridge/config.js';
import { WarmProviderPool } from '../src/bridge/warm-pool.js';
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

  // 3. Antigravity extracts streamed partial text (and returns '' for non-streaming single JSON)
  assert.equal(extractPartialText('antigravity', '{"status":"SUCCESS","response":"hi"}'), '');
  assert.equal(extractPartialText('antigravity', '{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"streamed"}}'), 'streamed');

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

test('fake stream wakes immediately when idle and coalesces mid-claim bursts over ~15 ms', { timeout: 3000 }, async () => {
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

    const sentAt = performance.now();
    // Flood with 5 events in one burst
    for (let i = 0; i < 5; i++) {
      streamController.enqueue(Buffer.from('event: task.submitted\ndata: {"scope":"project:demo"}\n\n'));
    }

    await new Promise(r => setTimeout(r, 120));

    // Claims:
    // 1st claim: initial claim
    // 2nd claim: immediate (0 ms) wake from event 1
    // 3rd claim: single coalesced wake (~15 ms) for events 2..5
    assert.ok(claimTimes.length >= 2 && claimTimes.length <= 3, `Expected 2 or 3 claims, got ${claimTimes.length}`);
    assert.ok(claimTimes[1]! - sentAt < 50, `Idle wake should be immediate (<50 ms), was ${claimTimes[1]! - sentAt} ms`);
    if (claimTimes.length >= 3) {
      const interval = claimTimes[2]! - claimTimes[1]!;
      assert.ok(interval >= 10 && interval < 150, `Coalesced mid-claim wake should be ~15 ms, was ${interval} ms`);
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
  // Claude turns send the prompt as a stream-json message on an open stdin; check the prompt text itself.
  assert.equal(req.keep_stdin_open, true);
  assert.equal((JSON.parse(req.input) as { message: { content: Array<{ text: string }> } }).message.content[0]!.text, req.prompt);
  const prompt = req.prompt!;
  assert.ok(!prompt.includes('DELEGATE: <one-line objective>'));
  const at = prompt.indexOf('Compare the three pricing pages in depth');
  assert.ok(at > 0, 'the objective reaches the model');
  assert.equal(prompt.lastIndexOf('Compare the three pricing pages in depth'), at, 'only once: not also as trusted instructions');
  const before = prompt.slice(0, at);
  assert.match(before.slice(before.lastIndexOf('<<<UNTRUSTED_CONTENT_')), /^<<<UNTRUSTED_CONTENT_[0-9a-f]{16}>>>\n$/, 'inside the untrusted delimiters');
});

test('a real Claude stream-json turn (with --include-partial-messages) yields its text live and the same final answer', () => {
  const stdout = readFileSync(new URL('./fixtures/claude-stream-json.ndjson', import.meta.url), 'utf8');
  const lines = stdout.trimEnd().split('\n');
  const firstDelta = lines.findIndex(l => l.includes('"text_delta"'));
  assert.equal(extractPartialText('claude', lines.slice(0, firstDelta + 1).join('\n')), 'one', 'text arrives before the turn ends');
  assert.equal(extractPartialText('claude', stdout), 'one two three four five');
  assert.equal(finalAnswer('claude', stdout), 'one two three four five');
  const cfg = baseConfig();
  const req = buildInvocation(cfg.agents[0]!, cfg.projects[0]!, makeTurnTask({ kind: 'turn', required_capability: 'claude.read', permission_envelope: { local_patch: false } } as any), {}, cfg, new AbortController().signal);
  assert.ok(req.args.includes('--include-partial-messages'), 'without it the CLI emits no deltas');
});

test('a bot chat-reply runner: fast models get the hand-off instruction, Opus and off do not', () => {
  const cfg = baseConfig();
  const agent = cfg.agents[0]!;
  const run = (runner: Record<string, unknown>) => {
    const req = buildInvocation(agent, cfg.projects[0]!, makeTurnTask({ kind: 'turn', required_capability: 'claude.read', permission_envelope: { local_patch: false, runner } } as any), {}, cfg, new AbortController().signal);
    const i = req.args.indexOf('--model');
    return { model: i >= 0 ? req.args[i + 1] : undefined, fast: req.input.includes('DELEGATE: <one-line objective>') };
  };
  assert.deepEqual(run({ provider: 'claude', model: 'claude-haiku-5-5', fast: true }), { model: 'claude-haiku-5-5', fast: true });
  assert.deepEqual(run({ provider: 'claude', model: 'claude-opus-5-5', fast: false }), { model: 'claude-opus-5-5', fast: false });
  assert.deepEqual(run({ fast: false }), { model: agent.model, fast: false }, 'off: the full model, never turn_model');
});

test('chat replies run the Claude CLI without user hooks, plugins or MCP; edits and delegated turns keep the full setup', () => {
  const cfg = baseConfig();
  const agent = cfg.agents[0]!;
  const args = (task: Record<string, unknown>) => buildInvocation(agent, cfg.projects[0]!, makeTurnTask(task as any), {}, cfg, new AbortController().signal).args;
  const light = (a: string[]) => a.includes('--strict-mcp-config') && a[a.indexOf('--setting-sources') + 1] === 'project';
  assert.ok(light(args({ kind: 'turn', required_capability: 'claude.read', permission_envelope: { local_patch: false } })));
  assert.ok(light(args({ kind: 'turn', required_capability: 'claude.read', permission_envelope: { local_patch: false, runner: { model: 'claude-opus-5-5', fast: false } } })), 'an Opus bot reply is still a chat reply');
  assert.ok(!light(args({ kind: 'turn', required_capability: 'claude.patch', permission_envelope: { local_patch: true } })), 'edit turn');
  assert.ok(!light(args({ kind: 'turn', required_capability: 'claude.read', permission_envelope: { local_patch: false, runner: { delegated: true } } })), 'delegated full turn');
});

test('a submitted task can name its model and effort; codex gets effort as a config override', () => {
  const cfg = parseBridgeConfig({
    service_url: 'http://127.0.0.1:8080',
    agents: [{ id: 'codex', provider: 'codex', binary: '/bin/codex', enable_patch: true, sandbox: false }],
    projects: [{ scope: 'project:demo', root: '/projects/demo', agents: ['codex'], allow_patch: true }]
  });
  const task = makeTurnTask({ kind: 'patch', required_capability: 'codex.patch',
    permission_envelope: { local_patch: true, runner: { model: 'gpt-6-astra', effort: 'medium' } } } as any);
  const req = buildInvocation(cfg.agents[0]!, cfg.projects[0]!, task, {}, cfg, new AbortController().signal);
  assert.equal(req.args[req.args.indexOf('--model') + 1], 'gpt-6-astra');
  assert.equal(req.args[req.args.indexOf('-c') + 1], 'model_reasoning_effort="medium"');
  assert.ok(!req.args.includes('--effort'), 'codex has no --effort flag');
  const plain = buildInvocation(cfg.agents[0]!, cfg.projects[0]!, makeTurnTask({ kind: 'patch', required_capability: 'codex.patch', permission_envelope: { local_patch: true } } as any), {}, cfg, new AbortController().signal);
  assert.ok(!plain.args.includes('-c') && !plain.args.includes('--model'), 'no override keeps the provider default');
});

test('cleanText slices UTF-8 safely without splitting multi-byte characters', () => {
  // Each emoji is 4 UTF-8 bytes; slicing at 5 or 6 bytes must yield 1 whole emoji (4 bytes), never U+FFFD
  const emojis = '🎉🚀🔥';
  assert.equal(cleanText(emojis, 4), '🎉');
  assert.equal(cleanText(emojis, 5), '🎉');
  assert.equal(cleanText(emojis, 7), '🎉');
  assert.equal(cleanText(emojis, 8), '🎉🚀');
  assert.ok(!cleanText('é'.repeat(20), 5).includes('\uFFFD'));
  assert.equal(cleanText('a\0b', 10), 'a\uFFFDb');
});

test('Claude streaming deltas are never duplicated when stderr is written or a large burst exceeds 8 KiB', async () => {
  const cfg = baseConfig();
  const checkpoints: any[] = [];
  const client: ToolClient = {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      if (name === 'task_claim') {
        return { task: makeTurnTask({ kind: 'turn', required_capability: 'claude.read', permission_envelope: { local_patch: false } } as any), lease_token: 'l', lease_generation: 1 } as T;
      }
      if (name === 'context_get') return { scope: 'project:demo', memories: [], conflicts: [] } as T;
      if (name === 'artifact_put') return { artifact: { id: 'art-1' } } as T;
      if (name === 'session_list') return { sessions: [] } as T;
      if (name === 'task_checkpoint') { checkpoints.push(args.checkpoint); return {} as T; }
      return {} as T;
    }
  };
  const d1 = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Alpha"}}}\n';
  const d2 = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":" Beta"}}}\n';
  const cfgHeartbeat = baseConfig();
  cfgHeartbeat.heartbeat_seconds = 0.04;
  const worker = new BridgeWorker(cfgHeartbeat, client, () => {}, async request => {
    // Chunk 1: stdout has d1, stderr adds 500 bytes (output_bytes > stdout_bytes)
    request.on_progress?.({ output_bytes: d1.length + 500, stdout_bytes: d1.length, stdout_tail: d1 });
    await new Promise(r => setTimeout(r, 10));
    // More stderr only (stdout_bytes unchanged, stdout_tail unchanged) -> must NOT duplicate "Alpha"
    request.on_progress?.({ output_bytes: d1.length + 1200, stdout_bytes: d1.length, stdout_tail: d1 });
    await new Promise(r => setTimeout(r, 10));
    // Chunk 2: d2 arrives; wait one short heartbeat so a running checkpoint captures the accumulated partial_text
    const total = d1 + d2;
    request.on_progress?.({ output_bytes: total.length + 1200, stdout_bytes: total.length, stdout_tail: total });
    await new Promise(r => setTimeout(r, 60));
    return {
      exit_code: 0,
      signal: null,
      stdout: total + '{"type":"result","subtype":"success","result":"Alpha Beta"}\n',
      stderr: 'x'.repeat(1200),
      duration_ms: 80,
      stop_reason: null
    };
  });
  await worker.claimAndRun(cfgHeartbeat.projects, new AbortController().signal);
  const partials = checkpoints.filter(c => typeof c.partial_text === 'string' && c.partial_text.length > 0).map(c => c.partial_text);
  assert.ok(!partials.some(p => p.includes('AlphaAlpha')), 'stderr bytes must not cause duplicate deltas');
  assert.equal(partials.at(-1), 'Alpha Beta', 'stderr bytes must not cause duplicate deltas');
});

test('SSE stream buffer cap at 1 MiB triggers reconnect without unbounded memory growth', { timeout: 3000 }, async () => {
  const cfg = baseConfig();
  cfg.poll_seconds = 10;
  cfg.usage_seconds = 0;
  const logs: Array<{ event: string; message?: unknown }> = [];
  let fetchCount = 0;
  const overflowLogged = deferred();

  const fakeFetch: typeof fetch = async () => {
    fetchCount++;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (fetchCount === 1) {
          // Enqueue > 1 MiB with no double-newline boundary
          controller.enqueue(Buffer.alloc(1024 * 1024 + 128, 0x61));
        }
      }
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const client: ToolClient = {
    async call<T>(name: string): Promise<T> {
      return (name === 'task_claim' ? { task: null } : {}) as T;
    }
  };
  const stop = new AbortController();
  const worker = new BridgeWorker(cfg, client, (event, meta) => {
    logs.push({ event, message: meta?.message });
    if (event === 'stream_connection_failed' && String(meta?.message).includes('1 MiB')) overflowLogged.resolve();
  }, undefined, undefined, fakeFetch);
  const runPromise = worker.run(stop.signal);
  try {
    await overflowLogged.promise;
    assert.ok(logs.some(l => l.event === 'stream_connection_failed' && String(l.message).includes('1 MiB')));
  } finally {
    worker.drain();
    stop.abort();
    await runPromise;
  }
});

test('inflight slot is released before slow recordSession finishes while drain still waits for it', { timeout: 3000 }, async () => {
  const cfg = baseConfig();
  cfg.max_concurrent = 1;
  cfg.poll_seconds = 10;
  cfg.usage_seconds = 0;

  let claimCount = 0;
  const sessionHold = deferred();
  const secondClaimed = deferred();
  let sessionDone = false;

  const client: ToolClient = {
    async call<T>(name: string): Promise<T> {
      if (name === 'task_claim') {
        claimCount++;
        if (claimCount === 1) return { task: makeTurnTask({ id: '11111111-1111-4111-8111-111111111111', kind: 'review' }), lease_token: 'l1', lease_generation: 1 } as T;
        if (claimCount === 2) {
          secondClaimed.resolve();
          return { task: null } as T;
        }
        return { task: null } as T;
      }
      if (name === 'context_get') return { scope: 'project:demo', memories: [], conflicts: [] } as T;
      if (name === 'artifact_put') return { artifact: { id: 'a1' } } as T;
      if (name === 'session_list') {
        await sessionHold.promise;
        return { sessions: [] } as T;
      }
      if (name === 'session_record') {
        sessionDone = true;
        return {} as T;
      }
      return {} as T;
    }
  };

  const stop = new AbortController();
  const worker = new BridgeWorker(cfg, client, () => {}, async () => ({
    exit_code: 0, signal: null, stdout: '{"type":"result","subtype":"success","is_error":false,"result":"ok"}', stderr: '', duration_ms: 5, stop_reason: null
  }));
  const runPromise = worker.run(stop.signal);
  try {
    // Even with max_concurrent=1 and task 1 still blocked in recordSession, claim #2 runs!
    await secondClaimed.promise;
    assert.equal(sessionDone, false, 'second claim ran while recordSession was still pending');
    worker.drain();
    sessionHold.resolve();
    await runPromise;
    assert.equal(sessionDone, true, 'drain waited for in-flight recordSession to complete');
  } finally {
    sessionHold.resolve();
    worker.drain();
    stop.abort();
    await runPromise;
  }
});

test('SSE required_capability filtering ignores mismatched providers and wakes on matching/auto capabilities', { timeout: 3000 }, async () => {
  const cfg = parseBridgeConfig({
    service_url: 'http://127.0.0.1:8080',
    poll_seconds: 10,
    usage_seconds: 0,
    agents: [{ id: 'claude', provider: 'claude', binary: '/bin/claude', enable_patch: false, sandbox: false }],
    projects: [{ scope: 'project:demo', root: '/projects/demo', agents: ['claude'], allow_patch: false }]
  });

  let claims = 0;
  const firstClaim = deferred();
  const secondClaim = deferred();
  const thirdClaim = deferred();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { streamController = c; } });
  const fakeFetch: typeof fetch = async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  const client: ToolClient = {
    async call<T>(name: string): Promise<T> {
      if (name === 'task_claim') {
        claims++;
        if (claims === 1) firstClaim.resolve();
        if (claims === 2) secondClaim.resolve();
        if (claims === 3) thirdClaim.resolve();
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
    await new Promise(r => setTimeout(r, 40));

    // Unmatched capabilities (different provider & patch when read-only) must NOT wake this worker!
    streamController.enqueue(Buffer.from('event: task.submitted\ndata: {"scope":"project:demo","payload":{"required_capability":"codex.read"}}\n\n'));
    streamController.enqueue(Buffer.from('event: task.submitted\ndata: {"scope":"project:demo","payload":{"required_capability":"claude.patch"}}\n\n'));
    streamController.enqueue(Buffer.from('event: task.submitted\ndata: {"scope":"project:demo","payload":{"required_capability":"auto.patch"}}\n\n'));
    await new Promise(r => setTimeout(r, 60));
    assert.equal(claims, 1, 'mismatched required_capability must not trigger claim stampede');

    // Matching capability wakes immediately!
    streamController.enqueue(Buffer.from('event: task.submitted\ndata: {"scope":"project:demo","payload":{"required_capability":"claude.read"}}\n\n'));
    await secondClaim.promise;
    await new Promise(r => setTimeout(r, 40));

    // auto.read also matches this worker!
    streamController.enqueue(Buffer.from('event: task.updated\ndata: {"scope":"project:demo","payload":{"status":"queued","required_capability":"auto.read"}}\n\n'));
    await thirdClaim.promise;
    assert.equal(claims, 3);
  } finally {
    worker.drain();
    stop.abort();
    try { streamController.close(); } catch {}
    await runPromise;
  }
});

test('batch task_claim requests limit and claims fan-out burst in 1 HTTP RTT', { timeout: 3000 }, async () => {
  const cfg = baseConfig();
  cfg.max_concurrent = 4;
  cfg.usage_seconds = 0;
  cfg.poll_seconds = 10;

  const claimArgs: Record<string, unknown>[] = [];
  const finishedIds: string[] = [];
  const allDone = deferred();

  const batch = ['11111111-1111-4111-8111-11111111111a', '11111111-1111-4111-8111-11111111111b', '11111111-1111-4111-8111-11111111111c'].map(id => ({
    task: makeTurnTask({ id, kind: 'turn', required_capability: 'claude.read' }),
    lease_token: `tok-${id}`,
    lease_generation: 1
  }));

  const client: ToolClient = {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      if (name === 'task_claim') {
        claimArgs.push(args);
        if (claimArgs.length === 1) return { claims: batch, ...batch[0] } as T;
        return { claims: [], task: null } as T;
      }
      if (name === 'task_finish') {
        finishedIds.push(String(args.task_id));
        if (finishedIds.length === 3) allDone.resolve();
        return {} as T;
      }
      if (name === 'session_list') return { sessions: [] } as T;
      return {} as T;
    }
  };

  const stop = new AbortController();
  const worker = new BridgeWorker(cfg, client, () => {}, async () => ({
    exit_code: 0, signal: null,
    stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', model: 'claude-haiku-5-5' }),
    stderr: '', duration_ms: 5, stop_reason: null
  }));
  const runPromise = worker.run(stop.signal);
  try {
    await allDone.promise;
    assert.equal(claimArgs[0]!.limit, 4, 'requests limit = min(16, max_concurrent - inflight)');
    assert.equal(finishedIds.length, 3);
    assert.equal(claimArgs.length, 1, 'batch response with fewer claims than limit stops polling in 1 RTT');
  } finally {
    worker.drain();
    stop.abort();
    await runPromise;
  }
});

test('1-RTT post-finish: skips provider_finished checkpoint, skips renew when >=30s remain, skips context_get on turns, falls back to artifact_put on 400 invalid_arguments', async () => {
  const cfg = baseConfig();
  cfg.lease_seconds = 120;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: ToolClient = {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ name, args });
      if (name === 'task_claim') {
        return { task: makeTurnTask({ kind: 'turn', required_capability: 'claude.read' }), lease_token: 'l1', lease_generation: 1 } as T;
      }
      if (name === 'session_list') return { sessions: [] } as T;
      return {} as T;
    }
  };

  const worker = new BridgeWorker(cfg, client, () => {}, async () => ({
    exit_code: 0, signal: null,
    stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', model: 'claude-haiku-5-5' }),
    stderr: '', duration_ms: 5, stop_reason: null
  }));
  await worker.claimAndRun(cfg.projects, new AbortController().signal);

  assert.equal(calls.filter(c => c.name === 'context_get').length, 0, 'turns skip wasted context_get');
  assert.equal(calls.filter(c => c.name === 'artifact_put').length, 0, 'modern server uses inline_artifacts on task_finish');
  assert.equal(calls.filter(c => c.name === 'task_heartbeat').length, 0, 'skips pre-finish renew when >=30s lease remains');
  assert.ok(!calls.some(c => c.name === 'task_checkpoint' && (c.args.checkpoint as any)?.phase === 'provider_finished'), 'removes redundant provider_finished checkpoint');
  const finishCall = calls.find(c => c.name === 'task_finish')!;
  assert.ok(Array.isArray(finishCall.args.inline_artifacts) && (finishCall.args.inline_artifacts as unknown[]).length === 1);

  // Backwards-compatibility fallback: older server rejects inline_artifacts with 400 invalid_arguments -> falls back to artifact_put
  const legacyCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const legacyClient: ToolClient = {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      legacyCalls.push({ name, args });
      if (name === 'task_claim') {
        return { task: makeTurnTask({ kind: 'turn', required_capability: 'claude.read' }), lease_token: 'l2', lease_generation: 1 } as T;
      }
      if (name === 'task_finish' && args.inline_artifacts) {
        throw new RemoteError(400, 'invalid_arguments');
      }
      if (name === 'artifact_put') return { artifact: { id: 'legacy-art-1' } } as T;
      if (name === 'session_list') return { sessions: [] } as T;
      return {} as T;
    }
  };
  // Also test conditional renew when remaining lease < 30_000 ms (lease_seconds = 10 -> remaining ~10s < 30s)
  const shortCfg = baseConfig();
  shortCfg.lease_seconds = 10;
  shortCfg.heartbeat_seconds = 5;
  const legacyWorker = new BridgeWorker(shortCfg, legacyClient, () => {}, async () => ({
    exit_code: 0, signal: null,
    stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'legacy ok', model: 'claude-haiku-5-5' }),
    stderr: '', duration_ms: 5, stop_reason: null
  }));
  await legacyWorker.claimAndRun(shortCfg.projects, new AbortController().signal);
  assert.equal(legacyCalls.filter(c => c.name === 'task_heartbeat').length, 1, 'renews before finish when <30s lease remains');
  assert.equal(legacyCalls.filter(c => c.name === 'artifact_put').length, 1, 'falls back to artifact_put on 400 invalid_arguments');
  const finalFinish = legacyCalls.filter(c => c.name === 'task_finish').at(-1)!;
  assert.deepEqual(finalFinish.args.artifact_ids, ['legacy-art-1']);
  assert.equal(finalFinish.args.inline_artifacts, undefined);
});

test('askedModel honors runner.model on non-turn task_submit and edit turns without false substitution', async () => {
  const cfg = baseConfig();
  let finishResult: Record<string, unknown> | undefined;
  const client: ToolClient = {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      if (name === 'task_claim') {
        return {
          task: makeTurnTask({
            kind: 'review',
            required_capability: 'claude.read',
            permission_envelope: { runner: { model: 'claude-sonnet-4-6' } }
          } as any),
          lease_token: 'l1',
          lease_generation: 1
        } as T;
      }
      if (name === 'context_get') return { scope: 'project:demo', memories: [], conflicts: [] } as T;
      if (name === 'session_list') return { sessions: [] } as T;
      if (name === 'task_finish') finishResult = args.result as Record<string, unknown>;
      return {} as T;
    }
  };
  const worker = new BridgeWorker(cfg, client, () => {}, async () => ({
    exit_code: 0, signal: null,
    stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'reviewed', model: 'claude-sonnet-4-6' }),
    stderr: '', duration_ms: 5, stop_reason: null
  }));
  await worker.claimAndRun(cfg.projects, new AbortController().signal);
  assert.deepEqual(finishResult?.served, { provider: 'claude', model: 'claude-sonnet-4-6' });
});

test('reportUsage reports default_model, turn_model, and live cached ACP models', async () => {
  const cfg = parseBridgeConfig({
    service_url: 'http://127.0.0.1:8080',
    agents: [
      { id: 'claude', provider: 'claude', binary: '/bin/claude', model: 'claude-opus-5-5', turn_model: 'claude-haiku-5-5', sandbox: false },
      { id: 'antigravity', provider: 'antigravity', binary: '/bin/agy', model: 'gemini-3.8-pro', turn_model: 'gemini-3.8-flash', sandbox: true }
    ],
    projects: [{ scope: 'project:demo', root: '/projects/demo', agents: ['claude', 'antigravity'] }]
  });
  const pool = new WarmProviderPool();
  pool.setCachedModels('antigravity', [
    { id: 'gemini-3.8-pro', label: 'Gemini 3.8 Pro', efforts: ['low', 'medium', 'high'], default: true },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], fast: true }
  ]);
  let reported: Record<string, unknown> | undefined;
  const client: ToolClient = {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      if (name === 'usage_report') reported = args;
      return {} as T;
    }
  };
  const now = new Date().toISOString();
  const worker = new BridgeWorker(cfg, client, () => {}, undefined, async () => [
    { provider: 'claude', ok: true, windows: [], fetched_at: now },
    { provider: 'antigravity', ok: false, windows: [], fetched_at: now, error: 'not exposed' }
  ], { warmPool: pool });
  await worker.reportUsage(new AbortController().signal);
  const reports = reported?.reports as Array<Record<string, unknown>>;
  assert.equal(reports.length, 2);
  assert.equal(reports[0]!.default_model, 'claude-opus-5-5');
  assert.equal(reports[0]!.turn_model, 'claude-haiku-5-5');
  assert.equal(reports[1]!.default_model, 'gemini-3.8-pro');
  assert.equal(reports[1]!.turn_model, 'gemini-3.8-flash');
  assert.equal((reports[1]!.models as Array<{ id: string }>).length, 2);
});

test('buildTurnPrompt preserves Agent instructions AND renders Task objective, Swarm goal, and crew [can edit]/[read-only]', () => {
  const prompt = buildTurnPrompt(makeTurnTask({
    objective: 'Scheduled run: audit flaky tests and summarize failures',
    agent: { instructions: 'You are the QA lead.' },
    swarm: { goal: 'Keep CI green on main' },
    agents: [
      { id: 'a1', name: 'Coder', role: 'engineer', edits: true },
      { id: 'a2', name: 'Scout', role: 'researcher', edits: false },
      { id: 'a3', name: 'Reviewer' }
    ]
  } as any), {});

  assert.ok(prompt.includes('Agent instructions:\nYou are the QA lead.'));
  assert.ok(prompt.includes('Swarm goal:\nKeep CI green on main'));
  assert.ok(prompt.includes('Task objective:\nScheduled run: audit flaky tests and summarize failures'));
  assert.ok(prompt.includes('- Coder (id: a1, role: engineer) [can edit]'));
  assert.ok(prompt.includes('- Scout (id: a2, role: researcher) [read-only]'));
  assert.ok(prompt.includes('- Reviewer (id: a3) [read-only]'));

  // Generic boilerplate turn headers are NOT redundantly rendered as Task objective:
  const generic = buildTurnPrompt(makeTurnTask({
    objective: 'Turn for agent QA Lead in #general',
    agent: { instructions: 'You are the QA lead.' }
  } as any), {});
  assert.ok(generic.includes('Agent instructions:\nYou are the QA lead.'));
  assert.ok(!generic.includes('Task objective:'));
});

test('buildInvocation propagates runnerModel & runnerEffort on edit turns, independent runnerEffort, and extends lightChat to router & summary turns', () => {
  const cfg = baseConfig();
  const agent = cfg.agents[0]!;
  const project = cfg.projects[0]!;
  const isLight = (a: string[]) => a.includes('--strict-mcp-config') && a[a.indexOf('--setting-sources') + 1] === 'project';

  // 1. Edit turn honors both runner.model and runner.effort
  const editWithRunner = buildInvocation(agent, project, makeTurnTask({
    kind: 'turn',
    required_capability: 'claude.patch',
    permission_envelope: { local_patch: true, runner: { model: 'claude-sonnet-4-6', effort: 'high' } }
  } as any), {}, cfg, new AbortController().signal);
  assert.equal(editWithRunner.args[editWithRunner.args.indexOf('--model') + 1], 'claude-sonnet-4-6');
  assert.equal(editWithRunner.args[editWithRunner.args.indexOf('--effort') + 1], 'high');
  assert.ok(!isLight(editWithRunner.args), 'ordinary edit turn keeps full MCP/plugin setup');

  // 2. Edit turn honors runner.effort independently even when runner.model is undefined
  const editEffortOnly = buildInvocation(agent, project, makeTurnTask({
    kind: 'turn',
    required_capability: 'claude.patch',
    permission_envelope: { local_patch: true, runner: { effort: 'max' } }
  } as any), {}, cfg, new AbortController().signal);
  assert.equal(editEffortOnly.args[editEffortOnly.args.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(editEffortOnly.args[editEffortOnly.args.indexOf('--effort') + 1], 'max');

  // 3. Non-edit turn honors runner.effort independently when runner.model is undefined
  const readEffortOnly = buildInvocation(agent, project, makeTurnTask({
    kind: 'turn',
    required_capability: 'claude.read',
    permission_envelope: { local_patch: false, runner: { effort: 'high' } }
  } as any), {}, cfg, new AbortController().signal);
  assert.equal(readEffortOnly.args[readEffortOnly.args.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(readEffortOnly.args[readEffortOnly.args.indexOf('--effort') + 1], 'high');

  // 4. Router turns and swarm summary turns (even on edit-capable leads) get lightChat flags
  const routerTurn = buildInvocation(agent, project, makeTurnTask({
    kind: 'turn',
    required_capability: 'claude.read',
    permission_envelope: { local_patch: false, runner: { router: true, delegated: true } }
  } as any), {}, cfg, new AbortController().signal);
  assert.ok(isLight(routerTurn.args), 'router turn uses lightChat');

  const summaryTurn = buildInvocation(agent, project, makeTurnTask({
    kind: 'turn',
    required_capability: 'claude.patch',
    permission_envelope: { local_patch: true, runner: { summary: true } }
  } as any), {}, cfg, new AbortController().signal);
  assert.ok(isLight(summaryTurn.args), 'swarm summary turn uses lightChat even on edit-capable lead');
});
