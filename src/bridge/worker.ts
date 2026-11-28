import { existsSync } from 'node:fs';
import { runConfiguredChecks, runFlowCheck } from './checks.js';
import { setTimeout as delay } from 'node:timers/promises';
import { AUTO_PATCH, AUTO_READ, buildInvocation, withTurnImages, capability, antigravityLogModel, classifyFailure, deniedActions, extractActivity, extractDelegate, extractPartialText, extractServed, extractUsage, finalAnswer, projectCapabilities, steerLine, steerMarker, providerSucceeded, codexThreadId, sessionMissing, UUID, type ActivityItem } from './adapters.js';
import { collectUsage, headroom } from '../usage/index.js';
import { windowsForModel } from '../usage/antigravity.js';
import type { UsageProviderId, UsageSnapshot } from '../usage/types.js';
import { runBoundedProcess } from './process.js';
import { WarmProviderPool } from './warm-pool.js';
import { sameModel, type ServedStamp } from '../core/failures.js';
import { reasonNotify } from './reason.js';
import { cleanupNative, finishNative, prepareNative, type NativeSession } from './native-session.js';
import { annotateEvidence, contextReceipt } from './context-receipt.js';
import { createWorktree, finishWorktree, inspectWorktree, providerPidfile, removeSnapshot, type PatchOutcome, type Worktree } from './worktree.js';
import type { AgentConfig, BridgeConfig, BridgeLogger, Claim, Lease, ProcessResult, ProcessRunner, ProjectConfig, Provider, Task, ToolClient } from './types.js';
import { redactSecrets } from '../safety/redact.js';
import { botSecrets, scrubSecrets } from './bot-secrets.js';

