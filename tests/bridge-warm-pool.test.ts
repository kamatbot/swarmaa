import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { finalAnswer, providerSucceeded } from '../src/bridge/adapters.js';
import { parseBridgeConfig } from '../src/bridge/config.js';
import type { ProcessRequest, Task, ToolClient } from '../src/bridge/types.js';
import { WarmProviderPool } from '../src/bridge/warm-pool.js';
import { BridgeWorker } from '../src/bridge/worker.js';

const MOCK_WARM_ACP = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const mode = process.env.MOCK_ACP_MODE || 'normal';
let initCount = 0;
let sessionSeq = 0;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let activePromptId = null;

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    initCount++;
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'mock-agy', version: '1.0' } } });
    return;
  }
  if (msg.method === 'session/load') {
    if (msg.params.sessionId === 'missing-session') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32004, message: 'Session not found' } });
    } else {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId: msg.params.sessionId,
          configOptions: [
            { id: 'model', category: 'model', currentValue: 'gemini-3.8-pro', options: [{ value: 'gemini-3.8-pro', name: 'Gemini 3.8 Pro' }, { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] },
            { id: 'thought_level', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }
          ]
        }
      });
    }
    return;
  }
  if (msg.method === 'session/new') {
    sessionSeq++;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'warm-sess-' + process.pid + '-' + sessionSeq,
        configOptions: [
          { id: 'model', category: 'model', currentValue: 'gemini-3.8-pro', options: [{ value: 'gemini-3.8-pro', name: 'Gemini 3.8 Pro' }, { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] },
          { id: 'thought_level', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }
        ]
      }
    });
    return;
  }
  if (msg.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === 'session/cancel') {
    process.stderr.write('CANCEL:' + msg.params.sessionId + '\\n');
    if (mode === 'cancel_clean' && activePromptId !== null) {
      const id = activePromptId;
      activePromptId = null;
      send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
    }
    return;
  }
  if (msg.method === 'session/prompt') {
    const promptText = (msg.params.prompt && msg.params.prompt[0] && msg.params.prompt[0].text) || '';
    if (promptText.includes('TRIGGER_CRASH')) {
      process.exit(2);
    }
    if (promptText.includes('TRIGGER_HANG')) {
      activePromptId = msg.id;
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working...' } } } });
      return;
    }
    const text = 'pid=' + process.pid + ' init=' + initCount + ' sess=' + msg.params.sessionId + ' prompt=' + promptText;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } } });
  }
});
`;

const MOCK_WARM_CLAUDE = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let turn = 0;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const text = (msg.message && msg.message.content && msg.message.content[0] && msg.message.content[0].text) || '';
  turn++;
  if (text.includes('TRIGGER_ERROR_RESULT')) {
    send({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'boom' });
    return;
  }
  if (text.includes('TRIGGER_CRASH')) {
    process.exit(1);
  }
  if (text.includes('TRIGGER_HANG')) {
    send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hanging' } } });
    return;
  }
  if (text.includes('TRIGGER_STEER_WAIT')) {
    send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first ' } } });
    send({ type: 'result', subtype: 'success', is_error: false, result: 'first pid=' + process.pid });
    return;
  }
  const reply = 'pid=' + process.pid + ' turn=' + turn + ' text=' + text;
  send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } } });
  send({ type: 'result', subtype: 'success', is_error: false, result: reply, model: 'claude-haiku-5-5' });
});
`;

