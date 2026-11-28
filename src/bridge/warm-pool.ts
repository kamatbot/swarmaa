import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { redactSecrets } from '../safety/redact.js';
import {
  asObj,
  extractAcpModelCatalog,
  extractModelFromObj,
  extractTextContent,
  extractUsageFromObj,
  formatAcpToolLabel,
  isReadOnlyAcpToolAllowed,
  mapToolState,
  runAcpSession,
  splitAgyModel,
  type AcpActivityItem,
  type AcpCallbacks,
  type AcpUsage,
  type JsonRpcMessage,
} from './acp.js';
import { runBoundedProcess, slideTail } from './process.js';
import type {
  BridgeLogger,
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
  Provider,
  ProviderModelInfo,
} from './types.js';

const LINE_HEAD = 2048;

export interface WarmPoolOptions {
  acpIdleTtlMs?: number;
  acpMaxTurns?: number;
  acpCancelGraceMs?: number;
  claudeIdleTtlMs?: number;
  claudeMaxTurns?: number;
  claudeMaxProcesses?: number;
  logger?: BridgeLogger;
  onModelsUpdated?: (provider: Provider, models: ProviderModelInfo[]) => void;
}

export interface WarmAcpMeta {
  projectRoot: string;
  patch: boolean;
}

export interface WarmClaudeMeta {
  projectRoot: string;
  model?: string;
  effort?: string;
  lightChat: boolean;
  patch: boolean;
}

function hashEnv(env: NodeJS.ProcessEnv): string {
  const hash = createHash('sha256');
  const keys = Object.keys(env).sort();
  for (const key of keys) {
    const val = env[key];
    if (val === undefined) continue;
    hash.update(key);
    hash.update('=');
    hash.update(val);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch { /* already exited */ }
}

function isClaudeResultLine(line: string): { isResult: boolean; ok: boolean } {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"result"')) {
    return { isResult: false, ok: false };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.type === 'result') {
      return { isResult: true, ok: parsed.subtype === 'success' && parsed.is_error !== true };
    }
  } catch { /* non-JSON or partial */ }
  return { isResult: false, ok: false };
}

interface ActiveAcpTurn {
  started: number;
  maxOutputBytes: number;
  totalBytes: number;
  stdoutBytes: number;
  stderrChunks: Buffer[];
  sessionId?: string;
  servedModel?: string;
  usage?: AcpUsage;
  fullText: string;
  promptStopReason?: string;
  protocolError?: string;
  deniedActions: string[];
  activityMap: Map<string, AcpActivityItem>;
  fallbackToolCounter: number;
  stopReason: ProcessResult['stop_reason'];
  callbacks?: AcpCallbacks;
  onProgress?: ProcessRequest['on_progress'];
  onOutputLimit: () => void;
}

class WarmAcpSlot {
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private nextId = 1;
  private initialized = false;
  private initModel?: string;
  private readonly pending = new Map<number, { resolve: (res: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  private activeTurn?: ActiveAcpTurn;
  private idleTimer?: ReturnType<typeof setTimeout>;
  inUse = false;
  disposed = false;
  childClosed = false;
  childExitCode: number | null = null;
  childSignal: NodeJS.Signals | null = null;
  spawnError = false;
  turnsCompleted = 0;

  constructor(
    readonly key: string,
    request: ProcessRequest,
    private readonly idleTtlMs: number,
    private readonly maxTurns: number,
    private readonly cancelGraceMs: number,
    private readonly onModels: (models: ProviderModelInfo[]) => void,
    private readonly onDispose: (slot: WarmAcpSlot) => void,
    private readonly isDraining: () => boolean
  ) {
    this.child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child.stdout.on('data', (chunk: Buffer) => {
      const turn = this.activeTurn;
      if (turn) {
        turn.totalBytes += chunk.byteLength;
        turn.stdoutBytes += chunk.byteLength;
        if (turn.totalBytes > turn.maxOutputBytes) {
          turn.onOutputLimit();
          return;
        }
      }
      this.stdoutBuffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = this.stdoutBuffer.indexOf('\n')) !== -1) {
        const line = this.stdoutBuffer.slice(0, nl);
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
        this.handleMessage(line);
      }
    });

    this.child.stderr.on('data', (chunk: Buffer) => {
      const turn = this.activeTurn;
      if (!turn) return;
      const available = Math.max(0, turn.maxOutputBytes - turn.totalBytes);
      if (available > 0) turn.stderrChunks.push(chunk.subarray(0, available));
      turn.totalBytes += chunk.byteLength;
      if (turn.totalBytes > turn.maxOutputBytes) turn.onOutputLimit();
    });

    this.child.stdin.on('error', () => { /* handled on close */ });

    this.child.once('error', () => {
      this.spawnError = true;
      this.rejectAllPending('Failed to spawn ACP process');
      this.dispose();
    });

    this.child.once('close', (code, sig) => {
      this.childClosed = true;
      this.childExitCode = code;
      this.childSignal = sig;
      if (this.stdoutBuffer.trim()) {
        this.handleMessage(this.stdoutBuffer);
        this.stdoutBuffer = '';
      }
      this.rejectAllPending(`ACP server exited unexpectedly (code=${code ?? 'null'})`);
      this.dispose();
    });
  }

