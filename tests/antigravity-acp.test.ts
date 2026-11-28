import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildAcpArgs,
  extractAcpModelCatalog,
  isReadOnlyAcpToolAllowed,
  runAcpSession,
  type AcpActivityItem,
  type ProviderModelInfo,
} from '../src/bridge/acp.js';
import {
  assertAntigravityCompliance,
  buildInvocation,
  deniedActions,
  extractActivity,
  extractPartialText,
  extractServed,
  extractUsage,
  finalAnswer,
  hasAntigravityEnterpriseAuth,
  isInteractiveAntigravityTask,
  providerSucceeded,
} from '../src/bridge/adapters.js';
import { parseBridgeConfig } from '../src/bridge/config.js';
import type { Task, ToolClient } from '../src/bridge/types.js';
import { BridgeWorker } from '../src/bridge/worker.js';

const MOCK_ACP_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const mode = process.env.MOCK_ACP_MODE || 'normal';
const seen = [];
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  seen.push(msg.method);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'mock-agy', version: '1.0' } } });
    return;
  }
  if (msg.method === 'session/load') {
    if (mode === 'load_missing') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32004, message: 'Session not found' } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params.sessionId, models: { currentModelId: 'gemini-3.8-pro' } } });
    }
    return;
  }
  if (msg.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'acp-sess-123',
        models: { currentModelId: 'gemini-3.8-flash' },
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'gemini-3.8-flash',
            options: [
              { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
              { value: 'gemini-3.8-pro', name: 'Gemini 3.8 Pro' }
            ]
          },
          {
            id: 'thought_level',
            name: 'Thought level',
            type: 'select',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' }
            ]
          }
        ]
      }
    });
    return;
  }
  if (msg.method === 'session/set_model') {
    send({ jsonrpc: '2.0', id: msg.id, result: { modelId: msg.params.modelId } });
    return;
  }
  if (msg.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === 'session/cancel') {
    process.stderr.write('CANCEL_RECEIVED:' + msg.params.sessionId + '\\n');
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (msg.method === 'session/prompt') {
    if (mode === 'hang_for_cancel') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working...' } } } });
      return;
    }
    if (mode === 'ask_permission') {
      send({
        jsonrpc: '2.0',
        id: 99,
        method: 'session/request_permission',
        params: {
          sessionId: msg.params.sessionId,
          toolCall: { toolCallId: 'tc_perm', title: 'Write file.ts', kind: 'edit' },
          options: [
            { optionId: 'allow_1', kind: 'allow_once', name: 'Allow' },
            { optionId: 'reject_1', kind: 'reject_once', name: 'Deny' }
          ]
        }
      });
      rl.once('line', (permLine) => {
        const resp = JSON.parse(permLine);
        const picked = resp.result?.outcome?.optionId;
        if (picked === 'allow_1') {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Edited!' } } } });
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        } else {
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      });
      return;
    }
    const blocks = msg.params.prompt || [];
    const hasImage = blocks.some(b => b.type === 'image' && b.mimeType === 'image/jpeg' && typeof b.data === 'string' && b.data.length > 0);
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tc_1', title: 'Read src/app.ts token=secretvalue1234', kind: 'read', status: 'in_progress' } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc_1', status: 'completed' } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: hasImage ? 'with image!' : 'ACP world!' } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 120, cachedReadTokens: 40, outputTokens: 25 } } });
  }
});
`;

function withMockAcpScript(fn: (scriptPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'acp-test-'));
  const scriptPath = join(dir, 'mock-agy-acp.cjs');
  writeFileSync(scriptPath, `#!/usr/bin/env node\n${MOCK_ACP_SERVER}`);
  chmodSync(scriptPath, 0o755);
  return fn(scriptPath).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const makeTask = (extra: Partial<Task> & Record<string, unknown> = {}): Task => ({
  id: '11111111-1111-4111-8111-111111111111',
  scope: 'project:demo',
  kind: 'turn',
  objective: 'Answer the user',
  constraints: [],
  acceptance_criteria: [],
  resource_key: null,
  required_capability: 'antigravity.read',
  checkpoint: null,
  context_refs: [],
  version: 1,
  ...extra,
} as Task);

