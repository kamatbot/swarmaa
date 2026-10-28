/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { AuthService, hashToken, newToken } from '../src/auth.js';
import { CoreService } from '../src/core/index.js';
import { event } from '../src/core/shared.js';
import { AppError } from '../src/errors.js';
import { createHttpHandler } from '../src/http.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal, ServerConfig } from '../src/types.js';

const connectionString = process.env.TEST_DATABASE_URL;

describe('teams phase 1 service foundation', { skip: !connectionString, concurrency: false }, () => {
  const schema = `teams_test_${randomUUID().replaceAll('-', '')}`;
  let control: Pool;
  let pool: Pool;
  let core: CoreService;
  let server: Server;
  let origin: string;

  before(async () => {
    control = new pg.Pool({ connectionString, max: 1 });
    await control.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` });

    for (const file of (await readdir(new URL('../db/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
    }

    core = new CoreService(pool);
    const config: ServerConfig = {
      host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1', allowedOrigins: [], allowInsecureLocalhost: true,
      maxBodyBytes: 131072, oauthEnabled: false, oauthRedirectHosts: [], eventCallbackHosts: [], eventEncryptionKey: '0'.repeat(64)
    };
    server = createServer(createHttpHandler({ pool, core, auth: new AuthService(pool), config, streamHeartbeatMs: 50 }));
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

  async function createPrincipal(tenantId: string, name: string, role: Principal['role'] = 'frontend', scopes = ['project:a']) {
    const p: Principal = {
      id: randomUUID(),
      tenantId,
      name,
      role,
      scopes,
      permissions: [...ROLE_PERMISSIONS[role]]
    };
    const token = newToken();
    await pool.query(
      `INSERT INTO principals(id, tenant_id, name, role, scopes, permissions, token_hash, last_seen_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, clock_timestamp())`,
      [p.id, p.tenantId, name, role, scopes, p.permissions, hashToken(token)]
    );
    return { ...p, token };
  }

  it('slims task_list while thread typing is running-only, redacted and bounded', async () => {
    const user = await createPrincipal(randomUUID(), 'perf-reader');
    const worker = await createPrincipal(user.tenantId, 'perf-worker', 'worker');
    const { thread } = await call(user, 'agent_create', {
      name: 'Stream', role: 'Helper', instructions: 'Help', scope: 'project:a', runner: { provider: 'claude' }
    });
    await call(user, 'thread_post', { thread_id: thread.id, body: 'Help', idempotency_key: 'perf' });
    await pool.query("UPDATE tasks SET checkpoint='{\"partial_text\":\"queued text\"}'::jsonb WHERE thread_id=$1", [thread.id]);
    assert.deepEqual((await call(user, 'thread_read', { thread_id: thread.id })).typing, []);
    const claim = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['claude.read'], kinds: ['turn'] });
    const checkpoint = { partial_output: 'x'.repeat(20480), partial_text: 'y'.repeat(5000) + ' token=supersecret12345', phase: 'running' };
    const result = { answer: 'a'.repeat(2000), summary: 'Brief', branch: 'test', review_required: true, transcript: 'z'.repeat(20000) };
    await pool.query('UPDATE tasks SET checkpoint=$2::jsonb, objective=$3, result=$4::jsonb WHERE id=$1',
      [claim.task.id, JSON.stringify(checkpoint), 'o'.repeat(1000), JSON.stringify(result)]);
    const listed = (await call(user, 'task_list', { scope: 'project:a' })).tasks[0];
    assert.ok(Buffer.byteLength(JSON.stringify(listed)) < 2048);
    assert.equal(listed.objective.length, 300);
    assert.deepEqual(listed.checkpoint, { phase: 'running' });
    assert.deepEqual(listed.result, { answer: 'a'.repeat(500), summary: 'Brief', branch: 'test', review_required: true });
    const full = (await call(user, 'task_get', { task_id: claim.task.id })).task;
    assert.deepEqual(full.checkpoint, checkpoint);
    assert.deepEqual(full.result, result);
    assert.equal(full.objective.length, 1000);
    const read = () => call(user, 'thread_read', { thread_id: thread.id, after_seq: 1 });
    const { typing } = await read();
    assert.equal(typing.length, 1);
    assert.equal(typing[0].task_id, claim.task.id);
    assert.equal(typing[0].agent_id, claim.task.agent_id);
    assert.equal(typing[0].text.length, 4000);
    assert.ok(typing[0].text.endsWith('token=[REDACTED]'));
    assert.ok(!JSON.stringify(typing).includes('supersecret12345'));
    assert.ok(!JSON.stringify(typing).includes('partial_output'));
    assert.ok(!Number.isNaN(Date.parse(typing[0].updated_at)));
    await pool.query("UPDATE tasks SET status='running',kind='review' WHERE id=$1", [claim.task.id]);
    assert.deepEqual((await read()).typing, []);
    await pool.query("UPDATE tasks SET kind='turn',checkpoint='{}'::jsonb WHERE id=$1", [claim.task.id]);
    assert.deepEqual((await read()).typing, []);
    await pool.query('UPDATE tasks SET checkpoint=$2::jsonb WHERE id=$1', [claim.task.id, JSON.stringify(checkpoint)]);
    await call(worker, 'task_finish', { task_id: claim.task.id, lease_token: claim.lease_token,
      lease_generation: claim.lease_generation, outcome: 'completed', result: { answer: 'Done' } });
    assert.deepEqual((await read()).typing, []);
    await event(pool, user, 'project:a', 'task.updated', claim.task.id, { task_id: claim.task.id, action: 'resolved' });
    const events = (await pool.query("SELECT payload FROM events WHERE subject_id=$1 AND name='task.updated'", [claim.task.id])).rows;
    assert.ok(events.some(e => e.payload.action === 'submitted'));
    assert.ok(events.some(e => e.payload.action === 'finished'));
    for (const { payload } of events) {
      assert.equal(payload.kind, 'turn');
      assert.equal(payload.thread_id, thread.id);
    }
    const submitted = (await pool.query("SELECT details FROM audit_log WHERE subject_id=$1 AND operation='task.submitted'", [claim.task.id])).rows[0];
    assert.equal(submitted.details.kind, 'turn');
    assert.equal(submitted.details.thread_id, thread.id);
  });

  for (const model of [undefined, 'configured-full-model']) {
    it(`delegates once with ${model ?? 'default model'}, batches pending messages and posts a notice`, async () => {
      const user = await createPrincipal(randomUUID(), 'delegate-reader');
      const worker = await createPrincipal(user.tenantId, 'delegate-worker', 'worker');
      const { agent, thread } = await call(user, 'agent_create', {
        name: 'Swift', role: 'Helper', instructions: 'Help', scope: 'project:a', runner: { provider: 'claude', ...(model ? { model } : {}) }
      });
      await call(user, 'thread_post', { thread_id: thread.id, body: 'Research this', idempotency_key: 'delegate' });
      const claim = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['claude.read'], kinds: ['turn'] });
      if (model) await call(user, 'thread_post', { thread_id: thread.id, body: 'Also this', idempotency_key: 'pending' });
      const finish = { task_id: claim.task.id, lease_token: claim.lease_token, lease_generation: claim.lease_generation,
        outcome: 'completed', result: { answer: 'I will research this.', delegate: { objective: 'Research in depth' } } };
      await call(worker, 'task_finish', finish);
      assert.equal((await call(worker, 'task_finish', finish)).replayed, true);
      const tasks = (await pool.query('SELECT * FROM tasks WHERE agent_id=$1 ORDER BY created_at', [agent.id])).rows;
      assert.equal(tasks.length, 2);
      assert.equal(tasks[1].objective, 'Research in depth');
      assert.equal(tasks[1].thread_id, thread.id);
      assert.equal(tasks[1].agent_id, agent.id);
      assert.equal(tasks[1].permission_envelope.runner.model, model ?? 'claude-opus-5-5');
      assert.equal(tasks[1].permission_envelope.runner.delegated, true);
      assert.equal(tasks[1].permission_envelope.local_patch, false);
      const messages = (await call(user, 'thread_read', { thread_id: thread.id })).messages;
      assert.equal(messages.filter((m: any) => m.body === 'I will research this.').length, 1);
      const notices = messages.filter((m: any) => m.kind === 'notice');
      assert.equal(notices.length, 1);
      assert.equal(notices[0].author.kind, 'system');
      assert.equal(notices[0].body, `Swift handed this to ${model ?? 'claude-opus-5-5'} for a fuller answer`);
      const next = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['claude.read'], kinds: ['turn'] });
      assert.equal(next.task.id, tasks[1].id);
      await call(worker, 'task_finish', { task_id: next.task.id, lease_token: next.lease_token,
        lease_generation: next.lease_generation, outcome: 'completed', result: { answer: 'Full answer', delegate: { objective: 'Again' } } });
      assert.equal((await pool.query('SELECT id FROM tasks WHERE agent_id=$1', [agent.id])).rows.length, 2);
      assert.equal((await call(user, 'thread_read', { thread_id: thread.id })).messages.filter((m: any) => m.kind === 'notice').length, 1);
    });
  }

  it('delegation keeps hop depth, pins auto agents to Claude, queues behind a busy agent, and skips swarm steps', async () => {
    const user = await createPrincipal(randomUUID(), 'delegate-review');
    const worker = await createPrincipal(user.tenantId, 'delegate-review-worker', 'worker');
    const { agent, thread } = await call(user, 'agent_create', { name: 'Auto', role: 'Helper', instructions: 'Help', scope: 'project:a', runner: { mode: 'auto' } });
    await call(user, 'thread_post', { thread_id: thread.id, body: 'Research this', idempotency_key: 'r1' });
    const claim = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['auto.read', 'claude.read'], kinds: ['turn'] });
    await pool.query("UPDATE tasks SET context_versions = context_versions || '{\"hop_depth\":2}'::jsonb WHERE id=$1", [claim.task.id]);
    // Another task of the same agent is already queued: the delegation must still be queued.
    await pool.query(`INSERT INTO tasks (id, tenant_id, scope, kind, agent_id, thread_id, objective, constraints, acceptance_criteria, permission_envelope,
      required_capability, resource_key, context_versions, status, created_by, idempotency_key, request_hash, max_attempts)
      SELECT gen_random_uuid(), tenant_id, scope, 'turn', agent_id, thread_id, 'busy', '[]', '[]', permission_envelope, required_capability, resource_key,
      '{}', 'queued', created_by, gen_random_uuid()::text, 'busy', 3 FROM tasks WHERE id=$1`, [claim.task.id]);
    await call(worker, 'task_finish', { task_id: claim.task.id, lease_token: claim.lease_token, lease_generation: claim.lease_generation,
      outcome: 'completed', result: { answer: 'On it.', delegate: { objective: 'Research in depth' } } });
    const follow = (await pool.query("SELECT * FROM tasks WHERE agent_id=$1 AND objective='Research in depth'", [agent.id])).rows;
    assert.equal(follow.length, 1, 'queued even though the agent was busy');
    assert.equal(follow[0].context_versions.hop_depth, 2, 'hop depth carries over');
    assert.equal(follow[0].required_capability, 'claude.read', 'an auto agent is pinned to Claude for the Claude model');
    assert.equal(follow[0].permission_envelope.runner.provider, 'claude');
    assert.equal(follow[0].permission_envelope.runner.model, 'claude-opus-5-5');

    const codex = await call(user, 'agent_create', { name: 'Cx', role: 'Helper', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' } });
    await call(user, 'thread_post', { thread_id: codex.thread.id, body: 'Do it', idempotency_key: 'c1' });
    const c = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['codex.read'], kinds: ['turn'] });
    await call(worker, 'task_finish', { task_id: c.task.id, lease_token: c.lease_token, lease_generation: c.lease_generation,
      outcome: 'completed', result: { answer: 'On it.', delegate: { objective: 'Deeper' } } });
    const cf = (await pool.query("SELECT * FROM tasks WHERE agent_id=$1 AND objective='Deeper'", [codex.agent.id])).rows[0];
    assert.equal(cf.required_capability, 'codex.read', 'a named non-Claude runner keeps its provider');
    assert.equal(cf.permission_envelope.runner.model, undefined, 'and is never handed a Claude model');
  });

  it('post queues one turn and finish posts the reply with the next seq', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-alice');
    const worker = await createPrincipal(tenantId, 'worker-1', 'worker');

    // 1. Create an agent
    const { agent, thread } = await call(user, 'agent_create', {
      name: 'Atlas',
      role: 'Team lead',
      instructions: 'You are Atlas. Help with architecture.',
      scope: 'project:a',
      runner: { provider: 'codex' }
    });

    assert.equal(agent.name, 'Atlas');
    assert.equal(agent.main_thread_id, thread.id);

    // 2. Post a message to Atlas's thread
    const postRes = await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'Hello Atlas, please review the PR.',
      idempotency_key: 'idemp-post-1'
    });

    assert.equal(postRes.message.seq, 1);
    assert.equal(postRes.message.author.kind, 'human');

    // Verify turn task was queued
    const tasksRes = await pool.query('SELECT * FROM tasks WHERE agent_id=$1', [agent.id]);
    assert.equal(tasksRes.rowCount, 1);
    const task = tasksRes.rows[0];
    assert.equal(task.kind, 'turn');
    assert.equal(task.status, 'queued');
    assert.equal(task.required_capability, 'codex.read');
    assert.equal(task.resource_key, `agent:${agent.id}`);

    // 3. Worker claims the turn
    const claimRes = await call(worker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['codex.read'],
      kinds: ['turn']
    });

    assert.ok(claimRes.task);
    assert.equal(claimRes.task.id, task.id);
    assert.equal(claimRes.task.kind, 'turn');
    assert.ok(claimRes.task.agent);
    assert.equal(claimRes.task.agent.name, 'Atlas');
    assert.ok(claimRes.task.thread_messages);
    assert.equal(claimRes.task.thread_messages.length, 1);

    // 4. Finish the turn
    await call(worker, 'task_finish', {
      task_id: task.id,
      lease_token: claimRes.lease_token,
      lease_generation: claimRes.lease_generation,
      outcome: 'completed',
      result: {
        provider: 'codex',
        answer: 'The PR architecture looks clean and ready.'
      }
    });

    // 5. Verify thread messages
    const readRes = await call(user, 'thread_read', { thread_id: thread.id });
    assert.equal(readRes.messages.length, 2);
    assert.equal(readRes.messages[0].seq, 1);
    assert.equal(readRes.messages[0].author.kind, 'human');
    assert.equal(readRes.messages[1].seq, 2);
    assert.equal(readRes.messages[1].author.kind, 'agent');
    assert.equal(readRes.messages[1].author.id, agent.id);
    assert.equal(readRes.messages[1].body, 'The PR architecture looks clean and ready.');
  });

  it('posts during a running turn batch into one follow-up turn, not two', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-bob');
    const worker = await createPrincipal(tenantId, 'worker-1', 'worker');

    const { agent, thread } = await call(user, 'agent_create', {
      name: 'Forge',
      role: 'Backend engineer',
      instructions: 'You are Forge.',
      scope: 'project:a',
      runner: { mode: 'auto' }
    });

    // Post 1 queues turn 1
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'Task 1: Set up migrations',
      idempotency_key: 'post-1'
    });

    // Worker claims Turn 1 -> Turn 1 is now running
    const claim1 = await call(worker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['auto.read', 'codex.read'],
      kinds: ['turn']
    });
    assert.ok(claim1.task);
    const turn1Id = claim1.task.id;

    // While Turn 1 is running, human posts twice
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'Task 2: Add API schemas',
      idempotency_key: 'post-2'
    });
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'Task 3: Add error handling',
      idempotency_key: 'post-3'
    });

    // Check that NO new turn tasks have been queued yet while Turn 1 is running
    const runningTasks = await pool.query('SELECT id, status FROM tasks WHERE agent_id=$1', [agent.id]);
    assert.equal(runningTasks.rowCount, 1);
    assert.equal(runningTasks.rows[0].id, turn1Id);

    // Finish Turn 1
    await call(worker, 'task_finish', {
      task_id: turn1Id,
      lease_token: claim1.lease_token,
      lease_generation: claim1.lease_generation,
      outcome: 'completed',
      result: { answer: 'Turn 1 finished: migrations created.' }
    });

    // Check tasks for agent: EXACTLY one follow-up turn was created
    const allTasks = await pool.query('SELECT id, status, kind FROM tasks WHERE agent_id=$1 ORDER BY created_at ASC', [agent.id]);
    assert.equal(allTasks.rowCount, 2);
    assert.equal(allTasks.rows[0].status, 'completed');
    assert.equal(allTasks.rows[1].status, 'queued');
    assert.equal(allTasks.rows[1].kind, 'turn');
    const turn2Id = allTasks.rows[1].id;

    // Worker claims Turn 2: verify it sees all messages including the batch
    const claim2 = await call(worker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['auto.read', 'codex.read'],
      kinds: ['turn']
    });
    assert.ok(claim2.task);
    assert.equal(claim2.task.id, turn2Id);
    // Messages in thread: Post 1, Reply 1, Post 2, Post 3
    assert.equal(claim2.task.thread_messages.length, 4);

    // Finish Turn 2
    await call(worker, 'task_finish', {
      task_id: turn2Id,
      lease_token: claim2.lease_token,
      lease_generation: claim2.lease_generation,
      outcome: 'completed',
      result: { answer: 'Turn 2 finished: API schemas and error handling done.' }
    });

    // No more turns should be queued
    const finalTasks = await pool.query("SELECT id FROM tasks WHERE agent_id=$1 AND status IN ('queued', 'running')", [agent.id]);
    assert.equal(finalTasks.rowCount, 0);
  });

  it('runner switch keeps the thread and posts a notice', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-charlie');

    const { agent, thread } = await call(user, 'agent_create', {
      name: 'Atlas',
      role: 'Team lead',
      instructions: 'Lead the team.',
      scope: 'project:a',
      runner: { provider: 'claude' }
    });

    // Post initial message
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'Initial check-in',
      idempotency_key: 'check-in'
    });

    // Update runner to Codex
    const updated = await call(user, 'agent_update', {
      agent_id: agent.id,
      expected_version: 1,
      runner: { provider: 'codex' }
    });

    assert.equal(updated.agent.version, 2);
    assert.equal(updated.agent.runner.provider, 'codex');

    // Read thread: must have notice posted
    const readRes = await call(user, 'thread_read', { thread_id: thread.id });
    assert.equal(readRes.messages.length, 2);
    assert.equal(readRes.messages[0].kind, 'text');
    assert.equal(readRes.messages[1].kind, 'notice');
    assert.ok(readRes.messages[1].body.includes('Atlas now runs on Codex'));

    // The thread is kept (still thread.id)
    assert.equal(readRes.thread_id, thread.id);
  });

  it('the turn grant refuses posting to another agent thread', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-dan');
    const worker = await createPrincipal(tenantId, 'worker-1', 'worker');

    // Create Agent A and Agent B
    const a = await call(user, 'agent_create', {
      name: 'Agent A', role: 'Dev', instructions: 'A', scope: 'project:a', runner: { provider: 'codex' }
    });
    const b = await call(user, 'agent_create', {
      name: 'Agent B', role: 'Dev', instructions: 'B', scope: 'project:a', runner: { provider: 'codex' }
    });

    // Post to Agent A -> Turn task for Agent A queued
    await call(user, 'thread_post', {
      thread_id: a.thread.id, body: 'Hello A', idempotency_key: 'post-a'
    });

    const claimA = await call(worker, 'task_claim', {
      scope: 'project:a', capabilities: ['codex.read'], kinds: ['turn']
    });
    assert.ok(claimA.task);
    assert.equal(claimA.task.agent_id, a.agent.id);

    // 1. Worker tries to finish Turn A with thread_id pointing to Agent B's thread
    await assert.rejects(
      async () => {
        await call(worker, 'task_finish', {
          task_id: claimA.task.id,
          lease_token: claimA.lease_token,
          lease_generation: claimA.lease_generation,
          outcome: 'completed',
          result: { answer: 'Spoofed reply', thread_id: b.thread.id }
        });
      },
      (err: any) => err instanceof AppError && err.code === 'turn_grant_forbidden'
    );

    // 2. Direct thread_post rejects unknown dead arguments turn_task_id / lease_token
    await assert.rejects(
      async () => {
        await call(user, 'thread_post', {
          thread_id: b.thread.id,
          body: 'Malicious post',
          idempotency_key: 'malicious-1',
          turn_task_id: claimA.task.id
        });
      },
      (err: any) => err instanceof AppError && err.code === 'invalid_arguments'
    );
  });

  it('thread_read pages both ways, and thread_mark_read drives unread counts in agent_list', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-elena');

    const { agent, thread } = await call(user, 'agent_create', {
      name: 'Scout', role: 'Researcher', instructions: 'Research', scope: 'project:a', runner: { provider: 'codex' }
    });

    // Post 5 messages
    for (let i = 1; i <= 5; i++) {
      await call(user, 'thread_post', {
        thread_id: thread.id,
        body: `Message number ${i}`,
        idempotency_key: `msg-${i}`
      });
    }

    // 1. Paging forward (after_seq: 2, limit: 2) -> seq 3, 4
    const pageForward = await call(user, 'thread_read', {
      thread_id: thread.id,
      after_seq: 2,
      limit: 2
    });
    assert.equal(pageForward.messages.length, 2);
    assert.equal(pageForward.messages[0].seq, 3);
    assert.equal(pageForward.messages[1].seq, 4);
    assert.equal(pageForward.has_more, true);

    // 2. Paging backward (before_seq: 4, limit: 2) -> seq 2, 3 (ascending order)
    const pageBackward = await call(user, 'thread_read', {
      thread_id: thread.id,
      before_seq: 4,
      limit: 2
    });
    assert.equal(pageBackward.messages.length, 2);
    assert.equal(pageBackward.messages[0].seq, 2);
    assert.equal(pageBackward.messages[1].seq, 3);

    // 3. Unread count in agent_list initially is 5
    const list1 = await call(user, 'agent_list', { scope: 'project:a' });
    const scout1 = list1.agents.find((x: any) => x.id === agent.id);
    assert.equal(scout1.unread_count, 5);

    // 4. Mark read up to seq 3 -> unread count becomes 2
    const markRes = await call(user, 'thread_mark_read', { thread_id: thread.id, seq: 3 });
    assert.equal(markRes.last_read_seq, 3);

    const list2 = await call(user, 'agent_list', { scope: 'project:a' });
    const scout2 = list2.agents.find((x: any) => x.id === agent.id);
    assert.equal(scout2.unread_count, 2);

    // 5. Mark read up to seq 5 -> unread count becomes 0
    await call(user, 'thread_mark_read', { thread_id: thread.id, seq: 5 });
    const list3 = await call(user, 'agent_list', { scope: 'project:a' });
    const scout3 = list3.agents.find((x: any) => x.id === agent.id);
    assert.equal(scout3.unread_count, 0);
  });

  it('the stream delivers message.created within 1 s and resumes from a cursor without gaps', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-frank');

    const { thread } = await call(user, 'agent_create', {
      name: 'StreamBot', role: 'Tester', instructions: 'Test stream', scope: 'project:a', runner: { provider: 'codex' }
    });

    // Connect to GET /api/stream?after=0.0
    const streamRes = await fetch(`${origin}/api/stream?after=0.0`, {
      headers: { Authorization: `Bearer ${user.token}` }
    });
    assert.equal(streamRes.status, 200);
    assert.equal(streamRes.headers.get('content-type')?.includes('text/event-stream'), true);

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();

    // Helper to read events until condition or timeout
    async function readUntilEvent(timeoutMs = 1500): Promise<{ event: string; id: string; data: Record<string, any> }> {
      const deadline = Date.now() + timeoutMs;
      let buffer = '';
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('\n\n')) {
          const parts = buffer.split('\n\n');
          for (const block of parts) {
            if (block.includes('event: message.created')) {
              const idMatch = block.match(/^id: ([^\n]+)/m);
              const dataMatch = block.match(/^data: ([^\n]+)/m);
              if (idMatch && dataMatch) {
                return { event: 'message.created', id: idMatch[1]!, data: JSON.parse(dataMatch[1]!) };
              }
            }
          }
        }
      }
      throw new Error(`Did not receive event within ${timeoutMs}ms`);
    }

    // Post message 1 while stream is listening
    const startPost = Date.now();
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'Stream test message 1',
      idempotency_key: 'stream-1'
    });

    // Verify stream delivers within 1s
    const firstEvent = await readUntilEvent(1000);
    const elapsed = Date.now() - startPost;
    assert.ok(elapsed <= 1000, `Stream must deliver within 1 s, took ${elapsed} ms`);
    assert.equal(firstEvent.event, 'message.created');
    assert.equal(firstEvent.data.payload.thread_id, thread.id);
    assert.equal(firstEvent.data.payload.seq, 1);
    assert.ok(firstEvent.id, 'Cursor id must be present on SSE message');

    // Disconnect stream
    await reader.cancel();

    // Post messages 2 and 3 while disconnected
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'Stream test message 2',
      idempotency_key: 'stream-2'
    });
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'Stream test message 3',
      idempotency_key: 'stream-3'
    });

    // Reconnect resuming from firstEvent.id cursor
    const resumeRes = await fetch(`${origin}/api/stream?after=${encodeURIComponent(firstEvent.id)}`, {
      headers: { Authorization: `Bearer ${user.token}` }
    });
    assert.equal(resumeRes.status, 200);
    const resumeReader = resumeRes.body!.getReader();

    let resumeBuffer = '';
    const receivedSeqs: number[] = [];
    const resumeDeadline = Date.now() + 2000;

    while (Date.now() < resumeDeadline && receivedSeqs.length < 2) {
      const { value, done } = await resumeReader.read();
      if (done) break;
      resumeBuffer += decoder.decode(value, { stream: true });
      const blocks = resumeBuffer.split('\n\n');
      for (const block of blocks) {
        if (block.includes('event: message.created')) {
          const dataMatch = block.match(/^data: ([^\n]+)/m);
          if (dataMatch) {
            const data = JSON.parse(dataMatch[1]!);
            if (!receivedSeqs.includes(data.payload.seq)) {
              receivedSeqs.push(data.payload.seq);
            }
          }
        }
      }
    }
    await resumeReader.cancel();

    // Verify exactly seq 2 and 3 arrived with no gaps
    assert.deepEqual(receivedSeqs, [2, 3]);
  });

  it('tenant and scope isolation for every tool', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    const userA = await createPrincipal(tenantA, 'user-a', 'frontend', ['project:a']);
    const userB = await createPrincipal(tenantB, 'user-b', 'frontend', ['project:a']);
    const userAWrongScope = await createPrincipal(tenantA, 'user-a2', 'frontend', ['project:b']);

    // Create Agent in Tenant A
    const { agent: agentA, thread: threadA } = await call(userA, 'agent_create', {
      name: 'Agent A', role: 'Dev', instructions: 'Inst A', scope: 'project:a', runner: { provider: 'codex' }
    });

    // 1. Cross-tenant agent_get must fail with not_found (404)
    await assert.rejects(
      () => call(userB, 'agent_get', { agent_id: agentA.id }),
      (err: any) => err instanceof AppError && err.code === 'not_found'
    );

    // 2. Cross-scope agent_get within same tenant must fail with not_found
    await assert.rejects(
      () => call(userAWrongScope, 'agent_get', { agent_id: agentA.id }),
      (err: any) => err instanceof AppError && err.code === 'not_found'
    );

    // 3. Cross-tenant thread_post must fail with not_found
    await assert.rejects(
      () => call(userB, 'thread_post', { thread_id: threadA.id, body: 'Cross tenant', idempotency_key: 'iso-1' }),
      (err: any) => err instanceof AppError && err.code === 'not_found'
    );

    // 4. Cross-tenant thread_read must fail with not_found
    await assert.rejects(
      () => call(userB, 'thread_read', { thread_id: threadA.id }),
      (err: any) => err instanceof AppError && err.code === 'not_found'
    );

    // 5. Cross-tenant thread_mark_read must fail with not_found
    await assert.rejects(
      () => call(userB, 'thread_mark_read', { thread_id: threadA.id, seq: 1 }),
      (err: any) => err instanceof AppError && err.code === 'not_found'
    );

    // 6. Cross-tenant agent_update must fail with not_found
    await assert.rejects(
      () => call(userB, 'agent_update', { agent_id: agentA.id, expected_version: 1, name: 'Hacked' }),
      (err: any) => err instanceof AppError && err.code === 'not_found'
    );

    // 7. Cross-tenant agent_archive must fail with not_found
    await assert.rejects(
      () => call(userB, 'agent_archive', { agent_id: agentA.id }),
      (err: any) => err instanceof AppError && err.code === 'not_found'
    );

    // 8. agent_list must not leak Tenant A's agents to Tenant B
    const listB = await call(userB, 'agent_list', { scope: 'project:a' });
    assert.equal(listB.agents.some((x: any) => x.id === agentA.id), false);
  });

  it('regression 1: an auto agent\'s turn claim returns a route with a provider', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-auto-1');
    const worker = await createPrincipal(tenantId, 'worker-auto-1', 'worker');

    const { agent, thread } = await call(user, 'agent_create', {
      name: 'AutoBot', role: 'Helper', instructions: 'Auto instructions', scope: 'project:a', runner: { mode: 'auto' }
    });

    await call(user, 'thread_post', {
      thread_id: thread.id, body: 'Help me auto', idempotency_key: 'auto-post-1'
    });

    await call(worker, 'usage_report', {
      reports: [{
        provider: 'codex',
        ok: true,
        fetched_at: new Date().toISOString(),
        windows: [{ name: '5h', used_percent: 20 }, { name: 'weekly', used_percent: 20 }]
      }]
    });

    const claimRes = await call(worker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['codex.read', 'auto.read'],
      kinds: ['turn']
    });

    assert.ok(claimRes.task, 'Auto turn task should be claimed');
    assert.equal(claimRes.task.agent_id, agent.id);
    assert.ok(claimRes.route, 'Route must be returned for auto task claim');
    assert.ok(claimRes.route.provider, 'Route provider must not be null');
    assert.ok(claimRes.route.allowed.length > 0, 'Route allowed providers must not be empty');
    assert.ok(claimRes.route.allowed.includes(claimRes.route.provider));
  });

  it('regression 2: worker without task:patch cannot claim or hold edit turns', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-patch-1');
    const roWorker = await createPrincipal(tenantId, 'worker-ro-1', 'worker');
    roWorker.permissions = roWorker.permissions.filter(p => p !== 'task:patch');
    await pool.query('UPDATE principals SET permissions=$2 WHERE id=$1', [roWorker.id, roWorker.permissions]);

    const patchWorker = await createPrincipal(tenantId, 'worker-patch-1', 'worker');
    if (!patchWorker.permissions.includes('task:patch')) {
      patchWorker.permissions.push('task:patch');
      await pool.query('UPDATE principals SET permissions=$2 WHERE id=$1', [patchWorker.id, patchWorker.permissions]);
    }

    const { agent, thread } = await call(user, 'agent_create', {
      name: 'EditBot', role: 'Editor', instructions: 'Edit code', scope: 'project:a',
      runner: { provider: 'codex' }, edits: true
    });

    await call(user, 'thread_post', {
      thread_id: thread.id, body: 'Perform edit', idempotency_key: 'edit-post-1'
    });

    // 1. Worker without task:patch requesting patch capability gets 403 forbidden
    await assert.rejects(
      () => call(roWorker, 'task_claim', {
        scope: 'project:a',
        capabilities: ['codex.patch'],
        kinds: ['turn']
      }),
      (err: any) => err instanceof AppError && err.code === 'forbidden'
    );

    // 2. Worker without task:patch requesting only read capabilities cannot claim edit turns
    const roClaim = await call(roWorker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['codex.read'],
      kinds: ['turn']
    });
    assert.equal(roClaim.task, null);

    // 3. Worker with task:patch can claim the edit turn
    const claimRes = await call(patchWorker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['codex.patch'],
      kinds: ['turn', 'patch']
    });
    assert.ok(claimRes.task, 'Worker with task:patch claims edit turn');
    assert.equal(claimRes.task.agent_id, agent.id);

    // 4. If worker loses task:patch while lease is running, heartbeat fails with 403 forbidden
    patchWorker.permissions = patchWorker.permissions.filter(p => p !== 'task:patch');
    await pool.query('UPDATE principals SET permissions=$2 WHERE id=$1', [patchWorker.id, patchWorker.permissions]);

    await assert.rejects(
      () => call(patchWorker, 'task_heartbeat', {
        task_id: claimRes.task.id,
        lease_token: claimRes.lease_token,
        lease_generation: claimRes.lease_generation,
        lease_seconds: 30
      }),
      (err: any) => err instanceof AppError && err.code === 'forbidden'
    );
  });

  it('regression 3: turns take resource lease agent:<id> preventing concurrent turns for one agent', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-res-1');
    const worker1 = await createPrincipal(tenantId, 'worker-res-1', 'worker');
    const worker2 = await createPrincipal(tenantId, 'worker-res-2', 'worker');

    const { agent, thread } = await call(user, 'agent_create', {
      name: 'SoloBot', role: 'Worker', instructions: 'Solo task', scope: 'project:a', runner: { provider: 'codex' }
    });

    await call(user, 'thread_post', {
      thread_id: thread.id, body: 'Task 1', idempotency_key: 'solo-1'
    });

    const claim1 = await call(worker1, 'task_claim', {
      scope: 'project:a',
      capabilities: ['codex.read'],
      kinds: ['turn']
    });
    assert.ok(claim1.task);
    assert.equal(claim1.task.agent_id, agent.id);

    // Directly insert another turn task for the same agent into tasks table
    const secondTaskId = randomUUID();
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, scope, kind, agent_id, thread_id, objective, constraints, acceptance_criteria,
        permission_envelope, required_capability, resource_key, context_versions, status, created_by, idempotency_key, request_hash, max_attempts)
       VALUES ($1, $2, 'project:a', 'turn', $3, $4, 'Turn 2', '[]', '[]', '{}', 'codex.read', $5, '{}', 'queued', $6, $7, $8, 3)`,
      [secondTaskId, tenantId, agent.id, thread.id, `agent:${agent.id}`, user.id, randomUUID(), 'hash2']
    );

    // Worker 2 attempts to claim while Worker 1 is still running Turn 1
    const claim2 = await call(worker2, 'task_claim', {
      scope: 'project:a',
      capabilities: ['codex.read'],
      kinds: ['turn']
    });
    assert.equal(claim2.task, null, 'Resource lease agent:<id> must prevent second concurrent turn for same agent');

    // Worker 1 finishes Turn 1, releasing resource lease
    await call(worker1, 'task_finish', {
      task_id: claim1.task.id,
      lease_token: claim1.lease_token,
      lease_generation: claim1.lease_generation,
      outcome: 'completed',
      result: { answer: 'Done 1' }
    });

    // Now Worker 2 can claim the second turn
    const claim3 = await call(worker2, 'task_claim', {
      scope: 'project:a',
      capabilities: ['codex.read'],
      kinds: ['turn']
    });
    assert.ok(claim3.task);
    assert.equal(claim3.task.id, secondTaskId);
  });

  it('regression 4: assignThreadSeq locks thread row preventing seq collisions across post, notice, and finish', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-seq-1');
    const { agent, thread } = await call(user, 'agent_create', {
      name: 'SeqBot', role: 'Tester', instructions: 'Seq test', scope: 'project:a', runner: { provider: 'codex' }
    });

    const posts = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call(user, 'thread_post', {
          thread_id: thread.id,
          body: `Message ${i}`,
          idempotency_key: `seq-msg-${i}`
        })
      )
    );

    const seqs = posts.map(p => p.message.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'All 10 concurrent posts must have unique sequential seqs');

    await call(user, 'agent_update', {
      agent_id: agent.id,
      expected_version: 1,
      runner: { provider: 'claude' }
    });

    const messagesRes = await call(user, 'thread_read', { thread_id: thread.id, limit: 20 });
    const readSeqs = messagesRes.messages.map((m: any) => m.seq);
    assert.equal(readSeqs.length, 11);
    assert.deepEqual(readSeqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('regression 5: task_get does not leak thread messages and task_claim bounds turn window to 40 messages or 24 KB', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-leak-1');
    const worker = await createPrincipal(tenantId, 'worker-leak-1', 'worker');

    const { agent, thread } = await call(user, 'agent_create', {
      name: 'LeakBot', role: 'Tester', instructions: 'Test leak', scope: 'project:a', runner: { provider: 'codex' }
    });

    for (let i = 1; i <= 45; i++) {
      await call(user, 'thread_post', {
        thread_id: thread.id,
        body: `Post ${i}`,
        idempotency_key: `leak-post-${i}`
      });
    }

    const listRes = await pool.query('SELECT id FROM tasks WHERE tenant_id=$1 AND agent_id=$2 AND status=\'queued\'', [tenantId, agent.id]);
    const taskId = listRes.rows[0].id;

    // 1. task_get must NOT leak thread_messages or message bodies
    const getRes = await call(user, 'task_get', { task_id: taskId });
    assert.equal(getRes.task.thread_messages, undefined, 'task_get must not include thread_messages');
    assert.equal(getRes.task.agent, undefined, 'task_get must not include agent row');

    // 2. task_claim returns the bounded turn window (capped to 40 messages, oldest first)
    const claimRes = await call(worker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['codex.read'],
      kinds: ['turn']
    });
    assert.ok(claimRes.task);
    assert.ok(Array.isArray(claimRes.task.thread_messages), 'task_claim must include thread_messages window for leaseholder');
    assert.equal(claimRes.task.thread_messages.length, 40, 'Window must cap at 40 messages');
    assert.equal(claimRes.task.thread_messages[0].seq, 6);
    assert.equal(claimRes.task.thread_messages[39].seq, 45);
  });

  it('agent names: a live name clash is a 409, an archived agent frees its name', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-names');
    const make = (name: string) => call(user, 'agent_create', { name, role: 'R', instructions: 'I', scope: 'project:a', runner: { provider: 'codex' } });
    const { agent } = await make('Scout');
    await assert.rejects(() => make('scout'), (e: any) => e.code === 'name_taken');
    await call(user, 'agent_archive', { agent_id: agent.id });
    assert.equal((await make('Scout')).agent.name, 'Scout');
  });

  it('regression 6: agent_update rejects scope argument', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-scope-1');

    const { agent } = await call(user, 'agent_create', {
      name: 'ScopeBot', role: 'Tester', instructions: 'Scope test', scope: 'project:a', runner: { provider: 'codex' }
    });

    await assert.rejects(
      () => call(user, 'agent_update', {
        agent_id: agent.id,
        expected_version: 1,
        scope: 'project:b'
      }),
      (err: any) => err instanceof AppError && err.code === 'invalid_arguments'
    );
  });

  it('regression 8: turn records max prompt seq at claim so queued messages are not answered twice', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-double-1');
    const worker = await createPrincipal(tenantId, 'worker-double-1', 'worker');

    const { agent, thread } = await call(user, 'agent_create', {
      name: 'DoubleBot', role: 'Assistant', instructions: 'Double test', scope: 'project:a', runner: { provider: 'codex' }
    });

    await call(user, 'thread_post', {
      thread_id: thread.id, body: 'Message 1', idempotency_key: 'double-1'
    });

    await call(user, 'thread_post', {
      thread_id: thread.id, body: 'Message 2', idempotency_key: 'double-2'
    });

    const claimRes = await call(worker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['codex.read'],
      kinds: ['turn']
    });
    assert.ok(claimRes.task);
    assert.equal(claimRes.task.context_versions.message_seq, 2);

    await call(worker, 'task_finish', {
      task_id: claimRes.task.id,
      lease_token: claimRes.lease_token,
      lease_generation: claimRes.lease_generation,
      outcome: 'completed',
      result: { answer: 'Answer for 1 and 2' }
    });

    const activeTasks = await pool.query(
      'SELECT id FROM tasks WHERE tenant_id=$1 AND agent_id=$2 AND status IN (\'queued\', \'running\')',
      [tenantId, agent.id]
    );
    assert.equal(activeTasks.rows.length, 0, 'No duplicate follow-up turn should be queued for message 2');

    await call(user, 'thread_post', {
      thread_id: thread.id, body: 'Message 3', idempotency_key: 'double-3'
    });
    const followUpTasks = await pool.query(
      'SELECT id FROM tasks WHERE tenant_id=$1 AND agent_id=$2 AND status=\'queued\'',
      [tenantId, agent.id]
    );
    assert.equal(followUpTasks.rows.length, 1, 'New message after finish should queue follow-up turn');
  });

  it('regression 9: UTF-8 byte length validation rejects 6000 euro signs and byte clips notices', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-bytes-1');
    const worker = await createPrincipal(tenantId, 'worker-bytes-1', 'worker');

    const { agent, thread } = await call(user, 'agent_create', {
      name: 'ByteBot', role: 'Validator', instructions: 'Byte validation test', scope: 'project:a', runner: { provider: 'codex' }
    });

    // 1. 6000 '€' has string length 6000 (<= 16384 characters), but byte length 18000 (> 16384 octets)
    const euro6000 = '€'.repeat(6000);
    await assert.rejects(
      () => call(user, 'thread_post', {
        thread_id: thread.id,
        body: euro6000,
        idempotency_key: 'euro-post-1'
      }),
      (err: any) => err instanceof AppError && err.code === 'invalid_arguments'
    );

    // 2. 3000 '€' in agent_create instructions: length 3000 (<= 8192 chars), but 9000 bytes (> 8192 octets)
    await assert.rejects(
      () => call(user, 'agent_create', {
        name: 'HugeInstBot', role: 'Validator', instructions: '€'.repeat(3000), scope: 'project:a', runner: { provider: 'codex' }
      }),
      (err: any) => err instanceof AppError && err.code === 'invalid_arguments'
    );

    // 3. Post a valid message to queue turn
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'Valid message',
      idempotency_key: 'valid-post-1'
    });

    // 4. Claim and finish with a multi-byte answer > 16384 bytes -> clips cleanly by bytes without DB constraint error
    const claimRes = await call(worker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['codex.read'],
      kinds: ['turn']
    });

    const hugeAnswer = '€'.repeat(6000);
    await call(worker, 'task_finish', {
      task_id: claimRes.task.id,
      lease_token: claimRes.lease_token,
      lease_generation: claimRes.lease_generation,
      outcome: 'completed',
      result: { answer: hugeAnswer }
    });

    const threadRes = await call(user, 'thread_read', { thread_id: thread.id, limit: 1 });
    const reply = threadRes.messages[0];
    assert.equal(reply.kind, 'text');
    assert.ok(Buffer.byteLength(reply.body, 'utf8') <= 16384, 'Reply body must be clipped to <= 16384 UTF-8 bytes');
  });

  it('regression 10: message idempotency key is unique per author and rejects different body with idempotency_conflict', async () => {
    const tenantId = randomUUID();
    const user1 = await createPrincipal(tenantId, 'user-idemp-1');
    const user2 = await createPrincipal(tenantId, 'user-idemp-2');

    const { thread } = await call(user1, 'agent_create', {
      name: 'IdempBot', role: 'Tester', instructions: 'Idemp test', scope: 'project:a', runner: { provider: 'codex' }
    });

    const post1 = await call(user1, 'thread_post', {
      thread_id: thread.id, body: 'Hello from User 1', idempotency_key: 'shared-key-1'
    });
    assert.equal(post1.replayed, false);

    const post1Replay = await call(user1, 'thread_post', {
      thread_id: thread.id, body: 'Hello from User 1', idempotency_key: 'shared-key-1'
    });
    assert.equal(post1Replay.replayed, true);
    assert.equal(post1Replay.message.id, post1.message.id);

    await assert.rejects(
      () => call(user1, 'thread_post', {
        thread_id: thread.id, body: 'Different body from User 1', idempotency_key: 'shared-key-1'
      }),
      (err: any) => err instanceof AppError && err.code === 'idempotency_conflict'
    );

    const post2 = await call(user2, 'thread_post', {
      thread_id: thread.id, body: 'Hello from User 2', idempotency_key: 'shared-key-1'
    });
    assert.equal(post2.replayed, false);
    assert.notEqual(post2.message.id, post1.message.id);
  });

  it('regression 11: GET /api/stream requires events:read, caps concurrent streams at 4, rechecks principal on heartbeat', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-stream-reg');

    const noEventsUser = await createPrincipal(tenantId, 'user-no-events');
    noEventsUser.permissions = noEventsUser.permissions.filter(p => p !== 'events:read');
    await pool.query('UPDATE principals SET permissions=$2 WHERE id=$1', [noEventsUser.id, noEventsUser.permissions]);

    const resForbidden = await fetch(`${origin}/api/stream?after=0.0`, {
      headers: { Authorization: `Bearer ${noEventsUser.token}` }
    });
    assert.equal(resForbidden.status, 403);

    // Rejected requests must not hold a stream slot.
    for (let i = 0; i < 4; i++) {
      const bad = await fetch(`${origin}/api/stream?after=x`, { headers: { Authorization: `Bearer ${user.token}` } });
      assert.equal(bad.status, 400);
      await bad.body?.cancel();
    }

    const streams: Response[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await fetch(`${origin}/api/stream?after=0.0`, {
        headers: { Authorization: `Bearer ${user.token}` }
      });
      assert.equal(s.status, 200);
      streams.push(s);
    }

    const stream5 = await fetch(`${origin}/api/stream?after=0.0`, {
      headers: { Authorization: `Bearer ${user.token}` }
    });
    assert.equal(stream5.status, 429);
    const body5 = (await stream5.json()) as any;
    assert.equal(body5.error.code, 'too_many_streams');

    await streams[0]!.body?.cancel();
    await new Promise(r => setTimeout(r, 50));

    const streamRetry = await fetch(`${origin}/api/stream?after=0.0`, {
      headers: { Authorization: `Bearer ${user.token}` }
    });
    assert.equal(streamRetry.status, 200);

    await streamRetry.body?.cancel();
    for (const s of streams.slice(1)) {
      await s.body?.cancel();
    }

    // 5. Recheck principal on heartbeat: disabling principal closes the stream
    const streamToRevoke = await fetch(`${origin}/api/stream?after=0.0`, {
      headers: { Authorization: `Bearer ${user.token}` }
    });
    assert.equal(streamToRevoke.status, 200);
    const revokeReader = streamToRevoke.body!.getReader();

    // Disable principal in database
    await pool.query('UPDATE principals SET disabled=true WHERE id=$1', [user.id]);

    let closed = false;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const res = await revokeReader.read();
      if (res.done) {
        closed = true;
        break;
      }
    }
    assert.ok(closed, 'Stream must be terminated when principal is disabled on heartbeat');

    await pool.query('UPDATE principals SET disabled=false WHERE id=$1', [user.id]);

    // 6. thread_post rejects dead arguments turn_task_id and lease_token
    const { thread } = await call(user, 'agent_create', {
      name: 'DeadArgBot', role: 'Tester', instructions: 'Inst', scope: 'project:a', runner: { provider: 'codex' }
    });
    await assert.rejects(
      () => call(user, 'thread_post', {
        thread_id: thread.id, body: 'test', idempotency_key: 'dead-1', turn_task_id: randomUUID()
      }),
      (err: any) => err instanceof AppError && err.code === 'invalid_arguments'
    );
    await assert.rejects(
      () => call(user, 'thread_post', {
        thread_id: thread.id, body: 'test', idempotency_key: 'dead-2', lease_token: 'dead'
      }),
      (err: any) => err instanceof AppError && err.code === 'invalid_arguments'
    );
  });
});