  private writeJson(msg: Record<string, unknown>): boolean {
    if (this.disposed || this.childClosed || this.child.stdin.destroyed || this.child.stdin.writableEnded) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(msg)}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  private sendRpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((res, rej) => {
      if (this.disposed || this.childClosed) {
        rej(new Error(`ACP process closed before ${method}`));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve: res, reject: rej });
      if (!this.writeJson({ jsonrpc: '2.0', id, method, params })) {
        this.pending.delete(id);
        rej(new Error(`Failed to write ACP request ${method}`));
      }
    });
  }

  private rejectAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.reject(new Error(reason));
    }
  }

  private handleServerRequest(msg: JsonRpcMessage): void {
    const id = msg.id!;
    if (msg.method === 'session/request_permission') {
      const params = asObj(msg.params) ?? {};
      const options = Array.isArray(params.options)
        ? params.options.map(asObj).filter((x): x is Record<string, unknown> => Boolean(x))
        : [];
      const toolCall = asObj(params.toolCall);
      const toolLabel = String(toolCall?.title ?? toolCall?.kind ?? toolCall?.toolName ?? params.title ?? 'permission');
      // Warm ACP processes are strictly read-only (`patch: false`).
      const allow = isReadOnlyAcpToolAllowed(toolCall, false, false);
      if (allow) {
        const picked = options.find(o => typeof o.kind === 'string' && o.kind.startsWith('allow')) ?? options[0];
        const optionId = typeof picked?.optionId === 'string' ? picked.optionId : undefined;
        this.writeJson({
          jsonrpc: '2.0',
          id,
          result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } },
        });
      } else {
        const turn = this.activeTurn;
        if (turn && turn.deniedActions.length < 10) {
          turn.deniedActions.push(redactSecrets(toolLabel).slice(0, 120));
        }
        const rejectOpt = options.find(o => typeof o.kind === 'string' && o.kind.startsWith('reject'));
        const optionId = typeof rejectOpt?.optionId === 'string' ? rejectOpt.optionId : undefined;
        this.writeJson({
          jsonrpc: '2.0',
          id,
          result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } },
        });
      }
      return;
    }
    this.writeJson({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported client method: ${msg.method}` } });
  }

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const turn = this.activeTurn;
    if (!turn) return;
    const update = asObj(params.update) ?? params;
    const kind = String(update.sessionUpdate ?? update.type ?? '');

    const foundModel = extractModelFromObj(update) ?? extractModelFromObj(params);
    if (foundModel) turn.servedModel = foundModel;
    const foundUsage = extractUsageFromObj(update) ?? extractUsageFromObj(params);
    if (foundUsage) turn.usage = foundUsage;

    if (kind === 'agent_message_chunk') {
      const chunkText = extractTextContent(update.content ?? update.text ?? update.delta);
      if (chunkText) {
        turn.fullText += chunkText;
        turn.callbacks?.onPartialText?.(turn.fullText);
        turn.onProgress?.({
          output_bytes: turn.totalBytes,
          stdout_bytes: turn.stdoutBytes,
          stdout_tail: turn.fullText.slice(-8192),
        });
      }
      return;
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const rawId = update.toolCallId ?? update.id ?? update.callId;
      const id = typeof rawId === 'string' || typeof rawId === 'number'
        ? String(rawId)
        : `acp_tool_${++turn.fallbackToolCounter}`;
      const existing = turn.activityMap.get(id);
      const tool = String(update.kind ?? update.toolName ?? update.name ?? existing?.tool ?? 'tool');
      const title = typeof update.title === 'string' ? update.title : '';
      const rawInput = asObj(update.rawInput) ?? asObj(update.input);
      const label = formatAcpToolLabel(tool, title, rawInput);
      const state = update.status !== undefined ? mapToolState(update.status) : (existing?.state ?? 'running');
      const item: AcpActivityItem = {
        id,
        tool,
        label: title || rawInput || !existing ? label : existing.label,
        state,
      };
      turn.activityMap.set(id, item);
      while (turn.activityMap.size > 20) turn.activityMap.delete(turn.activityMap.keys().next().value!);
      turn.callbacks?.onActivity?.(item);
    }
  }

  private handleMessage(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) return;
    let msg: JsonRpcMessage;
    try { msg = JSON.parse(trimmed) as JsonRpcMessage; } catch { return; }

    if (msg.id !== undefined && msg.method !== undefined) {
      this.handleServerRequest(msg);
      return;
    }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const key = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const entry = this.pending.get(key);
      if (!entry) return;
      this.pending.delete(key);
      if (msg.error) {
        entry.reject(Object.assign(new Error(msg.error.message ?? `ACP RPC error ${msg.error.code ?? ''}`), { rpcCode: msg.error.code }));
      } else {
        entry.resolve(asObj(msg.result) ?? {});
      }
      return;
    }

    if (msg.method === 'session/update' && msg.params) {
      this.handleSessionUpdate(msg.params);
    }
  }

  clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.disposed || this.childClosed || this.isDraining()) return;
    this.idleTimer = setTimeout(() => {
      if (!this.inUse) this.dispose();
    }, this.idleTtlMs);
    this.idleTimer.unref?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleTimer();
    this.rejectAllPending('ACP warm process disposed');
    this.onDispose(this);
    signalProcessGroup(this.child, 'SIGKILL');
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }

  private buildResult(turn: ActiveAcpTurn, succeeded: boolean): ProcessResult {
    const activity = [...turn.activityMap.values()].slice(-20);
    const stderrText = Buffer.concat(turn.stderrChunks).toString('utf8');
    const stopReason = this.spawnError ? 'spawn_error' : turn.stopReason;
    const payload: Record<string, unknown> = {
      protocol: 'acp',
      status: succeeded ? 'SUCCESS' : 'ERROR',
      response: turn.fullText,
      ...(turn.sessionId ? { session_id: turn.sessionId } : {}),
      ...(turn.servedModel ? { model: turn.servedModel } : {}),
      ...(turn.usage ? { usage: turn.usage } : {}),
      ...(turn.promptStopReason ? { stop_reason: turn.promptStopReason } : {}),
      ...(turn.deniedActions.length ? { denied_actions: turn.deniedActions.slice(0, 10).map(name => ({ display_name: name, action: name })) } : {}),
      ...(activity.length ? { activity } : {}),
      ...(!succeeded && turn.protocolError ? { error: turn.protocolError } : {}),
    };
    return {
      exit_code: stopReason ? this.childExitCode : (succeeded ? 0 : (this.childExitCode && this.childExitCode !== 0 ? this.childExitCode : 1)),
      signal: this.childSignal,
      stdout: stopReason === 'spawn_error' ? '' : JSON.stringify(payload),
      stderr: stderrText,
      duration_ms: Date.now() - turn.started,
      stop_reason: stopReason,
    };
  }

  async runTurn(request: ProcessRequest, callbacks?: AcpCallbacks): Promise<{ result: ProcessResult; failedBeforePrompt: boolean }> {
    const acp = request.acp!;
    if (request.signal?.aborted) {
      return {
        result: { exit_code: null, signal: null, stdout: '', stderr: '', duration_ms: 0, stop_reason: 'aborted' },
        failedBeforePrompt: false,
      };
    }

    this.clearIdleTimer();
    this.inUse = true;

    let cancelTriggered = false;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    let promptSettled = false;
    let promptStarted = false;
    let rejectOnStop: ((err: Error) => void) | undefined;

    const turn: ActiveAcpTurn = {
      started: Date.now(),
      maxOutputBytes: request.max_output_bytes,
      totalBytes: 0,
      stdoutBytes: 0,
      stderrChunks: [],
      servedModel: this.initModel,
      fullText: '',
      deniedActions: [],
      activityMap: new Map(),
      fallbackToolCounter: 0,
      stopReason: null,
      callbacks,
      onProgress: request.on_progress,
      onOutputLimit: () => stopTurn('output_limit'),
    };
    this.activeTurn = turn;

    const stopTurn = (reason: NonNullable<ProcessResult['stop_reason']>): void => {
      if (turn.stopReason) return;
      turn.stopReason = reason;
      if (reason === 'output_limit') {
        this.dispose();
        rejectOnStop?.(new Error('ACP output limit exceeded'));
        return;
      }
      if ((reason === 'aborted' || reason === 'timeout') && turn.sessionId && !this.disposed && !this.childClosed) {
        cancelTriggered = true;
        this.writeJson({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: turn.sessionId } });
        // Give the warm ACP server a brief grace period to settle session/cancel cleanly;
        // if it does not settle quickly, recycle the process immediately.
        cancelTimer = setTimeout(() => {
          if (!promptSettled) {
            this.dispose();
            rejectOnStop?.(new Error(`ACP cancel did not settle (${reason})`));
          }
        }, this.cancelGraceMs);
      } else {
        this.dispose();
        rejectOnStop?.(new Error(`ACP stopped: ${reason}`));
      }
    };

    const onAbort = (): void => stopTurn('aborted');
    const timeout = setTimeout(() => stopTurn('timeout'), request.timeout_ms);
    request.signal?.addEventListener('abort', onAbort, { once: true });

    let succeeded = false;
    let recycleProcess = false;

    try {
      if (request.signal?.aborted) {
        stopTurn('aborted');
        throw new Error('ACP turn aborted');
      }

      const raceStop = <T>(p: Promise<T>): Promise<T> => new Promise<T>((res, rej) => {
        rejectOnStop = rej;
        p.then(
          v => { rejectOnStop = undefined; res(v); },
          e => { rejectOnStop = undefined; rej(e); }
        );
      });

      if (!this.initialized) {
        const initRes = await raceStop(this.sendRpc('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'swarmaa-bridge', version: '1.0.0' },
        }));
        const initModel = extractModelFromObj(initRes);
        if (initModel) {
          this.initModel = initModel;
          turn.servedModel = initModel;
        }
        this.initialized = true;
      }

      let sessionRes: Record<string, unknown> | undefined;
      if (acp.resume_session_id) {
        try {
          sessionRes = await raceStop(this.sendRpc('session/load', {
            sessionId: acp.resume_session_id,
            cwd: acp.cwd,
            mcpServers: [],
          }));
          turn.sessionId = typeof sessionRes.sessionId === 'string' ? sessionRes.sessionId : acp.resume_session_id;
        } catch (err) {
          if (this.disposed || this.childClosed || turn.stopReason) throw err;
          sessionRes = undefined;
        }
      }
      if (!sessionRes) {
        sessionRes = await raceStop(this.sendRpc('session/new', {
          cwd: acp.cwd,
          mcpServers: [],
        }));
        turn.sessionId = typeof sessionRes.sessionId === 'string'
          ? sessionRes.sessionId
          : (typeof sessionRes.session_id === 'string' ? sessionRes.session_id : undefined);
      }
      if (!turn.sessionId) throw new Error('ACP session/new did not return a sessionId');

      const sessionModel = extractModelFromObj(sessionRes);
      if (sessionModel) turn.servedModel = sessionModel;
      const catalog = extractAcpModelCatalog(sessionRes);
      if (catalog?.length) {
        this.onModels(catalog);
        callbacks?.onModels?.(catalog);
      }

      const split = acp.model ? splitAgyModel(acp.model) : undefined;
      const level = acp.effort ?? split?.level;
      if (split) {
        try {
          await raceStop(this.sendRpc('session/set_config_option', { sessionId: turn.sessionId, configId: 'model', value: split.family }));
          turn.servedModel = acp.model;
        } catch (err) {
          if (this.disposed || this.childClosed || turn.stopReason) throw err;
        }
      }
      if (level) {
        try {
          await raceStop(this.sendRpc('session/set_config_option', { sessionId: turn.sessionId, configId: 'thought_level', value: level }));
        } catch (err) {
          if (this.disposed || this.childClosed || turn.stopReason) throw err;
        }
      }

      const promptBlocks: Array<Record<string, unknown>> = [{ type: 'text', text: acp.prompt }];
      for (const image of acp.images ?? []) {
        promptBlocks.push({ type: 'text', text: `Untrusted photo from message #${image.seq}:` });
        promptBlocks.push({ type: 'image', mimeType: image.mimeType ?? 'image/jpeg', data: image.data });
      }

      promptStarted = true;
      const promptRes = await raceStop(this.sendRpc('session/prompt', {
        sessionId: turn.sessionId,
        prompt: promptBlocks,
      }));
      promptSettled = true;

      const resModel = extractModelFromObj(promptRes);
      if (resModel) turn.servedModel = resModel;
      const resUsage = extractUsageFromObj(promptRes);
      if (resUsage) turn.usage = resUsage;
      if (typeof promptRes.stopReason === 'string') turn.promptStopReason = promptRes.stopReason;
      if (!turn.fullText) {
        const fallbackText = extractTextContent(promptRes.content ?? promptRes.response ?? promptRes.text);
        if (fallbackText) turn.fullText = fallbackText;
      }

      const ok = !turn.stopReason && turn.promptStopReason !== 'cancelled' && turn.fullText.trim() !== '';
      if (!ok && !turn.protocolError) {
        turn.protocolError = turn.deniedActions.length
          ? `Denied actions: ${turn.deniedActions.join(', ')}`
          : turn.promptStopReason === 'cancelled'
            ? 'ACP turn cancelled'
            : 'ACP session completed with empty response';
      }
      succeeded = ok;
      // Recycle if empty/error without clean prompt completion (denied actions still finished cleanly).
      if (!ok && !cancelTriggered && !turn.deniedActions.length) {
        recycleProcess = true;
      }
    } catch (err) {
      if (!turn.stopReason && !turn.protocolError) {
        turn.protocolError = err instanceof Error ? err.message : String(err);
      }
      recycleProcess = true;
    } finally {
      clearTimeout(timeout);
      if (cancelTimer) clearTimeout(cancelTimer);
      request.signal?.removeEventListener('abort', onAbort);
      const result = this.buildResult(turn, succeeded);
      this.activeTurn = undefined;
      this.turnsCompleted++;

      const canReuse =
        !recycleProcess &&
        !this.disposed &&
        !this.childClosed &&
        !this.isDraining() &&
        this.turnsCompleted < this.maxTurns &&
        (turn.stopReason === null || (cancelTriggered && promptSettled));

      if (canReuse) {
        this.inUse = false;
        this.armIdleTimer();
      } else {
        this.inUse = false;
        this.dispose();
      }
      return { result, failedBeforePrompt: !promptStarted && !succeeded && !turn.stopReason && !request.signal?.aborted };
    }
  }
}

