// Provider support matrix: a live smoke test against real CLIs and running Swarmaa swarm.
// Scenarios per provider: answer, served, continue, patch, cancel, notify.
// Exit 1 on any FAIL; output table + JSON report in .local/smoke-providers/<timestamp>.json.
// Usage: npm run smoke:providers [-- --providers claude,codex,antigravity] [--scope project:general] [--patch-scope <scope>] [--timeout 300] [--as notchtrader]
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { collectUsage, headroom as calcHeadroom } from '../src/usage/index.js';
import type { UsageProviderId } from '../src/usage/types.js';

export type ScenarioName = 'answer' | 'served' | 'continue' | 'patch' | 'cancel' | 'notify';
export type ScenarioVerdict = 'PASS' | 'FAIL' | 'SKIP';

export interface ScenarioResult {
  scenario: ScenarioName;
  verdict: ScenarioVerdict;
  duration_ms: number;
  reason?: string;
}

export interface TaskResultData {
  provider?: string;
  served?: { provider?: string };
  answer?: string;
  changed_files?: number;
  branch?: string;
  diffstat?: string;
  exit_code?: number;
  stop_reason?: string;
  [key: string]: unknown;
}

export interface TaskView {
  id: string;
  status: string;
  version: number;
  result?: TaskResultData;
  artifact_ids?: string[];
  [key: string]: unknown;
}

export interface ProviderResult {
  provider: string;
  version?: string;
  headroom?: number;
  scenarios: Record<ScenarioName, ScenarioResult>;
}

export interface SmokeMatrixReport {
  timestamp: string;
  scope: string;
  patch_scope?: string;
  cli_versions: Record<string, string>;
  providers: ProviderResult[];
  summary: {
    total_scenarios: number;
    passed: number;
    failed: number;
    skipped: number;
    all_passed: boolean;
  };
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'blocked']);
export const isTerminal = (status: string): boolean => TERMINAL_STATUSES.has(status);

/** Scenario 1 verdict: research/review task returns exact nonce. */
export function judgeAnswer(
  task: TaskView | null | undefined,
  expectedNonce: string,
  timedOut = false,
  timeoutSec = 300,
  durationMs = 0,
): ScenarioResult {
  if (timedOut) {
    return {
      scenario: 'answer',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: `timed out after ${timeoutSec}s waiting for answer`,
    };
  }
  if (!task) {
    return {
      scenario: 'answer',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: 'no task returned or task submission failed',
    };
  }
  if (task.status !== 'completed') {
    const exit = task.result?.exit_code !== undefined ? ` (exit ${task.result.exit_code})` : '';
    const stop = task.result?.stop_reason ? ` (stop: ${task.result.stop_reason})` : '';
    return {
      scenario: 'answer',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: `task ended with status "${task.status}"${exit}${stop}`,
    };
  }
  const answer = String(task.result?.answer ?? '');
  if (!answer.includes(expectedNonce)) {
    return {
      scenario: 'answer',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: `missing nonce in answer (expected to contain "${expectedNonce}")`,
    };
  }
  return {
    scenario: 'answer',
    verdict: 'PASS',
    duration_ms: durationMs,
  };
}

/** Scenario 2 verdict: ran on the expected provider (HarnessRouter rule 1). */
export function judgeServed(
  task: TaskView | null | undefined,
  expectedProvider: string,
  durationMs = 0,
): ScenarioResult {
  if (!task || !task.result) {
    return {
      scenario: 'served',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: 'task result not available',
    };
  }
  const servedObj = task.result.served as { provider?: string } | undefined;
  const actualProvider = servedObj?.provider ?? task.result.provider;
  if (!actualProvider) {
    return {
      scenario: 'served',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: 'no served provider recorded in task result',
    };
  }
  if (actualProvider !== expectedProvider) {
    return {
      scenario: 'served',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: `served by "${actualProvider}" instead of "${expectedProvider}" (HarnessRouter rule 1)`,
    };
  }
  return {
    scenario: 'served',
    verdict: 'PASS',
    duration_ms: durationMs,
  };
}

