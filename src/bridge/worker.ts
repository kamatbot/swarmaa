import { runFlowCheck } from './checks.js';
import { setTimeout as delay } from 'node:timers/promises';
import { AUTO_PATCH, AUTO_READ, buildInvocation, capability, antigravityLogModel, classifyFailure, deniedActions, extractDelegate, extractPartialText, extractServed, finalAnswer, projectCapabilities, providerSucceeded } from './adapters.js';
import { collectUsage, headroom } from '../usage/index.js';
import { windowsForModel } from '../usage/antigravity.js';
import type { UsageProviderId, UsageSnapshot } from '../usage/types.js';
import { runBoundedProcess } from './process.js';
import { sameModel, type ServedStamp } from '../core/failures.js';
import { reasonNotify } from './reason.js';
import { cleanupNative, finishNative, prepareNative, type NativeSession } from './native-session.js';
import { createWorktree, finishWorktree, inspectWorktree, removeSnapshot, type PatchOutcome, type Worktree } from './worktree.js';
import type { AgentConfig, BridgeConfig, BridgeLogger, Claim, Lease, ProcessResult, ProcessRunner, ProjectConfig, Task, ToolClient } from './types.js';
import { redactSecrets } from '../safety/redact.js';

function cleanText(value: string, maxBytes: number): string {
  // PostgreSQL text cannot contain NUL. Clip by UTF-8 bytes, not character count.
  return Buffer.from(value.replaceAll('\0', '\uFFFD'), 'utf8').subarray(0, maxBytes).toString('utf8');
}
/**
 * Provider output on its way into the service (answers, transcripts, diffs, checkpoints, chats) loses credential-shaped
 * text first: it is stored, readable by everyone with the scope and summarised to event sinks. Clipping with a margin
 * before redacting bounds the scan; clipping again after means a secret is never cut in half before the redactor sees it.
 */
function untrusted(value: string, maxBytes: number): string {
  return cleanText(redactSecrets(cleanText(value, maxBytes + 4096)), maxBytes);
}
function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z0-9_]+$/u.test(error.code)) return error.code;
  return 'worker_operation_failed';
}
/** No answer, a timeout, 429 or 5xx: the service may still hold the lease. Any other refusal is final. */
function transient(error: unknown): boolean {
  const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
  return status === undefined || status === 408 || status === 429 || status >= 500;
}
/** headroom: provider -> percent of quota left, from the latest local usage reading. */
function validateClaim(claim: Claim, project: ProjectConfig, agents: AgentConfig[], headroom: ReadonlyMap<string, number> = new Map()): { task: Task; lease: Lease; agent: AgentConfig } | null {
  if (!claim.task) return null;
  const task = claim.task;
  if (task.scope !== project.scope || !['research', 'review', 'patch', 'check', 'turn'].includes(task.kind) || typeof task.id !== 'string' || !claim.lease_token || !Number.isInteger(claim.lease_generation)) throw new Error('Invalid or misrouted task claim');
  const patch = task.kind === 'patch' || task.kind === 'check' || (task.kind === 'turn' && task.required_capability.endsWith('.patch'));
  const candidates = agents.filter(a => project.agents.includes(a.id) && (!patch || (project.allow_patch && a.enable_patch)));
  if (task.kind==='check') {
    if (!task.flow_id || !task.flow?.check || task.required_capability!=='bridge.check' || !project.checks || !candidates.length) throw new Error('Invalid check claim or local checks are not enabled');
    return {task,agent:candidates[0]!,lease:{task_id:task.id,lease_token:claim.lease_token,lease_generation:claim.lease_generation as number}};
  }
  const auto = task.required_capability === (patch ? AUTO_PATCH : AUTO_READ);
  // The service's route binds execution; without it (older service) auto work fails closed.
  if (auto && !claim.route) throw Object.assign(new Error('Service claim has no routing decision for auto work'), { code: 'route_unavailable' });
  const route = claim.route;
  const agent = auto
    ? (route!.provider !== null
      ? candidates.find(a => a.provider === route!.provider)
      : candidates.filter(a => route!.allowed.includes(a.provider)).sort((a, b) => (headroom.get(b.provider) ?? 50) - (headroom.get(a.provider) ?? 50))[0])
    : candidates.find(a => task.required_capability === capability(a, patch));
  if (!agent) throw Object.assign(new Error('Service returned a capability this worker did not advertise'), { code: auto ? 'route_unavailable' : 'worker_operation_failed' });
  return { task, agent, lease: { task_id: task.id, lease_token: claim.lease_token, lease_generation: claim.lease_generation as number } };
}