interface ActiveClaudeTurn {
  started: number;
  maxOutputBytes: number;
  output: Buffer[];
  errors: Buffer[];
  stdoutTail: Uint8Array;
  bytes: number;
  stdoutBytes: number;
  lineHead: string;
  lineTail: Uint8Array;
  rawLineChunks: Buffer[];
  steered: boolean;
  sawResult: boolean;
  resultOk: boolean;
  callerEnded: boolean;
  stopReason: ProcessResult['stop_reason'];
  onProgress?: ProcessRequest['on_progress'];
  onLine?: ProcessRequest['on_line'];
  settle: (exitCode: number | null, signal: NodeJS.Signals | null, recycle: boolean) => void;
  stop: (reason: NonNullable<ProcessResult['stop_reason']>) => void;
}

class WarmClaudeSlot {
  private readonly child: ChildProcessWithoutNullStreams;
  private activeTurn?: ActiveClaudeTurn;
  private idleTimer?: ReturnType<typeof setTimeout>;
  inUse = false;
  disposed = false;
  childClosed = false;
  childExitCode: number | null = null;
  childSignal: NodeJS.Signals | null = null;
  spawnError = false;
  turnsCompleted = 0;
  lastUsedAt = Date.now();

  constructor(
    readonly key: string,
    request: ProcessRequest,
    private readonly idleTtlMs: number,
    private readonly maxTurns: number,
    private readonly onDispose: (slot: WarmClaudeSlot) => void,
    private readonly isDraining: () => boolean
  ) {
    this.child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child.stdout.on('data', (chunk: Buffer) => {
      const turn = this.activeTurn;
      if (!turn) return;
      this.collect(turn, turn.output, chunk, true);
      this.processLines(turn, chunk);
    });

    this.child.stderr.on('data', (chunk: Buffer) => {
      const turn = this.activeTurn;
      if (!turn) return;
      this.collect(turn, turn.errors, chunk, false);
    });

    this.child.stdin.on('error', () => { /* reflected on close */ });

    this.child.once('error', () => {
      this.spawnError = true;
      const turn = this.activeTurn;
      if (turn) {
        turn.stopReason = 'spawn_error';
        turn.settle(null, null, true);
      }
      this.dispose();
    });

    this.child.once('close', (code, sig) => {
      this.childClosed = true;
      this.childExitCode = code;
      this.childSignal = sig;
      const turn = this.activeTurn;
      if (turn) {
        // Flush any trailing line without newline before settling.
        if (turn.rawLineChunks.length) {
          const trailing = Buffer.concat(turn.rawLineChunks).toString('utf8');
          turn.rawLineChunks = [];
          const res = isClaudeResultLine(trailing);
          if (res.isResult) {
            turn.sawResult = true;
            turn.resultOk = res.ok;
          }
        }
        turn.settle(code, sig, true);
      }
      this.dispose();
    });
  }