/** Scenario 3 verdict: continuation recalls the nonce. */
export function judgeContinue(
  task: TaskView | null | undefined,
  expectedNonce: string,
  timedOut = false,
  timeoutSec = 300,
  durationMs = 0,
): ScenarioResult {
  if (timedOut) {
    return {
      scenario: 'continue',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: `timed out after ${timeoutSec}s waiting for continuation`,
    };
  }
  if (!task) {
    return {
      scenario: 'continue',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: 'continuation task not found or continuation call failed',
    };
  }
  if (task.status !== 'completed') {
    return {
      scenario: 'continue',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: `continuation ended with status "${task.status}"`,
    };
  }
  const answer = String(task.result?.answer ?? '');
  if (!answer.includes(expectedNonce)) {
    return {
      scenario: 'continue',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: `missing nonce in continuation answer (expected to contain "${expectedNonce}")`,
    };
  }
  return {
    scenario: 'continue',
    verdict: 'PASS',
    duration_ms: durationMs,
  };
}

/** Scenario 4 verdict: patch task modified exact file. */
export function judgePatch(opts: {
  patchScope?: string;
  task?: TaskView | null;
  expectedNonce?: string;
  diffContent?: string;
  timedOut?: boolean;
  timeoutSec?: number;
  durationMs?: number;
}): ScenarioResult {
  const durationMs = opts.durationMs ?? 0;
  if (!opts.patchScope) {
    return {
      scenario: 'patch',
      verdict: 'SKIP',
      duration_ms: durationMs,
      reason: 'pass --patch-scope <scope> where project has allow_patch: true',
    };
  }
  if (opts.timedOut) {
    return {
      scenario: 'patch',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: `timed out after ${opts.timeoutSec ?? 300}s waiting for patch task`,
    };
  }
  if (!opts.task) {
    return {
      scenario: 'patch',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: 'patch task not found or submission failed',
    };
  }
  if (opts.task.status !== 'completed') {
    return {
      scenario: 'patch',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: `patch task ended with status "${opts.task.status}"`,
    };
  }
  const changedFiles = typeof opts.task.result?.changed_files === 'number' ? opts.task.result.changed_files : 0;
  if (changedFiles < 1) {
    return {
      scenario: 'patch',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: `changed_files is ${changedFiles} (expected >= 1)`,
    };
  }
  if (opts.expectedNonce) {
    const expectedFile = `smoke/${opts.expectedNonce}.txt`;
    if (opts.diffContent !== undefined && !opts.diffContent.includes(expectedFile)) {
      return {
        scenario: 'patch',
        verdict: 'FAIL',
        duration_ms: durationMs,
        reason: `branch diff does not contain "${expectedFile}"`,
      };
    }
  }
  return {
    scenario: 'patch',
    verdict: 'PASS',
    duration_ms: durationMs,
  };
}

/** Scenario 5 verdict: task cancelled within 30s and worker slot freed within 60s. */
export function judgeCancel(opts: {
  status?: string;
  cancelledWithin30s: boolean;
  slotFreedWithin60s: boolean;
  timedOut?: boolean;
  timeoutSec?: number;
  durationMs?: number;
}): ScenarioResult {
  const durationMs = opts.durationMs ?? 0;
  if (opts.timedOut) {
    return {
      scenario: 'cancel',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: `timed out after ${opts.timeoutSec ?? 300}s`,
    };
  }
  if (!opts.cancelledWithin30s) {
    return {
      scenario: 'cancel',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: `task status was not cancelled within 30s (status: "${opts.status ?? 'unknown'}")`,
    };
  }
  if (!opts.slotFreedWithin60s) {
    return {
      scenario: 'cancel',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: 'worker slot was not freed within 60s',
    };
  }
  return {
    scenario: 'cancel',
    verdict: 'PASS',
    duration_ms: durationMs,
  };
}

/** Scenario 6 verdict: task_finished notification found in submitter inbox. */
export function judgeNotify(opts: {
  notificationFound: boolean;
  timedOut?: boolean;
  timeoutSec?: number;
  durationMs?: number;
}): ScenarioResult {
  const durationMs = opts.durationMs ?? 0;
  if (opts.timedOut) {
    return {
      scenario: 'notify',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: `timed out after ${opts.timeoutSec ?? 300}s waiting for inbox notification`,
    };
  }
  if (!opts.notificationFound) {
    return {
      scenario: 'notify',
      verdict: 'FAIL',
      duration_ms: durationMs,
      reason: 'task_finished notification not found in inbox_get',
    };
  }
  return {
    scenario: 'notify',
    verdict: 'PASS',
    duration_ms: durationMs,
  };
}