test('buildAcpArgs emits only verified agy acp flags', () => {
  assert.deepEqual(buildAcpArgs({ patch: false }), ['acp', '--stdio', '--sandbox']);
  assert.deepEqual(buildAcpArgs({ patch: true }), ['acp', '--stdio', '--dangerously-skip-permissions']);
  assert.deepEqual(
    buildAcpArgs({ patch: false, processPerSession: true, agent: 'coder' }),
    ['acp', '--stdio', '--process-per-session', '--sandbox', '--agent', 'coder']
  );
});

test('runAcpSession completes full ACP lifecycle with streaming chunks, tools, image blocks, model & usage', async () => {
  await withMockAcpScript(async scriptPath => {
    const partials: string[] = [];
    const activities: AcpActivityItem[] = [];
    const res = await runAcpSession({
      command: process.execPath,
      args: [scriptPath],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      input: '',
      acp: {
        cwd: process.cwd(),
        prompt: 'Describe the photo',
        model: 'gemini-3.8-pro',
        effort: 'high',
        images: [{ seq: '1', data: '/9j/4AAQSkZJRg==', mimeType: 'image/jpeg' }],
        patch: false,
      },
      timeout_ms: 5000,
      max_output_bytes: 1 << 20,
    }, {
      onPartialText: t => partials.push(t),
      onActivity: a => activities.push({ ...a }),
    });

    assert.equal(res.exit_code, 0);
    assert.equal(providerSucceeded('antigravity', res), true);
    assert.equal(finalAnswer('antigravity', res.stdout), 'Hello with image!');
    assert.deepEqual(partials, ['Hello ', 'Hello with image!']);
    assert.equal(activities.length, 2);
    assert.equal(activities[0]!.state, 'running');
    assert.equal(activities[1]!.state, 'done');
    assert.ok(!activities[0]!.label.includes('secretvalue1234'), 'activity labels redact secrets');
    assert.deepEqual(extractUsage('antigravity', res.stdout), {
      input_tokens: 120,
      cached_input_tokens: 40,
      output_tokens: 25,
    });
    assert.equal(extractServed('antigravity', res).model, 'gemini-3.8-pro');
    assert.equal(extractActivity('antigravity', res.stdout).length, 1);
  });
});

test('runAcpSession falls back from session/load to session/new when resumed session is missing', async () => {
  await withMockAcpScript(async scriptPath => {
    const res = await runAcpSession({
      command: process.execPath,
      args: [scriptPath],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, MOCK_ACP_MODE: 'load_missing' },
      input: '',
      acp: {
        cwd: process.cwd(),
        prompt: 'Continue work',
        resume_session_id: 'old-session-id',
      },
      timeout_ms: 5000,
      max_output_bytes: 1 << 20,
    });
    assert.equal(res.exit_code, 0);
    assert.equal(finalAnswer('antigravity', res.stdout), 'Hello ACP world!');
    assert.equal(JSON.parse(res.stdout).session_id, 'acp-sess-123');
  });
});

test('runAcpSession handles session/request_permission: allows in patch mode, denies in read-only mode', async () => {
  await withMockAcpScript(async scriptPath => {
    const allowed = await runAcpSession({
      command: process.execPath,
      args: [scriptPath],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, MOCK_ACP_MODE: 'ask_permission' },
      input: '',
      acp: { cwd: process.cwd(), prompt: 'Edit', patch: true, dangerously_skip_permissions: true },
      timeout_ms: 5000,
      max_output_bytes: 1 << 20,
    });
    assert.equal(providerSucceeded('antigravity', allowed), true);
    assert.equal(finalAnswer('antigravity', allowed.stdout), 'Edited!');

    const denied = await runAcpSession({
      command: process.execPath,
      args: [scriptPath],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, MOCK_ACP_MODE: 'ask_permission' },
      input: '',
      acp: { cwd: process.cwd(), prompt: 'Edit', patch: false, dangerously_skip_permissions: false },
      timeout_ms: 5000,
      max_output_bytes: 1 << 20,
    });
    assert.equal(providerSucceeded('antigravity', denied), false);
    assert.deepEqual(deniedActions('antigravity', denied.stdout), ['Write file.ts']);
  });
});