  private collect(turn: ActiveClaudeTurn, destination: Buffer[], chunk: Buffer, isStdout: boolean): void {
    const available = Math.max(0, turn.maxOutputBytes - turn.bytes);
    const kept = available ? chunk.subarray(0, available) : Buffer.alloc(0);
    if (kept.length) destination.push(kept);
    if (isStdout) {
      if (kept.length) turn.stdoutTail = slideTail(turn.stdoutTail, kept);
      turn.stdoutBytes += chunk.byteLength;
    }
    turn.bytes += chunk.byteLength;
    turn.onProgress?.({
      output_bytes: turn.bytes,
      stdout_bytes: turn.stdoutBytes,
      stdout_tail: Buffer.from(turn.stdoutTail).toString('utf8'),
    });
    if (turn.bytes > turn.maxOutputBytes) turn.stop('output_limit');
  }

  private processLines(turn: ActiveClaudeTurn, chunk: Buffer): void {
    let start = 0;
    let newline: number;
    while ((newline = chunk.indexOf(10, start)) >= 0) {
      const piece = chunk.subarray(start, newline);
      if (turn.lineHead.length < LINE_HEAD) turn.lineHead += piece.subarray(0, LINE_HEAD).toString('utf8');
      turn.lineTail = slideTail(turn.lineTail, piece, LINE_HEAD);
      turn.rawLineChunks.push(piece);
      const head = turn.lineHead.slice(0, LINE_HEAD);
      const tail = Buffer.from(turn.lineTail).toString('utf8');
      const fullLine = Buffer.concat(turn.rawLineChunks).toString('utf8');
      turn.lineHead = '';
      turn.lineTail = Buffer.alloc(0);
      turn.rawLineChunks = [];
      start = newline + 1;

      const resultCheck = isClaudeResultLine(fullLine);
      if (resultCheck.isResult) {
        turn.sawResult = true;
        turn.resultOk = resultCheck.ok;
      }

      if (turn.onLine) {
        try { turn.onLine(head, tail); } catch { /* a caller bug must not kill the run */ }
      }

      if (resultCheck.isResult && (!turn.steered || turn.callerEnded)) {
        turn.settle(0, null, !resultCheck.ok);
        return;
      }
    }
    const rest = chunk.subarray(start);
    if (rest.length) {
      if (turn.lineHead.length < LINE_HEAD) turn.lineHead += rest.subarray(0, LINE_HEAD).toString('utf8');
      turn.lineTail = slideTail(turn.lineTail, rest, LINE_HEAD);
      turn.rawLineChunks.push(rest);
    }
  }

  clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.disposed || this.childClosed || this.isDraining()) return;
    this.idleTimer = setTimeout(() => {
      if (!this.inUse) this.dispose();
    }, this.idleTtlMs);
    this.idleTimer.unref?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleTimer();
    this.onDispose(this);
    signalProcessGroup(this.child, 'SIGKILL');
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }

  runTurn(request: ProcessRequest): Promise<{ result: ProcessResult; failedWithNoOutput: boolean }> {
    if (request.signal?.aborted) {
      return Promise.resolve({
        result: { exit_code: null, signal: null, stdout: '', stderr: '', duration_ms: 0, stop_reason: 'aborted' },
        failedWithNoOutput: false,
      });
    }

    this.clearIdleTimer();
    this.inUse = true;
    this.lastUsedAt = Date.now();

    return new Promise(resolve => {
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let finalTimer: ReturnType<typeof setTimeout> | undefined;

      const settle = (exitCode: number | null, signal: NodeJS.Signals | null, forceRecycle: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (finalTimer) clearTimeout(finalTimer);
        request.signal?.removeEventListener('abort', onAbort);
        this.activeTurn = undefined;
        this.turnsCompleted++;
        this.lastUsedAt = Date.now();

        const stdout = Buffer.concat(turn.output).toString('utf8');
        const stderr = Buffer.concat(turn.errors).toString('utf8');
        const stopReason = this.spawnError ? 'spawn_error' : turn.stopReason;
        const canReuse =
          !forceRecycle &&
          stopReason === null &&
          exitCode === 0 &&
          turn.resultOk &&
          !this.disposed &&
          !this.childClosed &&
          !this.isDraining() &&
          this.turnsCompleted < this.maxTurns;

        if (canReuse) {
          this.inUse = false;
          this.armIdleTimer();
        } else {
          this.inUse = false;
          this.dispose();
        }

        resolve({
          result: {
            exit_code: exitCode,
            signal,
            stdout,
            stderr,
            duration_ms: Date.now() - turn.started,
            stop_reason: stopReason,
          },
          failedWithNoOutput: stdout.length === 0 && stopReason === null && exitCode !== 0 && !request.signal?.aborted,
        });
      };

      const stop = (reason: NonNullable<ProcessResult['stop_reason']>): void => {
        if (turn.stopReason || settled) return;
        turn.stopReason = reason;
        signalProcessGroup(this.child, 'SIGTERM');
        killTimer = setTimeout(() => signalProcessGroup(this.child, 'SIGKILL'), 1500);
        finalTimer = setTimeout(() => settle(null, 'SIGKILL', true), 3000);
      };

      const turn: ActiveClaudeTurn = {
        started: Date.now(),
        maxOutputBytes: request.max_output_bytes,
        output: [],
        errors: [],
        stdoutTail: Buffer.alloc(0),
        bytes: 0,
        stdoutBytes: 0,
        lineHead: '',
        lineTail: Buffer.alloc(0),
        rawLineChunks: [],
        steered: false,
        sawResult: false,
        resultOk: false,
        callerEnded: false,
        stopReason: null,
        onProgress: request.on_progress,
        onLine: request.on_line,
        settle,
        stop,
      };
      this.activeTurn = turn;

      const onAbort = (): void => stop('aborted');
      const timeout = setTimeout(() => stop('timeout'), request.timeout_ms);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (request.signal?.aborted) {
        onAbort();
        return;
      }

      if (this.disposed || this.childClosed || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
        settle(this.childExitCode ?? 1, this.childSignal, true);
        return;
      }

      const payload = request.input.endsWith('\n') ? request.input : `${request.input}\n`;
      try {
        this.child.stdin.write(payload, 'utf8');
      } catch {
        settle(1, null, true);
        return;
      }

      const canWrite = (): boolean =>
        !settled && !this.disposed && !this.childClosed && !this.child.stdin.destroyed && !this.child.stdin.writableEnded;
      request.on_stdin?.({
        write: text => {
          if (!canWrite()) return false;
          turn.steered = true;
          try {
            this.child.stdin.write(text, 'utf8');
            return true;
          } catch {
            return false;
          }
        },
        end: () => {
          // Keep the warm process stdin open across turns; only settle a steered turn once its result arrived.
          turn.callerEnded = true;
          if (turn.sawResult && !settled) {
            settle(0, null, !turn.resultOk);
          }
        },
      });
    });
  }
}