/** Headroom check: skip providers under 5% quota headroom. */
export function checkHeadroom(headroomPct: number): { skip: boolean; reason?: string } {
  if (headroomPct < 5) {
    return {
      skip: true,
      reason: `provider usage headroom is under 5% (${headroomPct.toFixed(1)}% remaining)`,
    };
  }
  return { skip: false };
}

/** Construct skipped result set when headroom is under 5% or provider is unavailable. */
export function createSkippedProviderResult(
  provider: string,
  reason: string,
  headroom?: number,
  version?: string,
): ProviderResult {
  const scList: ScenarioName[] = ['answer', 'served', 'continue', 'patch', 'cancel', 'notify'];
  const scenarios: Record<ScenarioName, ScenarioResult> = {} as any;
  for (const s of scList) {
    scenarios[s] = {
      scenario: s,
      verdict: 'SKIP',
      duration_ms: 0,
      reason,
    };
  }
  return {
    provider,
    version,
    headroom,
    scenarios,
  };
}

/** Render detailed provider x scenario table. */
export function renderTable(results: ProviderResult[]): string {
  const rows: string[][] = [
    ['Provider', 'Scenario', 'Verdict', 'Duration', 'Notes'],
  ];

  for (const pr of results) {
    const scList: ScenarioName[] = ['answer', 'served', 'continue', 'patch', 'cancel', 'notify'];
    for (const sc of scList) {
      const r = pr.scenarios[sc];
      const verdict = r ? r.verdict : 'SKIP';
      const duration = r ? `${(r.duration_ms / 1000).toFixed(1)}s` : '-';
      const notes = (r?.reason ?? '').replace(/[\r\n]+/g, ' ');
      rows.push([pr.provider, sc, verdict, duration, notes]);
    }
  }

  const widths = rows[0]!.map((_, colIdx) =>
    Math.max(...rows.map((row) => (row[colIdx] ?? '').length))
  );

  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    lines.push(rows[i]!.map((cell, colIdx) => cell.padEnd(widths[colIdx]!)).join('  ').trimEnd());
    if (i === 0) {
      lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
    }
  }
  return lines.join('\n');
}

/** Render compact matrix view: provider x scenarios. */
export function renderMatrix(results: ProviderResult[]): string {
  const scList: ScenarioName[] = ['answer', 'served', 'continue', 'patch', 'cancel', 'notify'];
  const rows: string[][] = [
    ['Provider', ...scList, 'Notes'],
  ];

  for (const pr of results) {
    const notes: string[] = [];
    const cells = scList.map((sc) => {
      const r = pr.scenarios[sc];
      if (!r) return 'SKIP';
      if (r.verdict === 'FAIL' && r.reason) {
        notes.push(`${sc}: ${r.reason}`);
      }
      return `${r.verdict} (${(r.duration_ms / 1000).toFixed(1)}s)`;
    });
    rows.push([pr.provider, ...cells, notes.join('; ')]);
  }

  const widths = rows[0]!.map((_, colIdx) =>
    Math.max(...rows.map((row) => (row[colIdx] ?? '').length))
  );

  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    lines.push(rows[i]!.map((cell, colIdx) => cell.padEnd(widths[colIdx]!)).join('  ').trimEnd());
    if (i === 0) {
      lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
    }
  }
  return lines.join('\n');
}

/** Query installed CLI version for provider. */
export function getCliVersion(provider: string, execFn?: (cmd: string) => string): string {
  const cmdMap: Record<string, string> = {
    claude: 'claude --version',
    codex: 'codex --version',
    antigravity: 'agy --version',
    agy: 'agy --version',
  };
  const cmd = cmdMap[provider];
  if (!cmd) return 'unknown provider';
  if (execFn) {
    try {
      return execFn(cmd).trim();
    } catch {
      return '(not installed)';
    }
  }
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return '(not installed)';
  }
}

/** Tracker for cleanup on exit or interrupt. */
export class TaskTracker {
  private active = new Map<string, { id: string; version: number }>();

  track(id: string, version = 1): void {
    this.active.set(id, { id, version });
  }

  updateVersion(id: string, version: number): void {
    const entry = this.active.get(id);
    if (entry) entry.version = version;
  }

  untrack(id: string): void {
    this.active.delete(id);
  }

  getPending(): Array<{ id: string; version: number }> {
    return [...this.active.values()];
  }
}