function withMockScripts(fn: (scripts: { acp: string; claude: string; dir: string }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'warm-pool-test-'));
  const acp = join(dir, 'mock-acp.cjs');
  const claude = join(dir, 'mock-claude.cjs');
  writeFileSync(acp, MOCK_WARM_ACP);
  writeFileSync(claude, MOCK_WARM_CLAUDE);
  chmodSync(acp, 0o755);
  chmodSync(claude, 0o755);
  return fn({ acp, claude, dir }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function makeAcpReq(scriptPath: string, prompt: string, extra: Partial<ProcessRequest> & { resume?: string; patch?: boolean; mode?: string } = {}): ProcessRequest {
  return {
    command: process.execPath,
    args: [scriptPath],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, ...(extra.mode ? { MOCK_ACP_MODE: extra.mode } : {}) },
    input: '',
    acp: {
      cwd: process.cwd(),
      prompt,
      model: 'gemini-3.8-pro',
      effort: 'high',
      patch: Boolean(extra.patch),
      dangerously_skip_permissions: Boolean(extra.patch),
      ...(extra.resume ? { resume_session_id: extra.resume } : {}),
    },
    timeout_ms: 5000,
    max_output_bytes: 1 << 20,
    ...extra,
  };
}

function makeClaudeReq(scriptPath: string, text: string, extra: Partial<ProcessRequest> = {}): ProcessRequest {
  return {
    command: process.execPath,
    args: [scriptPath],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    input: JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n',
    keep_stdin_open: true,
    timeout_ms: 5000,
    max_output_bytes: 1 << 20,
    ...extra,
  };
}

const parsePid = (answer: string): number => Number(/pid=(\d+)/.exec(answer)![1]);

test('WarmProviderPool (ACP): reuses 1 process initialized once, captures live configOptions, respects resume/patch/maxTurns/TTL/cancel/closeAll', async () => {
  await withMockScripts(async ({ acp }) => {
    const pool = new WarmProviderPool({ acpIdleTtlMs: 60_000, acpMaxTurns: 3, acpCancelGraceMs: 120 });
    try {
      // Turn 1: spawns & initializes once, captures live configOptions
      const r1 = await pool.runAcp(makeAcpReq(acp, 'turn-1'), { projectRoot: '/proj/a', patch: false });
      assert.equal(providerSucceeded('antigravity', r1), true);
      const a1 = finalAnswer('antigravity', r1.stdout);
      const pid1 = parsePid(a1);
      assert.match(a1, /init=1/);
      assert.equal(pool.stats().acp.total, 1);
      assert.equal(pool.stats().acp.idle, 1);

      // Live model catalog was captured from configOptions
      const models = pool.getCachedModels('antigravity');
      assert.ok(models && models.length === 2);
      assert.deepEqual(models[0], { id: 'gemini-3.8-pro', label: 'Gemini 3.8 Pro', efforts: ['low', 'medium', 'high'], default: true });
      assert.deepEqual(models[1], { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], fast: true });

      // Turn 2 with session/load: SAME PID, init STILL 1!
      const r2 = await pool.runAcp(makeAcpReq(acp, 'turn-2', { resume: 'resumed-42' }), { projectRoot: '/proj/a', patch: false });
      const a2 = finalAnswer('antigravity', r2.stdout);
      assert.equal(parsePid(a2), pid1, 'reused same warm ACP process');
      assert.match(a2, /init=1/, 'initialize ran only once');
      assert.match(a2, /sess=resumed-42/, 'resumed session via session/load');

      // Patch task NEVER shares the warm read-only process
      const rPatch = await pool.runAcp(makeAcpReq(acp, 'patch-1', { patch: true }), { projectRoot: '/proj/a', patch: true });
      assert.notEqual(parsePid(finalAnswer('antigravity', rPatch.stdout)), pid1, 'patch never shares warm read-only ACP process');

      // Turn 3 hits acpMaxTurns=3 -> completes on pid1, then disposes pid1
      const r3 = await pool.runAcp(makeAcpReq(acp, 'turn-3'), { projectRoot: '/proj/a', patch: false });
      assert.equal(parsePid(finalAnswer('antigravity', r3.stdout)), pid1);
      assert.equal(pool.stats().acp.total, 0, 'disposed after reaching acpMaxTurns');

      // Turn 4 spawns a fresh process
      const r4 = await pool.runAcp(makeAcpReq(acp, 'turn-4'), { projectRoot: '/proj/a', patch: false });
      const pid2 = parsePid(finalAnswer('antigravity', r4.stdout));
      assert.notEqual(pid2, pid1);

      // Abort when cancel does NOT settle quickly -> sends session/cancel and recycles process
      const abort = new AbortController();
      const rHang = await pool.runAcp(
        makeAcpReq(acp, 'TRIGGER_HANG', { signal: abort.signal }),
        { projectRoot: '/proj/a', patch: false },
        { onPartialText: () => abort.abort() }
      );
      assert.equal(rHang.stop_reason, 'aborted');
      assert.match(rHang.stderr, /CANCEL:/);
      assert.equal(pool.stats().acp.total, 0, 'recycled hung ACP process after cancel grace');

      // Crash automatically disposes
      const rCrash = await pool.runAcp(makeAcpReq(acp, 'TRIGGER_CRASH'), { projectRoot: '/proj/a', patch: false });
      assert.equal(providerSucceeded('antigravity', rCrash), false);
      assert.equal(pool.stats().acp.total, 0);

      // Spawn one more and verify closeAll kills it cleanly (no orphan child)
      const rLive = await pool.runAcp(makeAcpReq(acp, 'alive'), { projectRoot: '/proj/a', patch: false });
      const livePid = parsePid(finalAnswer('antigravity', rLive.stdout));
      assert.equal(isPidAlive(livePid), true);
      pool.closeAll();
      await new Promise(r => setTimeout(r, 40));
      assert.equal(pool.stats().acp.total, 0);
      assert.equal(isPidAlive(livePid), false, 'closeAll must leave zero orphan ACP processes');
    } finally {
      pool.closeAll();
    }
  });
});