/**
 * Warm resident provider process pool for read-only Antigravity ACP and Claude stream-json turns.
 * Eliminates repeated CLI startup & initialization latency while strictly isolating patch worktrees.
 */
export class WarmProviderPool {
  private readonly acpIdleTtlMs: number;
  private readonly acpMaxTurns: number;
  private readonly acpCancelGraceMs: number;
  private readonly claudeIdleTtlMs: number;
  private readonly claudeMaxTurns: number;
  private readonly claudeMaxProcesses: number;
  private readonly logger?: BridgeLogger;
  private readonly onModelsUpdated?: (provider: Provider, models: ProviderModelInfo[]) => void;

  private readonly acpSlots = new Map<string, WarmAcpSlot>();
  private readonly claudeSlots = new Map<string, WarmClaudeSlot[]>();
  private readonly cachedModels = new Map<Provider, { models: ProviderModelInfo[]; signature: string }>();
  private draining = false;

  constructor(options: WarmPoolOptions = {}) {
    this.acpIdleTtlMs = options.acpIdleTtlMs ?? 10 * 60 * 1000;
    this.acpMaxTurns = options.acpMaxTurns ?? 50;
    this.acpCancelGraceMs = options.acpCancelGraceMs ?? 500;
    this.claudeIdleTtlMs = options.claudeIdleTtlMs ?? 5 * 60 * 1000;
    this.claudeMaxTurns = options.claudeMaxTurns ?? 25;
    this.claudeMaxProcesses = options.claudeMaxProcesses ?? 4;
    this.logger = options.logger;
    this.onModelsUpdated = options.onModelsUpdated;
  }