export function getHelpText(): string {
  return [
    'Usage: npm run smoke:providers [-- --providers claude,codex,antigravity] [--scope project:general] [--patch-scope <scope>] [--timeout 300] [--as notchtrader]',
    '',
    'Live provider support matrix smoke test against the running Swarmaa swarm on this Mac.',
    'Drives each provider through six scenarios: answer, served, continue, patch, cancel, notify.',
    '',
    'Options:',
    '  --providers    Comma-separated list of providers to test (default: claude,codex,antigravity)',
    '  --scope        Task scope for research/review/cancel/continue tasks (default: project:general)',
    '  --patch-scope  Scope whose bridge project has allow_patch enabled (required for patch scenario)',
    '  --timeout      Per-scenario timeout in seconds (default: 300)',
    '  --as           Identity token file in .local/<as>.json (default: notchtrader)',
    '  -h, --help     Show this help message and exit',
    '',
    'Scenarios:',
    '  answer    Task returns exact nonce: "Reply with exactly: swarmaa-ok-<nonce>"',
    '  served    Verified that result.provider equals the requested provider (HarnessRouter rule 1)',
    '  continue  task_continue recalls the nonce from the previous turn',
    '  patch     Creates file smoke/<nonce>.txt and verifies git diff (requires --patch-scope)',
    '  cancel    Submits a slow counting task and verifies cancellation within 30s and slot release within 60s',
    '  notify    Verifies submitter inbox receives task_finished notification via inbox_get',
  ].join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cleanupActiveTasks(
  tracker: TaskTracker,
  callFn: <T = unknown>(tool: string, args: object) => Promise<T>,
): Promise<void> {
  const pending = tracker.getPending();
  for (const { id } of pending) {
    try {
      const res = await callFn<{ task: TaskView }>('task_get', { task_id: id });
      if (res.task && !isTerminal(res.task.status)) {
        await callFn('task_cancel', { task_id: id, expected_version: res.task.version });
      }
    } catch {
      // Best-effort cleanup on shutdown
    }
  }
}

/** Check if this module is being executed directly in Node CLI. */
function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}