export function cleanText(value: string, maxBytes: number): string {
  // PostgreSQL text cannot contain NUL. Clip by UTF-8 bytes without splitting multi-byte characters.
  const buf = Buffer.from(value.replaceAll('\0', '\uFFFD'), 'utf8');
  let end = Math.min(buf.length, maxBytes);
  while (end > 0 && end < buf.length && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
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
/**
 * Before the provider starts, a service blip (a deploy restarting it, a dropped connection) is retried for about a
 * minute instead of blocking the task: nothing has run yet, so retrying is safe. A refusal still fails at once.
 */
async function beforeStart<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let wait = 1000; ; wait *= 2) {
    try { return await call(); }
    catch (error) {
      if (!transient(error) || wait > 32_000 || signal.aborted) throw error;
      await delay(wait, undefined, { signal });
    }
  }
}
/** context.task with the task view the 'starting' checkpoint returned (same taskView shape; instructions/runs kept). */
function withStartedTask(context: unknown, started: unknown): unknown {
  const ctx = context as { task?: Record<string, unknown> } | null, next = (started as { task?: Record<string, unknown> } | null)?.task;
  if (!ctx || typeof ctx !== 'object' || !ctx.task || typeof ctx.task !== 'object' || !next || typeof next !== 'object' || next.id !== ctx.task.id) return context;
  return { ...ctx, task: { ...ctx.task, ...next } };
}
const BLOCKED_SUMMARY: Record<string, string> = {
  antigravity_unattended_oauth_disallowed: 'Unattended Antigravity execution cannot run on consumer OAuth. Run interactively via `agy acp` or configure GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_APPLICATION_CREDENTIALS / agent.auth_mode.',
  photo_provider_unsupported: 'This provider does not support photo input; retry with Claude or Codex.',
  not_a_git_repo: 'The project folder is not a git repository, so edit work has no worktree to run in. Run `git init` and commit once in the project folder, then retry.',
  bad_base_ref: 'The branch this task starts from (base_ref) does not exist in the project checkout. Fetch or create it, or retry without base_ref.',
  context_too_large: 'The prompt is larger than this worker allows even after dropping optional memories. Narrow the task, shorten the agent instructions, or remove explicit context references; the sizes are in detail.',
  route_unavailable: 'No provider on this worker can take this auto-routed task right now; retry later or pin a provider.',
  worker_operation_failed: 'Worker could not complete this attempt. Check local CLI authentication/version, project configuration and service availability.'
};
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
  private readonly warmPool: WarmProviderPool;
  private readonly useWarmPool: boolean;
  private wakeTimer?: NodeJS.Timeout;
  private wakePending = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly client: ToolClient,
    private readonly logger: BridgeLogger = (event, metadata) => process.stderr.write(`${JSON.stringify({ event, ...metadata })}\n`),
    private readonly runner: ProcessRunner = runBoundedProcess,
    private readonly usage: (providers: UsageProviderId[]) => Promise<UsageSnapshot[]> = providers => collectUsage(providers, { claudeBinary: config.agents.find(a => a.provider === 'claude')?.binary }),
    streamOptions?: { fetcher?: typeof fetch; token?: string; warmPool?: WarmProviderPool } | typeof fetch
  ) {
    let explicitWarmPool: WarmProviderPool | undefined;
    if (typeof streamOptions === 'function') {
      this.streamFetch = streamOptions;
    } else if (streamOptions) {
      this.streamFetch = streamOptions.fetcher;
      this.streamToken = streamOptions.token;
      explicitWarmPool = streamOptions.warmPool;
    }
    this.warmPool = explicitWarmPool ?? new WarmProviderPool({
      logger: this.logger,
      onModelsUpdated: () => { this.nextUsageAt = 0; },
    });
    this.useWarmPool = this.runner === runBoundedProcess || Boolean(explicitWarmPool);
  }

  private triggerWake(): void {
    if (this.draining) return;
    if (this.pollWait && !this.pollWait.signal.aborted) {
      // Idle in poll sleep: wake immediately (0 ms).
      if (this.wakeTimer) {
        clearTimeout(this.wakeTimer);
        this.wakeTimer = undefined;
      }
      const wait = this.pollWait;
      this.pollWait = undefined;
      wait.abort();
      return;
    }
    // Mid-claim or busy: coalesce bursts over a tiny 15 ms window.
    if (!this.wakeTimer) {
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = undefined;
        if (this.draining) return;
        if (this.pollWait && !this.pollWait.signal.aborted) {
          const wait = this.pollWait;
          this.pollWait = undefined;
          wait.abort();
        } else {
          this.wakePending = true;
        }
      }, 15);
    }
  }

  private projectScopeCapabilities(): Map<string, Set<string>> {
    const scopeCaps = new Map<string, Set<string>>();
    for (const project of this.config.projects) {
      const caps = projectCapabilities(project, this.config.agents);
      const allowsPatch = caps.some(c => c.endsWith('.patch'));
      const allCaps = allowsPatch && project.checks !== undefined ? [...caps, 'bridge.check'] : caps;
      scopeCaps.set(project.scope, new Set(allCaps));
    }
    return scopeCaps;
  }

  private handleSseBlock(block: string, scopeCaps: Map<string, Set<string>>): void {
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

    const payload = (data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload))
      ? data.payload as Record<string, unknown>
      : undefined;
    const name = eventName || String(data.name ?? '');
    const scope = String(data.scope ?? payload?.scope ?? '');
    const status = String(payload?.status ?? data.status ?? '');

    const isSubmitted = name === 'task.submitted';
    const isQueuedUpdate = name === 'task.updated' && status === 'queued';
    if (!isSubmitted && !isQueuedUpdate) return;

    const caps = scopeCaps.get(scope) ?? scopeCaps.get('*');
    if (!caps) return;

    // When the SSE event advertises required_capability, only wake if this worker can actually claim it.
    const rawCap = payload?.required_capability ?? data.required_capability;
    const reqCap = typeof rawCap === 'string' && rawCap.trim() ? rawCap.trim() : undefined;
    if (reqCap && !caps.has(reqCap)) return;

    this.triggerWake();
  }

  private async maintainStream(signal: AbortSignal): Promise<void> {
    const token = this.streamToken ?? (this.client as any).token ?? process.env[this.config.token_env];
    if (!token && !this.streamFetch) {
      return;
    }
    const baseUrl = (this.client as any).origin ?? this.config.service_url;
    const url = `${baseUrl.replace(/\/+$/, '')}/api/stream?after=now`;
    const fetcher = this.streamFetch ?? (this.client as any).fetcher ?? globalThis.fetch;
    const scopeCaps = this.projectScopeCapabilities();

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
        const MAX_SSE_BUFFER_BYTES = 1024 * 1024; // 1 MiB cap; reconnect on overflow
        let buffer = '';
        const decoder = new TextDecoder('utf8');

        try {
          while (!signal.aborted && !this.draining) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
            if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
              throw new Error('SSE buffer exceeded 1 MiB limit');
            }

            let boundary: number;
            while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
              const eventBlock = buffer.slice(0, boundary);
              const match = buffer.slice(boundary).match(/^\r?\n\r?\n/);
              const delimLength = match ? match[0].length : 2;
              buffer = buffer.slice(boundary + delimLength);
              this.handleSseBlock(eventBlock, scopeCaps);
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
    this.warmPool.drain();
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

  /** Immediately terminate all warm resident provider processes. */
  close(): void {
    this.warmPool.closeAll();
  }

  /** Report provider quota and configured/live model catalogs to the service between tasks. Failures only delay routing data. */
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
      await this.client.call('usage_report', {
        reports: snapshots.map(s => {
          const cfgAgent = this.config.agents.find(a => a.provider === s.provider);
          const liveModels = this.warmPool.getCachedModels(s.provider as Provider);
          return {
            provider: s.provider,
            ok: s.ok,
            windows: s.windows,
            fetched_at: s.fetched_at,
            ...(s.plan ? { plan: s.plan.slice(0, 80) } : {}),
            ...(s.error ? { error: s.error.slice(0, 200) } : {}),
            ...(cfgAgent?.model ? { default_model: cfgAgent.model } : {}),
            ...(cfgAgent?.turn_model ? { turn_model: cfgAgent.turn_model } : {}),
            ...(liveModels?.length ? { models: liveModels } : {}),
          };
        }),
        slots: this.draining ? 0 : this.config.max_concurrent,
      }, signal);
    } catch (error) {
      this.logger('usage_report_failed', { code: errorCode(error), message: String((error as Error)?.message ?? error).slice(0, 200) });
    }
  }

  /**
   * One polling loop with `max_concurrent` slots: each pass asks for up to `max_concurrent - inflight`
   * tasks in a single batch `task_claim` RTT across projects, and runs claimed tasks concurrently.
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
        // Homebrew upgrading node deletes the binary this process runs on; macOS then refuses it folder access
        // (EPERM in ~/Documents). Stop claiming and exit once idle so launchd restarts on the new binary.
        if (!this.draining && !existsSync(process.execPath)) { this.logger('node_binary_replaced', { path: process.execPath }); this.drain(); }
        let queueMayHaveMore = false;
        await this.reportUsage(signal);
        for (let i = 0; i < this.config.projects.length; i += 64) {
          const projects = this.config.projects.slice(i, i + 64);
          while (!signal.aborted && !this.draining && !(once && claimedOnce) && inflight < this.config.max_concurrent) {
            const limit = once ? 1 : Math.min(16, this.config.max_concurrent - inflight);
            const claimStarted = performance.now();
            let claimed: { claims: Claim[]; isBatch: boolean };
            try {
              claimed = await this.claimBatch(projects, signal, limit);
            } catch (error) {
              this.logger('bridge_poll_failed', { scope: projects[0]!.scope, code: errorCode(error), message: String((error as Error)?.message ?? error).slice(0, 200) });
              break;
            }
            if (!claimed.claims.length) break;
            claimedOnce = true;
            for (const claim of claimed.claims) {
              let slotReleased = false;
              const releaseSlot = (): void => {
                if (slotReleased) return;
                slotReleased = true;
                const wasAtCapacity = inflight >= this.config.max_concurrent;
                inflight--;
                if (wasAtCapacity && !this.draining && !once) this.pollWait?.abort();
              };
              inflight++;
              const task = this.runClaim(claim, projects, signal, claimStarted, releaseSlot)
                .catch(error => {
                  this.logger('bridge_poll_failed', { scope: claim.task?.scope ?? projects[0]!.scope, code: errorCode(error), message: String((error as Error)?.message ?? error).slice(0, 200) });
                })
                .finally(() => {
                  releaseSlot();
                  running.delete(task);
                  if (!running.size) {
                    if (this.drainTimer) clearTimeout(this.drainTimer);
                    if (this.draining || once) this.pollWait?.abort();
                  }
                });
              running.add(task);
            }
            if (once) { queueMayHaveMore = true; break; }
            // A batch-capable server returning fewer than `limit` claims has drained this slice's queue.
            if (claimed.isBatch && claimed.claims.length < limit) break;
            queueMayHaveMore = true;
          }
        }
        if (once && !running.size) return;
        if (this.draining && !running.size) break;
        if (!queueMayHaveMore) {
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
      this.warmPool.drain();
      await Promise.allSettled([...running, ...(streamTask ? [streamTask] : [])]);
      this.warmPool.closeAll();
    }
  }

  private async claimBatch(projects: ProjectConfig[], signal: AbortSignal, limit: number): Promise<{ claims: Claim[]; isBatch: boolean }> {
    const args: Record<string, unknown> = {
      projects: projects.map(project => {
        const capabilities = projectCapabilities(project, this.config.agents);
        const allowsPatch = capabilities.some(c => c.endsWith('.patch'));
        const checks = allowsPatch && project.checks !== undefined;
        return {
          scope: project.scope,
          capabilities: checks ? [...capabilities, 'bridge.check'] : capabilities,
          kinds: allowsPatch ? ['research', 'review', 'patch', ...(checks ? ['check'] : [])] : ['research', 'review'],
        };
      }),
      lease_seconds: this.config.lease_seconds,
      ...(limit > 1 ? { limit } : {}),
    };
    const response = await this.client.call<Claim>('task_claim', args, signal);
    if (Array.isArray(response?.claims)) {
      return { claims: response.claims.filter(c => Boolean(c?.task)), isBatch: true };
    }
    return { claims: response?.task ? [response] : [], isBatch: false };
  }

  private async runClaim(claim: Claim, projects: ProjectConfig[], signal: AbortSignal, claimStarted: number, onSlotRelease?: () => void, onClaimed?: () => void): Promise<boolean> {
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
    await this.execute(valid.task, valid.lease, valid.agent, project, signal, claimStarted, onSlotRelease);
    return true;
  }

  async claimAndRun(projects: ProjectConfig[], signal: AbortSignal, onClaimed?: () => void, onSlotRelease?: () => void): Promise<boolean> {
    if (this.draining || signal.aborted) return false;
    const claimStarted = performance.now();
    const { claims } = await this.claimBatch(projects, signal, 1);
    if (!claims.length) return false;
    return this.runClaim(claims[0]!, projects, signal, claimStarted, onSlotRelease, onClaimed);
  }

  private async execute(task: Task, lease: Lease, agent: AgentConfig, project: ProjectConfig, shutdown: AbortSignal, claimStarted: number, onSlotRelease?: () => void): Promise<void> {
    const execution = new AbortController();
    const heartbeatStop = new AbortController();
    let leaseLost = false;
    let finished = false;
    let completionAttempted = false;
    let isPatchWork = task.kind === 'patch' || (task.kind === 'turn' && task.required_capability.endsWith('.patch'));
    let worktree: Worktree | undefined;
    // What reached the model, recorded on the result (finished or blocked) so the task can show the context it used.
    let context: unknown;
    let promptText: string | undefined;
    let patchResult: PatchOutcome | undefined;
    let observedCommit:string|undefined;
    let checkFact:Awaited<ReturnType<typeof runFlowCheck>>|undefined;
    let snapshotInvalid = false;
    let checkResults: Awaited<ReturnType<typeof runConfiguredChecks>> | undefined;
    // A retry resumes the provider's own session recorded in this task's checkpoint by an earlier attempt;
    // Antigravity turns may also receive a persistent native_session_id populated from agent_provider_sessions.
    const prior = task.checkpoint as { native_session?: { provider?: unknown; id?: unknown }; last_failure?: unknown } | null;
    const ACP_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/u;
    const taskNativeSessionId = typeof task.native_session_id === 'string' && ACP_SESSION_ID_RE.test(task.native_session_id)
      ? task.native_session_id
      : undefined;
    const priorId = prior?.native_session?.provider === agent.provider && typeof prior.native_session.id === 'string'
      ? (agent.provider === 'antigravity'
        ? (ACP_SESSION_ID_RE.test(prior.native_session.id) ? prior.native_session.id : undefined)
        : (UUID.test(prior.native_session.id) ? prior.native_session.id : undefined))
      : undefined;
    const resumeId = task.kind === 'check'
      ? undefined
      : task.kind === 'turn'
        ? (agent.provider === 'antigravity' ? taskNativeSessionId : undefined)
        : priorId;
    let nativeId = resumeId;
    let lastFailure = typeof prior?.last_failure === 'string' ? prior.last_failure : undefined;
    let finalizeFailure: { worktree_path: string; recovery: string } | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let leaseDeadlineMs = 0;
    let progress = { output_bytes: 0, stdout_tail: '' };
    let currentPartialText = '';
    let lastSentPartialText = '';
    let activityVersion = 0;
    let lastSentActivityVersion = 0;
    let lastCheckpointTime = 0;
    let partialTextTimer: NodeJS.Timeout | undefined;
    let checkpointInFlight = false;
    const activityLog = new Map<string, ActivityItem>();
    // Steering: thread messages the owner sends while a Claude turn runs go into its open stdin (stream-json).
    // The service returns them on checkpoint/heartbeat responses; steered_seq (acknowledged by Claude's replay)
    // tells the service not to start a follow-up turn for them. Unacknowledged ones still get a follow-up turn.
    const steerable = task.kind === 'turn' && agent.provider === 'claude';
    let stdinCtl: { write: (text: string) => boolean; end: () => void } | undefined;
    let steerWritten = 0, steerAcked = 0, steerCount = 0, stdinClosed = false;
    let closeTimer: NodeJS.Timeout | undefined;
    const closeStdin = (): void => {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = undefined; }
      if (stdinClosed) return;
      stdinClosed = true;
      stdinCtl?.end();
    };
    const takeSteers = (response: unknown): void => {
      if (!steerable || stdinClosed || !stdinCtl) return;
      const steer = (response as { steer?: unknown } | undefined)?.steer;
      if (!Array.isArray(steer)) return;
      for (const m of steer as Array<{ seq?: unknown; body?: unknown }>) {
        const seq = Number(m?.seq);
        if (!Number.isSafeInteger(seq) || seq <= steerWritten || typeof m.body !== 'string') continue;
        if (!stdinCtl.write(steerLine(seq, m.body))) return;
        steerWritten = seq; steerCount++;
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = undefined; }
        this.logger('turn_steered', { task_id: task.id, seq });
      }
    };
    // An unescaped "type":"…" is JSON structure (quotes inside string values are escaped). Claude puts it
    // first in most events but near the end of its result event, so look at both ends of the line.
    const eventType = (head: string, tail: string): string | undefined => {
      const first = /^\{\s*"type"\s*:\s*"([a-z_]+)"/u.exec(head)?.[1];
      if (first) return first;
      if (/"type"\s*:\s*"result"/u.test(tail) && /"subtype"|"terminal_reason"|"is_error"/u.test(head + tail)) return 'result';
      return undefined;
    };
    const onLine = (head: string, tail: string): void => {
      if (!head.startsWith('{')) return;
      const type = eventType(head, tail);
      if (type === 'result') {
        // No steer: the turn is over, close now. After a steer, wait briefly: Claude starts another turn for a
        // queued message (any new line cancels the close); EOF never aborts a turn already started.
        if (!steerCount) closeStdin();
        else if (!closeTimer && !stdinClosed) closeTimer = setTimeout(closeStdin, 2500);
        return;
      }
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = undefined; }
      if (type === 'user' && steerWritten > steerAcked) {
        for (let seq = steerWritten; seq > steerAcked; seq--) if (head.includes(steerMarker(seq))) { steerAcked = seq; break; }
      }
    };
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
      leaseDeadlineMs = requestStarted + this.config.lease_seconds * 1000;
      const remaining = leaseDeadlineMs - 4000 - performance.now();
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
      if (nativeId) base.native_session = { provider: agent.provider, id: nativeId };
      if (lastFailure) base.last_failure = lastFailure;
      if (steerable && !stdinClosed && stdinCtl) base.steer_after_seq = steerWritten;
      if (steerAcked) base.steered_seq = steerAcked;
      if (task.kind === 'turn') {
        base.partial_text = untrusted(currentPartialText, 8192);
      }
      // The tail holds only the latest output: keep what earlier checkpoints saw (updated in place, newest 20).
      for (const item of extractActivity(agent.provider, progress.stdout_tail)) activityLog.set(item.id, item);
      while (activityLog.size > 20) activityLog.delete(activityLog.keys().next().value!);
      if (activityLog.size) base.activity = [...activityLog.values()];
      return base;
    };
    const sendPartialCheckpoint = async (): Promise<void> => {
      if (finished || leaseLost || execution.signal.aborted || heartbeatStop.signal.aborted) return;
      if (checkpointInFlight) return;
      if (currentPartialText === lastSentPartialText && activityVersion === lastSentActivityVersion) return;

      checkpointInFlight = true;
      const sentText = currentPartialText;
      const sentActivity = activityVersion;
      try {
        // Checkpoint only: lease renewal stays with the heartbeat loop.
        takeSteers(await this.client.call('task_checkpoint', { ...lease, checkpoint: checkpoint('running') }));
        lastSentPartialText = sentText;
        lastSentActivityVersion = sentActivity;
        lastCheckpointTime = Date.now();
      } catch (error) {
        if (!transient(error)) { loseLease(errorCode(error)); return; }
        this.logger('checkpoint_retry', { task_id: task.id, code: errorCode(error) });
      } finally {
        checkpointInFlight = false;
        if ((currentPartialText !== lastSentPartialText || activityVersion !== lastSentActivityVersion) && !finished && !leaseLost) {
          schedulePartialCheckpoint();
        }
      }
    };
    const schedulePartialCheckpoint = (): void => {
      if (finished || leaseLost || execution.signal.aborted || heartbeatStop.signal.aborted || partialTextTimer) return;
      const now = Date.now();
      const elapsed = now - lastCheckpointTime;
      // Match the service's 3 s event throttle so a streaming turn does not take the scope lock twice as often.
      if (elapsed >= 3000) {
        void sendPartialCheckpoint();
      } else {
        partialTextTimer = setTimeout(() => {
          partialTextTimer = undefined;
          void sendPartialCheckpoint();
        }, 3000 - elapsed);
      }
    };
    const updatePartialText = (stdoutTail: string, stdoutBytes: number): void => {
      if (task.kind !== 'turn') return;

      const tailBuf = Buffer.from(stdoutTail, 'utf8');
      const tailStartOffset = Math.max(0, stdoutBytes - tailBuf.length);
      const newBytesStart = Math.max(0, streamParserState.totalProcessedBytes - tailStartOffset);
      const newBuf = tailBuf.subarray(newBytesStart);
      const lastLf = newBuf.lastIndexOf(10); // '\n'

      if (lastLf >= 0) {
        const completeLinesBuf = newBuf.subarray(0, lastLf + 1);
        streamParserState.totalProcessedBytes = tailStartOffset + newBytesStart + completeLinesBuf.length;
        const chunkText = completeLinesBuf.toString('utf8');
        const extracted = extractPartialText(agent.provider, chunkText);
        if (extracted) {
          if (agent.provider === 'claude' || agent.provider === 'antigravity') {
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

      for (const item of extractActivity(agent.provider, stdoutTail)) {
        const prev = activityLog.get(item.id);
        if (!prev || prev.state !== item.state || prev.label !== item.label) {
          activityLog.set(item.id, item);
          activityVersion++;
        }
      }
      while (activityLog.size > 20) activityLog.delete(activityLog.keys().next().value!);

      if (currentPartialText !== lastSentPartialText || activityVersion !== lastSentActivityVersion) {
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
            takeSteers(await this.client.call('task_checkpoint', { ...lease, checkpoint: checkpoint('running') }));
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
      if (task.kind === 'turn' || task.kind === 'check') {
        // task_claim already delivers agent, thread_messages, agents, and project_bots for turns; checks need no context.
        const started = await beforeStart(() => this.client.call('task_checkpoint', { ...lease, checkpoint: checkpoint('starting') }, execution.signal), execution.signal);
        context = withStartedTask({ scope: task.scope, task, memories: [], conflicts: [] }, started);
      } else {
        // Independent reads/writes, so one round trip instead of two. The only coupling: context.task is the task row,
        // and serially it showed the 'starting' checkpoint and version. Overlay the checkpoint's returned row so the
        // prompt is the same whichever finishes first. A refused checkpoint still fails the attempt before anything runs.
        const [started, fetched] = await Promise.all([
          beforeStart(() => this.client.call('task_checkpoint', { ...lease, checkpoint: checkpoint('starting') }, execution.signal), execution.signal),
          beforeStart(() => this.client.call('context_get', { scope: task.scope, task_id: task.id, limit: 12 }, execution.signal), execution.signal),
        ]);
        context = withStartedTask(fetched, started);
      }
      // Patch work gets its own worktree+branch, so parallel patch tasks on one project never share files.
      // ponytail: flow commits must exist locally; cross-host execution needs reviewed commit transfer.
      const isPatchWork = task.kind === 'patch' || (task.kind === 'turn' && task.required_capability.endsWith('.patch'));
      if (isPatchWork || task.flow_id) {
        worktree = await createWorktree(project.root, task.kind==='check' ? 'check' : agent.provider, task, this.logger);
        if (task.flow_id) {
          const snapshot = await inspectWorktree(worktree);
          if (task.kind!=='patch' && (snapshot.commit!==task.flow?.commit || snapshot.dirty)) throw Object.assign(new Error('Flow snapshot is not the exact clean pinned commit'),{code:'flow_commit_mismatch'});
          if (task.kind==='patch' && task.flow?.commit && worktree.baseCommit!==task.flow.commit) throw Object.assign(new Error('Patch base differs from pinned commit'),{code:'flow_commit_mismatch'});
          observedCommit = snapshot.commit;
        }
      }
      if (task.kind !== 'turn' && task.kind !== 'check') await annotateEvidence(context, project.root, worktree?.baseCommit ?? task.base_ref ?? 'HEAD');
      let result: ProcessResult;
      let nativeSession: NativeSession | undefined;
      let nativePlan: ReturnType<typeof prepareNative>;
      try { if (task.kind!=='check') nativePlan = prepareNative(agent, task, worktree?.dir, undefined, undefined, resumeId ? { id: resumeId, projectRoot: project.root } : undefined); }
      catch { this.logger('native_session_failed', { task_id: task.id, phase: 'prepare' }); }
      // Claude resumes only when its transcript was put back (plan.resumed); Codex and Antigravity ACP resume by session id.
      const resumed = agent.provider === 'codex' || agent.provider === 'antigravity' || nativePlan?.resumed ? resumeId : undefined;
      try {
        if (leaseLost || execution.signal.aborted) throw new Error('Execution start was aborted');
        if (task.kind==='check') {
          checkFact = await runFlowCheck(task,project,agent,this.config,worktree!,this.runner,execution.signal);
          result = {exit_code:checkFact.exit_code,signal:null,stdout:checkFact.output_tail,stderr:'',duration_ms:checkFact.duration_ms,stop_reason:checkFact.stop_reason as ProcessResult['stop_reason']};
        } else {
          result = await withTurnImages(agent, task, context, async images => {
          // Secrets the owner added for this project in the Mac app (a bot asked with question_ask credential).
          const secrets = task.kind === 'turn' ? await botSecrets(task.scope) : {};
          const scrub = (s: string) => scrubSecrets(images.length ? s.replace(/[A-Za-z0-9+/]{128,}={0,2}/gu, "[photo removed]") : s, secrets);
          const go = async (id?: string): Promise<ProcessResult> => {
            const request = buildInvocation(agent, project, task, context, this.config, execution.signal, process.env, worktree, nativePlan, images, id || lastFailure ? { id, note: lastFailure } : undefined);
            promptText = request.prompt;
            if (worktree && isPatchWork) request.pidfile = providerPidfile(worktree.dir);
            if (request.keep_stdin_open) {
              // A retry in this attempt (missing session) starts over with a fresh stdin.
              stdinClosed = false; steerCount = 0; steerWritten = steerAcked;
              request.on_stdin = ctl => { stdinCtl = ctl; };
              request.on_line = onLine;
            }
            Object.assign(request.env, secrets);
            request.on_progress = value => {
              // ACP's tail is answer text, not CLI JSON lines: its text and activity arrive via onPartialText/onActivity,
              // so scanning it would turn JSON-looking answer lines into fake partial text or activity rows.
              if (request.acp && this.useWarmPool) { progress = { ...value, stdout_tail: '' }; return; }
              progress = images.length ? { ...value, stdout_tail: "" } : { ...value, stdout_tail: scrubSecrets(value.stdout_tail, secrets) };
              updatePartialText(progress.stdout_tail, value.stdout_bytes ?? value.output_bytes);
            };
            const output = request.acp && this.useWarmPool
              ? await this.warmPool.runAcp(request, { projectRoot: project.root, patch: isPatchWork }, {
                  onPartialText: text => {
                    currentPartialText = scrub(text);
                    if (currentPartialText !== lastSentPartialText) schedulePartialCheckpoint();
                  },
                  onActivity: item => {
                    const nextItem = { ...item, label: scrubSecrets(item.label, secrets) };
                    const prev = activityLog.get(item.id);
                    if (!prev || prev.state !== nextItem.state || prev.label !== nextItem.label) {
                      activityLog.set(item.id, nextItem);
                      activityVersion++;
                      while (activityLog.size > 20) activityLog.delete(activityLog.keys().next().value!);
                      schedulePartialCheckpoint();
                    }
                  },
                })
              : this.useWarmPool && agent.provider === 'claude' && task.kind === 'turn' && !isPatchWork && !nativePlan
                ? await this.warmPool.runClaude(request, {
                    projectRoot: project.root,
                    model: request.pool_meta?.model,
                    effort: request.pool_meta?.effort,
                    lightChat: Boolean(request.pool_meta?.light_chat),
                    patch: false,
                  }, this.runner)
                : await this.runner(request);
            closeStdin();
            return { ...output, stdout: scrub(output.stdout), stderr: scrub(output.stderr) };
          };
          const first = await go(resumed);
          if (!resumed || providerSucceeded(agent.provider, first) || !sessionMissing(first)) return first;
          // The CLI no longer has that session: one fresh session in this same attempt.
          this.logger('resume_session_missing', { task_id: task.id });
          if (nativePlan) { cleanupNative(nativePlan); try { nativePlan = prepareNative(agent, task, worktree?.dir); } catch { nativePlan = undefined; } }
          return go(undefined);
          });
          nativeId = agent.provider === 'codex' ? codexThreadId(result.stdout) ?? nativeId : nativePlan?.id ?? nativeId;
          if (agent.provider === 'antigravity') {
            try {
              const parsed = JSON.parse(result.stdout) as { session_id?: unknown };
              if (typeof parsed.session_id === 'string' && ACP_SESSION_ID_RE.test(parsed.session_id)) {
                nativeId = parsed.session_id;
                if (!nativeSession) {
                  nativeSession = { harness: 'antigravity', id: parsed.session_id, resume: `agy --resume ${parsed.session_id}` };
                }
              }
            } catch { /* non-ACP or non-JSON */ }
          }
          // Owner-configured checks judge the patch before it is committed; a flow's own check steps cover flow patches.
          if (task.kind === 'patch' && !task.flow_id && worktree && project.checks && Object.keys(project.checks).length && providerSucceeded(agent.provider, result) && !leaseLost && !execution.signal.aborted)
            checkResults = await runConfiguredChecks(project, agent, this.config, worktree, this.runner, execution.signal);
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
        // Commit only while this worker still holds the lease. A lost lease leaves the worktree
        // for the next attempt; committing here races a worker that has already been given the task.
        if (worktree && isPatchWork && !leaseLost) {
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
      const failedChecks = checkResults?.filter(c => !c.passed) ?? [];
      const outcome = finalizeFailure ? 'failed' : shutdown.aborted || denied.length || snapshotInvalid ? 'blocked' : task.kind==='check' ? (checkFact?.passed ? 'completed' : 'blocked') : providerSucceeded(agent.provider, result) && !failedChecks.length ? 'completed' : 'failed';
      // What the next (resumed) attempt is told about why this one failed. Persist via checkpoint only on failure
      // so the happy path stays 1 atomic RTT while retries still receive last_failure + native_session.
      if (outcome === 'failed') {
        lastFailure = untrusted(failedChecks.length
          ? `Configured checks failed:\n${failedChecks.map(c => `${c.name} (exit ${c.exit_code ?? 'none'}${c.stop_reason ? `, ${c.stop_reason}` : ''}):\n${c.output_tail.slice(-1500)}`).join('\n')}`
          : classifyFailure(agent.provider, result)?.detail ?? 'The previous attempt failed.', 3000);
        await this.client.call('task_checkpoint', { ...lease, checkpoint: checkpoint('provider_finished') });
      }
      // Stop concurrent heartbeats before the terminal update to avoid a harmless
      // post-completion heartbeat being mistaken for a lost lease. Only renew if
      // remaining lease time is under 30 s so normal finishes complete in 1 atomic RTT.
      heartbeatStop.abort();
      await heartbeat;
      if (leaseLost) return;
      if (leaseDeadlineMs - performance.now() < 30_000) {
        await renew();
        if (leaseLost) return;
      }
      let failure: ReturnType<typeof classifyFailure> = outcome === 'completed' ? undefined : failedChecks.length && !finalizeFailure
        ? { code: 'swarmaa_checks_failed', retry: true, detail: `Configured checks failed: ${failedChecks.map(c => c.name).join(', ')}` }
        : classifyFailure(agent.provider, result);
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
      const runnerFast = envelope?.runner?.fast, delegated = envelope?.runner?.delegated === true, isRouter = envelope?.runner?.router === true;
      const usedTurnModel = isTurn && !isEditTurn && !delegated && !runnerModel && Boolean(agent.turn_model) && runnerFast !== false;
      const fastTurn = isTurn && !isEditTurn && !delegated && !isRouter && (runnerModel ? runnerFast === true : Boolean(agent.turn_model) && runnerFast !== false);
      const askedModel = runnerModel ?? (usedTurnModel ? agent.turn_model : agent.model);
      let served: ServedStamp = task.kind === 'check' ? { provider: 'bridge', model: null } : extractServed(agent.provider, result, askedModel);
      if (agent.provider === 'antigravity' && !served.model) {
        const model = await antigravityLogModel(Date.parse(startedAt));
        if (model) served = { provider: 'antigravity', model, ...(askedModel && !sameModel(askedModel, model) ? { substituted: true } : {}) };
      }
      const rawAnswer = task.kind === 'check' ? checkFact!.output_tail : finalAnswer(agent.provider, result.stdout);
      const { cleanAnswer, delegate } = extractDelegate(rawAnswer, !fastTurn);
      const usage = task.kind === 'check' ? undefined : extractUsage(agent.provider, result.stdout);
      const transcriptArtifact = {
        name: `${agent.id}-transcript.txt`,
        media_type: 'text/plain',
        content: task.kind === 'check' ? JSON.stringify(checkFact) : this.resultArtifact(agent, result),
      };
      const diffArtifactPayload = patchResult?.diff
        ? {
            name: `${agent.id}-patch.diff`,
            media_type: 'text/x-diff',
            content: untrusted(patchResult.diff, Buffer.byteLength(patchResult.diff)),
          }
        : undefined;
      const inlineArtifacts = [transcriptArtifact, ...(diffArtifactPayload ? [diffArtifactPayload] : [])];
      const baseResult = {
        agent: agent.id, provider: task.kind==='check' ? 'bridge' : agent.provider, execution_completed: outcome === 'completed',
        acceptance_criteria_verified: false, review_required: true,
        exit_code: result.exit_code, stop_reason: result.stop_reason,
        duration_ms: result.duration_ms,
        ...(usage ? { usage } : {}),
        served,
        ...(failure ? { failure } : {}),
        ...(task.kind !== 'check' ? { context_used: contextReceipt(task, context, promptText, this.config.max_prompt_bytes, worktree?.baseRef ?? task.base_ref ?? null) } : {}),
        // The agent's own answer, so callers can read it with task_get; untrusted provider output.
        answer: task.kind==='check' ? checkFact!.output_tail : untrusted(cleanAnswer, 8 * 1024),
        ...(delegate ? { delegate } : {}),
        ...(denied.length ? { denied_actions: denied, next_step: 'This worker cannot run those actions (read-only sandbox). Resubmit with a capability whose worker can, e.g. codex.read, or narrow the task.' } : {}),
        summary: task.kind==='check' ? `Deterministic bridge check ${outcome==='completed' ? 'passed' : 'did not pass'}. See the recorded check evidence.` : failedChecks.length ? 'Provider finished but the configured checks failed. See checks for their output.' : outcome === 'completed' ? 'Provider completed. Review the transcript and acceptance criteria before integrating changes.' : 'Provider did not complete successfully. Review the transcript before continuing the task.',
        ...(isPatchWork ? { commands_allowed: true, ...(patchResult ? { branch: patchResult.branch, base_ref: patchResult.base_ref, base_commit: patchResult.base_commit, head_commit: patchResult.head_commit, changed_files: patchResult.changed_files, diffstat: patchResult.diffstat, ...(patchResult.continued ? { continued: true } : {}) } : {}), ...(finalizeFailure ?? {}) } : {}),
        ...(nativeSession ? { native_session: nativeSession } : {}),
        ...(task.flow_id ? {observed_commit:observedCommit} : {}),
        ...(checkFact ? {check:checkFact} : {}),
        ...(checkResults ? { checks: checkResults, checks_passed: !failedChecks.length } : {}),
        ...(snapshotInvalid ? {reason:'Review changed tracked source or HEAD; pinned evidence is invalid.'} : {}),
        tests_run_by_bridge: task.kind==='check'
      };
      const completion = {
        ...lease, outcome, inline_artifacts: inlineArtifacts, result: baseResult
      };
      completionAttempted = true;
      try {
        await this.client.call('task_finish', completion);
      } catch (finishErr) {
        const status = finishErr && typeof finishErr === 'object' && 'status' in finishErr && typeof (finishErr as { status?: unknown }).status === 'number'
          ? (finishErr as { status: number }).status
          : undefined;
        const code = errorCode(finishErr);
        const shouldFallbackToArtifactPut =
          (status === 400 && code === 'invalid_arguments') ||
          (Boolean(diffArtifactPayload) && code === 'artifact_too_large');
        if (shouldFallbackToArtifactPut) {
          // Backwards compatibility with older servers (or oversized diff): upload artifacts separately and retry.
          const artifact = await this.client.call<{ artifact: { id: string } }>('artifact_put', {
            ...lease,
            name: transcriptArtifact.name,
            media_type: transcriptArtifact.media_type,
            content: transcriptArtifact.content,
          });
          let diffArtifact: { artifact: { id: string } } | undefined;
          let diffArtifactError: string | undefined;
          if (diffArtifactPayload) {
            // The commit already exists; a failed upload must not lose branch/base/head provenance.
            try {
              diffArtifact = await this.client.call<{ artifact: { id: string } }>('artifact_put', {
                ...lease,
                name: diffArtifactPayload.name,
                media_type: diffArtifactPayload.media_type,
                content: diffArtifactPayload.content,
              });
            } catch (error) {
              if (leaseLost) return;
              diffArtifactError = `${errorCode(error)}: ${error instanceof Error ? error.message.slice(0, 200) : ''}`;
            }
          }
          if (leaseLost) return;
          const fallbackCompletion = {
            ...lease,
            outcome,
            artifact_ids: [artifact.artifact.id, ...(diffArtifact ? [diffArtifact.artifact.id] : [])],
            result: diffArtifactError ? { ...baseResult, diff_artifact_error: diffArtifactError } : baseResult,
          };
          try { await this.client.call('task_finish', fallbackCompletion); }
          catch { await this.client.call('task_finish', fallbackCompletion); }
        } else {
          // A response can be lost after the commit. Retry the exact idempotent result.
          await this.client.call('task_finish', completion);
        }
      }
      finished = true;
      this.logger('task_finished', { task_id: task.id, outcome });
      // Release the concurrency slot before best-effort session recording and notifications so the next claim is not blocked.
      onSlotRelease?.();
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
            ...(error && typeof error === 'object' && 'detail' in error ? { detail: (error as { detail: unknown }).detail } : {}),
            ...(context !== undefined && task.kind !== 'check' ? { context_used: contextReceipt(task, context, promptText, this.config.max_prompt_bytes, worktree?.baseRef ?? task.base_ref ?? null) } : {}),
            ...(task.kind==='check' ? {reason:`Deterministic check could not run: ${errorCode(error)}`,tests_run_by_bridge:true,observed_commit:observedCommit} : {}),
            summary: BLOCKED_SUMMARY[errorCode(error)] ?? `Worker could not complete this attempt (${errorCode(error)}). Check local CLI authentication/version, project configuration and service availability.`,
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
