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

describe('teams service performance fixes', { skip: !connectionString, concurrency: false }, () => {
  const schema = `teams_fixes_${randomUUID().replaceAll('-', '')}`;
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

  const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
  async function fixture() {
    const user = await createPrincipal(randomUUID(), 'reader');
    const { agent, thread } = await call(user, 'agent_create', {
      name: 'Atlas', role: 'Lead', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' }
    });
    return { user, agent, thread };
  }
  async function counted(fn: () => Promise<any>) {
    const original = pool.query;
    const sql: string[] = [];
    pool.query = function (this: Pool, ...args: any[]) {
      sql.push(typeof args[0] === 'string' ? args[0] : args[0].text);
      return (original as any).apply(this, args);
    } as typeof pool.query;
    try { return { value: await fn(), sql }; } finally { pool.query = original; }
  }

  it('default page is newest, ascending, with both paging directions preserved', async () => {
    const { user, thread } = await fixture();
    for (let i = 1; i <= 6; i++) await call(user, 'thread_post', { thread_id: thread.id, body: `Post ${i}`, idempotency_key: `p${i}` });
    const latest = await call(user, 'thread_read', { thread_id: thread.id, limit: 2 });
    assert.deepEqual(latest.messages.map((m: any) => m.seq), [5, 6]);
    assert.equal(latest.has_more, true);
    const older = await call(user, 'thread_read', { thread_id: thread.id, before_seq: 5, limit: 2 });
    assert.deepEqual(older.messages.map((m: any) => m.seq), [3, 4]);
    const newer = await call(user, 'thread_read', { thread_id: thread.id, after_seq: 4, limit: 2 });
    assert.deepEqual(newer.messages.map((m: any) => m.seq), [5, 6]);
    assert.equal(newer.has_more, false);
  });

  it('embeds open/answered questions, answers and complete swarm cards in bounded batches', async () => {
    const { user, agent, thread } = await fixture();
    const q1 = randomUUID(), q2 = randomUUID();
    for (const [id, status] of [[q1, 'open'], [q2, 'answered']]) {
      await pool.query(`INSERT INTO questions(id,tenant_id,scope,thread_id,agent_id,prompt,options,status,choices,answer_text)
        VALUES($1,$2,'project:a',$3,$4,'Choose','["yes"]',$5,$6::jsonb,$7)`,
        [id, user.tenantId, thread.id, agent.id, status, status === 'answered' ? '["yes"]' : null, status === 'answered' ? 'Agreed' : null]);
    }
    const { swarm } = await call(user, 'swarm_start', {
      title: 'Plan', goal: 'Ship', scope: 'project:a', thread_id: thread.id, owner_agent_id: agent.id,
      steps: [{ key: 'a', title: 'Work', assignee_agent_id: agent.id }], idempotency_key: 'swarm'
    });
    for (const [kind, ref] of [['question', { question_id: q1 }], ['question', { question_id: q2 }], ['answer', { question_id: q2 }], ['swarm', { swarm_id: swarm.id }], ['swarm', { swarm_id: swarm.id }]] as const) {
      await pool.query(`INSERT INTO messages(id,tenant_id,scope,thread_id,seq,author,kind,body,ref)
        SELECT $1,$2,'project:a',$3,COALESCE(max(seq),0)+1,'{"kind":"system","id":"test"}',$4,'unchanged',$5::jsonb FROM messages WHERE thread_id=$3`,
        [randomUUID(), user.tenantId, thread.id, kind, JSON.stringify(ref)]);
    }
    const { value, sql } = await counted(() => call(user, 'thread_read', { thread_id: thread.id }));
    const questions = value.messages.filter((m: any) => m.kind === 'question');
    assert.equal(questions[0].question.answer, null);
    assert.deepEqual(questions[1].question.answer, { choices: ['yes'], text: 'Agreed' });
    assert.deepEqual(value.messages.find((m: any) => m.kind === 'answer').answer, { question_id: q2, choices: ['yes'], text: 'Agreed' });
    const expected = (await call(user, 'swarm_get', { swarm_id: swarm.id })).swarm;
    for (const m of value.messages.filter((m: any) => m.kind === 'swarm')) assert.deepEqual(m.swarm, expected);
    assert.equal(questions[0].body, 'unchanged');
    assert.deepEqual(questions[0].ref, { question_id: q1 });
    assert.equal(sql.filter(s => /FROM questions/.test(s)).length, 1);
    assert.equal(sql.filter(s => /FROM swarms/.test(s)).length, 1);
    assert.equal(sql.length, 4);
    const limited = { ...user, permissions: user.permissions.filter(p => p !== 'task:read') };
    assert.equal((await call(limited, 'thread_read', { thread_id: thread.id })).messages.find((m: any) => m.kind === 'swarm').swarm, undefined);
  });

  it('task_resolve accepts answer_questions, rejects missing grants/names/scopes and active tasks', async () => {
    const { user, thread } = await fixture();
    await call(user, 'thread_post', { thread_id: thread.id, body: 'Work', idempotency_key: 'work' });
    const task = (await pool.query('SELECT * FROM tasks WHERE thread_id=$1', [thread.id])).rows[0];
    const granted: Principal = { ...user, permissions: [...user.permissions, 'answer_questions'] };
    const args = { task_id: task.id, expected_version: task.version, resolved: true };
    for (const p of [user, { ...granted, name: 'Grok' }, { ...granted, name: 'DOT' }]) {
      await assert.rejects(call(p, 'task_resolve', args), (e: any) => e.status === 403);
    }
    for (const status of ['queued', 'running']) {
      if (status === 'running') {
        const worker = await createPrincipal(user.tenantId, 'worker', 'worker');
        await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['codex.read'], kinds: ['turn'] });
      }
      await assert.rejects(call(granted, 'task_resolve', args), (e: any) => e.status === 409 && e.code === 'task_active');
    }
    await pool.query("UPDATE tasks SET status='completed', lease_owner=NULL, lease_hash=NULL, lease_expires_at=NULL WHERE id=$1", [task.id]);
    await assert.rejects(call({ ...granted, scopes: ['project:elsewhere'] }, 'task_resolve', args), (e: any) => e.status === 403);
    args.expected_version = (await pool.query('SELECT version FROM tasks WHERE id=$1', [task.id])).rows[0].version;
    assert.ok((await call(granted, 'task_resolve', args)).task.resolved_at);
  });

  it('agent_list query count is constant for 5 and 50 agents; thread_list stays one query', async () => {
    const { user } = await fixture();
    for (let i = 1; i < 50; i++) await call(user, 'agent_create', { name: `Agent-${i}`, role: 'Help', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' } });
    const small = await counted(() => call(user, 'agent_list', { limit: 5 }));
    const large = await counted(() => call(user, 'agent_list', { limit: 50 }));
    assert.equal(small.value.agents.length, 5); assert.equal(large.value.agents.length, 50);
    assert.equal(small.sql.length, large.sql.length); assert.ok(large.sql.length <= 6);
    assert.ok(large.value.agents.every((a: any) => a.status === 'offline'));
    await createPrincipal(user.tenantId, 'live', 'worker');
    assert.ok((await call(user, 'agent_list')).agents.every((a: any) => a.status === 'idle'));
    assert.equal((await counted(() => call(user, 'thread_list', { limit: 50 }))).sql.length, 1);
  });

  it('NOTIFY wakes every idle stream within 50 ms of commit with a 2 s safety poll', async () => {
    const { user } = await fixture();
    const { channel } = await call(user, 'channel_create', { name: 'Live', scope: 'project:a', members: [] });
    const controllers = [new AbortController(), new AbortController()];
    const received: number[] = [];
    const readers: Promise<void>[] = [];
    try {
      for (const controller of controllers) {
        const response = await fetch(`${origin}/api/stream?after=now`, { headers: { Authorization: `Bearer ${user.token}` }, signal: controller.signal });
        const reader = response.body!.getReader();
        await reader.read(); // initial cursor
        readers.push((async () => {
          let text = '';
          try {
            while (true) {
              const r = await reader.read(); if (r.done) break;
              text += new TextDecoder().decode(r.value);
              if (text.includes('event: message.created')) { received.push(performance.now()); break; }
            }
          } catch (e) { if (!controller.signal.aborted) throw e; }
        })());
      }
      await pause(60); // idle after initial read; baseline's 200 ms poll is still asleep
      const client = await pool.connect();
      let committed: number;
      try {
        await client.query('BEGIN');
        const { event } = await import('../src/core/shared.js');
        await event(client, user, 'project:a', 'message.created', randomUUID(), { thread_id: channel.id });
        await pause(20);
        assert.equal(received.length, 0, 'no notification before commit');
        await client.query('COMMIT'); committed = performance.now();
      } finally { client.release(); }
      await Promise.race([Promise.all(readers), pause(1000)]);
      assert.equal(received.length, 2);
      for (const at of received) assert.ok(at - committed! < 50, `delivery ${at - committed!} ms`);
    } finally { controllers.forEach(c => c.abort()); await Promise.all(readers); }
  });
});
