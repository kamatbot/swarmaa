/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { CoreService } from '../src/core/index.js';
import { DEFAULT_POLICY, type RoutingPolicy } from '../src/core/routing.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal } from '../src/types.js';

const connectionString = process.env.TEST_DATABASE_URL;
const schema = `collective_test_${randomUUID().replaceAll('-', '')}`;

describe('failure codes and routing', { skip: !connectionString, concurrency: false }, () => {
  let control: Pool;
  let pool: Pool;
  let core: CoreService;

  before(async () => {
    control = new pg.Pool({ connectionString, max: 2 });
    await control.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` });
    for (const file of [
      '001_identity.sql', '002_core.sql', '005_swarm.sql', '006_sessions.sql',
      '008_lessons.sql', '010_routing_policy.sql', '011_patch_routing.sql',
      '012_session_task.sql', '013_worker_slots.sql', '016_worker_slots_drain.sql',
      '019_inbox.sql', '020_inbox_receipts.sql', '021_flows.sql', '018_events_xid.sql',
      '023_failure_routing.sql', '024_teams.sql', '025_teams_swarms.sql'
    ]) {
      await pool.query(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    core = new CoreService(pool);
  });

  after(async () => {
    if (pool) await pool.end();
    if (control) {
      try { await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await control.end(); }
    }
  });

  const call = async (p: Principal, name: string, args: Record<string, unknown>) => await core.call(p, name, args) as Record<string, any>;

  async function fixture(tenantId = randomUUID()) {
    const make = (name: string, role: Principal['role'], extra: Principal['permissions'] = []): Principal => ({
      id: randomUUID(), tenantId, name, role, scopes: ['project:a'], permissions: [...ROLE_PERMISSIONS[role], ...extra]
    });
    const ps = {
      front: make('dot', 'frontend'),
      owner: make('owner-ui', 'admin'),
      claude: make('w-claude', 'worker'),
      codex: make('w-codex', 'worker'),
      agy: make('w-agy', 'worker')
    };
    for (const p of Object.values(ps)) {
      await pool.query(
        `INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [p.id, p.tenantId, p.name, p.role, p.scopes, p.permissions, randomUUID()]
      );
    }
    return ps;
  }

  const report = (provider: string, five: number, weekly: number, resetsAt: string | null = null) => ({
    reports: [{
      provider, ok: true, fetched_at: new Date().toISOString(),
      windows: [
        { name: '5h', used_percent: five, resets_at: resetsAt },
        { name: 'weekly', used_percent: weekly, resets_at: resetsAt }
      ]
    }]
  });

  const submit = (key: string, kind = 'review', capability = 'auto.read', extra: Record<string, unknown> = {}) => ({
    scope: 'project:a', kind, objective: 'Test objective for failure codes.', idempotency_key: key, required_capability: capability, ...extra
  });

  const finish = (w: Principal, claimResult: any, result: Record<string, unknown>, outcome: 'completed' | 'failed' | 'blocked' = 'failed') => {
    return call(w, 'task_finish', {
      task_id: claimResult.task.id,
      lease_token: claimResult.lease_token,
      lease_generation: claimResult.lease_generation,
      outcome,
      result,
      artifact_ids: []
    });
  };

  it('quota_exhausted on an auto task requeues it excluding that provider', async () => {
    const f = await fixture();
    // Report usage for claude and codex
    await call(f.claude, 'usage_report', report('claude', 20, 20));
    await call(f.codex, 'usage_report', report('codex', 10, 10));

    // Submit auto.read task
    const sub = await call(f.front, 'task_submit', submit('auto-quota-1'));
    assert.equal(sub.task.status, 'queued');

    // Claude is first in default policy, so claude claims it
    const claim1 = await call(f.claude, 'task_claim', { scope: 'project:a', capabilities: ['claude.read', 'auto.read'] });
    assert.equal(claim1.task?.id, sub.task.id);
    assert.equal(claim1.route?.provider, 'claude');

    // Claude encounters quota_exhausted
    const finishRes = await finish(f.claude, claim1, {
      provider: 'claude',
      served: { provider: 'claude', model: 'claude-3-5' },
      failure: { code: 'quota_exhausted', retry: false, detail: 'You have exceeded your current quota' }
    });

    // Task is requeued!
    assert.equal(finishRes.task.status, 'queued');
    assert.deepEqual(finishRes.task.excluded_providers, ['claude']);

    // Claude tries to claim again, but is excluded!
    const claimClaude = await call(f.claude, 'task_claim', { scope: 'project:a', capabilities: ['claude.read', 'auto.read'] });
    assert.equal(claimClaude.task, null);

    // Codex claims it instead
    const claimCodex = await call(f.codex, 'task_claim', { scope: 'project:a', capabilities: ['codex.read', 'auto.read'] });
    assert.equal(claimCodex.task?.id, sub.task.id);
    assert.equal(claimCodex.route?.provider, 'codex');

    // Inbox contains rerouted notice
    const inbox = await call(f.front, 'inbox_get', {});
    const reroutedItem = inbox.items.find((i: any) => i.task_id === sub.task.id && i.body?.includes('rerouted to codex'));
    assert.ok(reroutedItem, 'Expected inbox notice mentioning reroute to codex');
    assert.match(reroutedItem.body, /failed \(quota_exhausted on claude, rerouted to codex\)/);
  });

  it('when every enabled provider is exhausted, the task fails with reset times', async () => {
    const f = await fixture();
    // Restrict policy to claude and codex only
    const pol: RoutingPolicy = {
      fallback: 'most_headroom',
      providers: [
        { provider: 'claude', enabled: true, kinds: ['review', 'research', 'patch'], max_five_hour_pct: 90, max_weekly_pct: 90 },
        { provider: 'codex', enabled: true, kinds: ['review', 'research', 'patch'], max_five_hour_pct: 90, max_weekly_pct: 90 },
        { provider: 'antigravity', enabled: false, kinds: ['review', 'patch'], max_five_hour_pct: 90, max_weekly_pct: 90 }
      ]
    };
    await call(f.owner, 'routing_set', { policy: pol });

    const claudeReset = '2026-10-25T12:00:00.000Z';
    const codexReset = '2026-10-25T14:00:00.000Z';
    await call(f.claude, 'usage_report', report('claude', 10, 10, claudeReset));
    await call(f.codex, 'usage_report', report('codex', 20, 20, codexReset));

    const sub = await call(f.front, 'task_submit', submit('all-exhausted-1'));

    // 1st claim: claude
    const claim1 = await call(f.claude, 'task_claim', { scope: 'project:a', capabilities: ['claude.read', 'auto.read'] });
    assert.equal(claim1.task?.id, sub.task.id);

    // Claude fails with quota_exhausted
    await finish(f.claude, claim1, {
      provider: 'claude',
      served: { provider: 'claude', model: 'claude-3-5' },
      failure: { code: 'quota_exhausted', retry: false, detail: 'Monthly limit reached' }
    });

    // 2nd claim: codex (only remaining provider)
    const claim2 = await call(f.codex, 'task_claim', { scope: 'project:a', capabilities: ['codex.read', 'auto.read'] });
    assert.equal(claim2.task?.id, sub.task.id);

    // Codex also fails with quota_exhausted
    const finalFinish = await finish(f.codex, claim2, {
      provider: 'codex',
      served: { provider: 'codex', model: 'gpt-5' },
      failure: { code: 'quota_exhausted', retry: false, detail: 'Quota exhausted' }
    });

    // Every enabled provider is exhausted: task fails!
    assert.equal(finalFinish.task.status, 'failed');
    assert.equal(finalFinish.task.failure?.code, 'quota_exhausted');
    assert.match(finalFinish.task.failure?.detail ?? '', /claude resets at 2026-10-25T12:00:00.000Z/);
    assert.match(finalFinish.task.failure?.detail ?? '', /codex resets at 2026-10-25T14:00:00.000Z/);
  });

  it('explicit-capability tasks never reroute', async () => {
    const f = await fixture();
    // Submit task with explicit capability codex.read
    const sub = await call(f.front, 'task_submit', submit('explicit-no-reroute', 'review', 'codex.read'));

    const claim = await call(f.codex, 'task_claim', { scope: 'project:a', capabilities: ['codex.read'] });
    assert.equal(claim.task?.id, sub.task.id);

    const finishRes = await finish(f.codex, claim, {
      provider: 'codex',
      served: { provider: 'codex', model: 'gpt-5' },
      failure: { code: 'quota_exhausted', retry: false, detail: 'No quota' }
    });

    // Task immediately fails; never requeued
    assert.equal(finishRes.task.status, 'failed');
    assert.equal(finishRes.task.failure?.code, 'quota_exhausted');

    // Confirm it is not in queued state
    const getTask = await call(f.front, 'task_get', { task_id: sub.task.id });
    assert.equal(getTask.task.status, 'failed');
  });

  it('rate_limited respects backoff', async () => {
    const f = await fixture();
    await call(f.codex, 'usage_report', report('codex', 10, 10));

    const sub = await call(f.front, 'task_submit', submit('rate-limit-backoff'));
    const claim = await call(f.codex, 'task_claim', { scope: 'project:a', capabilities: ['codex.read', 'auto.read'] });

    // Rate limited with 10s backoff
    const finishRes = await finish(f.codex, claim, {
      provider: 'codex',
      served: { provider: 'codex', model: 'gpt-5' },
      failure: { code: 'rate_limited', retry: true, detail: '429 Rate limited', retry_after_ms: 10000 }
    });

    assert.equal(finishRes.task.status, 'queued');
    assert.ok(finishRes.task.not_before, 'Expected not_before to be set');

    // Immediate claim should not return the task (backoff not elapsed)
    const claimImmediate = await call(f.codex, 'task_claim', { scope: 'project:a', capabilities: ['codex.read', 'auto.read'] });
    assert.equal(claimImmediate.task, null);

    // Update not_before to the past to simulate elapsed backoff
    await pool.query(`UPDATE tasks SET not_before = clock_timestamp() - interval '1 second' WHERE id = $1`, [sub.task.id]);

    // Now claim succeeds!
    const claimAfter = await call(f.codex, 'task_claim', { scope: 'project:a', capabilities: ['codex.read', 'auto.read'] });
    assert.equal(claimAfter.task?.id, sub.task.id);
  });

  it('provider_error retries once with backoff, then reroutes', async () => {
    const f = await fixture();
    await call(f.claude, 'usage_report', report('claude', 20, 20));
    await call(f.codex, 'usage_report', report('codex', 10, 10));

    const sub = await call(f.front, 'task_submit', submit('provider-error-retry'));

    // 1st claim by claude
    const claim1 = await call(f.claude, 'task_claim', { scope: 'project:a', capabilities: ['claude.read', 'auto.read'] });
    assert.equal(claim1.task?.id, sub.task.id);

    // 1st failure: provider_error -> retries on same provider with backoff
    const res1 = await finish(f.claude, claim1, {
      provider: 'claude',
      served: { provider: 'claude', model: 'claude-3-5' },
      failure: { code: 'provider_error', retry: true, detail: '503 Service Unavailable' }
    });
    assert.equal(res1.task.status, 'queued');
    // claude is NOT yet excluded
    assert.deepEqual(res1.task.excluded_providers, []);

    // Simulate elapsed backoff
    await pool.query(`UPDATE tasks SET not_before = clock_timestamp() - interval '1 second' WHERE id = $1`, [sub.task.id]);

    // Claim again: claude takes it again
    const claim2 = await call(f.claude, 'task_claim', { scope: 'project:a', capabilities: ['claude.read', 'auto.read'] });
    assert.equal(claim2.task?.id, sub.task.id);

    // 2nd failure: provider_error on claude -> now excluded and rerouted!
    const res2 = await finish(f.claude, claim2, {
      provider: 'claude',
      served: { provider: 'claude', model: 'claude-3-5' },
      failure: { code: 'provider_error', retry: true, detail: '503 Service Unavailable' }
    });
    assert.equal(res2.task.status, 'queued');
    assert.deepEqual(res2.task.excluded_providers, ['claude']);

    // Next claim: claude cannot claim; codex can claim!
    const claimClaude = await call(f.claude, 'task_claim', { scope: 'project:a', capabilities: ['claude.read', 'auto.read'] });
    assert.equal(claimClaude.task, null);

    const claimCodex = await call(f.codex, 'task_claim', { scope: 'project:a', capabilities: ['codex.read', 'auto.read'] });
    assert.equal(claimCodex.task?.id, sub.task.id);
  });

  it('flows different-provider uses served.provider', async () => {
    const f = await fixture();
    const flowDef = {
      id: 'diff-prov-flow',
      title: 'Different provider flow',
      steps: [
        { id: 'step-a', kind: 'review', capability: 'auto.read', objective: 'Step A', needs: [] },
        { id: 'step-b', kind: 'review', capability: { different_provider_than: 'step-a' }, objective: 'Step B', needs: ['step-a'] }
      ]
    };
    const commit = 'a'.repeat(40);
    await call(f.owner, 'flow_start', {
      scope: 'project:a',
      flow: flowDef,
      inputs: { commit },
      idempotency_key: 'flow-diff-prov-1'
    });

    // Step A is claimed by claude
    const claimA = await call(f.claude, 'task_claim', { scope: 'project:a', capabilities: ['claude.read', 'auto.read'] });
    assert.equal(claimA.task.flow?.step_id, 'step-a');

    // Claude completes Step A with served.provider = 'claude'
    await finish(f.claude, claimA, {
      provider: 'claude',
      served: { provider: 'claude', model: 'claude-3-5' },
      observed_commit: commit,
      answer: 'Step A done'
    }, 'completed');

    // Step B is now ready. Claude tries to claim it, but must be excluded because Step A was served by claude!
    const claimBClaude = await call(f.claude, 'task_claim', { scope: 'project:a', capabilities: ['claude.read', 'auto.read'] });
    assert.equal(claimBClaude.task, null);

    // Codex claims Step B
    const claimBCodex = await call(f.codex, 'task_claim', { scope: 'project:a', capabilities: ['codex.read', 'auto.read'] });
    assert.equal(claimBCodex.task?.flow?.step_id, 'step-b');
    assert.equal(claimBCodex.route?.provider, 'codex');
  });

  it('tenant isolation: exclusions and quota state do not cross tenants', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const fA = await fixture(tenantA);
    const fB = await fixture(tenantB);

    await call(fA.claude, 'usage_report', report('claude', 20, 20));
    await call(fA.codex, 'usage_report', report('codex', 10, 10));
    await call(fB.claude, 'usage_report', report('claude', 20, 20));

    // Submit auto task in Tenant A and Tenant B
    const subA = await call(fA.front, 'task_submit', submit('tenant-a-task'));
    const subB = await call(fB.front, 'task_submit', submit('tenant-b-task'));

    // Tenant A claude claims and fails with quota_exhausted
    const claimA = await call(fA.claude, 'task_claim', { scope: 'project:a', capabilities: ['claude.read', 'auto.read'] });
    await finish(fA.claude, claimA, {
      provider: 'claude',
      served: { provider: 'claude', model: 'claude-3-5' },
      failure: { code: 'quota_exhausted', retry: false, detail: 'Quota spent' }
    });

    // In Tenant A, claude is excluded
    const getA = await call(fA.front, 'task_get', { task_id: subA.task.id });
    assert.deepEqual(getA.task.excluded_providers, ['claude']);

    // In Tenant B, claude can still claim tenant B's task without exclusion!
    const claimB = await call(fB.claude, 'task_claim', { scope: 'project:a', capabilities: ['claude.read', 'auto.read'] });
    assert.equal(claimB.task?.id, subB.task.id);
  });

  it('visibility: task_get, swarm_status and inbox reflect failure.code and served', async () => {
    const f = await fixture();
    const sub = await call(f.front, 'task_submit', submit('visibility-test', 'review', 'claude.read'));
    const claim = await call(f.claude, 'task_claim', { scope: 'project:a', capabilities: ['claude.read'] });

    await finish(f.claude, claim, {
      provider: 'claude',
      served: { provider: 'claude', model: 'claude-3-5-sonnet', substituted: false },
      failure: { code: 'auth_required', retry: false, detail: 'sign in to Claude Code' }
    });

    // 1. inbox message shows auth_required reason (checked before task_get so it is unread)
    const inbox = await call(f.front, 'inbox_get', {});
    const inboxItem = inbox.items.find((i: any) => i.task_id === sub.task.id);
    assert.ok(inboxItem);
    assert.match(inboxItem.body, /failed: auth_required, sign in to Claude Code/);

    // 2. task_get shows failure and served
    const taskGet = await call(f.front, 'task_get', { task_id: sub.task.id });
    assert.equal(taskGet.task.failure?.code, 'auth_required');
    assert.equal(taskGet.task.served?.provider, 'claude');
    assert.equal(taskGet.task.served?.model, 'claude-3-5-sonnet');

    // 3. swarm_status recent items show failure.code and served
    const status = await call(f.front, 'swarm_status', {});
    const recentItem = status.recent.find((r: any) => r.id === sub.task.id);
    assert.ok(recentItem, 'Expected task in swarm_status recent items');
    assert.equal(recentItem.failure?.code, 'auth_required');
    assert.equal(recentItem.served?.provider, 'claude');
  });
});
