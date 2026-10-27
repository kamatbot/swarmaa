/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { AuthService, hashToken, newToken } from '../src/auth.js';
import { CoreService } from '../src/core/index.js';
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
    server = createServer(createHttpHandler({ pool, core, auth: new AuthService(pool), config }));
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

    // 2. Direct thread_post with turn_task_id targeting Agent B's thread
    await assert.rejects(
      async () => {
        await call(user, 'thread_post', {
          thread_id: b.thread.id,
          body: 'Malicious post',
          idempotency_key: 'malicious-1',
          turn_task_id: claimA.task.id
        });
      },
      (err: any) => err instanceof AppError && err.code === 'turn_grant_forbidden'
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
});
