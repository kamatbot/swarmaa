import { spawn } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { redactSecrets } from '../safety/redact.js';
import { processStart } from './process.js';
import type { ProcessRequest, ProcessResult } from './types.js';

export interface AcpActivityItem {
  id: string;
  tool: string;
  label: string;
  state: 'running' | 'done' | 'failed';
}

export interface AcpUsage {
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
}

export interface AcpCallbacks {
  onPartialText?: (text: string) => void;
  onActivity?: (item: AcpActivityItem) => void;
}

export interface AcpArgsOptions {
  patch?: boolean;
  dangerouslySkipPermissions?: boolean;
  processPerSession?: boolean;
  agent?: string;
}

/** Build verified `agy acp` CLI arguments (no prompt in argv, no private endpoints). */
export function buildAcpArgs(opts: AcpArgsOptions = {}): string[] {
  const args = ['acp', '--stdio'];
  if (opts.processPerSession) args.push('--process-per-session');
  if (opts.patch || opts.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
  else args.push('--sandbox');
  if (opts.agent) args.push('--agent', opts.agent);
  return args;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

function asObj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(block => extractTextContent(block)).join('');
  }
  const obj = asObj(content);
  if (!obj) return '';
  if ((obj.type === undefined || obj.type === 'text') && typeof obj.text === 'string') return obj.text;
  if (obj.content !== undefined) return extractTextContent(obj.content);
  return '';
}

function extractModelFromObj(obj: Record<string, unknown> | undefined): string | undefined {
  if (!obj) return undefined;
  for (const key of ['currentModelId', 'modelId', 'model']) {
    if (typeof obj[key] === 'string' && obj[key]!.trim()) return obj[key]!.trim();
  }
  for (const nestedKey of ['models', 'metadata', 'response_metadata', 'usage']) {
    const nested = asObj(obj[nestedKey]);
    const found = extractModelFromObj(nested);
    if (found) return found;
  }
  return undefined;
}

function extractUsageFromObj(obj: Record<string, unknown> | undefined): AcpUsage | undefined {
  if (!obj) return undefined;
  const candidate = asObj(obj.usage) ?? obj;
  const inputRaw = candidate.input_tokens ?? candidate.inputTokens ?? candidate.promptTokens;
  const outputRaw = candidate.output_tokens ?? candidate.outputTokens ?? candidate.completionTokens;
  const cachedRaw = candidate.cached_input_tokens ?? candidate.cachedReadTokens ?? candidate.cachedTokens ?? candidate.cache_read_input_tokens;
  const okNum = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (!okNum(inputRaw) || !okNum(outputRaw)) return undefined;
  if (cachedRaw !== undefined && !okNum(cachedRaw)) return undefined;
  return {
    input_tokens: inputRaw,
    output_tokens: outputRaw,
    ...(cachedRaw !== undefined ? { cached_input_tokens: cachedRaw } : {}),
  };
}

function mapToolState(status: unknown): 'running' | 'done' | 'failed' {
  const s = typeof status === 'string' ? status.toLowerCase() : '';
  if (s === 'completed' || s === 'done' || s === 'success') return 'done';
  if (s === 'failed' || s === 'error' || s === 'cancelled' || s === 'rejected' || s === 'denied') return 'failed';
  return 'running';
}

function formatAcpToolLabel(tool: string, title: string, input?: Record<string, unknown>): string {
  if (title && title.trim()) return redactSecrets(title.trim()).slice(0, 120);
  if (input) {
    for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description']) {
      const val = input[key];
      if (typeof val === 'string' && val.trim()) {
        const firstLine = val.trim().split(/\r?\n/)[0]!.trim().slice(0, 80);
        const sep = key === 'command' ? ': ' : ' ';
        return redactSecrets(`${tool}${sep}${firstLine}`).slice(0, 120);
      }
    }
  }
  return redactSecrets(tool || 'tool').slice(0, 120);
}

/**
 * Official Agent Client Protocol (ACP) JSON-RPC 2.0 client over stdio.
 * Runs the unmodified `agy acp` binary (optionally wrapped in Seatbelt) through:
 *   initialize -> session/new (or session/load) -> session/prompt -> session/cancel on abort.
 */