export class BridgeWorker {
  /** Latest local quota headroom per provider, used to pick an agent for auto-routed work. */
  private readonly headroom = new Map<string, number>();
  private nextUsageAt = 0;
  private draining = false;
  private readonly running = new Set<Promise<unknown>>();
  private readonly drainAbort = new AbortController();
  private readonly streamAbort = new AbortController();
  private pollWait?: AbortController;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private readonly streamFetch?: typeof fetch;
  private readonly streamToken?: string;
  private lastWakeTime = 0;
  private wakeTimer?: NodeJS.Timeout;
  private wakePending = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly client: ToolClient,
    private readonly logger: BridgeLogger = (event, metadata) => process.stderr.write(`${JSON.stringify({ event, ...metadata })}\n`),
    private readonly runner: ProcessRunner = runBoundedProcess,
    private readonly usage: (providers: UsageProviderId[]) => Promise<UsageSnapshot[]> = providers => collectUsage(providers),
    streamOptions?: { fetcher?: typeof fetch; token?: string } | typeof fetch
  ) {
    if (typeof streamOptions === 'function') {
      this.streamFetch = streamOptions;
    } else if (streamOptions) {
      this.streamFetch = streamOptions.fetcher;
      this.streamToken = streamOptions.token;
    }
  }

  private triggerWake(): void {
    const now = Date.now();
    const timeSinceLast = now - this.lastWakeTime;
    if (timeSinceLast >= 200) {
      this.lastWakeTime = now;
      if (this.wakeTimer) {
        clearTimeout(this.wakeTimer);
        this.wakeTimer = undefined;
      }
      if (this.pollWait) {
        this.pollWait.abort();
      } else {
        this.wakePending = true;
      }
    } else if (!this.wakeTimer) {
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = undefined;
        this.lastWakeTime = Date.now();
        if (this.pollWait) {
          this.pollWait.abort();
        } else {
          this.wakePending = true;
        }
      }, 200 - timeSinceLast);
    }
  }

  private handleSseBlock(block: string, myScopes: Set<string>): void {
    let eventName = '';
    let dataStr = '';

    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataStr = line.slice(5).trim();
      }
    }

    if (!dataStr && !eventName) return;

    let data: Record<string, unknown> = {};
    if (dataStr) {
      try { data = JSON.parse(dataStr); } catch {}
    }

    const name = eventName || String(data.name ?? '');
    const scope = String(data.scope ?? (data.payload as any)?.scope ?? '');
    const status = String((data.payload as any)?.status ?? data.status ?? '');

    const isSubmitted = name === 'task.submitted';
    const isQueuedUpdate = name === 'task.updated' && status === 'queued';

    if ((isSubmitted || isQueuedUpdate) && (myScopes.has(scope) || myScopes.has('*'))) {
      this.triggerWake();
    }
  }

  private async maintainStream(signal: AbortSignal): Promise<void> {
    const token = this.streamToken ?? (this.client as any).token ?? process.env[this.config.token_env];
    if (!token && !this.streamFetch) {
      return;
    }
    const baseUrl = (this.client as any).origin ?? this.config.service_url;
    const url = `${baseUrl.replace(/\/+$/, '')}/api/stream?after=now`;
    const fetcher = this.streamFetch ?? (this.client as any).fetcher ?? globalThis.fetch;
    const myScopes = new Set(this.config.projects.map(p => p.scope));

    let backoffMs = 500;

    while (!signal.aborted && !this.draining) {
      try {
        const response = await fetcher(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token ?? 'worker-token'}`,
            Accept: 'text/event-stream'
          },
          signal
        });

        if (!response.ok || !response.body) {
          throw new Error(`Stream request failed with status ${response.status}`);
        }

        const reader = response.body.getReader();
        let buffer = '';
        const decoder = new TextDecoder('utf8');

        try {
          while (!signal.aborted && !this.draining) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true });

            let boundary: number;
            while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
              const eventBlock = buffer.slice(0, boundary);
              const match = buffer.slice(boundary).match(/^\r?\n\r?\n/);
              const delimLength = match ? match[0].length : 2;
              buffer = buffer.slice(boundary + delimLength);
              this.handleSseBlock(eventBlock, myScopes);
              // Reset only once something arrives: a 200 that closes at once must keep backing off.
              backoffMs = 500;
            }
          }
        } finally {
          try { await reader.cancel(); } catch {}
          reader.releaseLock();
        }
      } catch (err) {
        if (signal.aborted || this.draining) break;
        this.logger('stream_connection_failed', {
          message: String((err as Error)?.message ?? err).slice(0, 200),
          retry_in_ms: backoffMs
        });
      }

      if (signal.aborted || this.draining) break;
      try {
        await delay(backoffMs, undefined, { signal });
        backoffMs = Math.min(backoffMs * 2, 30_000);
      } catch {
        break;
      }
    }
  }

  /** Stop claiming; the run loop and task heartbeats stay alive until every task settles. */
  drain(maxSeconds?: number): void {
    if (this.draining) return;
    this.draining = true;
    this.nextUsageAt = 0;
    this.streamAbort.abort();
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    this.logger('bridge_draining', { running: this.running.size });
    this.pollWait?.abort();
    if (maxSeconds !== undefined && this.running.size) this.drainTimer = setTimeout(() => {
      this.logger('bridge_drain_deadline', { running: this.running.size });
      this.drainAbort.abort();
    }, maxSeconds * 1000);
  }

  /** Report provider quota to the service between tasks. Failures only delay routing data. */
  async reportUsage(signal: AbortSignal): Promise<void> {
    const seconds = this.draining ? Math.min(this.config.usage_seconds || 30, 30) : this.config.usage_seconds;
    if (!seconds || Date.now() < this.nextUsageAt) return;
    this.nextUsageAt = Date.now() + seconds * 1000;
    const providers = [...new Set(this.config.agents.map(a => a.provider))] as UsageProviderId[];
    try {
      const agyModel = this.config.agents.find(a => a.provider === 'antigravity')?.model;
      const snapshots = (this.draining ? [] : await this.usage(providers))
        .map(s => s.provider === 'antigravity' ? { ...s, windows: windowsForModel(s.windows, agyModel) } : s);
      for (const s of snapshots) this.headroom.set(s.provider, headroom(s));
      await this.client.call('usage_report', { reports: snapshots.map(s => ({ provider: s.provider, ok: s.ok, windows: s.windows, fetched_at: s.fetched_at,
        ...(s.plan ? { plan: s.plan.slice(0, 80) } : {}), ...(s.error ? { error: s.error.slice(0, 200) } : {}) })), slots: this.draining ? 0 : this.config.max_concurrent }, signal);
    } catch (error) {
      this.logger('usage_report_failed', { code: errorCode(error), message: String((error as Error)?.message ?? error).slice(0, 200) });
    }
  }

  /**
   * One polling loop with `max_concurrent` slots: each pass asks for work across projects, and keeps
   * claiming while it has work and a slot is free. Claimed tasks run in the background, so a
   * worker runs up to `max_concurrent` tasks at once without multiplying its requests to the service.
   */
  async run(signal: AbortSignal, once = false): Promise<void> {
    signal = AbortSignal.any([signal, this.drainAbort.signal]);
    let streamTask: Promise<void> | undefined;
    if (!once) {
      const streamSignal = AbortSignal.any([signal, this.streamAbort.signal]);
      streamTask = this.maintainStream(streamSignal).catch(err => {
        this.logger('stream_loop_error', { message: String(err) });
      });
    }
    let inflight = 0;
    let claimedOnce = false;
    const running = this.running;
    try {
      while (!signal.aborted && (!this.draining || running.size)) {
        let claimedAny = false;
        await this.reportUsage(signal);
        for (let i = 0; i < this.config.projects.length; i += 64) {
          const projects = this.config.projects.slice(i, i + 64);
          while (!signal.aborted && !this.draining && !(once && claimedOnce) && inflight < this.config.max_concurrent) {
            let claimed!: () => void;
            const started = new Promise<boolean>(r => { claimed = () => r(true); });
            inflight++;
            const task = this.claimAndRun(projects, signal, claimed)
              .catch(error => { this.logger('bridge_poll_failed', { scope: projects[0]!.scope, code: errorCode(error), message: String((error as Error)?.message ?? error).slice(0, 200) }); return false; })
              .finally(() => {
                inflight--; running.delete(task);
                if (!running.size) {
                  if (this.drainTimer) clearTimeout(this.drainTimer);
                  if (this.draining || once) this.pollWait?.abort();
                }
              });
            running.add(task);
            if (!(await Promise.race([started, task]))) break; // nothing to claim here
            claimedAny = true;
            claimedOnce = true;
            if (once) break;
          }
        }
        if (once && !running.size) return;
        if (this.draining && !running.size) break;
        if (!claimedAny) {
          if (this.wakePending) {
            this.wakePending = false;
            continue;
          }
          this.pollWait = new AbortController();
          const seconds = this.draining ? Math.min(this.config.poll_seconds, this.config.usage_seconds || 30, 30) : this.config.poll_seconds;
          try { await delay(seconds * 1000, undefined, { signal: AbortSignal.any([signal, this.pollWait.signal]) }); } catch { /* shutdown, drain, or the last task finished */ }
          finally { this.pollWait = undefined; }
        }
      }
    } finally {
      this.streamAbort.abort();
      if (this.wakeTimer) {
        clearTimeout(this.wakeTimer);
        this.wakeTimer = undefined;
      }
      await Promise.allSettled([...running, ...(streamTask ? [streamTask] : [])]);
    }
  }

  async claimAndRun(projects: ProjectConfig[], signal: AbortSignal, onClaimed?: () => void): Promise<boolean> {
    if (this.draining || signal.aborted) return false;
    const claimStarted = performance.now();
    const claim = await this.client.call<Claim>('task_claim', {
      projects: projects.map(project => {
        const capabilities = projectCapabilities(project, this.config.agents);
        const allowsPatch = capabilities.some(c => c.endsWith('.patch'));
        const checks = allowsPatch && project.checks !== undefined;
        return { scope: project.scope, capabilities:checks ? [...capabilities,'bridge.check'] : capabilities,
          kinds: allowsPatch ? ['research', 'review', 'patch',...(checks ? ['check'] : [])] : ['research', 'review'] };
      }),
      lease_seconds: this.config.lease_seconds
    }, signal);
    if (!claim.task) return false;
    const project = projects.find(p => p.scope === claim.task!.scope);
    if (!project) throw new Error('Invalid or misrouted task claim');
    let valid: ReturnType<typeof validateClaim>;
    try { valid = validateClaim(claim, project, this.config.agents, this.headroom); }
    catch (error) {
      // A routing mismatch is not retryable here: release the lease as blocked so the owner sees why, and run nothing.
      if (errorCode(error) === 'route_unavailable' && claim.task && claim.lease_token) {
        await this.client.call('task_finish', { task_id: claim.task.id, lease_token: claim.lease_token, lease_generation: claim.lease_generation, outcome: 'blocked', result: {
          code: 'route_unavailable', review_required: true, acceptance_criteria_verified: false,
          summary: 'Service routing decision is missing or names a provider this worker cannot run; nothing was executed.' } });
        return true;
      }
      throw error;
    }
    if (!valid) return false;
    onClaimed?.();
    await this.execute(valid.task, valid.lease, valid.agent, project, signal, claimStarted);
    return true;
  }

  private async execute(task: Task, lease: Lease, agent: AgentConfig, project: ProjectConfig, shutdown: AbortSignal, claimStarted: number): Promise<void> {
    const execution = new AbortController();
    const heartbeatStop = new AbortController();
    let leaseLost = false;
    let finished = false;
    let completionAttempted = false;
    let isPatchWork = task.kind === 'patch' || (task.kind === 'turn' && task.required_capability.endsWith('.patch'));
    let worktree: Worktree | undefined;
    let patchResult: PatchOutcome | undefined;
    let observedCommit:string|undefined;
    let checkFact:Awaited<ReturnType<typeof runFlowCheck>>|undefined;
    let snapshotInvalid = false;
    let finalizeFailure: { worktree_path: string; recovery: string } | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let progress = { output_bytes: 0, stdout_tail: '' };
    let currentPartialText = '';
    let lastSentPartialText = '';
    let lastCheckpointTime = 0;
    let partialTextTimer: NodeJS.Timeout | undefined;
    let checkpointInFlight = false;
    const streamParserState = { totalProcessedBytes: 0 };
    const startedAt = new Date().toISOString();
    const onShutdown = (): void => execution.abort();
    shutdown.addEventListener('abort', onShutdown, { once: true });
    if (shutdown.aborted) execution.abort();
    const loseLease = (code: string): void => {
      if (leaseLost || finished) return;
      leaseLost = true;
      execution.abort();
      this.logger('lease_lost_process_stopping', { task_id: task.id, code });
    };
    const armExpiry = (requestStarted: number): void => {
      if (leaseLost || finished) return;
      if (expiryTimer) clearTimeout(expiryTimer);
      // The server renews after the request starts. Measuring from request start is
      // conservative and avoids trusting wall-clock synchronization. Leave four
      // seconds for the subprocess termination grace before the known lease window.
      const remaining = requestStarted + this.config.lease_seconds * 1000 - 4000 - performance.now();
      if (remaining <= 0) loseLease('local_lease_deadline');
      else expiryTimer = setTimeout(() => loseLease('local_lease_deadline'), remaining);
    };
    const renew = async (): Promise<void> => {
      const started = performance.now();
      await this.client.call('task_heartbeat', { ...lease, lease_seconds: this.config.lease_seconds });
      armExpiry(started);
    };
    armExpiry(claimStarted);
    const checkpoint = (phase: string): Record<string, unknown> => {
      const base: Record<string, unknown> = {
        phase, agent: agent.id, provider: task.kind==='check' ? 'bridge' : agent.provider, started_at: startedAt,
        output_bytes: progress.output_bytes, partial_output: untrusted(progress.stdout_tail, 8192),
        partial_output_is_untrusted: true
      };
      if (task.kind === 'turn' && agent.provider !== 'antigravity') {
        base.partial_text = untrusted(currentPartialText, 8192);
      }
      return base;
    };
    const sendPartialCheckpoint = async (): Promise<void> => {
      if (finished || leaseLost || execution.signal.aborted || heartbeatStop.signal.aborted) return;
      if (checkpointInFlight) return;
      if (currentPartialText === lastSentPartialText) return;

      checkpointInFlight = true;
      try {
        // Checkpoint only: lease renewal stays with the heartbeat loop.
        await this.client.call('task_checkpoint', { ...lease, checkpoint: checkpoint('running') });
        lastSentPartialText = currentPartialText;
        lastCheckpointTime = Date.now();
      } catch (error) {
        if (!transient(error)) { loseLease(errorCode(error)); return; }
        this.logger('checkpoint_retry', { task_id: task.id, code: errorCode(error) });
      } finally {
        checkpointInFlight = false;
        if (currentPartialText !== lastSentPartialText && !finished && !leaseLost) {
          schedulePartialCheckpoint();
        }
      }
    };
    const schedulePartialCheckpoint = (): void => {
      if (finished || leaseLost || execution.signal.aborted || heartbeatStop.signal.aborted || partialTextTimer) return;
      const now = Date.now();
      const elapsed = now - lastCheckpointTime;
      if (elapsed >= 1500) {
        void sendPartialCheckpoint();
      } else {
        partialTextTimer = setTimeout(() => {
          partialTextTimer = undefined;
          void sendPartialCheckpoint();
        }, 1500 - elapsed);
      }
    };
    const updatePartialText = (stdoutTail: string, outputBytes: number): void => {
      if (task.kind !== 'turn' || agent.provider === 'antigravity') return;

      const tailBuf = Buffer.from(stdoutTail, 'utf8');
      const tailStartOffset = outputBytes - tailBuf.length;
      const newBytesStart = Math.max(0, streamParserState.totalProcessedBytes - tailStartOffset);
      const newBuf = tailBuf.subarray(newBytesStart);
      const lastLf = newBuf.lastIndexOf(10); // '\n'

      if (lastLf >= 0) {
        const completeLinesBuf = newBuf.subarray(0, lastLf + 1);
        streamParserState.totalProcessedBytes += completeLinesBuf.length;
        const chunkText = completeLinesBuf.toString('utf8');
        const extracted = extractPartialText(agent.provider, chunkText);
        if (extracted) {
          if (agent.provider === 'claude') {
            currentPartialText += extracted;
          } else if (agent.provider === 'codex') {
            currentPartialText = extracted;
          }
        }
      }

      if (!currentPartialText) {
        const fromTail = extractPartialText(agent.provider, stdoutTail);
        if (fromTail) currentPartialText = fromTail;
      }

      if (currentPartialText !== lastSentPartialText) {
        schedulePartialCheckpoint();
      }
    };
    const heartbeat = (async (): Promise<void> => {
      while (!heartbeatStop.signal.aborted) {
        try { await delay(this.config.heartbeat_seconds * 1000, undefined, { signal: heartbeatStop.signal }); } catch { return; }
        if (finished) return;
        try {
          await renew();
          if (leaseLost) return;
          if (!finished) {
            await this.client.call('task_checkpoint', { ...lease, checkpoint: checkpoint('running') });
            lastSentPartialText = currentPartialText;
            lastCheckpointTime = Date.now();
          }
        } catch (error) {
          if (finished) return;
          // A refusal is final. An ambiguous failure (slow service, restart, dropped connection) is retried on the
          // next beat: the local deadline armed by the last successful renewal still stops the process before the
          // service's lease can lapse, so files are never written past a lease the service may have reassigned.
          if (!transient(error)) { loseLease(errorCode(error)); return; }
          this.logger('heartbeat_retry', { task_id: task.id, code: errorCode(error) });
        }
      }
    })();
    this.logger('task_claimed', { task_id: task.id, scope: task.scope, provider: task.kind==='check' ? 'bridge' : agent.provider, kind: task.kind });
    try {
      if (leaseLost) return;
      await this.client.call('task_checkpoint', { ...lease, checkpoint: checkpoint('starting') }, execution.signal);
      const context = await this.client.call('context_get', { scope: task.scope, task_id: task.id, limit: 12 }, execution.signal);
      // Patch work gets its own worktree+branch, so parallel patch tasks on one project never share files.
      // ponytail: flow commits must exist locally; cross-host execution needs reviewed commit transfer.
      const isPatchWork = task.kind === 'patch' || (task.kind === 'turn' && task.required_capability.endsWith('.patch'));
      if (isPatchWork || task.flow_id) {
        worktree = await createWorktree(project.root, task.kind==='check' ? 'check' : agent.provider, task);
        if (task.flow_id) {
          const snapshot = await inspectWorktree(worktree);
          if (task.kind!=='patch' && (snapshot.commit!==task.flow?.commit || snapshot.dirty)) throw Object.assign(new Error('Flow snapshot is not the exact clean pinned commit'),{code:'flow_commit_mismatch'});
          if (task.kind==='patch' && task.flow?.commit && worktree.baseCommit!==task.flow.commit) throw Object.assign(new Error('Patch base differs from pinned commit'),{code:'flow_commit_mismatch'});
          observedCommit = snapshot.commit;
        }
      }
      let result: ProcessResult;
      let nativeSession: NativeSession | undefined;
      let nativePlan: ReturnType<typeof prepareNative>;
      try { if (task.kind!=='check') nativePlan = prepareNative(agent, task, worktree?.dir); }
      catch { this.logger('native_session_failed', { task_id: task.id, phase: 'prepare' }); }
      try {
        if (leaseLost || execution.signal.aborted) throw new Error('Execution start was aborted');
        if (task.kind==='check') {
          checkFact = await runFlowCheck(task,project,agent,this.config,worktree!,this.runner,execution.signal);
          result = {exit_code:checkFact.exit_code,signal:null,stdout:checkFact.output_tail,stderr:'',duration_ms:checkFact.duration_ms,stop_reason:checkFact.stop_reason as ProcessResult['stop_reason']};
        } else {
          const request = buildInvocation(agent, project, task, context, this.config, execution.signal, process.env, worktree, nativePlan);
          request.on_progress = value => {
            progress = value;
            updatePartialText(value.stdout_tail, value.output_bytes);
          };
          result = await this.runner(request);
          if (task.flow_id && task.kind!=='patch') {
            const snapshot = await inspectWorktree(worktree!);
            snapshotInvalid = snapshot.dirty || snapshot.commit!==observedCommit;
          }
        }
      } finally {
        if (nativePlan) {
          try { nativeSession = finishNative(nativePlan, project.root, worktree?.dir); }
          catch (error) { cleanupNative(nativePlan); this.logger('native_session_failed', { task_id: task.id, phase: 'copy', message: error instanceof Error ? error.message.slice(0, 200) : '' }); }
        }
        // Whatever the provider did (even if aborted), commit it to the branch and drop the worktree.
        if (worktree && isPatchWork) {
          try { patchResult = await finishWorktree(project.root, agent.provider, task, worktree, this.config.max_output_bytes); }
          catch {
            // Finalization failed: the worktree stays on disk and the task must not read as completed.
            this.logger('worktree_requires_review', { task_id: task.id, dir: worktree.dir });
            finalizeFailure = { worktree_path: worktree.dir, recovery: `edits kept in ${worktree.dir} on branch ${worktree.branch}; commit or remove manually` };
          }
        }
      }
      if (task.flow_id && patchResult) observedCommit = patchResult.head_commit ?? patchResult.base_commit;
      if (leaseLost) return;
      // A provider that stopped because the sandbox denied actions it needed did not finish the task.
      const denied = task.kind==='check' ? [] : deniedActions(agent.provider, result.stdout);
      const outcome = finalizeFailure ? 'failed' : shutdown.aborted || denied.length || snapshotInvalid ? 'blocked' : task.kind==='check' ? (checkFact?.passed ? 'completed' : 'blocked') : providerSucceeded(agent.provider, result) ? 'completed' : 'failed';
      await this.client.call('task_checkpoint', { ...lease, checkpoint: checkpoint('provider_finished') });
      const artifact = await this.client.call<{ artifact: { id: string } }>('artifact_put', {
        ...lease, name: `${agent.id}-transcript.txt`, media_type: 'text/plain',
        content: task.kind==='check' ? JSON.stringify(checkFact) : this.resultArtifact(agent, result)
      });
      let diffArtifact: { artifact: { id: string } } | undefined;
      let diffArtifactError: string | undefined;
      if (patchResult?.diff) {
        // The commit already exists; a failed upload must not lose branch/base/head provenance.
        try { diffArtifact = await this.client.call<{ artifact: { id: string } }>('artifact_put', { ...lease, name: `${agent.id}-patch.diff`, media_type: 'text/x-diff', content: untrusted(patchResult.diff, Buffer.byteLength(patchResult.diff)) }); }
        catch (error) { if (leaseLost) return; diffArtifactError = `${errorCode(error)}: ${error instanceof Error ? error.message.slice(0, 200) : ''}`; }
      }
      if (leaseLost) return;
      // Stop concurrent heartbeats before the terminal update to avoid a harmless
      // post-completion heartbeat being mistaken for a lost lease. Renew once more
      // to give the bounded terminal request a full lease window.
      heartbeatStop.abort();
      await heartbeat;
      if (leaseLost) return;
      await renew();
      if (leaseLost) return;
      let failure = outcome === 'completed' ? undefined : classifyFailure(agent.provider, result);
      if (outcome !== 'completed' && !failure) {
        // The provider finished; the bridge could not commit its worktree (for example gigabytes of untracked build output).
        if (finalizeFailure) failure = { code: 'swarmaa_worktree_commit_failed', retry: false, detail: 'Provider finished but its worktree could not be committed; untracked build output is the usual cause. Edits are kept in the worktree.' };
        else if (denied.length) failure = { code: 'sandbox_denied', retry: false, detail: `Denied actions: ${denied.join(', ')}` };
        else if (shutdown.aborted) failure = { code: 'cancelled', retry: false, detail: 'Task cancelled by shutdown or signal' };
        else failure = { code: 'harness_error', retry: false, detail: 'Harness failed' };
      }
      if (partialTextTimer) {
        clearTimeout(partialTextTimer);
        partialTextTimer = undefined;
      }
      const envelope = (task as any).permission_envelope ?? (task as any).envelope;
      const runnerModel = envelope?.runner?.model ?? envelope?.model ?? (task as any).runner?.model;
      const isTurn = task.kind === 'turn';
      const isEditTurn = isTurn && (isPatchWork || Boolean(envelope?.local_patch));
      // Same rule as buildInvocation: the fast model only for non-edit, non-delegated turns without a runner model.
      const runnerFast = envelope?.runner?.fast, delegated = envelope?.runner?.delegated === true;
      const fastTurn = isTurn && !isEditTurn && !delegated && (runnerModel ? runnerFast === true : Boolean(agent.turn_model) && runnerFast !== false);
      const askedModel = isTurn && !isEditTurn && runnerModel ? runnerModel : fastTurn ? agent.turn_model : agent.model;
      let served: ServedStamp = task.kind === 'check' ? { provider: 'bridge', model: null } : extractServed(agent.provider, result, askedModel);
      if (agent.provider === 'antigravity' && !served.model) {
        const model = await antigravityLogModel(Date.parse(startedAt));
        if (model) served = { provider: 'antigravity', model, ...(askedModel && !sameModel(askedModel, model) ? { substituted: true } : {}) };
      }
      const rawAnswer = task.kind === 'check' ? checkFact!.output_tail : finalAnswer(agent.provider, result.stdout);
      const { cleanAnswer, delegate } = extractDelegate(rawAnswer, !fastTurn);
      const completion = {
        ...lease, outcome, artifact_ids: [artifact.artifact.id, ...(diffArtifact ? [diffArtifact.artifact.id] : [])], result: {
          agent: agent.id, provider: task.kind==='check' ? 'bridge' : agent.provider, execution_completed: outcome === 'completed',
          acceptance_criteria_verified: false, review_required: true,
          exit_code: result.exit_code, stop_reason: result.stop_reason,
          duration_ms: result.duration_ms,
          served,
          ...(failure ? { failure } : {}),
          // The agent's own answer, so callers can read it with task_get; untrusted provider output.
          answer: task.kind==='check' ? checkFact!.output_tail : untrusted(cleanAnswer, 8 * 1024),
          ...(delegate ? { delegate } : {}),
          ...(denied.length ? { denied_actions: denied, next_step: 'This worker cannot run those actions (read-only sandbox). Resubmit with a capability whose worker can, e.g. codex.read, or narrow the task.' } : {}),
          summary: task.kind==='check' ? `Deterministic bridge check ${outcome==='completed' ? 'passed' : 'did not pass'}. See the recorded check evidence.` : outcome === 'completed' ? 'Provider completed. Review the transcript and acceptance criteria before integrating changes.' : 'Provider did not complete successfully. Review the transcript before continuing the task.',
          ...(isPatchWork ? { commands_allowed: true, ...(patchResult ? { branch: patchResult.branch, base_ref: patchResult.base_ref, base_commit: patchResult.base_commit, head_commit: patchResult.head_commit, changed_files: patchResult.changed_files, diffstat: patchResult.diffstat, ...(patchResult.continued ? { continued: true } : {}) } : {}), ...(diffArtifactError ? { diff_artifact_error: diffArtifactError } : {}), ...(finalizeFailure ?? {}) } : {}),
          ...(nativeSession ? { native_session: nativeSession } : {}),
          ...(task.flow_id ? {observed_commit:observedCommit} : {}),
          ...(checkFact ? {check:checkFact} : {}),
          ...(snapshotInvalid ? {reason:'Review changed tracked source or HEAD; pinned evidence is invalid.'} : {}),
          tests_run_by_bridge: task.kind==='check'
        }
      };
      completionAttempted = true;
      try { await this.client.call('task_finish', completion); }
      catch { // A response can be lost after the commit. Retry the exact idempotent result.
        await this.client.call('task_finish', completion);
      }
      finished = true;
      this.logger('task_finished', { task_id: task.id, outcome });
      const branchLine = [patchResult ? `Branch: ${patchResult.branch} @ ${patchResult.head_commit?.slice(0, 7) ?? 'none'} (${patchResult.changed_files} files)` : finalizeFailure?.recovery, nativeSession ? `Resume: ${nativeSession.resume}` : undefined].filter(Boolean).join('\n') || undefined;
      if (task.kind!=='check') await this.recordSession(task, agent, project, context, completion.result.answer, branchLine);
      try { await this.notifyReason(task.id, outcome); }
      catch { this.logger('reason_notification_failed', { task_id: task.id }); }
    } catch (error) {
      if (!leaseLost) {
        this.logger('task_execution_failed', { task_id: task.id, code: errorCode(error) });
        if (completionAttempted) {
          // Never replace an ambiguous successful completion with a different result.
          this.logger('task_finish_unconfirmed', { task_id: task.id });
          return;
        }
        try {
          await this.client.call('task_finish', { ...lease, outcome: 'blocked', result: {
            agent: agent.id, code: errorCode(error), review_required: true,
            ...(task.kind==='check' ? {reason:`Deterministic check could not run: ${errorCode(error)}`,tests_run_by_bridge:true,observed_commit:observedCommit} : {}),
            summary: 'Worker could not complete this attempt. Check local CLI authentication/version, project configuration, context size and service availability.',
            acceptance_criteria_verified: false
          } });
          finished = true;
        } catch { this.logger('task_finish_unconfirmed', { task_id: task.id }); }
      }
    } finally {
      if (partialTextTimer) {
        clearTimeout(partialTextTimer);
        partialTextTimer = undefined;
      }
      if (worktree && !isPatchWork) {
        try { await removeSnapshot(project.root,worktree); } catch { this.logger('snapshot_cleanup_failed',{task_id:task.id}); }
      }
      execution.abort();
      heartbeatStop.abort();
      shutdown.removeEventListener('abort', onShutdown);
      await heartbeat;
      if (expiryTimer) clearTimeout(expiryTimer);
    }
  }

  /** Show the run as a shared chat (`swarm:<task id>`). Best effort: a failure never changes the task outcome. */
  private async recordSession(task: Task, agent: AgentConfig, project: ProjectConfig, context: unknown, answer: string, branchLine?: string): Promise<void> {
    try {
      const harness = { claude: 'claude-code', codex: 'codex', antigravity: 'antigravity' }[agent.provider];
      const key = `swarm:${task.id}`;
      let turns: { role: string; text: string; at?: string | null }[] = [];
      // session_list has no key filter; the 50 newest chats of this harness+scope are enough to find a live run.
      const listed = await this.client.call<{ sessions: { id: string; session_id: string }[] }>('session_list', { scope: task.scope, harness, limit: 50 });
      const existing = listed.sessions.find(x => x.session_id === key);
      if (existing) turns = (await this.client.call<{ session: { turns: typeof turns } }>('session_get', { id: existing.id })).session.turns;
      // Newest continuation instruction (or the objective on the first attempt), unless that text is already recorded.
      const instructions = (context as { task?: { instructions?: { instruction?: unknown }[] } } | null)?.task?.instructions ?? [];
      const latest = [...instructions].reverse().map(i => i.instruction).find((i): i is string => typeof i === 'string');
      const prompt = cleanText(latest ?? task.objective, 8000).slice(0, 8000);
      const now = new Date().toISOString();
      const next = [...turns, ...(turns.some(t => t.role === 'user' && t.text === prompt) ? [] : [{ role: 'user', text: prompt, at: now }]),
        { role: 'assistant', text: (answer.trim() ? answer : '(no answer)').slice(0, 8000 - (branchLine ? branchLine.length + 1 : 0)) + (branchLine ? `\n${branchLine}` : ''), at: now }].slice(-40);
      await this.client.call('session_record', { harness, session_id: key, scope: task.scope, cwd: project.root, task_id: task.id,
        title: `[swarm] ${task.objective.split('\n')[0]!.trim()}`.slice(0, 200), turns: next, ended: true });
    } catch (error) {
      this.logger('session_record_failed', { task_id: task.id, code: errorCode(error) });
    }
  }

  private resultArtifact(agent: AgentConfig, result: ProcessResult): string {
    const header = JSON.stringify({ provider: agent.provider, agent: agent.id, exit_code: result.exit_code, stop_reason: result.stop_reason, duration_ms: result.duration_ms, acceptance_criteria_verified: false });
    // The final answer goes first: clipping keeps the start, and the answer is what readers need.
    const answer = finalAnswer(agent.provider, result.stdout);
    return untrusted(`${header}\n\nANSWER (untrusted provider output)\n${answer || '(none)'}\n\nSTDOUT (untrusted provider output)\n${result.stdout}\n\nSTDERR (untrusted provider diagnostics)\n${result.stderr}`, 240 * 1024);
  }

  private async notifyReason(taskId: string, outcome: string): Promise<void> {
    const reason = this.config.reason;
    if (!reason) return;
    const result = await reasonNotify(reason, this.config.token_env, taskId, outcome, this.runner);
    this.logger(result.exit_code === 0 && !result.stop_reason ? 'reason_notification_sent' : 'reason_notification_failed', { task_id: taskId });
  }
}