test('runAcpSession sends session/cancel on AbortSignal', async () => {
  await withMockAcpScript(async scriptPath => {
    const controller = new AbortController();
    const res = await runAcpSession({
      command: process.execPath,
      args: [scriptPath],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, MOCK_ACP_MODE: 'hang_for_cancel' },
      input: '',
      acp: { cwd: process.cwd(), prompt: 'Long task' },
      signal: controller.signal,
      timeout_ms: 5000,
      max_output_bytes: 1 << 20,
    }, {
      onPartialText: () => controller.abort(),
    });
    assert.equal(res.stop_reason, 'aborted');
    assert.match(res.stderr, /CANCEL_RECEIVED:acp-sess-123/);
  });
});

test('Google ToS compliance boundary: all person-started work uses ACP, unattended OAuth fails closed, enterprise fallback splits model/effort', { skip: process.platform !== 'darwin' }, () => {
  const cfg = parseBridgeConfig({
    service_url: 'http://127.0.0.1:8080',
    agents: [{ id: 'antigravity', provider: 'antigravity', binary: '/bin/agy', model: 'gemini-3.8-pro', enable_patch: true }],
    projects: [{ scope: 'project:demo', root: '/projects/demo', agents: ['antigravity'], allow_patch: true }],
  });
  const agent = cfg.agents[0]!;
  const project = cfg.projects[0]!;

  // 1. Interactive turn: routes through `agy acp --stdio --sandbox` even without API key
  const turn = makeTask({ kind: 'turn', required_capability: 'antigravity.read' });
  assert.equal(isInteractiveAntigravityTask(turn), true);
  const acpReq = buildInvocation(agent, project, turn, {}, cfg, new AbortController().signal, { HOME: '/h' });
  assert.ok(acpReq.acp, 'interactive turn uses ACP');
  assert.equal(acpReq.input, '');
  const agyIdx = acpReq.args.indexOf('/bin/agy');
  assert.deepEqual(acpReq.args.slice(agyIdx + 1), ['acp', '--stdio', '--sandbox']);
  assert.ok(!acpReq.args.some(a => a.startsWith('-p=')), 'never leaks prompt via -p= argv');

  // 2. Scheduled turn without API/enterprise auth: fails closed
  const scheduledTurn = makeTask({ kind: 'turn', permission_envelope: { scheduled: true } } as any);
  assert.equal(isInteractiveAntigravityTask(scheduledTurn), false);
  assert.throws(
    () => assertAntigravityCompliance(agent, scheduledTurn, { HOME: '/h' }),
    (err: any) => err.code === 'antigravity_unattended_oauth_disallowed'
  );

  // 3. Person-started review AND patch ALSO route through `agy acp --stdio` (never -p= in argv)...
  const bgReview = makeTask({ kind: 'review', required_capability: 'antigravity.read', initiator_kind: 'person' } as any);
  assert.equal(isInteractiveAntigravityTask(bgReview), true);
  const reviewReq = buildInvocation(agent, project, bgReview, {}, cfg, new AbortController().signal, { HOME: '/h' });
  assert.ok(reviewReq.acp, 'person-started review uses ACP');
  assert.equal(reviewReq.acp!.patch, false);
  assert.deepEqual(reviewReq.args.slice(reviewReq.args.indexOf('/bin/agy') + 1), ['acp', '--stdio', '--sandbox']);
  assert.ok(!reviewReq.args.some(a => a.startsWith('-p=')), 'person-started review never uses -p= in argv');

  const bgPatch = makeTask({ kind: 'patch', required_capability: 'antigravity.patch', initiator_kind: 'person' } as any);
  const patchReq = buildInvocation(agent, project, bgPatch, {}, cfg, new AbortController().signal, { HOME: '/h' }, { dir: '/wt/x', gitDir: '/projects/demo/.git' });
  assert.ok(patchReq.acp, 'person-started patch uses ACP');
  assert.equal(patchReq.acp!.patch, true);
  assert.equal(patchReq.acp!.dangerously_skip_permissions, true);
  assert.deepEqual(patchReq.args.slice(patchReq.args.indexOf('/bin/agy') + 1), ['acp', '--stdio', '--dangerously-skip-permissions']);
  assert.ok(!patchReq.args.some(a => a.startsWith('-p=')), 'person-started patch never uses -p= in argv');

  // ...while a scheduled bot run or webhook-sourced task without API/enterprise auth fails closed.
  for (const initiator_kind of ['schedule', 'source', 'bot_check']) {
    const unattended = makeTask({ kind: 'review', required_capability: 'antigravity.read', initiator_kind } as any);
    assert.equal(isInteractiveAntigravityTask(unattended), false);
    assert.throws(
      () => buildInvocation(agent, project, unattended, {}, cfg, new AbortController().signal, { HOME: '/h' }),
      (err: any) => err.code === 'antigravity_unattended_oauth_disallowed'
    );
  }

  // 4. Unattended enterprise/API-key fallback: print mode splits `-low|-medium|-high|-xhigh` so --model and --effort never conflict
  assert.equal(hasAntigravityEnterpriseAuth(agent, { GEMINI_API_KEY: 'key' }), true);
  assert.equal(hasAntigravityEnterpriseAuth({ ...agent, auth_mode: 'enterprise' }, {}), true);
  const bgReq = buildInvocation(
    { ...agent, model: 'gemini-3.8-flash-high' },
    project,
    makeTask({ kind: 'review', initiator_kind: 'schedule' } as any),
    {},
    cfg,
    new AbortController().signal,
    { HOME: '/h', GEMINI_API_KEY: 'key' }
  );
  assert.equal(bgReq.acp, undefined);
  const directArgs = bgReq.args.slice(bgReq.args.indexOf('/bin/agy') + 1);
  assert.ok(!directArgs.includes('--input-format'), "agy's stream-json input wants event-shaped messages");
  assert.equal(directArgs[directArgs.indexOf('--output-format') + 1], 'json');
  assert.equal(directArgs[directArgs.indexOf('--model') + 1], 'gemini-3.8-flash');
  assert.equal(directArgs[directArgs.indexOf('--effort') + 1], 'high');
  assert.equal(directArgs.filter(a => a.startsWith('-p=')).length, 1, 'prompt attached to -p=');
  assert.equal(bgReq.input, '');
});