  getCachedModels(provider: Provider): ProviderModelInfo[] | undefined {
    return this.cachedModels.get(provider)?.models;
  }

  setCachedModels(provider: Provider, models: ProviderModelInfo[]): boolean {
    if (!models.length) return false;
    const signature = JSON.stringify(models);
    const existing = this.cachedModels.get(provider);
    if (existing?.signature === signature) return false;
    this.cachedModels.set(provider, { models, signature });
    this.onModelsUpdated?.(provider, models);
    return true;
  }

  private acpKey(projectRoot: string, request: ProcessRequest): string {
    return `${projectRoot}\0${request.command}\0${JSON.stringify(request.args)}\0${hashEnv(request.env)}`;
  }

  private claudeKey(meta: WarmClaudeMeta, request: ProcessRequest): string {
    return `${meta.projectRoot}\0${meta.model ?? ''}\0${meta.effort ?? ''}\0${meta.lightChat ? '1' : '0'}\0${request.command}\0${JSON.stringify(request.args)}\0${hashEnv(request.env)}`;
  }

  private allClaudeSlots(): WarmClaudeSlot[] {
    const out: WarmClaudeSlot[] = [];
    for (const list of this.claudeSlots.values()) {
      for (const slot of list) {
        if (!slot.disposed) out.push(slot);
      }
    }
    return out;
  }

  private removeClaudeSlot(slot: WarmClaudeSlot): void {
    const list = this.claudeSlots.get(slot.key);
    if (!list) return;
    const idx = list.indexOf(slot);
    if (idx >= 0) list.splice(idx, 1);
    if (!list.length) this.claudeSlots.delete(slot.key);
  }

  private evictOldestIdleClaude(): boolean {
    let oldest: WarmClaudeSlot | undefined;
    for (const slot of this.allClaudeSlots()) {
      if (slot.inUse || slot.disposed) continue;
      if (!oldest || slot.lastUsedAt < oldest.lastUsedAt) oldest = slot;
    }
    if (!oldest) return false;
    oldest.dispose();
    return true;
  }

