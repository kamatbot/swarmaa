import { setTimeout as delay } from 'node:timers/promises';
import { AUTO_PATCH, AUTO_READ, buildInvocation, capability, deniedActions, finalAnswer, projectCapabilities, providerSucceeded } from './adapters.js';
import { collectUsage, headroom } from '../usage/index.js';
import type { UsageProviderId, UsageSnapshot } from '../usage/types.js';
import { runBoundedProcess } from './process.js';
import { reasonNotify } from './reason.js';
import { cleanupNative, finishNative, prepareNative, type NativeSession } from './native-session.js';
import { createWorktree, finishWorktree, type PatchOutcome, type Worktree } from './worktree.js';
import type { AgentConfig, BridgeConfig, BridgeLogger, Claim, Lease, ProcessResult, ProcessRunner, ProjectConfig, Task, ToolClient } from './types.js';

function cleanText(value: string, maxBytes: number): string {
  // PostgreSQL text cannot contain NUL. Clip by UTF-8 bytes, not character count.
  return Buffer.from(value.replaceAll('\0', '\uFFFD'), 'utf8').subarray(0, maxBytes).toString('utf8');
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
  if (task.scope !== project.scope || !['research', 'review', 'patch'].includes(task.kind) || typeof task.id !== 'string' || !claim.lease_token || !Number.isInteger(claim.lease_generation)) throw new Error('Invalid or misrouted task claim');
  const patch = task.kind === 'patch';
  const candidates = agents.filter(a => project.agents.includes(a.id) && (!patch || (project.allow_patch && a.enable_patch)));
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
  private pollWait?: AbortController;
  private drainTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly config: BridgeConfig,
    private readonly client: ToolClient,
    private readonly logger: BridgeLogger = (event, metadata) => process.stderr.write(`${JSON.stringify({ event, ...metadata })}\n`),
    private readonly runner: ProcessRunner = runBoundedProcess,
    private readonly usage: (providers: UsageProviderId[]) => Promise<UsageSnapshot[]> = providers => collectUsage(providers)
  ) {}

  /** Stop claiming; the run loop and task heartbeats stay alive until every task settles. */
  drain(maxSeconds?: number): void {
    if (this.draining) return;
    this.draining = true;
    this.nextUsageAt = 0;
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
      const snapshots = this.draining ? [] : await this.usage(providers);
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
    let inflight = 0;
    let claimedOnce = false;
    const running = this.running;
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
        this.pollWait = new AbortController();
        const seconds = this.draining ? Math.min(this.config.poll_seconds, this.config.usage_seconds || 30, 30) : this.config.poll_seconds;
        try { await delay(seconds * 1000, undefined, { signal: AbortSignal.any([signal, this.pollWait.signal]) }); } catch { /* shutdown, drain, or the last task finished */ }
        finally { this.pollWait = undefined; }
      }
    }
    await Promise.allSettled([...running]);
  }

  async claimAndRun(projects: ProjectConfig[], signal: AbortSignal, onClaimed?: () => void): Promise<boolean> {
    if (this.draining || signal.aborted) return false;
    const claimStarted = performance.now();
    const claim = await this.client.call<Claim>('task_claim', {
      projects: projects.map(project => {
        const capabilities = projectCapabilities(project, this.config.agents);
        const allowsPatch = capabilities.some(c => c.endsWith('.patch'));
        return { scope: project.scope, capabilities, kinds: allowsPatch ? ['research', 'review', 'patch'] : ['research', 'review'] };
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
    let worktree: Worktree | undefined;
    let patchResult: PatchOutcome | undefined;
    let finalizeFailure: { worktree_path: string; recovery: string } | undefined;
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
          if (finished) return;
          // A refusal is final. An ambiguous failure (slow service, restart, dropped connection) is retried on the
          // next beat: the local deadline armed by the last successful renewal still stops the process before the
          // service's lease can lapse, so files are never written past a lease the service may have reassigned.
          if (!transient(error)) { loseLease(errorCode(error)); return; }
          this.logger('heartbeat_retry', { task_id: task.id, code: errorCode(error) });
        }
      }
    })();
    this.logger('task_claimed', { task_id: task.id, scope: task.scope, provider: agent.provider, kind: task.kind });
    try {
      if (leaseLost) return;
      await this.client.call('task_checkpoint', { ...lease, checkpoint: checkpoint('starting') }, execution.signal);
      const context = await this.client.call('context_get', { scope: task.scope, task_id: task.id, limit: 12 }, execution.signal);
      // Patch work gets its own worktree+branch, so parallel patch tasks on one project never share files.
      if (task.kind === 'patch') worktree = await createWorktree(project.root, agent.provider, task);
      let result: ProcessResult;
      let nativeSession: NativeSession | undefined;
      let nativePlan: ReturnType<typeof prepareNative>;
      try { nativePlan = prepareNative(agent, task, worktree?.dir); }
      catch { this.logger('native_session_failed', { task_id: task.id, phase: 'prepare' }); }
      try {
        const request = buildInvocation(agent, project, task, context, this.config, execution.signal, process.env, worktree, nativePlan);
        request.on_progress = value => { progress = value; };
        if (leaseLost || execution.signal.aborted) throw new Error('Provider start was aborted');
        result = await this.runner(request);
      } finally {
        if (nativePlan) {
          try { nativeSession = finishNative(nativePlan, project.root, worktree?.dir); }
          catch (error) { cleanupNative(nativePlan); this.logger('native_session_failed', { task_id: task.id, phase: 'copy', message: error instanceof Error ? error.message.slice(0, 200) : '' }); }
        }
        // Whatever the provider did (even if aborted), commit it to the branch and drop the worktree.
        if (worktree) {
          try { patchResult = await finishWorktree(project.root, agent.provider, task, worktree, this.config.max_output_bytes); }
          catch {
            // Finalization failed: the worktree stays on disk and the task must not read as completed.
            this.logger('worktree_requires_review', { task_id: task.id, dir: worktree.dir });
            finalizeFailure = { worktree_path: worktree.dir, recovery: `edits kept in ${worktree.dir} on branch ${worktree.branch}; commit or remove manually` };
          }
        }
      }
      if (leaseLost) return;
      // A provider that stopped because the sandbox denied actions it needed did not finish the task.
      const denied = deniedActions(agent.provider, result.stdout);
      const outcome = finalizeFailure ? 'failed' : shutdown.aborted || denied.length ? 'blocked' : providerSucceeded(agent.provider, result) ? 'completed' : 'failed';
      await this.client.call('task_checkpoint', { ...lease, checkpoint: checkpoint('provider_finished') });
      const artifact = await this.client.call<{ artifact: { id: string } }>('artifact_put', {
        ...lease, name: `${agent.id}-transcript.txt`, media_type: 'text/plain',
        content: this.resultArtifact(agent, result)
      });
      let diffArtifact: { artifact: { id: string } } | undefined;
      let diffArtifactError: string | undefined;
      if (patchResult?.diff) {
        // The commit already exists; a failed upload must not lose branch/base/head provenance.
        try { diffArtifact = await this.client.call<{ artifact: { id: string } }>('artifact_put', { ...lease, name: `${agent.id}-patch.diff`, media_type: 'text/x-diff', content: patchResult.diff }); }
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
      const completion = {
        ...lease, outcome, artifact_ids: [artifact.artifact.id, ...(diffArtifact ? [diffArtifact.artifact.id] : [])], result: {
          agent: agent.id, provider: agent.provider, execution_completed: outcome === 'completed',
          acceptance_criteria_verified: false, review_required: true,
          exit_code: result.exit_code, stop_reason: result.stop_reason,
          duration_ms: result.duration_ms,
          // The agent's own answer, so callers can read it with task_get; untrusted provider output.
          answer: cleanText(finalAnswer(agent.provider, result.stdout), 8 * 1024),
          ...(denied.length ? { denied_actions: denied, next_step: 'This worker cannot run those actions (read-only sandbox). Resubmit with a capability whose worker can, e.g. codex.read, or narrow the task.' } : {}),
          summary: outcome === 'completed' ? 'Provider completed. Review the transcript and acceptance criteria before integrating changes.' : 'Provider did not complete successfully. Review the transcript before continuing the task.',
          ...(task.kind === 'patch' ? { commands_allowed: true, ...(patchResult ? { branch: patchResult.branch, base_ref: patchResult.base_ref, base_commit: patchResult.base_commit, head_commit: patchResult.head_commit, changed_files: patchResult.changed_files, diffstat: patchResult.diffstat, ...(patchResult.continued ? { continued: true } : {}) } : {}), ...(diffArtifactError ? { diff_artifact_error: diffArtifactError } : {}), ...(finalizeFailure ?? {}) } : {}),
          ...(nativeSession ? { native_session: nativeSession } : {}),
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
      const branchLine = [patchResult ? `Branch: ${patchResult.branch} @ ${patchResult.head_commit?.slice(0, 7) ?? 'none'} (${patchResult.changed_files} files)` : finalizeFailure?.recovery, nativeSession ? `Resume: ${nativeSession.resume}` : undefined].filter(Boolean).join('\n') || undefined;
      await this.recordSession(task, agent, project, context, completion.result.answer, branchLine);
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
    return cleanText(`${header}\n\nANSWER (untrusted provider output)\n${answer || '(none)'}\n\nSTDOUT (untrusted provider output)\n${result.stdout}\n\nSTDERR (untrusted provider diagnostics)\n${result.stderr}`, 240 * 1024);
  }

  private async notifyReason(taskId: string, outcome: string): Promise<void> {
    const reason = this.config.reason;
    if (!reason) return;
    const result = await reasonNotify(reason, this.config.token_env, taskId, outcome, this.runner);
    this.logger(result.exit_code === 0 && !result.stop_reason ? 'reason_notification_sent' : 'reason_notification_failed', { task_id: taskId });
  }
}