test('WarmProviderPool (ACP): idle TTL disposes unused warm process automatically', async () => {
  await withMockScripts(async ({ acp }) => {
    const pool = new WarmProviderPool({ acpIdleTtlMs: 80 });
    try {
      const r1 = await pool.runAcp(makeAcpReq(acp, 'ttl-check'), { projectRoot: '/proj/ttl', patch: false });
      const pid = parsePid(finalAnswer('antigravity', r1.stdout));
      assert.equal(pool.stats().acp.idle, 1);
      await new Promise(r => setTimeout(r, 150));
      assert.equal(pool.stats().acp.total, 0);
      assert.equal(isPidAlive(pid), false);
    } finally {
      pool.closeAll();
    }
  });
});

test('WarmProviderPool (Claude): one turn per process with a prewarmed spare, keys by (projectRoot, model, effort, lightChat), enforces LRU cap, recycles on error/abort', async () => {
  await withMockScripts(async ({ claude }) => {
    const pool = new WarmProviderPool({ claudeIdleTtlMs: 60_000, claudeMaxProcesses: 2 });
    try {
      // Turn 2 with the same key runs in the spare started after turn 1: a fresh conversation, never turn 1's
      const r1 = await pool.runClaude(makeClaudeReq(claude, 'hello-1'), { projectRoot: '/proj/a', model: 'haiku', effort: 'low', lightChat: true, patch: false });
      assert.equal(providerSucceeded('claude', r1), true);
      const pidA = parsePid(finalAnswer('claude', r1.stdout));
      assert.match(finalAnswer('claude', r1.stdout), /turn=1/);

      const r2 = await pool.runClaude(makeClaudeReq(claude, 'hello-2'), { projectRoot: '/proj/a', model: 'haiku', effort: 'low', lightChat: true, patch: false });
      assert.equal(providerSucceeded('claude', r2), true);
      assert.notEqual(parsePid(finalAnswer('claude', r2.stdout)), pidA, 'turn 2 never joins turn 1\'s Claude conversation');
      assert.match(finalAnswer('claude', r2.stdout), /turn=1/, 'turn 2 starts a fresh conversation');

      // Different lightChat/model/effort key gets its own warm process
      const rB = await pool.runClaude(makeClaudeReq(claude, 'full-1'), { projectRoot: '/proj/a', model: 'opus', effort: 'high', lightChat: false, patch: false });
      const pidB = parsePid(finalAnswer('claude', rB.stdout));
      assert.notEqual(pidB, pidA);
      assert.equal(pool.stats().claude.total, 2);

      // Third distinct key exceeds claudeMaxProcesses=2 -> evicts oldest idle process (pidA)
      await new Promise(r => setTimeout(r, 15));
      const rC = await pool.runClaude(makeClaudeReq(claude, 'proj-b'), { projectRoot: '/proj/b', model: 'haiku', effort: 'low', lightChat: true, patch: false });
      const pidC = parsePid(finalAnswer('claude', rC.stdout));
      assert.equal(pool.stats().claude.total, 2, 'enforces claudeMaxProcesses cap via LRU eviction');
      await new Promise(r => setTimeout(r, 30));
      assert.equal(isPidAlive(pidA), false, 'evicted oldest idle Claude process');

      // Patch mode NEVER shares warm pool (calls fallback directly)
      let fallbackCalled = false;
      await pool.runClaude(makeClaudeReq(claude, 'patch'), { projectRoot: '/proj/b', model: 'haiku', effort: 'low', lightChat: false, patch: true }, async () => {
        fallbackCalled = true;
        return { exit_code: 0, signal: null, stdout: '{"type":"result","subtype":"success","result":"patched"}', stderr: '', duration_ms: 1, stop_reason: null };
      });
      assert.equal(fallbackCalled, true, 'patch worktrees never share warm Claude processes');

      // Error result recycles warm process immediately
      const rErr = await pool.runClaude(makeClaudeReq(claude, 'TRIGGER_ERROR_RESULT'), { projectRoot: '/proj/b', model: 'haiku', effort: 'low', lightChat: true, patch: false });
      assert.equal(providerSucceeded('claude', rErr), false);
      await new Promise(r => setTimeout(r, 30));
      assert.equal(isPidAlive(pidC), false, 'error result immediately recycles warm Claude process');

      // Abort recycles warm process immediately
      const abort = new AbortController();
      const rAbort = await pool.runClaude(
        makeClaudeReq(claude, 'TRIGGER_HANG', {
          signal: abort.signal,
          on_progress: () => abort.abort(),
        }),
        { projectRoot: '/proj/a', model: 'opus', effort: 'high', lightChat: false, patch: false }
      );
      assert.equal(rAbort.stop_reason, 'aborted');
      await new Promise(r => setTimeout(r, 30));
      assert.equal(isPidAlive(pidB), false, 'abort immediately recycles warm Claude process');
      assert.equal(pool.stats().claude.busy, 0, 'only idle spares remain; an aborted turn starts no spare');

      // Steered turn: on_stdin.write keeps turn open until caller calls on_stdin.end(), then returns warm process to pool
      let stdinCtl: { write: (t: string) => boolean; end: () => void } | undefined;
      let resultCount = 0;
      const rSteer = await pool.runClaude(
        makeClaudeReq(claude, 'TRIGGER_STEER_WAIT', {
          on_stdin: ctl => {
            stdinCtl = ctl;
            ctl.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'steered-followup' }] } }) + '\n');
          },
          on_line: head => {
            if (head.includes('"type":"result"')) {
              resultCount++;
              if (resultCount === 2) stdinCtl?.end();
            }
          },
        }),
        { projectRoot: '/proj/steer', model: 'haiku', effort: 'low', lightChat: true, patch: false }
      );
      assert.equal(providerSucceeded('claude', rSteer), true);
      assert.match(finalAnswer('claude', rSteer.stdout), /first pid=\d+\n\npid=\d+ turn=2 text=steered-followup/);
      assert.equal(pool.stats().claude.busy, 0, 'the steered turn finished');
      assert.ok(pool.stats().claude.idle >= 1, 'a fresh spare is ready after a steered turn');

      pool.closeAll();
      assert.equal(pool.stats().claude.total, 0);
    } finally {
      pool.closeAll();
    }
  });
});

