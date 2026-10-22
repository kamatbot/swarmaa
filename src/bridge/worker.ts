import { setTimeout as delay } from 'node:timers/promises';
import { AUTO_READ, buildInvocation, capability, finalAnswer, projectCapabilities, providerSucceeded } from './adapters.js';
import { collectUsage, headroom } from '../usage/index.js';
import type { UsageProviderId, UsageSnapshot } from '../usage/types.js';
import { runBoundedProcess } from './process.js';
import { reasonNotify } from './reason.js';
import { acquirePatchWorkspaceLock } from './workspace-lock.js';
import type { AgentConfig, BridgeConfig, BridgeLogger, Claim, Lease, ProcessResult, ProcessRunner, ProjectConfig, Task, ToolClient } from './types.js';

function cleanText(value: string, maxBytes: number): string {
  // PostgreSQL text cannot contain NUL. Clip by UTF-8 bytes, not character count.
  return Buffer.from(value.replaceAll('\0', '\uFFFD'), 'utf8').subarray(0, maxBytes).toString('utf8');
}
function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z0-9_]+$/u.test(error.code)) return error.code;
  return 'worker_operation_failed';
}
/** headroom: provider -> percent of quota left, from the latest local usage reading. */
function validateClaim(claim: Claim, project: ProjectConfig, agents: AgentConfig[], headroom: ReadonlyMap<string, number> = new Map()): { task: Task; lease: Lease; agent: AgentConfig } | null {
  if (!claim.task) return null;
  const task = claim.task;
  if (task.scope !== project.scope || !['research', 'review', 'patch'].includes(task.kind) || typeof task.id !== 'string' || !claim.lease_token || !Number.isInteger(claim.lease_generation)) throw new Error('Invalid or misrouted task claim');
  const auto = task.required_capability === AUTO_READ && task.kind !== 'patch';
  const agent = auto
    ? agents.filter(a => project.agents.includes(a.id)).sort((a, b) => (headroom.get(b.provider) ?? 50) - (headroom.get(a.provider) ?? 50))[0]
    : agents.find(a => project.agents.includes(a.id) && task.required_capability === capability(a, task.kind === 'patch'));
  if (!agent || (task.kind === 'patch' && (!project.allow_patch || !agent.enable_patch || agent.provider !== 'claude'))) throw new Error('Service returned a capability this worker did not advertise');
  return { task, agent, lease: { task_id: task.id, lease_token: claim.lease_token, lease_generation: claim.lease_generation as number } };
}

export class BridgeWorker {
  /** Latest local quota headroom per provider, used to pick an agent for auto-routed work. */
  private readonly headroom = new Map<string, number>();
  private nextUsageAt = 0;

  constructor(
    private readonly config: BridgeConfig,
    private readonly client: ToolClient,
    private readonly logger: BridgeLogger = (event, metadata) => process.stderr.write(`${JSON.stringify({ event, ...metadata })}\n`),
    private readonly runner: ProcessRunner = runBoundedProcess,
    private readonly usage: (providers: UsageProviderId[]) => Promise<UsageSnapshot[]> = providers => collectUsage(providers)
  ) {}

  /** Report provider quota to the service between tasks. Failures only delay routing data. */
  async reportUsage(signal: AbortSignal): Promise<void> {
    if (!this.config.usage_seconds || Date.now() < this.nextUsageAt) return;
    this.nextUsageAt = Date.now() + this.config.usage_seconds * 1000;
    const providers = [...new Set(this.config.agents.map(a => a.provider))] as UsageProviderId[];
    try {
      const snapshots = await this.usage(providers);
      for (const s of snapshots) this.headroom.set(s.provider, headroom(s));
      await this.client.call('usage_report', { reports: snapshots.map(s => ({ provider: s.provider, ok: s.ok, windows: s.windows, fetched_at: s.fetched_at,
        ...(s.plan ? { plan: s.plan.slice(0, 80) } : {}), ...(s.error ? { error: s.error.slice(0, 200) } : {}) })) }, signal);
    } catch (error) {
      this.logger('usage_report_failed', { code: errorCode(error) });
    }
  }

  /** Poll projects fairly; one process owns at most one local task at a time. */
  async run(signal: AbortSignal, once = false): Promise<void> {
    while (!signal.aborted) {
      let claimedAny = false;
      await this.reportUsage(signal);
      for (const project of this.config.projects) {
        if (signal.aborted) return;
        try {
          const claimed = await this.claimAndRun(project, signal);
          claimedAny ||= claimed;
          if (once && claimed) return;
        } catch (error) {
          this.logger('bridge_poll_failed', { scope: project.scope, code: errorCode(error) });
        }
      }
      if (once) return;
      if (!claimedAny) {
        try { await delay(this.config.poll_seconds * 1000, undefined, { signal }); } catch { return; }
      }
    }
  }

  async claimAndRun(project: ProjectConfig, signal: AbortSignal): Promise<boolean> {
    const capabilities = projectCapabilities(project, this.config.agents);
    const allowsPatch = capabilities.some(c => c.endsWith('.patch'));
    const claimStarted = performance.now();
    const claim = await this.client.call<Claim>('task_claim', {
      scope: project.scope, capabilities,
      kinds: allowsPatch ? ['research', 'review', 'patch'] : ['research', 'review'],
      lease_seconds: this.config.lease_seconds
    }, signal);
    const valid = validateClaim(claim, project, this.config.agents, this.headroom);
    if (!valid) return false;
    await this.execute(valid.task, valid.lease, valid.agent, project, signal, claimStarted);
    return true;
  }