test('isReadOnlyAcpToolAllowed uses a case-normalized explicit allowlist and refuses mutating kinds/verbs', () => {
  for (const safe of ['read', 'READ', 'search', 'list', 'grep', 'glob', 'fetch', 'web', 'think', 'execute', 'command', 'bash', 'terminal', 'other']) {
    assert.equal(isReadOnlyAcpToolAllowed({ kind: safe, title: 'Inspect file' }, false, false), true, `expected ${safe} allowed`);
  }
  for (const unsafe of ['edit', 'EDIT', 'write', 'Write', 'delete', 'DELETE', 'move', 'create', 'patch', 'apply', 'rename', 'modify', 'file_edit', 'apply_patch', 'unknown_kind', '']) {
    assert.equal(isReadOnlyAcpToolAllowed({ kind: unsafe, title: 'Do thing' }, false, false), false, `expected ${unsafe} denied`);
  }
  // Mutating toolName on an otherwise allowed kind is refused.
  assert.equal(isReadOnlyAcpToolAllowed({ kind: 'other', toolName: 'write_file', title: 'Helper' }, false, false), false);
  assert.equal(isReadOnlyAcpToolAllowed({ kind: 'execute', toolName: 'applyPatch', title: 'Apply' }, false, false), false);
  // Generic `other` with leading mutating verb in title is refused, while safe `read` on a file named write.ts is allowed.
  assert.equal(isReadOnlyAcpToolAllowed({ kind: 'other', title: 'Write config.json' }, false, false), false);
  assert.equal(isReadOnlyAcpToolAllowed({ kind: 'read', title: 'Read src/write.ts' }, false, false), true);
  // Missing toolCall fails closed in read-only mode.
  assert.equal(isReadOnlyAcpToolAllowed(undefined, false, false), false);
  // Patch mode allows full tools.
  assert.equal(isReadOnlyAcpToolAllowed({ kind: 'edit', toolName: 'write_file' }, true, false), true);
  assert.equal(isReadOnlyAcpToolAllowed({ kind: 'DELETE' }, false, true), true);
});