  async runAcp(request: ProcessRequest, meta: WarmAcpMeta, callbacks?: AcpCallbacks): Promise<ProcessResult> {
    const wrappedCallbacks: AcpCallbacks = {
      ...callbacks,
      onModels: models => {
        this.setCachedModels('antigravity', models);
        callbacks?.onModels?.(models);
      },
    };

    // Never share warm ACP processes with patch worktrees or when draining.
    if (meta.patch || request.acp?.patch || request.acp?.dangerously_skip_permissions || this.draining) {
      return runAcpSession(request, wrappedCallbacks);
    }

    const key = this.acpKey(meta.projectRoot, request);
    const existing = this.acpSlots.get(key);

    // Keep at most 1 warm resident ACP process per (projectRoot, patch: false).
    // If it is already serving another concurrent turn, run a one-shot session so turns never block each other.
    if (existing && existing.inUse && !existing.disposed && !existing.childClosed) {
      return runAcpSession(request, wrappedCallbacks);
    }

    let slot = existing && !existing.disposed && !existing.childClosed ? existing : undefined;
    const reused = Boolean(slot);
    if (!slot) {
      slot = new WarmAcpSlot(
        key,
        request,
        this.acpIdleTtlMs,
        this.acpMaxTurns,
        this.acpCancelGraceMs,
        models => this.setCachedModels('antigravity', models),
        s => { if (this.acpSlots.get(key) === s) this.acpSlots.delete(key); },
        () => this.draining
      );
      this.acpSlots.set(key, slot);
    }

    const first = await slot.runTurn(request, wrappedCallbacks);
    // If a reused idle warm process had died right before checkout, transparently respawn once.
    if (reused && first.failedBeforePrompt && !this.draining && !request.signal?.aborted) {
      this.logger?.('warm_acp_respawn', { project_root: meta.projectRoot });
      const fresh = new WarmAcpSlot(
        key,
        request,
        this.acpIdleTtlMs,
        this.acpMaxTurns,
        this.acpCancelGraceMs,
        models => this.setCachedModels('antigravity', models),
        s => { if (this.acpSlots.get(key) === s) this.acpSlots.delete(key); },
        () => this.draining
      );
      this.acpSlots.set(key, fresh);
      return (await fresh.runTurn(request, wrappedCallbacks)).result;
    }
    return first.result;
  }

  async runClaude(
    request: ProcessRequest,
    meta: WarmClaudeMeta,
    fallback: ProcessRunner = runBoundedProcess
  ): Promise<ProcessResult> {
    // Never share warm Claude processes with patch worktrees, non-stream-json requests, or during drain.
    if (meta.patch || !request.keep_stdin_open || this.draining) {
      return fallback(request);
    }

    const key = this.claudeKey(meta, request);
    const list = this.claudeSlots.get(key) ?? [];
    let slot = list.find(s => !s.inUse && !s.disposed && !s.childClosed);
    const reused = Boolean(slot);

    if (!slot) {
      while (this.allClaudeSlots().length >= this.claudeMaxProcesses) {
        if (!this.evictOldestIdleClaude()) {
          // All warm slots are currently busy; fall back to one-shot process without exceeding the cap.
          return fallback(request);
        }
      }
      slot = new WarmClaudeSlot(
        key,
        request,
        this.claudeIdleTtlMs,
        this.claudeMaxTurns,
        s => this.removeClaudeSlot(s),
        () => this.draining
      );
      const targetList = this.claudeSlots.get(key) ?? [];
      targetList.push(slot);
      this.claudeSlots.set(key, targetList);
    }

    const first = await slot.runTurn(request);
    if (reused && first.failedWithNoOutput && !this.draining && !request.signal?.aborted) {
      this.logger?.('warm_claude_respawn', { project_root: meta.projectRoot });
      while (this.allClaudeSlots().length >= this.claudeMaxProcesses) {
        if (!this.evictOldestIdleClaude()) return fallback(request);
      }
      const fresh = new WarmClaudeSlot(
        key,
        request,
        this.claudeIdleTtlMs,
        this.claudeMaxTurns,
        s => this.removeClaudeSlot(s),
        () => this.draining
      );
      const targetList = this.claudeSlots.get(key) ?? [];
      targetList.push(fresh);
      this.claudeSlots.set(key, targetList);
      return (await fresh.runTurn(request)).result;
    }
    return first.result;
  }

  /** Stop keeping idle warm processes alive; active turns dispose their process upon completion. */
  drain(): void {
    this.draining = true;
    for (const slot of [...this.acpSlots.values()]) {
      if (!slot.inUse) slot.dispose();
    }
    for (const slot of [...this.allClaudeSlots()]) {
      if (!slot.inUse) slot.dispose();
    }
  }

  /** Immediately terminate and dispose all warm processes so no orphan children leak. */
  closeAll(): void {
    this.draining = true;
    for (const slot of [...this.acpSlots.values()]) {
      slot.dispose();
    }
    this.acpSlots.clear();
    for (const slot of [...this.allClaudeSlots()]) {
      slot.dispose();
    }
    this.claudeSlots.clear();
  }

  stats(): {
    acp: { total: number; idle: number; busy: number };
    claude: { total: number; idle: number; busy: number };
  } {
    const acp = [...this.acpSlots.values()].filter(s => !s.disposed);
    const claude = this.allClaudeSlots();
    const acpBusy = acp.filter(s => s.inUse).length;
    const claudeBusy = claude.filter(s => s.inUse).length;
    return {
      acp: { total: acp.length, idle: acp.length - acpBusy, busy: acpBusy },
      claude: { total: claude.length, idle: claude.length - claudeBusy, busy: claudeBusy },
    };
  }
}