  private async execute(task: Task, lease: Lease, agent: AgentConfig, project: ProjectConfig, shutdown: AbortSignal, claimStarted: number): Promise<void> {
    const execution = new AbortController();
    const heartbeatStop = new AbortController();
    let leaseLost = false;
    let finished = false;
    let completionAttempted = false;
    let releaseWorkspace: (() => Promise<void>) | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let progress = { output_bytes: 0, stdout_tail: '' };
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
    const checkpoint = (phase: string): Record<string, unknown> => ({
      phase, agent: agent.id, provider: agent.provider, started_at: startedAt,
      output_bytes: progress.output_bytes, partial_output: cleanText(progress.stdout_tail, 8192),
      partial_output_is_untrusted: true
    });
    const heartbeat = (async (): Promise<void> => {
      while (!heartbeatStop.signal.aborted) {
        try { await delay(this.config.heartbeat_seconds * 1000, undefined, { signal: heartbeatStop.signal }); } catch { return; }
        if (finished) return;
        try {
          await renew();
          if (leaseLost) return;
          if (!finished) await this.client.call('task_checkpoint', { ...lease, checkpoint: checkpoint('running') });
        } catch (error) {
          if (!finished) {
            // Ambiguous renewal is treated as loss. Never continue writing local files on faith.
            loseLease(errorCode(error));
          }
          return;
        }
      }
    })();
    this.logger('task_claimed', { task_id: task.id, scope: task.scope, provider: agent.provider, kind: task.kind });
    try {
      if (leaseLost) return;
      await this.client.call('task_checkpoint', { ...lease, checkpoint: checkpoint('starting') }, execution.signal);
      const context = await this.client.call('context_get', { scope: task.scope, task_id: task.id, limit: 12 }, execution.signal);
      const request = buildInvocation(agent, project, task, context, this.config, execution.signal);
      request.on_progress = value => { progress = value; };
      if (task.kind === 'patch') releaseWorkspace = await acquirePatchWorkspaceLock(project.root, task.id);
      if (leaseLost || execution.signal.aborted) throw new Error('Provider start was aborted');
      const result = await this.runner(request);
      if (releaseWorkspace) {
        await releaseWorkspace();
        releaseWorkspace = undefined;
      }
      if (leaseLost) return;
      const outcome = shutdown.aborted ? 'blocked' : providerSucceeded(agent.provider, result) ? 'completed' : 'failed';
      await this.client.call('task_checkpoint', { ...lease, checkpoint: checkpoint('provider_finished') });
      const artifact = await this.client.call<{ artifact: { id: string } }>('artifact_put', {
        ...lease, name: `${agent.id}-transcript.txt`, media_type: 'text/plain',
        content: this.resultArtifact(agent, result)
      });
      if (leaseLost) return;
      // Stop concurrent heartbeats before the terminal update to avoid a harmless
      // post-completion heartbeat being mistaken for a lost lease. Renew once more
      // to give the bounded terminal request a full lease window.
      heartbeatStop.abort();
      await heartbeat;
      if (leaseLost) return;
      await renew();
      if (leaseLost) return;
      const completion = {
        ...lease, outcome, artifact_ids: [artifact.artifact.id], result: {
          agent: agent.id, provider: agent.provider, execution_completed: outcome === 'completed',
          acceptance_criteria_verified: false, review_required: true,
          exit_code: result.exit_code, stop_reason: result.stop_reason,
          duration_ms: result.duration_ms,
          // The agent's own answer, so callers can read it with task_get; untrusted provider output.
          answer: cleanText(finalAnswer(agent.provider, result.stdout), 8 * 1024),
          summary: outcome === 'completed' ? 'Provider completed. Review the transcript and acceptance criteria before integrating changes.' : 'Provider did not complete successfully. Review the transcript before continuing the task.',
          source_only_patch: task.kind === 'patch',
          tests_run_by_bridge: false
        }
      };
      completionAttempted = true;
      try { await this.client.call('task_finish', completion); }
      catch { // A response can be lost after the commit. Retry the exact idempotent result.
        await this.client.call('task_finish', completion);
      }
      finished = true;
      this.logger('task_finished', { task_id: task.id, outcome });
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
            summary: 'Worker could not complete this attempt. Check local CLI authentication/version, project configuration, context size and service availability.',
            acceptance_criteria_verified: false
          } });
          finished = true;
        } catch { this.logger('task_finish_unconfirmed', { task_id: task.id }); }
      }
    } finally {
      execution.abort();
      heartbeatStop.abort();
      shutdown.removeEventListener('abort', onShutdown);
      await heartbeat;
      if (expiryTimer) clearTimeout(expiryTimer);
      if (releaseWorkspace) {
        try { await releaseWorkspace(); }
        catch { this.logger('workspace_lock_requires_review', { task_id: task.id }); }
      }
    }
  }

  private resultArtifact(agent: AgentConfig, result: ProcessResult): string {
    const header = JSON.stringify({ provider: agent.provider, agent: agent.id, exit_code: result.exit_code, stop_reason: result.stop_reason, duration_ms: result.duration_ms, acceptance_criteria_verified: false });
    // The final answer goes first: clipping keeps the start, and the answer is what readers need.
    const answer = finalAnswer(agent.provider, result.stdout);
    return cleanText(`${header}\n\nANSWER (untrusted provider output)\n${answer || '(none)'}\n\nSTDOUT (untrusted provider output)\n${result.stdout}\n\nSTDERR (untrusted provider diagnostics)\n${result.stderr}`, 240 * 1024);
  }

  private async notifyReason(taskId: string, outcome: string): Promise<void> {
    const reason = this.config.reason;
    if (!reason) return;
    const result = await reasonNotify(reason, this.config.token_env, taskId, outcome, this.runner);
    this.logger(result.exit_code === 0 && !result.stop_reason ? 'reason_notification_sent' : 'reason_notification_failed', { task_id: taskId });
  }
}