if (isDirectExecution()) {
  const { values } = parseArgs({
    options: {
      providers: { type: 'string', default: 'claude,codex,antigravity' },
      scope: { type: 'string', default: 'project:general' },
      'patch-scope': { type: 'string' },
      timeout: { type: 'string', default: '300' },
      as: { type: 'string', default: 'notchtrader' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(getHelpText());
    process.exit(0);
  }

  const base = `http://127.0.0.1:${process.env.PORT ?? 8787}`;
  const tokenFile = `.local/${values.as}.json`;
  if (!existsSync(tokenFile)) {
    console.error(`Token file not found: ${tokenFile}`);
    process.exit(1);
  }
  const token = (JSON.parse(readFileSync(tokenFile, 'utf8')) as { token: string }).token;

  async function call<T = unknown>(tool: string, args: object): Promise<T> {
    const r = await fetch(`${base}/api/tools/${tool}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const j = (await r.json()) as { result?: T; error?: { code: string; message: string } };
    if (j.error) throw new Error(`${tool}: ${j.error.code} ${j.error.message}`);
    return j.result as T;
  }

  const targetProviders = values.providers!
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const timeoutSec = Math.max(10, Number(values.timeout) || 300);
  const timeoutMs = timeoutSec * 1000;
  const tracker = new TaskTracker();

  let isExiting = false;
  const onSignal = async () => {
    if (isExiting) return;
    isExiting = true;
    console.log('\nReceived abort signal, cleaning up active smoke tasks...');
    await cleanupActiveTasks(tracker, call);
    process.exit(1);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    // 1. Report CLI versions
    console.log('Provider CLI versions:');
    const cliVersions: Record<string, string> = {};
    for (const p of targetProviders) {
      const ver = getCliVersion(p);
      cliVersions[p] = ver;
      console.log(`  ${p.padEnd(14)}: ${ver}`);
    }
    console.log('');

    // 2. Fetch headroom from swarm_status and usage collector
    const status = await call<{
      usage?: Array<{ provider: string; ok: boolean; headroom: number }>;
      workers?: Array<{ name: string; live: boolean; slots: number; running: Array<{ task_id: string }> }>;
    }>('swarm_status', {});

    const providerHeadroom = new Map<string, number>();
    for (const p of targetProviders) {
      const entry = status.usage?.find((u) => u.provider === p);
      if (entry && typeof entry.headroom === 'number') {
        providerHeadroom.set(p, entry.headroom);
      } else {
        try {
          const snaps = await collectUsage([p as UsageProviderId]);
          if (snaps[0]) providerHeadroom.set(p, calcHeadroom(snaps[0]));
        } catch {
          providerHeadroom.set(p, 100);
        }
      }
    }

    // 3. Cost guard calculation
    const patchEnabled = Boolean(values['patch-scope']);
    const nonSkippedCount = targetProviders.filter(
      (p) => !checkHeadroom(providerHeadroom.get(p) ?? 100).skip,
    ).length;
    const tasksPerProvider = patchEnabled ? 3 : 2; // answer, (patch), cancel; continue is an instruction append
    const totalPlannedTasks = nonSkippedCount * tasksPerProvider;
    console.log(
      `Cost guard: planned tasks to submit: ${totalPlannedTasks} tasks (${nonSkippedCount} active providers × ${tasksPerProvider} tasks; continue appends instruction; patch: ${patchEnabled ? 'enabled' : 'skipped'})`,
    );
    console.log('');

    // 4. Run providers in parallel
    const sharedSeenInbox = new Set<string>();

    async function runProviderScenarios(provider: string): Promise<ProviderResult> {
      const curHeadroom = providerHeadroom.get(provider) ?? 100;
      const headroomCheck = checkHeadroom(curHeadroom);
      if (headroomCheck.skip) {
        return createSkippedProviderResult(
          provider,
          headroomCheck.reason!,
          curHeadroom,
          cliVersions[provider],
        );
      }

      const scenarios: Record<ScenarioName, ScenarioResult> = {} as any;
      let answerTask: TaskView | null = null;
      const answerNonce = randomUUID().slice(0, 8);

      // Scenario 1: answer
      const answerStart = Date.now();
      let answerTimedOut = false;
      try {
        const sub = await call<{ task: TaskView }>('task_submit', {
          scope: values.scope,
          kind: provider === 'antigravity' ? 'review' : 'research',
          required_capability: `${provider}.read`,
          idempotency_key: `smoke-matrix-${Date.now()}-${provider}-answer`,
          objective: `[smoke] Reply with exactly: swarmaa-ok-${answerNonce}`,
        });
        answerTask = sub.task;
        tracker.track(answerTask.id, answerTask.version);

        while (answerTask && !isTerminal(answerTask.status) && Date.now() - answerStart < timeoutMs) {
          await sleep(2000);
          const getRes: { task: TaskView } = await call<{ task: TaskView }>('task_get', { task_id: answerTask.id });
          answerTask = getRes.task;
          tracker.updateVersion(answerTask.id, answerTask.version);
        }
        if (answerTask && !isTerminal(answerTask.status)) {
          answerTimedOut = true;
        } else if (answerTask) {
          tracker.untrack(answerTask.id);
        }
      } catch {
        answerTask = null;
      }
      scenarios.answer = judgeAnswer(
        answerTask,
        answerNonce,
        answerTimedOut,
        timeoutSec,
        Date.now() - answerStart,
      );

      // Scenario 2: served
      const servedStart = Date.now();
      scenarios.served = judgeServed(answerTask, provider, Date.now() - servedStart);

      // Scenario 3: continue
      const continueStart = Date.now();
      if (scenarios.answer.verdict !== 'PASS' || !answerTask || answerTask.status !== 'completed') {
        scenarios.continue = {
          scenario: 'continue',
          verdict: 'FAIL',
          duration_ms: 0,
          reason: `prerequisite "answer" scenario did not pass (${scenarios.answer.reason ?? 'failed'})`,
        };
      } else {
        let continueTask: TaskView | null = null;
        let continueTimedOut = false;
        try {
          tracker.track(answerTask.id, answerTask.version);
          const contSub = await call<{ task: TaskView }>('task_continue', {
            task_id: answerTask.id,
            expected_version: answerTask.version,
            instruction: '[smoke] What was the nonce?',
            idempotency_key: `smoke-matrix-${Date.now()}-${provider}-continue`,
          });
          continueTask = contSub.task;
          tracker.updateVersion(continueTask.id, continueTask.version);

          while (continueTask && !isTerminal(continueTask.status) && Date.now() - continueStart < timeoutMs) {
            await sleep(2000);
            const getRes: { task: TaskView } = await call<{ task: TaskView }>('task_get', { task_id: continueTask.id });
            continueTask = getRes.task;
            tracker.updateVersion(continueTask.id, continueTask.version);
          }
          if (continueTask && !isTerminal(continueTask.status)) {
            continueTimedOut = true;
          } else if (continueTask) {
            tracker.untrack(continueTask.id);
          }
        } catch {
          continueTask = null;
        }
        scenarios.continue = judgeContinue(
          continueTask,
          answerNonce,
          continueTimedOut,
          timeoutSec,
          Date.now() - continueStart,
        );
      }

      // Scenario 4: patch
      const patchStart = Date.now();
      if (!patchEnabled) {
        scenarios.patch = judgePatch({ patchScope: undefined, durationMs: 0 });
      } else {
        const patchNonce = randomUUID().slice(0, 8);
        let patchTask: TaskView | null = null;
        let patchTimedOut = false;
        let diffContent: string | undefined = undefined;

        try {
          const pSub = await call<{ task: TaskView }>('task_submit', {
            scope: values['patch-scope']!,
            kind: 'patch',
            required_capability: `${provider}.patch`,
            idempotency_key: `smoke-matrix-${Date.now()}-${provider}-patch`,
            objective: `[smoke] Create a file smoke/${patchNonce}.txt containing exactly: ${patchNonce}`,
          });
          patchTask = pSub.task;
          tracker.track(patchTask.id, patchTask.version);

          while (patchTask && !isTerminal(patchTask.status) && Date.now() - patchStart < timeoutMs) {
            await sleep(2000);
            const getRes: { task: TaskView } = await call<{ task: TaskView }>('task_get', { task_id: patchTask.id });
            patchTask = getRes.task;
            tracker.updateVersion(patchTask.id, patchTask.version);
          }
          if (patchTask && !isTerminal(patchTask.status)) {
            patchTimedOut = true;
          } else if (patchTask) {
            tracker.untrack(patchTask.id);
          }

          if (patchTask && patchTask.status === 'completed' && patchTask.artifact_ids?.length) {
            for (const artId of patchTask.artifact_ids) {
              try {
                const art = await call<{ artifact: { name: string; content: string } }>('artifact_get', { artifact_id: artId });
                if (art.artifact.name.endsWith('-patch.diff')) {
                  diffContent = art.artifact.content;
                  break;
                }
              } catch {}
            }
          }
        } catch {
          patchTask = null;
        }
        scenarios.patch = judgePatch({
          patchScope: values['patch-scope'],
          task: patchTask,
          expectedNonce: patchNonce,
          diffContent,
          timedOut: patchTimedOut,
          timeoutSec,
          durationMs: Date.now() - patchStart,
        });
      }

      // Scenario 5: cancel
      const cancelStart = Date.now();
      let cancelTask: TaskView | null = null;
      let cancelTimedOut = false;
      let cancelledWithin30s = false;
      let slotFreedWithin60s = false;

      try {
        const cSub = await call<{ task: TaskView }>('task_submit', {
          scope: values.scope,
          kind: provider === 'antigravity' ? 'review' : 'research',
          required_capability: `${provider}.read`,
          idempotency_key: `smoke-matrix-${Date.now()}-${provider}-cancel`,
          objective: '[smoke] Count slowly to 500, one number per line',
        });
        cancelTask = cSub.task;
        tracker.track(cancelTask.id, cancelTask.version);

        while (cancelTask && cancelTask.status === 'queued' && Date.now() - cancelStart < timeoutMs) {
          await sleep(1000);
          const getRes: { task: TaskView } = await call<{ task: TaskView }>('task_get', { task_id: cancelTask.id });
          cancelTask = getRes.task;
          tracker.updateVersion(cancelTask.id, cancelTask.version);
        }

        if (!cancelTask || cancelTask.status !== 'running') {
          cancelTimedOut = true;
        } else {
          const cancelIssuedAt = Date.now();
          await call('task_cancel', { task_id: cancelTask.id, expected_version: cancelTask.version });

          while (Date.now() - cancelIssuedAt < 30_000) {
            await sleep(1000);
            const getRes: { task: TaskView } = await call<{ task: TaskView }>('task_get', { task_id: cancelTask.id });
            cancelTask = getRes.task;
            tracker.updateVersion(cancelTask.id, cancelTask.version);
            if (cancelTask.status === 'cancelled') {
              cancelledWithin30s = true;
              tracker.untrack(cancelTask.id);
              break;
            }
            if (isTerminal(cancelTask.status)) break;
          }

          const slotDeadline = cancelIssuedAt + 60_000;
          const targetCancelId = cancelTask.id;
          while (Date.now() < slotDeadline) {
            await sleep(2000);
            const st = await call<{
              workers?: Array<{ name: string; running: Array<{ task_id: string }> }>;
            }>('swarm_status', {});
            const stillRunning = st.workers?.some((w) =>
              w.running?.some((t) => t.task_id === targetCancelId),
            );
            if (!stillRunning) {
              slotFreedWithin60s = true;
              break;
            }
          }
        }
      } catch {
        // Handled via flags
      }
      scenarios.cancel = judgeCancel({
        status: cancelTask?.status,
        cancelledWithin30s,
        slotFreedWithin60s,
        timedOut: cancelTimedOut,
        timeoutSec,
        durationMs: Date.now() - cancelStart,
      });

      // Scenario 6: notify
      const notifyStart = Date.now();
      let notificationFound = false;
      let notifyTimedOut = false;

      if (!answerTask) {
        scenarios.notify = {
          scenario: 'notify',
          verdict: 'FAIL',
          duration_ms: 0,
          reason: 'no answer task was submitted to check notifications for',
        };
      } else {
        const notifyDeadline = notifyStart + Math.min(timeoutMs, 60_000);
        while (Date.now() < notifyDeadline) {
          if (sharedSeenInbox.has(answerTask.id)) {
            notificationFound = true;
            break;
          }
          try {
            const inboxRes = await call<{ items: Array<{ task_id?: string; kind?: string }> }>('inbox_get', { limit: 50 });
            for (const item of inboxRes.items ?? []) {
              if (item.kind === 'task_finished' && item.task_id) {
                sharedSeenInbox.add(item.task_id);
              }
            }
            if (sharedSeenInbox.has(answerTask.id)) {
              notificationFound = true;
              break;
            }
          } catch {}
          await sleep(2000);
        }
        if (!notificationFound) {
          notifyTimedOut = Date.now() >= notifyDeadline;
        }
        scenarios.notify = judgeNotify({
          notificationFound,
          timedOut: notifyTimedOut,
          timeoutSec: Math.min(timeoutSec, 60),
          durationMs: Date.now() - notifyStart,
        });
      }

      return {
        provider,
        version: cliVersions[provider],
        headroom: curHeadroom,
        scenarios,
      };
    }

    const results = await Promise.all(targetProviders.map(runProviderScenarios));

    // 5. Output tables
    console.log('Provider Support Matrix Results:');
    console.log('');
    console.log(renderTable(results));
    console.log('');
    console.log('Matrix Overview:');
    console.log(renderMatrix(results));
    console.log('');

    // 6. Write JSON copy to .local/smoke-providers/<timestamp>.json
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const outDir = join('.local', 'smoke-providers');
    mkdirSync(outDir, { recursive: true });
    const jsonPath = join(outDir, `${timestamp}.json`);

    let totalScenarios = 0;
    let passedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const pr of results) {
      for (const s of Object.values(pr.scenarios)) {
        totalScenarios++;
        if (s.verdict === 'PASS') passedCount++;
        else if (s.verdict === 'FAIL') failedCount++;
        else skippedCount++;
      }
    }

    const report: SmokeMatrixReport = {
      timestamp: new Date().toISOString(),
      scope: values.scope,
      patch_scope: values['patch-scope'],
      cli_versions: cliVersions,
      providers: results,
      summary: {
        total_scenarios: totalScenarios,
        passed: passedCount,
        failed: failedCount,
        skipped: skippedCount,
        all_passed: failedCount === 0,
      },
    };

    writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`Saved run JSON to: ${jsonPath}`);

    // Clean up any remaining tasks before exit
    await cleanupActiveTasks(tracker, call);

    if (failedCount > 0) {
      console.log(`\nFAIL: ${failedCount} scenario(s) failed.`);
      process.exit(1);
    } else {
      console.log(`\nSUCCESS: All scenarios passed or skipped (${passedCount} passed, ${skippedCount} skipped).`);
      process.exit(0);
    }
  } catch (err) {
    console.error('Smoke matrix run failed with unhandled error:', err);
    await cleanupActiveTasks(tracker, call);
    process.exit(1);
  }
}