export async function runAcpSession(request: ProcessRequest, callbacks?: AcpCallbacks): Promise<ProcessResult> {
  const acp = request.acp;
  if (!acp) throw new Error('runAcpSession requires request.acp configuration');
  const started = Date.now();
  if (request.signal?.aborted) {
    return { exit_code: null, signal: null, stdout: '', stderr: '', duration_ms: 0, stop_reason: 'aborted' };
  }

  return new Promise<ProcessResult>(resolve => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (request.pidfile && child.pid && process.platform !== 'win32') {
      try {
        writeFileSync(request.pidfile, JSON.stringify({ pid: child.pid, pgid: child.pid, started: processStart(child.pid) }), { mode: 0o600 });
      } catch { /* best effort */ }
    }

    let settled = false;
    let stopReason: ProcessResult['stop_reason'] = null;
    let totalBytes = 0;
    let stdoutBytes = 0;
    const stderrChunks: Buffer[] = [];
    let stdoutBuffer = '';
    let nextId = 1;
    let sessionId: string | undefined;
    let servedModel: string | undefined;
    let usage: AcpUsage | undefined;
    let fullText = '';
    let promptStopReason: string | undefined;
    let protocolError: string | undefined;
    const deniedActions: string[] = [];
    const activityMap = new Map<string, AcpActivityItem>();
    let fallbackToolCounter = 0;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    let childExitCode: number | null = null;
    let childSignal: NodeJS.Signals | null = null;
    let childClosed = false;

    const pending = new Map<number, { resolve: (res: Record<string, unknown>) => void; reject: (err: Error) => void }>();

    const signalGroup = (sig: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* already exited */ }
    };

    const writeJson = (msg: Record<string, unknown>): boolean => {
      if (settled || childClosed || child.stdin.destroyed || child.stdin.writableEnded) return false;
      try {
        child.stdin.write(`${JSON.stringify(msg)}\n`, 'utf8');
        return true;
      } catch {
        return false;
      }
    };

    const sendRpc = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      return new Promise((res, rej) => {
        if (settled || childClosed) {
          rej(new Error(`ACP process closed before ${method}`));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        if (!writeJson({ jsonrpc: '2.0', id, method, params })) {
          pending.delete(id);
          rej(new Error(`Failed to write ACP request ${method}`));
        }
      });
    };

    const sendCancel = (): void => {
      if (sessionId) {
        writeJson({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
      }
    };

    const rejectAllPending = (reason: string): void => {
      for (const [id, entry] of pending) {
        pending.delete(id);
        entry.reject(new Error(reason));
      }
    };

    const buildOutput = (succeeded: boolean): ProcessResult => {
      const activity = [...activityMap.values()].slice(-20);
      const stderrText = Buffer.concat(stderrChunks).toString('utf8');
      const payload: Record<string, unknown> = {
        protocol: 'acp',
        status: succeeded ? 'SUCCESS' : 'ERROR',
        response: fullText,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(servedModel ? { model: servedModel } : {}),
        ...(usage ? { usage } : {}),
        ...(promptStopReason ? { stop_reason: promptStopReason } : {}),
        ...(deniedActions.length ? { denied_actions: deniedActions.slice(0, 10).map(name => ({ display_name: name, action: name })) } : {}),
        ...(activity.length ? { activity } : {}),
        ...(!succeeded && protocolError ? { error: protocolError } : {}),
      };
      return {
        exit_code: stopReason ? childExitCode : (succeeded ? 0 : (childExitCode && childExitCode !== 0 ? childExitCode : 1)),
        signal: childSignal,
        stdout: stopReason === 'spawn_error' ? '' : JSON.stringify(payload),
        stderr: stderrText,
        duration_ms: Date.now() - started,
        stop_reason: stopReason,
      };
    };

    const finish = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (cancelTimer) clearTimeout(cancelTimer);
      if (killTimer) clearTimeout(killTimer);
      if (finalTimer) clearTimeout(finalTimer);
      request.signal?.removeEventListener('abort', onAbort);
      rejectAllPending('ACP session finished');
      signalGroup('SIGKILL');
      if (request.pidfile) try { unlinkSync(request.pidfile); } catch { /* absent */ }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(buildOutput(succeeded));
    };

    const stop = (reason: NonNullable<ProcessResult['stop_reason']>): void => {
      if (stopReason || settled) return;
      stopReason = reason;
      const sentCancel = (reason === 'aborted' || reason === 'timeout') && Boolean(sessionId);
      if (sentCancel) sendCancel();
      rejectAllPending(`ACP stopped: ${reason}`);
      const beginSignals = (): void => {
        if (settled || childClosed) { finish(false); return; }
        signalGroup('SIGTERM');
        killTimer = setTimeout(() => signalGroup('SIGKILL'), 1500);
        finalTimer = setTimeout(() => finish(false), 3000);
      };
      if (sentCancel) {
        // Give the ACP server a brief grace window to process session/cancel and flush before SIGTERM.
        cancelTimer = setTimeout(beginSignals, 150);
      } else {
        beginSignals();
      }
    };

    const onAbort = (): void => stop('aborted');
    const timeout = setTimeout(() => stop('timeout'), request.timeout_ms);

    const handleServerRequest = (msg: JsonRpcMessage): void => {
      const id = msg.id!;
      if (msg.method === 'session/request_permission') {
        const params = asObj(msg.params) ?? {};
        const options = Array.isArray(params.options) ? params.options.map(asObj).filter((x): x is Record<string, unknown> => !!x) : [];
        const toolCall = asObj(params.toolCall);
        const toolLabel = String(toolCall?.title ?? toolCall?.kind ?? toolCall?.toolName ?? params.title ?? 'permission');
        const allow = Boolean(acp.patch || acp.dangerously_skip_permissions);
        if (allow) {
          const picked = options.find(o => typeof o.kind === 'string' && o.kind.startsWith('allow')) ?? options[0];
          const optionId = typeof picked?.optionId === 'string' ? picked.optionId : undefined;
          writeJson({
            jsonrpc: '2.0',
            id,
            result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } },
          });
        } else {
          if (deniedActions.length < 10) deniedActions.push(redactSecrets(toolLabel).slice(0, 120));
          const rejectOpt = options.find(o => typeof o.kind === 'string' && o.kind.startsWith('reject'));
          const optionId = typeof rejectOpt?.optionId === 'string' ? rejectOpt.optionId : undefined;
          writeJson({
            jsonrpc: '2.0',
            id,
            result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } },
          });
        }
        return;
      }
      writeJson({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported client method: ${msg.method}` } });
    };

    const handleSessionUpdate = (params: Record<string, unknown>): void => {
      const update = asObj(params.update) ?? params;
      const kind = String(update.sessionUpdate ?? update.type ?? '');

      const foundModel = extractModelFromObj(update) ?? extractModelFromObj(params);
      if (foundModel) servedModel = foundModel;
      const foundUsage = extractUsageFromObj(update) ?? extractUsageFromObj(params);
      if (foundUsage) usage = foundUsage;

      if (kind === 'agent_message_chunk') {
        const chunkText = extractTextContent(update.content ?? update.text ?? update.delta);
        if (chunkText) {
          fullText += chunkText;
          callbacks?.onPartialText?.(fullText);
          request.on_progress?.({
            output_bytes: totalBytes,
            stdout_bytes: stdoutBytes,
            stdout_tail: fullText.slice(-8192),
          });
        }
        return;
      }

      if (kind === 'tool_call' || kind === 'tool_call_update') {
        const rawId = update.toolCallId ?? update.id ?? update.callId;
        const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : `acp_tool_${++fallbackToolCounter}`;
        const existing = activityMap.get(id);
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
        activityMap.set(id, item);
        while (activityMap.size > 20) activityMap.delete(activityMap.keys().next().value!);
        callbacks?.onActivity?.(item);
      }
    };

    const handleMessage = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) return;
      let msg: JsonRpcMessage;
      try { msg = JSON.parse(trimmed) as JsonRpcMessage; } catch { return; }

      if (msg.id !== undefined && msg.method !== undefined) {
        handleServerRequest(msg);
        return;
      }

      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const key = typeof msg.id === 'number' ? msg.id : Number(msg.id);
        const entry = pending.get(key);
        if (!entry) return;
        pending.delete(key);
        if (msg.error) {
          entry.reject(Object.assign(new Error(msg.error.message ?? `ACP RPC error ${msg.error.code ?? ''}`), { rpcCode: msg.error.code }));
        } else {
          entry.resolve(asObj(msg.result) ?? {});
        }
        return;
      }

      if (msg.method === 'session/update' && msg.params) {
        handleSessionUpdate(msg.params);
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      stdoutBytes += chunk.byteLength;
      if (totalBytes > request.max_output_bytes) {
        stop('output_limit');
        return;
      }
      stdoutBuffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        handleMessage(line);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const available = Math.max(0, request.max_output_bytes - totalBytes);
      if (available > 0) stderrChunks.push(chunk.subarray(0, available));
      totalBytes += chunk.byteLength;
      if (totalBytes > request.max_output_bytes) stop('output_limit');
    });

    child.stdin.on('error', () => { /* handled on close */ });
    child.once('error', () => {
      stopReason = 'spawn_error';
      rejectAllPending('Failed to spawn ACP process');
      finish(false);
    });
    child.once('close', (code, sig) => {
      childClosed = true;
      childExitCode = code;
      childSignal = sig;
      if (stdoutBuffer.trim()) {
        handleMessage(stdoutBuffer);
        stdoutBuffer = '';
      }
      if (!settled) {
        if (stopReason) finish(false);
        else rejectAllPending(`ACP server exited unexpectedly (code=${code ?? 'null'})`);
      }
    });

    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) {
      onAbort();
      return;
    }

    // Drive the ACP JSON-RPC 2.0 session lifecycle.
    void (async () => {
      try {
        const initRes = await sendRpc('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'swarmaa-bridge', version: '1.0.0' },
        });
        const initModel = extractModelFromObj(initRes);
        if (initModel) servedModel = initModel;

        let sessionRes: Record<string, unknown> | undefined;
        if (acp.resume_session_id) {
          try {
            sessionRes = await sendRpc('session/load', {
              sessionId: acp.resume_session_id,
              cwd: acp.cwd,
              mcpServers: [],
            });
            sessionId = typeof sessionRes.sessionId === 'string' ? sessionRes.sessionId : acp.resume_session_id;
          } catch {
            // Session could not be resumed; start a fresh session cleanly.
            sessionRes = undefined;
          }
        }
        if (!sessionRes) {
          sessionRes = await sendRpc('session/new', {
            cwd: acp.cwd,
            mcpServers: [],
          });
          sessionId = typeof sessionRes.sessionId === 'string'
            ? sessionRes.sessionId
            : (typeof sessionRes.session_id === 'string' ? sessionRes.session_id : undefined);
        }
        if (!sessionId) throw new Error('ACP session/new did not return a sessionId');

        const sessionModel = extractModelFromObj(sessionRes);
        if (sessionModel) servedModel = sessionModel;

        if (acp.model) {
          try {
            const setRes = await sendRpc('session/set_model', { sessionId, modelId: acp.model });
            const nextModel = extractModelFromObj(setRes);
            if (nextModel) servedModel = nextModel;
            else servedModel ??= acp.model;
          } catch {
            // Optional ACP capability; ignore if server does not implement session/set_model.
          }
        }

        if (acp.effort) {
          try {
            await sendRpc('session/set_config_option', { sessionId, configId: 'effort', value: acp.effort });
          } catch {
            // Optional ACP capability; ignore if unsupported.
          }
        }

        const promptBlocks: Array<Record<string, unknown>> = [{ type: 'text', text: acp.prompt }];
        for (const image of acp.images ?? []) {
          promptBlocks.push({ type: 'text', text: `Untrusted photo from message #${image.seq}:` });
          promptBlocks.push({ type: 'image', mimeType: image.mimeType ?? 'image/jpeg', data: image.data });
        }

        const promptRes = await sendRpc('session/prompt', {
          sessionId,
          prompt: promptBlocks,
        });

        const resModel = extractModelFromObj(promptRes);
        if (resModel) servedModel = resModel;
        const resUsage = extractUsageFromObj(promptRes);
        if (resUsage) usage = resUsage;
        if (typeof promptRes.stopReason === 'string') promptStopReason = promptRes.stopReason;
        if (!fullText) {
          const fallbackText = extractTextContent(promptRes.content ?? promptRes.response ?? promptRes.text);
          if (fallbackText) fullText = fallbackText;
        }

        // Gracefully close stdin so `agy acp` exits cleanly, with bounded wait before teardown.
        try { child.stdin.end(); } catch {}
        if (!childClosed) {
          await new Promise<void>(r => {
            const t = setTimeout(r, 500);
            child.once('close', () => { clearTimeout(t); r(); });
          });
        }

        const ok = !stopReason && promptStopReason !== 'cancelled' && fullText.trim() !== '' && deniedActions.length === 0;
        if (!ok && !protocolError) {
          protocolError = deniedActions.length
            ? `Denied actions: ${deniedActions.join(', ')}`
            : promptStopReason === 'cancelled'
              ? 'ACP turn cancelled'
              : 'ACP session completed with empty response';
        }
        finish(ok);
      } catch (err) {
        if (!settled && !stopReason) {
          protocolError = err instanceof Error ? err.message : String(err);
          finish(false);
        }
      }
    })();
  });
}
