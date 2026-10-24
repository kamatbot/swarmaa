/** Disposable PostgreSQL invariants. Authored only; not executed during source-only implementation. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { CoreService } from '../src/core/index.js';
import { DEFAULT_POLICY } from '../src/core/routing.js';
import { WorkflowService } from '../src/core/workflows.js';
import { AppError } from '../src/errors.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal } from '../src/types.js';

const connectionString = process.env.TEST_DATABASE_URL;
const schema = `workflow_test_${randomUUID().replaceAll('-', '')}`;
const base = 'a'.repeat(40);
type Result = Record<string, any>;

describe('bounded independent-review workflows', { skip: !connectionString, concurrency: false }, () => {
  let control: Pool;
  let pool: Pool;
  let core: CoreService;
  let coordinator: WorkflowService;

  before(async () => {
    assert.ok(connectionString, 'Set TEST_DATABASE_URL to a disposable PostgreSQL database. Never use DATABASE_URL.');
    control = new pg.Pool({ connectionString, max: 2 });
    await control.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString, max: 12, options: `-c search_path=${schema},public` });
    const directory = new URL('../db/migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, directory), 'utf8'));
    }
    core = new CoreService(pool);
    coordinator = new WorkflowService(pool);
  });

  after(async () => {
    if (pool) await pool.end();
    if (control) {
      try { await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await control.end(); }
    }
  });

  const call = async (p: Principal, name: string, args: Record<string, unknown>): Promise<Result> => await core.call(p, name, args) as Result;
  const rejects = async (p: Principal, name: string, args: Record<string, unknown>, code: string): Promise<void> => {
    await assert.rejects(() => call(p, name, args), (error: unknown) => error instanceof AppError && error.code === code);
  };
  const submission = (key = randomUUID()) => ({ scope: 'project:a', objective: 'Review the authorization boundary and identify concrete defects.',
    base_commit: base, reviewers: ['claude', 'codex'], synthesis_provider: 'auto', idempotency_key: key });
  const lease = (claimed: Result) => ({ task_id: claimed.task.id, lease_token: claimed.lease_token, lease_generation: claimed.lease_generation });
  const step = (run: Result, name: string): Result => run.steps.find((item: Result) => item.key === name);
  const claim = (worker: Principal, provider: string): Promise<Result> => call(worker, 'task_claim', {
    scope: 'project:a', capabilities: [`${provider}.read`, 'auto.read'], kinds: ['review'], lease_seconds: 30,
  });
  const finish = (worker: Principal, claimed: Result, result: Record<string, unknown> = {}): Promise<Result> => call(worker, 'task_finish', {
    ...lease(claimed), outcome: 'completed', artifact_ids: [],
    result: { base_commit: base, execution_completed: true, acceptance_criteria_verified: false, review_required: true, ...result },
  });
  const get = async (p: Principal, id: string): Promise<Result> => (await call(p, 'workflow_get', { workflow_id: id })).workflow;

  async function fixture(): Promise<{ front: Principal; owner: Principal; claude: Principal; codex: Principal; wrongScope: Principal; wrongTenant: Principal }> {
    const tenantId = randomUUID();
    const principals: Record<string, Principal> = {
      front: { id: randomUUID(), tenantId, name: 'dot', role: 'frontend', scopes: ['project:a'], permissions: [...ROLE_PERMISSIONS.frontend], credentialVersion: 1 },
      owner: { id: randomUUID(), tenantId, name: 'owner', role: 'admin', scopes: ['*'], permissions: ['admin'], credentialVersion: 1 },
      claude: { id: randomUUID(), tenantId, name: 'claude', role: 'worker', scopes: ['project:a'], permissions: [...ROLE_PERMISSIONS.worker], credentialVersion: 1 },
      codex: { id: randomUUID(), tenantId, name: 'codex', role: 'worker', scopes: ['project:a'], permissions: [...ROLE_PERMISSIONS.worker], credentialVersion: 1 },
      wrongScope: { id: randomUUID(), tenantId, name: 'grok', role: 'frontend', scopes: ['project:b'], permissions: [...ROLE_PERMISSIONS.frontend], credentialVersion: 1 },
      wrongTenant: { id: randomUUID(), tenantId: randomUUID(), name: 'other', role: 'frontend', scopes: ['project:a'], permissions: [...ROLE_PERMISSIONS.frontend], credentialVersion: 1 },
    };
    for (const p of Object.values(principals)) {
      await pool.query(`INSERT INTO principals (id,tenant_id,name,role,scopes,permissions,token_hash,worker_slots)
        VALUES ($1,$2,$3,$4,$5,$6,$7,2)`, [p.id, p.tenantId, p.name, p.role, p.scopes, p.permissions, randomUUID()]);
    }
    return principals as { front: Principal; owner: Principal; claude: Principal; codex: Principal; wrongScope: Principal; wrongTenant: Principal };
  }

  async function finishReviewers(f: Awaited<ReturnType<typeof fixture>>, run: Result): Promise<void> {
    const a = await claim(f.claude, 'claude');
    const b = await claim(f.codex, 'codex');
    assert.equal(a.task.id, step(run, 'reviewer_a').task.id);
    assert.equal(b.task.id, step(run, 'reviewer_b').task.id);
    await Promise.all([finish(f.claude, a), finish(f.codex, b)]);
  }

  it('atomically creates exactly three pinned steps, with idempotent concurrent submission', async () => {
    const f = await fixture();
    const input = submission();
    const [a, b] = await Promise.all([call(f.front, 'workflow_submit', input), call(f.front, 'workflow_submit', input)]);
    assert.equal(a.workflow.id, b.workflow.id);
    assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
    const run = a.workflow;
    assert.equal(run.steps.length, 3);
    assert.equal(run.budget.max_tasks, 3);
    assert.equal(run.budget.max_total_attempts, 6);
    assert.equal(run.verification, 'unverified');
    for (const child of run.steps) {
      assert.equal(child.task.workflow_id, run.id);
      assert.equal(child.task.workflow_step, child.key);
      assert.equal(child.task.base_ref, base);
      assert.equal(child.task.kind, 'review');
      assert.equal(child.task.max_attempts, 2);
      assert.equal(child.task.permission_envelope.local_patch, false);
      assert.equal(child.task.permission_envelope.external_side_effects, false);
    }
    assert.equal(step(run, 'reviewer_a').task.status, 'queued');
    assert.equal(step(run, 'reviewer_b').task.status, 'queued');
    assert.deepEqual(step(run, 'reviewer_a').depends_on, []);
    assert.equal(step(run, 'synthesis').task.status, 'queued');
    assert.equal(step(run, 'synthesis').phase, 'waiting_for_dependencies');
    assert.equal(step(run, 'synthesis').activated_at, null);
    assert.deepEqual(step(run, 'synthesis').depends_on, ['reviewer_a', 'reviewer_b']);
    const count = await pool.query('SELECT count(*)::int AS count FROM tasks WHERE workflow_id=$1', [run.id]);
    assert.equal(count.rows[0].count, 3);
    await rejects(f.front, 'workflow_submit', { ...input, objective: 'Different work' }, 'idempotency_conflict');
  });

  it('rejects moving refs, same-provider reviewers, unbounded budgets and unknown arguments', async () => {
    const f = await fixture();
    for (const invalid of [{ base_commit: 'main' }, { base_commit: 'A'.repeat(40) }, { reviewers: ['claude', 'claude'] },
      { reviewers: ['claude'] }, { reviewers: ['claude', 'unknown'] }, { max_attempts: 4 }, { timeout_seconds: 86401 },
      { template: 'arbitrary_dag' }, { command: 'arbitrary command' }]) {
      await rejects(f.front, 'workflow_submit', { ...submission(), ...invalid }, 'invalid_arguments');
    }
    const count = await pool.query('SELECT count(*)::int AS count FROM workflow_runs WHERE tenant_id=$1', [f.front.tenantId]);
    assert.equal(count.rows[0].count, 0);
  });

  it('resolves default reviewers once and replays the original run after policy changes', async () => {
    const f = await fixture();
    const { reviewers: _unused, ...input } = submission();
    const first = await call(f.front, 'workflow_submit', input);
    assert.deepEqual(first.workflow.reviewers, ['claude', 'codex']);
    const policy = { ...DEFAULT_POLICY, providers: DEFAULT_POLICY.providers.map(p => ({ ...p, enabled: p.provider !== 'codex' })) };
    await call(f.owner, 'routing_set', { policy });
    const replay = await call(f.front, 'workflow_submit', input);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.workflow.reviewers, first.workflow.reviewers);
    await rejects(f.front, 'workflow_submit', submission(), 'review_providers_unavailable');
  });

  it('preserves tenant/scope/permission isolation through direct CoreService calls', async () => {
    const f = await fixture();
    const run = (await call(f.front, 'workflow_submit', submission())).workflow;
    for (const p of [f.wrongScope, f.wrongTenant]) {
      await rejects(p, 'workflow_get', { workflow_id: run.id }, 'not_found');
      await rejects(p, 'workflow_cancel', { workflow_id: run.id, expected_version: run.version }, 'not_found');
    }
    await rejects(f.wrongScope, 'workflow_list', { scope: 'project:a' }, 'scope_forbidden');
    const readOnly = { ...f.front, permissions: ['task:read'] as Principal['permissions'] };
    await rejects(readOnly, 'workflow_submit', submission(), 'forbidden');
    await rejects(readOnly, 'workflow_cancel', { workflow_id: run.id, expected_version: run.version }, 'forbidden');
    assert.ok(!core.listTools(f.front).some(tool => tool.name === 'workflow_review'));
    assert.ok(core.listTools(f.owner).some(tool => tool.name === 'workflow_review'));
    assert.ok(!core.listTools(f.claude).some(tool => tool.name === 'workflow_submit' || tool.name === 'workflow_review'));
    assert.ok(core.listTools(f.claude).some(tool => tool.name === 'task_message_pull'));
    assert.ok(!core.listTools(f.front).some(tool => tool.name === 'task_message_pull' || tool.name === 'task_message_ack'));
    assert.ok(!core.listTools({ ...f.front, permissions: ['task:read'] }).some(tool => tool.name === 'task_handoff'));
    assert.equal((await get(f.owner, run.id)).id, run.id);
  });

  it('validates every context reference before creating a workflow or its tasks', async () => {
    const f = await fixture();
    await rejects(f.front, 'workflow_submit', { ...submission(), context_refs: [randomUUID()] }, 'invalid_context_refs');
    const result = await pool.query('SELECT count(*)::int AS count FROM tasks WHERE tenant_id=$1', [f.front.tenantId]);
    assert.equal(result.rows[0].count, 0);
  });

  it('paginates every workflow when PostgreSQL timestamps share a JavaScript millisecond', async () => {
    const f = await fixture();
    const runs: Result[] = [];
    for (const fraction of ['000200', '000600', '000900']) {
      const run = (await call(f.front, 'workflow_submit', submission())).workflow;
      await pool.query('UPDATE workflow_runs SET created_at=$2::timestamptz WHERE id=$1', [run.id, `2026-01-01T00:00:00.${fraction}Z`]);
      runs.push(run);
    }
    const first = await call(f.front, 'workflow_list', { scope: 'project:a', limit: 1 });
    assert.equal(first.workflows[0].id, runs[2]!.id);
    const second = await call(f.front, 'workflow_list', { scope: 'project:a', limit: 1, before_id: first.next_before_id });
    assert.equal(second.workflows[0].id, runs[1]!.id);
    const third = await call(f.front, 'workflow_list', { scope: 'project:a', limit: 1, before_id: second.next_before_id });
    assert.equal(third.workflows[0].id, runs[0]!.id);
    assert.equal(third.next_before_id, null);
  });

  it('queues synthesis once after both reviewers finish, across coordinator restarts and races', async () => {
    const f = await fixture();
    const run = (await call(f.front, 'workflow_submit', submission())).workflow;
    const a = await claim(f.claude, 'claude');
    const b = await claim(f.codex, 'codex');
    await finish(f.claude, a);
    await coordinator.advance(100);
    assert.equal(step(await get(f.front, run.id), 'synthesis').phase, 'waiting_for_dependencies');
    await finish(f.codex, b);
    await Promise.all([new WorkflowService(pool).advance(100), new WorkflowService(pool).advance(100)]);
    const ready = await get(f.front, run.id);
    assert.equal(ready.version, 2);
    assert.equal(step(ready, 'synthesis').task.status, 'queued');
    assert.notEqual(step(ready, 'synthesis').activated_at, null);
    const synthesis = await claim(f.claude, 'claude');
    assert.equal(synthesis.task.id, step(run, 'synthesis').task.id);
    await finish(f.claude, synthesis, { answer: 'Evidence and disagreements for owner review.' });
    await new WorkflowService(pool).advance(100);
    const completed = await get(f.front, run.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.verification, 'unverified');
    assert.equal(completed.acceptance_criteria_verified, false);
    assert.equal(completed.review_required, true);
    await rejects(f.front, 'workflow_review', { workflow_id: run.id, expected_version: completed.version, verdict: 'approved' }, 'owner_required');
    const approved = (await call(f.owner, 'workflow_review', { workflow_id: run.id, expected_version: completed.version,
      verdict: 'approved', reason: 'Owner reviewed the source-backed synthesis.' })).workflow;
    assert.equal(approved.owner_review.reviewed_by, f.owner.id);
    assert.equal(approved.verification, 'approved');
    assert.equal(approved.acceptance_criteria_verified, true);
    await rejects(f.owner, 'workflow_review', { workflow_id: run.id, expected_version: completed.version, verdict: 'rejected' }, 'version_conflict');
  });

  it('blocks missing or wrong commit provenance instead of accepting legacy worker success', async () => {
    const f = await fixture();
    const run = (await call(f.front, 'workflow_submit', submission())).workflow;
    const a = await claim(f.claude, 'claude');
    const b = await claim(f.codex, 'codex');
    await finish(f.claude, a, { base_commit: 'b'.repeat(40) });
    await coordinator.advance(100);
    const blocked = await get(f.front, run.id);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.reason, 'unverified_commit_provenance');
    assert.equal(step(blocked, 'synthesis').activated_at, null);
    assert.equal(step(blocked, 'reviewer_b').task.status, 'cancelled');
    await rejects(f.codex, 'task_heartbeat', { ...lease(b), lease_seconds: 30 }, 'lease_lost');
  });

  it('preserves timely completed work when the coordinator restarts after its deadline', async () => {
    const f = await fixture();
    const run = (await call(f.front, 'workflow_submit', submission())).workflow;
    await finishReviewers(f, run);
    await coordinator.advance(100);
    const synthesis = await claim(f.claude, 'claude');
    await finish(f.claude, synthesis);
    await pool.query(`UPDATE workflow_runs SET deadline_at=(SELECT max(completed_at)+interval '1 microsecond'
      FROM tasks WHERE workflow_id=$1) WHERE id=$1`, [run.id]);
    await new WorkflowService(pool).advance(100);
    const completed = await get(f.front, run.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.verification, 'unverified');
  });

  it('fences cancellation across a finish race and never requeues cancelled children', async () => {
    const f = await fixture();
    const run = (await call(f.front, 'workflow_submit', submission())).workflow;
    const a = await claim(f.claude, 'claude');
    const results = await Promise.allSettled([finish(f.claude, a), call(f.front, 'workflow_cancel', { workflow_id: run.id, expected_version: run.version })]);
    assert.equal(results[1]!.status, 'fulfilled');
    await coordinator.advance(100);
    const cancelled = await get(f.front, run.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.steps.every((child: Result) => ['completed', 'cancelled'].includes(child.task.status)));
    assert.equal(step(cancelled, 'synthesis').task.status, 'cancelled');
    await rejects(f.claude, 'task_heartbeat', { ...lease(a), lease_seconds: 30 }, 'lease_lost');
  });

  it('cannot bypass dependency or run budgets through standalone task controls', async () => {
    const f = await fixture();
    const run = (await call(f.front, 'workflow_submit', submission())).workflow;
    const child = step(run, 'synthesis').task;
    await rejects(f.front, 'task_continue', { task_id: child.id, expected_version: child.version, instruction: 'Start early', idempotency_key: randomUUID() }, 'workflow_managed');
    await rejects(f.front, 'task_cancel', { task_id: child.id, expected_version: child.version }, 'workflow_managed');
    await rejects(f.front, 'task_submit', { scope: 'project:a', kind: 'review', objective: 'Fake managed step', required_capability: 'claude.read',
      idempotency_key: `workflow:${run.id}:reviewer_a` }, 'invalid_arguments');
  });

  it('checks the workflow deadline at claim and heartbeat before the coordinator runs', async () => {
    const f = await fixture();
    const run = (await call(f.front, 'workflow_submit', submission())).workflow;
    const a = await claim(f.claude, 'claude');
    await pool.query("UPDATE workflow_runs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [run.id]);
    assert.equal((await claim(f.codex, 'codex')).task, null);
    await rejects(f.claude, 'task_heartbeat', { ...lease(a), lease_seconds: 30 }, 'lease_lost');
    await coordinator.advance(100);
    const expired = await get(f.front, run.id);
    assert.equal(expired.status, 'failed');
    assert.equal(expired.reason, 'workflow_deadline_exceeded');
    assert.ok(expired.steps.every((child: Result) => child.task.status === 'cancelled'));
  });

  it('clamps claims and renewals to the workflow deadline', async () => {
    const f = await fixture();
    const run = (await call(f.front, 'workflow_submit', submission())).workflow;
    const budget = await pool.query<{ deadline_at: Date }>("UPDATE workflow_runs SET deadline_at=clock_timestamp()+interval '120 seconds' WHERE id=$1 RETURNING deadline_at", [run.id]);
    const a = await call(f.claude, 'task_claim', { scope: 'project:a', capabilities: ['claude.read'], kinds: ['review'], lease_seconds: 300 });
    assert.equal(a.task.lease_expires_at, budget.rows[0]!.deadline_at.toISOString());
    const renewed = await call(f.claude, 'task_heartbeat', { ...lease(a), lease_seconds: 300 });
    assert.equal(renewed.task.lease_expires_at, budget.rows[0]!.deadline_at.toISOString());
    await call(f.front, 'workflow_cancel', { workflow_id: run.id, expected_version: run.version });
  });

  it('does not let rotated, disabled or narrowed initiating identities launch deferred work', async () => {
    for (const mutation of ['credential_version=credential_version+1', 'disabled=true', "scopes=ARRAY['project:b']::text[]", "permissions=ARRAY['task:read']::text[]"]) {
      const f = await fixture();
      const run = (await call(f.front, 'workflow_submit', submission())).workflow;
      await finishReviewers(f, run);
      // SQL fragments are fixed test-owned cases, never application input.
      await pool.query(`UPDATE principals SET ${mutation} WHERE id=$1`, [f.front.id]);
      await coordinator.advance(100);
      const stopped = await get(f.owner, run.id);
      assert.equal(stopped.status, 'blocked');
      assert.equal(stopped.reason, 'authorization_revoked');
      assert.equal(step(stopped, 'synthesis').activated_at, null);
    }
  });

  it('retains the original OAuth grant boundary through deferred synthesis', async () => {
    const f = await fixture();
    const clientId = `workflow-test-${randomUUID()}`;
    const grantId = randomUUID();
    await pool.query(`INSERT INTO oauth_clients (client_id,client_name,redirect_uris) VALUES ($1,'Workflow test',ARRAY['https://example.com/callback'])`, [clientId]);
    await pool.query(`INSERT INTO oauth_grants (id,principal_id,client_id,resource,grant_snapshot,expires_at)
      VALUES ($1,$2,$3,'https://example.com/mcp',$4::jsonb,clock_timestamp()+interval '1 hour')`, [grantId, f.front.id, clientId, JSON.stringify(f.front)]);
    const oauth = { ...f.front, oauthGrantId: grantId };
    const run = (await call(oauth, 'workflow_submit', submission())).workflow;
    const grantDeadline = await pool.query<{ expires_at: Date }>("UPDATE oauth_grants SET expires_at=clock_timestamp()+interval '120 seconds' WHERE id=$1 RETURNING expires_at", [grantId]);
    const a = await call(f.claude, 'task_claim', { scope: 'project:a', capabilities: ['claude.read'], kinds: ['review'], lease_seconds: 300 });
    assert.equal(a.task.lease_expires_at, grantDeadline.rows[0]!.expires_at.toISOString());
    const heartbeat = await call(f.claude, 'task_heartbeat', { ...lease(a), lease_seconds: 300 });
    assert.equal(heartbeat.task.lease_expires_at, grantDeadline.rows[0]!.expires_at.toISOString());
    await finish(f.claude, a);
    await finish(f.codex, await claim(f.codex, 'codex'));
    await pool.query('UPDATE oauth_grants SET revoked_at=clock_timestamp() WHERE id=$1', [grantId]);
    await coordinator.advance(100);
    const blocked = await get(f.owner, run.id);
    assert.equal(blocked.reason, 'authorization_revoked');
    assert.equal(step(blocked, 'synthesis').activated_at, null);
    const stored = await pool.query('SELECT authorization_snapshot,oauth_grant_id FROM workflow_runs WHERE id=$1', [run.id]);
    assert.equal(stored.rows[0].oauth_grant_id, grantId);
    assert.ok(!JSON.stringify(stored.rows[0].authorization_snapshot).includes('token'));
  });

  it('honors the bounded attempt count after worker loss', async () => {
    const f = await fixture();
    const run = (await call(f.front, 'workflow_submit', { ...submission(), max_attempts: 1 })).workflow;
    const a = await claim(f.claude, 'claude');
    await pool.query("UPDATE tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [a.task.id]);
    assert.equal((await claim(f.claude, 'claude')).task, null);
    await coordinator.advance(100);
    const failed = await get(f.front, run.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason, 'step_reviewer_a_failed');
    assert.equal(step(failed, 'reviewer_a').task.attempt_count, 1);
    assert.equal(step(failed, 'synthesis').task.attempt_count, 0);
  });

  it('reserves all three queue slots atomically across concurrent workflows', async () => {
    const f = await fixture();
    await pool.query(`INSERT INTO tasks (id,tenant_id,scope,kind,objective,permission_envelope,required_capability,status,created_by,idempotency_key,request_hash)
      SELECT gen_random_uuid(),$1,'project:a','review','Existing bounded task','{}'::jsonb,'claude.read','blocked',$2,'capacity-'||n,repeat('0',64)
      FROM generate_series(1,995) AS n`, [f.front.tenantId, f.front.id]);
    const results = await Promise.allSettled([call(f.front, 'workflow_submit', submission()), call(f.front, 'workflow_submit', submission())]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.ok(failed.reason instanceof AppError && failed.reason.code === 'queue_full');
    const counts = await pool.query('SELECT count(*)::int AS count FROM tasks WHERE tenant_id=$1', [f.front.tenantId]);
    assert.equal(counts.rows[0].count, 998);
  });

  it('keeps reviewer outputs independent while preserving attributed owner context', async () => {
    const f = await fixture();
    const run = (await call(f.front, 'workflow_submit', submission())).workflow;
    const a = await claim(f.claude, 'claude');
    const provenance = { source_task_id: a.task.id, source_lease_token: a.lease_token, source_lease_generation: a.lease_generation };
    await rejects(f.claude, 'task_message_send', { ...provenance, task_id: step(run, 'reviewer_b').task.id,
      body: 'Please reuse my conclusion.', idempotency_key: randomUUID() }, 'independent_review');
    const own = await call(f.claude, 'task_message_send', { ...provenance, task_id: a.task.id,
      body: 'My remaining open question.', idempotency_key: randomUUID() });
    assert.equal(own.accepted, true);
    assert.equal(own.message.source_task_id, a.task.id);
    const owner = await call(f.front, 'task_message_send', { task_id: step(run, 'reviewer_b').task.id,
      body: 'Prioritize the authorization boundary.', idempotency_key: randomUUID() });
    assert.equal(owner.accepted, true);
    assert.equal(owner.message.actor_id, f.front.id);
    await call(f.front, 'workflow_cancel', { workflow_id: run.id, expected_version: run.version });
  });

  it('supplies bounded attributed upstream evidence only to synthesis, with artifact permissions', async () => {
    const f = await fixture();
    const run = (await call(f.front, 'workflow_submit', submission())).workflow;
    const a = await claim(f.claude, 'claude');
    const b = await claim(f.codex, 'codex');
    const artifact = (await call(f.claude, 'artifact_put', { ...lease(a), name: 'review.md', content: '日'.repeat(15000), media_type: 'text/markdown' })).artifact;
    await call(f.claude, 'task_finish', { ...lease(a), outcome: 'completed', artifact_ids: [artifact.id],
      result: { base_commit: base, answer: 'é'.repeat(10000), summary: 'Summary '.repeat(500), acceptance_criteria_verified: false } });
    const independent = await call(f.codex, 'context_get', { scope: 'project:a', task_id: b.task.id });
    assert.equal(independent.workflow.independent_review, true);
    assert.equal(independent.workflow.upstream, undefined);
    const otherArtifact = (await call(f.codex, 'artifact_put', { ...lease(b), name: 'second-review.md', content: 'z'.repeat(20000), media_type: 'text/markdown' })).artifact;
    await call(f.codex, 'task_finish', { ...lease(b), outcome: 'completed', artifact_ids: [otherArtifact.id],
      result: { base_commit: base, answer: 'A different conclusion with evidence.', acceptance_criteria_verified: false } });
    await coordinator.advance(100);
    const synthId = step(run, 'synthesis').task.id;
    const packet = await call(f.front, 'context_get', { scope: 'project:a', task_id: synthId });
    assert.equal(packet.workflow.base_commit, base);
    assert.equal(packet.workflow.upstream.length, 2);
    assert.ok(packet.workflow.upstream.every((item: Result) => item.ready && item.acceptance_criteria_verified === false));
    const first = packet.workflow.upstream.find((item: Result) => item.task_id === a.task.id);
    assert.equal(first.answer.truncated, true);
    assert.ok(Buffer.byteLength(first.answer.text, 'utf8') <= 8192);
    assert.ok(!first.answer.text.includes('\uFFFD'));
    assert.equal(first.artifacts[0].id, artifact.id);
    assert.equal(first.artifacts[0].sha256, artifact.sha256);
    assert.equal(first.artifacts[0].excerpt_truncated, true);
    const bytes = packet.workflow.upstream.flatMap((item: Result) => item.artifacts).reduce((sum: number, item: Result) => sum + Buffer.byteLength(item.excerpt, 'utf8'), 0);
    assert.ok(bytes <= 16384);
    const noArtifacts = { ...f.front, permissions: f.front.permissions.filter(permission => permission !== 'artifact:read') };
    await rejects(noArtifacts, 'context_get', { scope: 'project:a', task_id: synthId }, 'forbidden');
    const ownContext = await call(noArtifacts, 'context_get', { scope: 'project:a', task_id: a.task.id });
    assert.equal(ownContext.workflow.independent_review, true);
    await rejects(f.wrongTenant, 'context_get', { scope: 'project:a', task_id: synthId }, 'not_found');
    const current = await get(f.front, run.id);
    await call(f.front, 'workflow_cancel', { workflow_id: run.id, expected_version: current.version });
  });

  it('does not let a hundred unactivated synthesis steps starve later runnable tasks', async () => {
    const f = await fixture();
    for (let n = 0; n < 100; n++) await call(f.front, 'workflow_submit', submission());
    // Emulate completed reviewer results while their coordinator is offline; all synthesis
    // steps remain queued and unactivated. They must be excluded before the claim LIMIT.
    await pool.query(`UPDATE tasks SET status='completed',completed_at=clock_timestamp(),result=$2::jsonb
      WHERE tenant_id=$1 AND workflow_step IN ('reviewer_a','reviewer_b')`, [f.front.tenantId, JSON.stringify({ base_commit: base })]);
    const standalone = (await call(f.front, 'task_submit', { scope: 'project:a', kind: 'review', objective: 'Ready independent work',
      required_capability: 'claude.read', idempotency_key: randomUUID() })).task;
    assert.equal((await claim(f.claude, 'claude')).task.id, standalone.id);
  });

  it('returns an explicitly bounded metadata timeline without message/transcript bodies', async () => {
    const f = await fixture();
    const run = (await call(f.front, 'workflow_submit', submission())).workflow;
    const taskId = step(run, 'reviewer_a').task.id;
    const messageId = randomUUID();
    await pool.query(`INSERT INTO events (id,tenant_id,scope,name,subject_id,payload)
      VALUES ($1,$2,'project:a','task.updated',$3,$4::jsonb)`, [randomUUID(), f.front.tenantId, taskId,
      JSON.stringify({ task_id: taskId, action: 'message_sent', message_id: messageId, delivery_status: 'accepted', content: 'Never expose a transcript body here.' })]);
    const result = await call(f.front, 'workflow_get', { workflow_id: run.id, timeline_limit: 1 });
    assert.equal(result.timeline.events.length, 1);
    assert.equal(result.timeline.has_more, true);
    assert.equal(result.timeline.events[0].message_id, messageId);
    assert.equal(result.timeline.events[0].delivery_status, 'accepted');
    assert.equal(result.timeline.events[0].content, undefined);
    assert.equal(result.timeline.coverage, 'most_recent_metadata_events');
  });
});