test('extractAcpModelCatalog and runAcpSession capture live configOptions models and thought_level efforts', async () => {
  await withMockAcpScript(async scriptPath => {
    let seenModels: ProviderModelInfo[] | undefined;
    const res = await runAcpSession({
      command: process.execPath,
      args: [scriptPath],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      input: '',
      acp: { cwd: process.cwd(), prompt: 'Hi' },
      timeout_ms: 5000,
      max_output_bytes: 1 << 20,
    }, {
      onModels: m => { seenModels = m; },
    });
    assert.equal(res.exit_code, 0);
    assert.deepEqual(seenModels, [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], fast: true, default: true },
      { id: 'gemini-3.8-pro', label: 'Gemini 3.8 Pro', efforts: ['low', 'medium', 'high'] },
    ]);
  });

  // Fallback to availableModels when configOptions is absent
  assert.deepEqual(
    extractAcpModelCatalog({
      models: {
        currentModelId: 'gemini-3.8-pro',
        availableModels: [{ modelId: 'gemini-3.8-pro', name: 'Gemini 3.8 Pro' }, { modelId: 'gemini-3.8-flash-lite', name: 'Flash Lite' }],
      },
    }),
    [
      { id: 'gemini-3.8-pro', label: 'Gemini 3.8 Pro', default: true },
      { id: 'gemini-3.8-flash-lite', label: 'Flash Lite', fast: true },
    ]
  );
});

test('BridgeWorker finishes unattended consumer-OAuth Antigravity task as blocked with actionable code', { skip: process.platform !== 'darwin' }, async () => {
  const cfg = parseBridgeConfig({
    service_url: 'http://127.0.0.1:8080',
    agents: [{ id: 'antigravity', provider: 'antigravity', binary: '/bin/agy' }],
    projects: [{ scope: 'project:demo', root: '/tmp', agents: ['antigravity'] }],
  });
  const bgTask = makeTask({ kind: 'review', required_capability: 'antigravity.read', initiator_kind: 'schedule' } as any);
  let finishArgs: Record<string, unknown> | undefined;
  const client: ToolClient = {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      if (name === 'task_claim') return { task: bgTask, lease_token: 'l', lease_generation: 1 } as T;
      if (name === 'context_get') return { scope: bgTask.scope, task: bgTask, memories: [], conflicts: [] } as T;
      if (name === 'task_finish') finishArgs = args;
      return {} as T;
    },
  };
  const savedKeys = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  };
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    let ran = false;
    const worker = new BridgeWorker(cfg, client, () => {}, async () => {
      ran = true;
      return { exit_code: 0, signal: null, stdout: '', stderr: '', duration_ms: 1, stop_reason: null };
    });
    await worker.claimAndRun(cfg.projects, new AbortController().signal);
    assert.equal(ran, false, 'provider must never spawn when unattended OAuth is disallowed');
    assert.equal(finishArgs?.outcome, 'blocked');
    assert.equal((finishArgs?.result as Record<string, unknown>).code, 'antigravity_unattended_oauth_disallowed');
  } finally {
    for (const [k, v] of Object.entries(savedKeys)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('extractPartialText supports Antigravity ACP agent_message_chunk and stream-json deltas', () => {
  const acpStream = [
    JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Part 1 ' } } } }),
    JSON.stringify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Part 2' } }),
  ].join('\n');
  assert.equal(extractPartialText('antigravity', acpStream), 'Part 1 Part 2');
});