test('BridgeWorker wires WarmProviderPool end-to-end: reuses ACP process, persists native_session, reports live models, and closes on drain', { skip: process.platform !== 'darwin' }, async () => {
  await withMockScripts(async ({ acp }) => {
    const cfg = parseBridgeConfig({
      service_url: 'http://127.0.0.1:8080',
      usage_seconds: 60,
      agents: [{ id: 'antigravity', provider: 'antigravity', binary: acp, model: 'gemini-3.8-pro', turn_model: 'gemini-3.8-flash', sandbox: true }],
      projects: [{ scope: 'project:demo', root: process.cwd(), agents: ['antigravity'] }],
    });
    // Use warmPool directly via streamOptions; note sandbox-exec runs our mock node script inside Seatbelt.
    const pool = new WarmProviderPool({ acpIdleTtlMs: 60_000 });
    const finishes: Array<Record<string, unknown>> = [];
    let usageArgs: Record<string, unknown> | undefined;
    let claimCount = 0;
    let savedSessionId: string | undefined;

    const client: ToolClient = {
      async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
        if (name === 'task_claim') {
          claimCount++;
          const task: Task = {
            id: `11111111-1111-4111-8111-11111111111${claimCount}`,
            scope: 'project:demo',
            kind: 'turn',
            objective: `Turn ${claimCount}`,
            constraints: [],
            acceptance_criteria: [],
            resource_key: null,
            required_capability: 'antigravity.read',
            checkpoint: null,
            context_refs: [],
            ...(savedSessionId ? { native_session_id: savedSessionId } : {}),
            version: 1,
          };
          return { task, lease_token: `lease-${claimCount}`, lease_generation: 1 } as T;
        }
        if (name === 'task_finish') {
          finishes.push(args);
          const ns = (args.result as Record<string, any>)?.native_session;
          if (ns?.id) savedSessionId = ns.id;
          return {} as T;
        }
        if (name === 'usage_report') {
          usageArgs = args;
          return {} as T;
        }
        if (name === 'session_list') return { sessions: [] } as T;
        return {} as T;
      },
    };

    const worker = new BridgeWorker(cfg, client, () => {}, undefined, async () => [
      { provider: 'antigravity', ok: false, windows: [], fetched_at: new Date().toISOString(), error: 'n/a' },
    ], { warmPool: pool });

    try {
      await worker.claimAndRun(cfg.projects, new AbortController().signal);
      await worker.claimAndRun(cfg.projects, new AbortController().signal);
      assert.equal(finishes.length, 2);
      const ans1 = String((finishes[0]!.result as Record<string, unknown>).answer);
      const ans2 = String((finishes[1]!.result as Record<string, unknown>).answer);
      const pid1 = parsePid(ans1);
      const pid2 = parsePid(ans2);
      assert.equal(pid1, pid2, 'BridgeWorker reused warm ACP process across turns');
      assert.match(ans2, /init=1/);
      assert.ok(savedSessionId && ans2.includes(`sess=${savedSessionId}`), 'turn 2 resumed ACP session from task.native_session_id');

      // Live ACP models reported via usage_report
      await worker.reportUsage(new AbortController().signal);
      const reports = usageArgs?.reports as Array<Record<string, unknown>>;
      assert.equal(reports.length, 1);
      assert.equal(reports[0]!.default_model, 'gemini-3.8-pro');
      assert.equal(reports[0]!.turn_model, 'gemini-3.8-flash');
      assert.equal((reports[0]!.models as Array<{ id: string }>).length, 2);

      // Drain immediately tears down idle warm process
      worker.drain();
      await new Promise(r => setTimeout(r, 40));
      assert.equal(pool.stats().acp.total, 0);
      assert.equal(isPidAlive(pid1), false);
    } finally {
      worker.close();
    }
  });
});
