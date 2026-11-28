/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { AuthService, hashToken, newToken } from '../src/auth.js';
import { CoreService } from '../src/core/index.js';
import { DEFAULT_POLICY } from '../src/core/routing.js';
import { event } from '../src/core/shared.js';
import { createHttpHandler } from '../src/http.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal, ServerConfig } from '../src/types.js';

const connectionString = process.env.TEST_DATABASE_URL;

describe('handoffs, model catalog, fan-in synthesis, and next-wave perf', { skip: !connectionString, concurrency: false }, () => {
  const schema = `next_wave_${randomUUID().replaceAll('-', '')}`;
  let control: Pool;
  let pool: Pool;
  let core: CoreService;
  let server: Server;
  let origin: string;

  before(async () => {
    control = new pg.Pool({ connectionString, max: 1 });
    await control.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString, max: 12, options: `-c search_path=${schema},public` });
    for (const file of (await readdir(new URL('../db/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    core = new CoreService(pool);
    const config: ServerConfig = {
      host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1', allowedOrigins: [], allowInsecureLocalhost: true,
      maxBodyBytes: 262144, oauthEnabled: false, oauthRedirectHosts: [], eventCallbackHosts: [], eventEncryptionKey: '0'.repeat(64)
    };
    server = createServer(createHttpHandler({ pool, core, auth: new AuthService(pool), config, streamHeartbeatMs: 5000 }));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    config.port = (server.address() as { port: number }).port;
    origin = `http://127.0.0.1:${config.port}`;
  });

  after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>(r => server.close(() => r()));
    await pool?.end();
    if (control) {
      await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await control.end();
    }
  });

  const call = async (p: Principal, name: string, args: Record<string, unknown> = {}) =>
    await core.call(p, name, args) as Record<string, any>;

  async function createPrincipal(tenantId: string, name: string, role: Principal['role'] = 'admin', scopes = ['*']) {
    const p: Principal = {
      id: randomUUID(),
      tenantId,
      name,
      role,
      scopes,
      permissions: role === 'worker'
        ? [...ROLE_PERMISSIONS.worker, 'task:patch']
        : [...ROLE_PERMISSIONS[role]]
    };
    const token = newToken();
    await pool.query(
      `INSERT INTO principals(id, tenant_id, name, role, scopes, permissions, token_hash, last_seen_at, worker_slots)
       VALUES($1, $2, $3, $4, $5, $6, $7, clock_timestamp(), 4)`,
      [p.id, p.tenantId, name, role, scopes, p.permissions, hashToken(token)]
    );
    return { ...p, token };
  }

  it('populates claimTask.agents and native_session_id on turn claim', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'owner', 'admin', ['project:a']);
    const worker = await createPrincipal(tenantId, 'worker', 'worker', ['project:a']);
    const { agent: lead } = await call(user, 'agent_create', { name: 'Lead', role: 'Lead', instructions: 'Lead', scope: 'project:a', runner: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }, edits: false });
    const { agent: coder } = await call(user, 'agent_create', { name: 'Coder', role: 'Engineer', instructions: 'Code', scope: 'project:a', runner: { provider: 'codex', model: 'gpt-5.4' }, edits: true });
    const { thread } = await call(user, 'bot_create', {
      name: 'DevBot', job: 'Build', scope: 'project:a', lead_agent_id: lead.id, member_agent_ids: [coder.id],
      rules: { first_reply: 'off' },
    });
    await pool.query(
      `INSERT INTO agent_provider_sessions(tenant_id, agent_id, provider, session_data) VALUES($1,$2,'claude',$3::jsonb)`,
      [tenantId, lead.id, JSON.stringify({ session_id: 'sess-claude-42' })]
    );

    await call(user, 'thread_post', { thread_id: thread.id, body: 'Start work', idempotency_key: 'post-1' });
    const claim = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['claude.read', 'codex.patch'], kinds: ['turn'] });
    assert.ok(claim.task);
    assert.equal(claim.task.native_session_id, 'sess-claude-42');
    assert.deepEqual(claim.task.agents, [
      { id: coder.id, name: 'Coder', role: 'Engineer', edits: true },
      { id: lead.id, name: 'Lead', role: 'Lead', edits: false },
    ]);
    assert.deepEqual(claim.task.permission_envelope.runner, {
      provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', fast: false,
    });
  });

  it('propagates swarm goal, instructions, upstream edit head_commit as base_ref, and upstream step results; skips intermediate auto-review; summary turn is read-only', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'owner', 'admin', ['project:sw']);
    const worker = await createPrincipal(tenantId, 'worker', 'worker', ['project:sw']);
    const { agent: lead } = await call(user, 'agent_create', { name: 'Lead', role: 'Lead', instructions: 'Lead', scope: 'project:sw', runner: { provider: 'claude', model: 'claude-opus-5-5' }, edits: true });
    const { agent: dev1 } = await call(user, 'agent_create', { name: 'Dev1', role: 'Eng', instructions: 'Code', scope: 'project:sw', runner: { provider: 'codex', model: 'gpt-6-astra', effort: 'high' }, edits: true });
    const { agent: dev2 } = await call(user, 'agent_create', { name: 'Dev2', role: 'Eng', instructions: 'Test', scope: 'project:sw', runner: { provider: 'claude', model: 'claude-sonnet-5-5' }, edits: true });
    const { bot, thread } = await call(user, 'bot_create', {
      name: 'ShipBot', job: 'Ship', scope: 'project:sw', lead_agent_id: lead.id, member_agent_ids: [dev1.id, dev2.id],
      rules: { review_edits: true },
    });

    await call(user, 'swarm_start', {
      title: 'Two-step patch',
      goal: 'Implement feature X cleanly',
      scope: 'project:sw',
      thread_id: thread.id,
      owner_agent_id: lead.id,
      base_ref: 'release/v1',
      steps: [
        { key: 's1', title: 'Write core', assignee_agent_id: dev1.id, instructions: 'Add core module', check: 'core compiles', kind: 'patch' },
        { key: 's2', title: 'Add tests', assignee_agent_id: dev2.id, needs: ['s1'], instructions: 'Write unit tests', check: 'tests pass', kind: 'patch' },
      ],
    });

    // Claim step 1
    const c1 = await call(worker, 'task_claim', { scope: 'project:sw', capabilities: ['codex.patch', 'claude.patch'], kinds: ['turn', 'patch'] });
    assert.ok(c1.task);
    assert.equal(c1.task.base_ref, 'release/v1');
    assert.match(c1.task.objective, /Add core module/);
    assert.match(c1.task.objective, /Implement feature X cleanly/);
    assert.deepEqual(c1.task.permission_envelope.runner, { provider: 'codex', model: 'gpt-6-astra', effort: 'high', fast: false });

    const commit1 = 'a'.repeat(40);
    const baseCommit = 'b'.repeat(40);
    await call(worker, 'task_finish', {
      task_id: c1.task.id,
      lease_token: c1.lease_token,
      lease_generation: c1.lease_generation,
      outcome: 'completed',
      result: {
        answer: 'Implemented core.ts with full exports',
        branch: 'swarmaa/codex/s1',
        head_commit: commit1,
        base_commit: baseCommit,
        diffstat: 'src/core.ts | 42 +++',
        served: { provider: 'codex', model: 'gpt-6-astra' },
      },
    });

    // No intermediate auto-review queued for swarm step 1
    const reviews = (await pool.query("SELECT id FROM tasks WHERE bot_id=$1 AND kind='review'", [bot.id])).rows;
    assert.equal(reviews.length, 0, 'intermediate swarm step must not queue auto-review');

    // Step 2 inherits step 1 head_commit as base_ref and includes upstream step results in handoff message
    const c2 = await call(worker, 'task_claim', { scope: 'project:sw', capabilities: ['claude.patch'], kinds: ['turn', 'patch'] });
    assert.ok(c2.task);
    assert.equal(c2.task.base_ref, commit1, 'step 2 should build on step 1 head_commit');
    const handoffMsg = (c2.task.thread_messages as any[]).find(m => m.kind === 'handoff');
    assert.ok(handoffMsg);
    assert.match(handoffMsg.body, /Swarm goal: Implement feature X cleanly/);
    assert.match(handoffMsg.body, /Instructions: Write unit tests/);
    assert.match(handoffMsg.body, /Upstream step results:/);
    assert.match(handoffMsg.body, /Implemented core\.ts with full exports/);
    assert.match(handoffMsg.body, /swarmaa\/codex\/s1/);

    await call(worker, 'task_finish', {
      task_id: c2.task.id, lease_token: c2.lease_token, lease_generation: c2.lease_generation,
      outcome: 'completed', result: { answer: 'Tests passing' },
    });

    // Summary turn is forced read-only even though lead has edits: true
    const summaryTask = (await pool.query("SELECT * FROM tasks WHERE agent_id=$1 AND initiator_kind='swarm' AND status='queued'", [lead.id])).rows[0];
    assert.ok(summaryTask);
    assert.equal(summaryTask.required_capability, 'claude.read');
    assert.equal(summaryTask.permission_envelope.local_patch, false);
    assert.equal(summaryTask.permission_envelope.runner.summary, true);
    assert.equal(summaryTask.permission_envelope.runner.fast, false);
  });

  it('multi-bot project_dispatch fan-in synthesis, DELEGATE propagation, coalescing, and terminal-only copy', async () => {
    const tenantId = randomUUID();
    const owner = await createPrincipal(tenantId, 'owner', 'admin', ['*']);
    const worker = await createPrincipal(tenantId, 'worker', 'worker', ['project:coord', 'project:alpha', 'project:beta']);

    const mkBot = async (scope: string, name: string, rules: Record<string, unknown> = {}) => {
      const { agent } = await call(owner, 'agent_create', { name: `${name}Lead`, role: 'Lead', instructions: 'Help', scope, runner: { provider: 'codex' } });
      return call(owner, 'bot_create', { name, job: name, scope, lead_agent_id: agent.id, member_agent_ids: [], rules });
    };
    const coord = await mkBot('project:coord', 'Coordinator', { dispatch_all_projects: true, first_reply: 'off' });
    const alpha = await mkBot('project:alpha', 'Alpha', { first_reply: 'claude-haiku-5-5' });
    const beta = await mkBot('project:beta', 'Beta', { first_reply: 'claude-haiku-5-5' });

    // Coordinator dispatches to both Alpha and Beta in one turn
    await call(owner, 'thread_post', { thread_id: coord.thread.id, body: 'Check both projects', idempotency_key: 'coord-1' });
    const cc = await call(worker, 'task_claim', { scope: 'project:coord', capabilities: ['codex.read'], kinds: ['turn'] });
    await call(worker, 'task_finish', {
      task_id: cc.task.id, lease_token: cc.lease_token, lease_generation: cc.lease_generation, outcome: 'completed',
      result: {
        answer: `Dispatching.\n\n\`\`\`swarmaa-actions\n${JSON.stringify([
          { type: 'project_dispatch', bot: 'Alpha', body: 'Status of alpha?' },
          { type: 'project_dispatch', bot: 'Beta', body: 'Status of beta?' },
        ])}\n\`\`\``
      }
    });

    // Both dispatched turns skip Haiku first-reply (fast: false, codex.read, not claude.read)
    const alphaTask = (await pool.query("SELECT * FROM tasks WHERE thread_id=$1 AND status='queued'", [alpha.thread.id])).rows[0];
    const betaTask = (await pool.query("SELECT * FROM tasks WHERE thread_id=$1 AND status='queued'", [beta.thread.id])).rows[0];
    assert.equal(alphaTask.required_capability, 'codex.read');
    assert.equal(alphaTask.permission_envelope.runner.fast, false);
    assert.equal(betaTask.required_capability, 'codex.read');
    assert.equal(betaTask.permission_envelope.runner.fast, false);
    const groupId = alphaTask.context_versions.dispatched_from[0].dispatch_group_id;
    assert.ok(groupId);
    assert.equal(betaTask.context_versions.dispatched_from[0].dispatch_group_id, groupId);

    // Alpha delegates first -> intermediate reply must NOT be copied to coordinator yet; dispatched_from propagates!
    const ac1 = await call(worker, 'task_claim', { scope: 'project:alpha', capabilities: ['codex.read'], kinds: ['turn'] });
    await call(worker, 'task_finish', {
      task_id: ac1.task.id, lease_token: ac1.lease_token, lease_generation: ac1.lease_generation, outcome: 'completed',
      result: { answer: 'Looking deeper...', delegate: { objective: 'Deep alpha check' } },
    });
    const coordMsgsMid = (await pool.query("SELECT body FROM messages WHERE thread_id=$1", [coord.thread.id])).rows;
    assert.ok(!coordMsgsMid.some(m => m.body.includes('Looking deeper')), 'delegating turn must not copy intermediate answer');
    const alphaDelegate = (await pool.query("SELECT * FROM tasks WHERE thread_id=$1 AND status='queued'", [alpha.thread.id])).rows[0];
    assert.equal(alphaDelegate.context_versions.dispatched_from[0].dispatch_group_id, groupId);

    // Alpha finishes delegated turn -> copied back, completed=1/2, NO synthesis turn yet
    const ac2 = await call(worker, 'task_claim', { scope: 'project:alpha', capabilities: ['codex.read'], kinds: ['turn'] });
    await call(worker, 'task_finish', {
      task_id: ac2.task.id, lease_token: ac2.lease_token, lease_generation: ac2.lease_generation, outcome: 'completed',
      result: { answer: 'Alpha is healthy.' },
    });
    assert.equal((await pool.query("SELECT id FROM tasks WHERE thread_id=$1 AND status='queued'", [coord.thread.id])).rows.length, 0);

    // Beta fails -> failure copied back, completed(1)+failed(1) >= total(2) -> ONE synthesis turn queued!
    const bc = await call(worker, 'task_claim', { scope: 'project:beta', capabilities: ['codex.read'], kinds: ['turn'] });
    await call(worker, 'task_finish', {
      task_id: bc.task.id, lease_token: bc.lease_token, lease_generation: bc.lease_generation, outcome: 'failed',
      result: { failure: { code: 'harness_error', detail: 'Beta offline' } },
    });
    const groupRow = (await pool.query('SELECT * FROM dispatch_groups WHERE id=$1', [groupId])).rows[0];
    assert.equal(groupRow.completed, 1);
    assert.equal(groupRow.failed, 1);
    assert.equal(groupRow.synthesized, true);

    const synthTasks = (await pool.query("SELECT * FROM tasks WHERE thread_id=$1 AND status='queued'", [coord.thread.id])).rows;
    assert.equal(synthTasks.length, 1);
    assert.equal(synthTasks[0].context_versions.dispatch_group_id, groupId);
    assert.equal(synthTasks[0].context_versions.summary, true);
    assert.equal(synthTasks[0].permission_envelope.local_patch, false);
  });

  it('botTaskFinished strips parent runner to prevent cross-provider poisoning; usage_report + swarm_status expose model_catalog', async () => {
    const tenantId = randomUUID();
    const owner = await createPrincipal(tenantId, 'owner', 'admin', ['project:mc']);
    const worker = await createPrincipal(tenantId, 'worker', 'worker', ['project:mc']);
    const { agent } = await call(owner, 'agent_create', { name: 'Editor', role: 'Dev', instructions: 'Edit', scope: 'project:mc', runner: { provider: 'claude', model: 'claude-opus-5-5', effort: 'max' }, edits: true });
    const { bot, thread } = await call(owner, 'bot_create', {
      name: 'CodeBot', job: 'Code', scope: 'project:mc', lead_agent_id: agent.id, member_agent_ids: [],
      routing: { review: { mode: 'different_from_author' } },
      rules: { review_edits: true },
    });

    await call(worker, 'usage_report', {
      slots: 4,
      reports: [
        { provider: 'claude', ok: true, fetched_at: new Date().toISOString(), windows: [{ name: '5h', used_percent: 20 }], default_model: 'claude-opus-5-5', turn_model: 'claude-sonnet-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
        { provider: 'codex', ok: true, fetched_at: new Date().toISOString(), windows: [{ name: '5h', used_percent: 10 }], default_model: 'gpt-6-astra', models: ['gpt-6-astra', 'gpt-5.4'] },
      ],
    });
    const status = await call(owner, 'swarm_status', { scope: 'project:mc' });
    assert.equal(status.model_catalog.providers.claude.default_model, 'claude-opus-5-5');
    assert.equal(status.model_catalog.providers.claude.turn_model, 'claude-sonnet-5-5');
    assert.equal(status.model_catalog.providers.codex.default_model, 'gpt-6-astra');
    assert.deepEqual(status.workers[0].default_models, { claude: 'claude-opus-5-5', codex: 'gpt-6-astra' });

    // Edit finishes on Claude with opus+max in permission_envelope.runner -> review task must strip runner!
    await call(owner, 'thread_post', { thread_id: thread.id, body: 'Fix bug', idempotency_key: 'fix-1' });
    const claim = await call(worker, 'task_claim', { scope: 'project:mc', capabilities: ['claude.patch'], kinds: ['turn', 'patch'] });
    assert.equal(claim.task.permission_envelope.runner.model, 'claude-opus-5-5');
    await call(worker, 'task_finish', {
      task_id: claim.task.id, lease_token: claim.lease_token, lease_generation: claim.lease_generation, outcome: 'completed',
      result: { answer: 'Fixed', branch: 'swarmaa/claude/1', head_commit: 'c'.repeat(40), base_commit: 'd'.repeat(40), served: { provider: 'claude', model: 'claude-opus-5-5' } },
    });
    const reviewTask = (await pool.query("SELECT * FROM tasks WHERE bot_id=$1 AND kind='review'", [bot.id])).rows[0];
    assert.ok(reviewTask);
    assert.equal(reviewTask.permission_envelope.runner, undefined, 'parent claude runner must not poison codex review task');
  });

  it('routing-policy-aware DELEGATE_MODEL respects disabled Claude and thread_post runner override', async () => {
    const tenantId = randomUUID();
    const owner = await createPrincipal(tenantId, 'owner', 'admin', ['project:del']);
    const worker = await createPrincipal(tenantId, 'worker', 'worker', ['project:del']);
    const policy = structuredClone(DEFAULT_POLICY);
    policy.providers.find(p => p.provider === 'claude')!.enabled = false;
    await call(owner, 'routing_set', { policy });
    await call(worker, 'usage_report', {
      slots: 2,
      reports: [
        { provider: 'codex', ok: true, fetched_at: new Date().toISOString(), windows: [{ name: '5h', used_percent: 10 }, { name: 'weekly', used_percent: 10 }] },
      ],
    });

    const { agent, thread } = await call(owner, 'agent_create', { name: 'AutoAgent', role: 'Helper', instructions: 'Help', scope: 'project:del', runner: { mode: 'auto' } });
    // Single-message runner override on thread_post
    await call(owner, 'thread_post', {
      thread_id: thread.id, body: 'Use codex mini', idempotency_key: 'p-override',
      runner: { provider: 'codex', model: 'gpt-5.4-mini', effort: 'low' },
    });
    const c = await call(worker, 'task_claim', { scope: 'project:del', capabilities: ['codex.read', 'auto.read'], kinds: ['turn'] });
    assert.equal(c.task.required_capability, 'codex.read');
    assert.deepEqual(c.task.permission_envelope.runner, { provider: 'codex', model: 'gpt-5.4-mini', effort: 'low', fast: false });

    // DELEGATE on auto agent when Claude is disabled routes to codex (never forces claude-opus-5-5)
    await call(worker, 'task_finish', {
      task_id: c.task.id, lease_token: c.lease_token, lease_generation: c.lease_generation, outcome: 'completed',
      result: { answer: 'Delegating', delegate: { objective: 'Deep analysis' } },
    });
    const follow = (await pool.query("SELECT * FROM tasks WHERE agent_id=$1 AND objective='Deep analysis'", [agent.id])).rows[0];
    assert.equal(follow.required_capability, 'codex.read');
    assert.equal(follow.permission_envelope.runner.provider, 'codex');
    assert.equal(follow.permission_envelope.runner.model, undefined);
  });

  it('atomic watch_session on task_submit, inline_artifacts on task_finish, limit batching on task_claim, and required_capability on events', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user', 'admin', ['project:at']);
    const worker = await createPrincipal(tenantId, 'worker', 'worker', ['project:at']);

    const s1 = await call(user, 'task_submit', {
      scope: 'project:at', kind: 'review', objective: 'Review 1', idempotency_key: 's1',
      required_capability: 'codex.read', watch_session: 'claude:sess-watch-1',
    });
    assert.equal(s1.watching, true);
    const s2 = await call(user, 'task_submit', {
      scope: 'project:at', kind: 'review', objective: 'Review 2', idempotency_key: 's2',
      required_capability: 'codex.read',
    });

    // Verify required_capability in task.updated event
    const ev = (await pool.query("SELECT payload FROM events WHERE tenant_id=$1 AND subject_id=$2 AND name='task.updated' ORDER BY seq ASC LIMIT 1", [tenantId, s1.task.id])).rows[0];
    assert.equal(ev.payload.required_capability, 'codex.read');

    // Batch claim with limit: 2 claims both tasks in one round trip
    const claimed = await call(worker, 'task_claim', { scope: 'project:at', capabilities: ['codex.read'], kinds: ['review'], limit: 2 });
    assert.equal(claimed.tasks.length, 2);
    assert.equal(claimed.task.id, claimed.tasks[0].task.id);

    // Finish task 1 with inline_artifacts + verify idempotent replay
    const finishArgs = {
      task_id: claimed.tasks[0].task.id,
      lease_token: claimed.tasks[0].lease_token,
      lease_generation: claimed.tasks[0].lease_generation,
      outcome: 'completed',
      result: { answer: 'Looks great' },
      inline_artifacts: [{ name: 'report.md', content: '# Report\nAll clear.', media_type: 'text/markdown' }],
    };
    const fin1 = await call(worker, 'task_finish', finishArgs);
    assert.equal(fin1.replayed, false);
    assert.equal(fin1.task.artifact_ids.length, 1);
    const finReplay = await call(worker, 'task_finish', finishArgs);
    assert.equal(finReplay.replayed, true);
    const art = await call(user, 'artifact_get', { artifact_id: fin1.task.artifact_ids[0] });
    assert.equal(art.artifact.name, 'report.md');
    assert.equal(art.artifact.content, '# Report\nAll clear.');

    // Atomic watch_session delivered a session-scoped inbox notification to that session
    const inbox = await call(user, 'inbox_get', { session: 'claude:sess-watch-1' });
    const watchedItem = (inbox.items as any[]).find(i => i.task_id === s1.task.id && i.recipient_session === 'claude:sess-watch-1');
    assert.ok(watchedItem, 'atomic watch_session must create a session-scoped inbox delivery');
    const watcherRow = (await pool.query('SELECT session FROM task_watchers WHERE task_id=$1 AND principal_id=$2', [s1.task.id, user.id])).rows[0];
    assert.equal(watcherRow?.session, 'claude:sess-watch-1');
  });

  it('attention_list paginates with full microsecond precision without skipping same-millisecond rows', async () => {
    const tenantId = randomUUID();
    const owner = await createPrincipal(tenantId, 'owner', 'admin', ['project:us']);
    const base = '2026-11-28T10:00:00.123';
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    // Three failed tasks within the exact same millisecond (different microseconds!)
    for (let i = 0; i < 3; i++) {
      const ts = `${base}${String(100 + i * 200).padStart(3, '0')}Z`;
      await pool.query(
        `INSERT INTO tasks(id, tenant_id, scope, kind, objective, constraints, acceptance_criteria, permission_envelope, required_capability, status, created_by, idempotency_key, request_hash, max_attempts, result, updated_at)
         VALUES($1,$2,'project:us','review',$3,'[]','[]','{}','codex.read','failed',$4,$5,$6,3,'{"failure":{"code":"harness_error"}}'::jsonb,$7::timestamptz)`,
        [ids[i], tenantId, `Failed ${i}`, owner.id, `k-${i}`, `h-${i}`, ts]
      );
    }
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await call(owner, 'attention_list', { scope: 'project:us', limit: 1, ...(cursor ? { after: cursor } : {}) });
      for (const item of res.items) collected.push(item.id);
      if (!res.has_more) break;
      cursor = res.next_cursor;
    }
    assert.deepEqual(collected, [ids[2], ids[1], ids[0]], 'all 3 same-ms rows must appear in exact microsecond order with zero skips');
  });

  it('SSE /api/stream resolves xmin-hidden events within ~30ms instead of stalling 2-15s', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'sse-user', 'admin', ['project:sse']);
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/stream?after=now&scope=project:sse`, {
      headers: { Authorization: `Bearer ${user.token}` },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read(); // initial cursor

    // Open an older transaction with an assigned xid so the subsequent committed event is temporarily hidden by xmin
    const holder = await pool.connect();
    let deliveredMs = Infinity;
    let releasedAt = 0;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_current_xact_id()');

      const gotEvent = (async () => {
        let buf = '';
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          buf += new TextDecoder().decode(r.value);
          if (buf.includes('event: memory.changed')) {
            deliveredMs = performance.now() - releasedAt;
            return;
          }
        }
      })();

      // Commit event in a newer xid while older xid is still open -> NOTIFY fires, poll sees 0 visible rows + hidden=true -> 30ms retry
      await event(pool, user, 'project:sse', 'memory.changed', randomUUID(), { action: 'created' });
      await new Promise(r => setTimeout(r, 80));
      releasedAt = performance.now();
      await holder.query('COMMIT');

      await Promise.race([gotEvent, new Promise(r => setTimeout(r, 1000))]);
      assert.ok(deliveredMs < 400, `expected <400ms delivery after older xact committed (30ms retry), got ${deliveredMs}ms`);
    } finally {
      controller.abort();
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
  });
});
