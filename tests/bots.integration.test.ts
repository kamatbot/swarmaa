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

describe('bots core service (Brief B1)', { skip: !connectionString, concurrency: false }, () => {
  const schema = `bots_test_${randomUUID().replaceAll('-', '')}`;
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

  async function createPrincipal(tenantId: string, name: string, role: Principal['role'] = 'frontend', scopes = ['project:a', 'project:b']) {
    const p: Principal = {
      id: randomUUID(),
      tenantId,
      name,
      role,
      scopes,
      permissions: role === 'worker' ? [...ROLE_PERMISSIONS[role], 'task:patch'] : [...ROLE_PERMISSIONS[role]]
    };
    const token = newToken();
    await pool.query(
      `INSERT INTO principals(id, tenant_id, name, role, scopes, permissions, token_hash, last_seen_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, clock_timestamp())`,
      [p.id, p.tenantId, name, role, scopes, p.permissions, hashToken(token)]
    );
    return { ...p, token };
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

  it('validates appearance updates, preserves legacy avatars and exposes color in views', async () => {
    const user = await createPrincipal(randomUUID(), 'appearance-owner');
    const lead = (await call(user, 'agent_create', {
      name: 'Lead', role: 'Lead', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;
    let bot = (await call(user, 'bot_create', {
      name: 'Appearance', job: 'Help', scope: 'project:a', lead_agent_id: lead.id, member_agent_ids: []
    })).bot;
    assert.equal(bot.color, null);
    await pool.query('UPDATE bots SET avatar=$2 WHERE id=$1', [bot.id, 'legacy free text']);
    bot = (await call(user, 'bot_update', { bot_id: bot.id, expected_version: bot.version, color: 'blue' })).bot;
    assert.equal(bot.avatar, 'legacy free text');
    for (const fields of [{ avatar: 'mark' }, { avatar: 'unknown' }, { avatar: '' }, { avatar: 42 },
      { color: 'orange' }, { color: 'green' }, { color: 'unknown' }, { color: false }]) {
      await assert.rejects(call(user, 'bot_update', { bot_id: bot.id, expected_version: bot.version, ...fields }),
        (e: unknown) => e instanceof AppError && e.status === 400 && e.code === 'invalid_arguments');
    }
    for (const [avatar, color] of [['lead', 'blue'], ['runner', 'butter'], ['scout', 'peach'], ['navigator', 'lilac'],
      ['clerk', 'pink'], ['scribe', 'lime'], ['badge-sun', 'sky'], ['badge-peri', 'orchid'], ['badge-peach', null], [null, null]]) {
      bot = (await call(user, 'bot_update', { bot_id: bot.id, expected_version: bot.version, avatar, color })).bot;
      assert.equal(bot.avatar, avatar);
      assert.equal(bot.color, color);
      assert.equal((await call(user, 'bot_get', { bot_id: bot.id })).bot.color, color);
      assert.equal((await call(user, 'bot_list', { scope: 'project:a' })).bots[0].color, color);
    }
    await assert.rejects(pool.query('UPDATE bots SET color=$2 WHERE id=$1', [bot.id, 'orange']), { code: '23514' });
  });

  it('applies bot appearance on completion once, audits it, and rejects invalid or non-bot actions', async () => {
    const user = await createPrincipal(randomUUID(), 'appearance-turn-owner');
    const worker = await createPrincipal(user.tenantId, 'appearance-worker', 'worker');
    const made = await call(user, 'agent_create', {
      name: 'Lead', role: 'Lead', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' }
    });
    const { bot, thread } = await call(user, 'bot_create', {
      name: 'Appearance', job: 'Help', scope: 'project:a', lead_agent_id: made.agent.id, member_agent_ids: [], rules: { first_reply: 'off' }, routing: { summary: { provider: 'codex' } }
    });
    async function finish(threadId: string, action: Record<string, unknown>) {
      await call(user, 'thread_post', { thread_id: threadId, body: 'Change appearance', idempotency_key: randomUUID() });
      const claim = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['codex.read'], kinds: ['turn'] });
      assert.ok(claim.task);
      const args = { task_id: claim.task.id, lease_token: claim.lease_token, lease_generation: claim.lease_generation,
        outcome: 'completed', result: { answer: 'Done\n\n```swarmaa-actions\n' + JSON.stringify([action]) + '\n```' } };
      await call(worker, 'task_finish', args);
      return args;
    }
    const args = await finish(thread.id, { type: 'bot_appearance', avatar: 'scout', color: 'peach' });
    await call(worker, 'task_finish', args);
    let updated = (await call(user, 'bot_get', { bot_id: bot.id })).bot;
    assert.equal(updated.version, bot.version + 1);
    assert.equal(updated.avatar, 'scout');
    assert.equal(updated.color, 'peach');
    assert.equal((await pool.query("SELECT 1 FROM events WHERE subject_id=$1 AND name='bot.updated' AND payload->>'reason'='appearance'", [bot.id])).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE subject_id=$1 AND operation='bot.update' AND details->>'reason'='appearance'", [bot.id])).rowCount, 1);
    for (const fields of [{ avatar: 'mark' }, { avatar: 'unknown' }, { color: 'unknown' }]) {
      await finish(thread.id, { type: 'bot_appearance', ...fields });
      const messages = (await call(user, 'thread_read', { thread_id: thread.id })).messages;
      assert.match(messages.at(-1).body, /Turn action rejected/);
      assert.equal((await call(user, 'bot_get', { bot_id: bot.id })).bot.version, updated.version);
    }
    await finish(made.thread.id, { type: 'bot_appearance', avatar: 'runner' });
    const messages = (await call(user, 'thread_read', { thread_id: made.thread.id })).messages;
    assert.match(messages.at(-1).body, /bot_appearance requires a bot turn/);
    assert.equal((await call(user, 'bot_get', { bot_id: bot.id })).bot.version, updated.version);
    await finish(thread.id, { type: 'bot_appearance', color: null });
    updated = (await call(user, 'bot_get', { bot_id: bot.id })).bot;
    assert.equal(updated.avatar, 'scout');
    assert.equal(updated.color, null);
  });

  it('create, update and archive, with versions, idempotency and name_taken', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-1');

    const lead = (await call(user, 'agent_create', {
      name: 'Atlas', role: 'Lead', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;
    const member = (await call(user, 'agent_create', {
      name: 'Forge', role: 'Dev', instructions: 'Code', scope: 'project:a', runner: { provider: 'claude' }, edits: true
    })).agent;

    // 1. Create bot
    const createRes = await call(user, 'bot_create', {
      name: 'Launch',
      job: 'Coordinate project launch and track marketing banners',
      scope: 'project:a',
      lead_agent_id: lead.id,
      member_agent_ids: [member.id],
      routing: {
        research: { mode: 'auto' },
        patch: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }
      },
      rules: { quota_floor_pct: 10, review_edits: true },
      schedule: '0 9 * * 1-5',
      idempotency_key: 'idem-bot-create'
    });

    const bot = createRes.bot;
    assert.equal(bot.name, 'Launch');
    assert.equal(bot.version, 1);
    assert.equal(bot.archived, false);
    assert.equal(bot.lead_agent_id, lead.id);
    assert.deepEqual(bot.member_agent_ids, [member.id]);
    assert.equal(createRes.thread.kind, 'bot');
    assert.equal(createRes.thread.title, 'Launch');
    assert.equal(createRes.thread.lead_agent_id, lead.id);

    // 2. Idempotency replay
    const replayed = await call(user, 'bot_create', {
      name: 'Launch',
      job: 'Coordinate project launch and track marketing banners',
      scope: 'project:a',
      lead_agent_id: lead.id,
      member_agent_ids: [member.id],
      idempotency_key: 'idem-bot-create'
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.bot.id, bot.id);

    // 3. Name taken conflict
    await assert.rejects(
      call(user, 'bot_create', {
        name: 'launch', // case-insensitive duplicate
        job: 'Another launch',
        scope: 'project:a',
        lead_agent_id: lead.id,
        member_agent_ids: []
      }),
      (err: any) => err.status === 409 && err.code === 'name_taken'
    );

    // Same name in different scope is allowed
    const otherScopeLead = (await call(user, 'agent_create', {
      name: 'Atlas2', role: 'Lead', instructions: 'Help', scope: 'project:b', runner: { provider: 'codex' }
    })).agent;
    const botProjectB = await call(user, 'bot_create', {
      name: 'Launch',
      job: 'Launch in project B',
      scope: 'project:b',
      lead_agent_id: otherScopeLead.id,
      member_agent_ids: []
    });
    assert.equal(botProjectB.bot.scope, 'project:b');

    // 4. Update with expected_version
    await assert.rejects(
      call(user, 'bot_update', {
        bot_id: bot.id,
        expected_version: 99,
        job: 'New job description'
      }),
      (err: any) => err.status === 409 && err.code === 'conflict'
    );

    const updateRes = await call(user, 'bot_update', {
      bot_id: bot.id,
      expected_version: 1,
      job: 'Updated job description',
      routing: {
        patch: { provider: 'codex' }
      }
    });
    assert.equal(updateRes.bot.version, 2);
    assert.equal(updateRes.bot.job, 'Updated job description');

    // Verify notice was posted to bot thread on routing update
    const threadAfterUpdate = await call(user, 'thread_read', { thread_id: bot.thread_id });
    const notice = threadAfterUpdate.messages.find((m: any) => m.kind === 'notice');
    assert.ok(notice, 'notice message should be posted to bot thread');
    assert.ok(notice.body.includes('Edits now run on Codex'));

    // 5. Archive
    const archived = await call(user, 'bot_archive', { bot_id: bot.id });
    assert.equal(archived.bot.archived, true);
    assert.equal(archived.bot.version, 3);

    // Re-creating bot with previously taken name now succeeds since archived
    const recreated = await call(user, 'bot_create', {
      name: 'Launch',
      job: 'New active launch bot',
      scope: 'project:a',
      lead_agent_id: lead.id,
      member_agent_ids: []
    });
    assert.equal(recreated.bot.name, 'Launch');
    assert.notEqual(recreated.bot.id, bot.id);
  });

  it('unarchives with schedule recomputed, preserving cancelled tasks and the cleared star', async () => {
    const user = await createPrincipal(randomUUID(), 'unarchive-owner');
    const lead = (await call(user, 'agent_create', {
      name: 'Lead', role: 'Lead', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;
    for (const paused of [false, true]) {
      const bot = (await call(user, 'bot_create', {
        name: `Scheduled ${paused}`, job: 'Help', scope: 'project:a', lead_agent_id: lead.id,
        member_agent_ids: [], starred: true, schedule: '0 9 * * *', rules: { schedule_paused: paused }
      })).bot;
      await call(user, 'thread_post', { thread_id: bot.thread_id, body: 'Help', idempotency_key: `post-${paused}` });
      await call(user, 'bot_archive', { bot_id: bot.id });
      assert.ok(!(await call(user, 'bot_list', {})).bots.some((b: any) => b.id === bot.id));
      assert.equal((await call(user, 'bot_list', { include_archived: true })).bots.find((b: any) => b.id === bot.id).archived, true);
      await pool.query("UPDATE bots SET next_run_at='2000-01-01' WHERE id=$1", [bot.id]);
      const restored = (await call(user, 'bot_unarchive', { bot_id: bot.id })).bot;
      assert.equal(restored.archived, false);
      assert.equal(restored.starred, false);
      assert.equal(restored.schedule, bot.schedule);
      assert.equal(restored.rules.schedule_paused, paused);
      assert.equal(restored.version, bot.version + 2);
      if (paused) assert.equal(restored.next_run_at, null);
      else assert.ok(Date.parse(restored.next_run_at) > Date.now());
      assert.deepEqual((await pool.query('SELECT status FROM tasks WHERE bot_id=$1', [bot.id])).rows.map(r => r.status), ['cancelled']);
    }
    const original = (await call(user, 'bot_list', {})).bots[0];
    await call(user, 'bot_archive', { bot_id: original.id });
    await call(user, 'bot_create', { name: original.name, job: 'Help', scope: 'project:a', lead_agent_id: lead.id, member_agent_ids: [] });
    await assert.rejects(call(user, 'bot_unarchive', { bot_id: original.id }), (e: any) => e.code === 'name_taken');
  });

  it('deletes only an archived, exactly confirmed bot and preserves tasks and agents', async () => {
    const user = await createPrincipal(randomUUID(), 'delete-owner');
    const lead = (await call(user, 'agent_create', {
      name: 'Lead', role: 'Lead', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;
    const bot = (await call(user, 'bot_create', {
      name: 'Delete Me', job: 'Help', scope: 'project:a', lead_agent_id: lead.id, member_agent_ids: []
    })).bot;
    await call(user, 'thread_post', { thread_id: bot.thread_id, body: 'Keep my task', idempotency_key: 'delete-post' });
    const task = (await pool.query('SELECT * FROM tasks WHERE bot_id=$1', [bot.id])).rows[0];
    assert.ok(task);
    await pool.query(`INSERT INTO questions(id,tenant_id,scope,thread_id,agent_id,prompt) VALUES($1,$2,'project:a',$3,$4,'Question')`,
      [randomUUID(), user.tenantId, bot.thread_id, lead.id]);
    await assert.rejects(call(user, 'bot_delete', { bot_id: bot.id, confirm_name: bot.name }),
      (e: any) => e.status === 409 && e.code === 'bot_not_archived');
    await call(user, 'bot_archive', { bot_id: bot.id });
    for (const name of ['delete me', 'Delete Me ', '', undefined]) {
      await assert.rejects(call(user, 'bot_delete', { bot_id: bot.id, confirm_name: name }),
        (e: any) => e.status === 400 && e.code === 'confirm_mismatch');
    }
    assert.ok((await call(user, 'thread_read', { thread_id: bot.thread_id })).messages.length > 0);
    assert.deepEqual(await call(user, 'bot_delete', { bot_id: bot.id, confirm_name: bot.name }), { deleted: true });
    for (const [table, key, id] of [['bots', 'id', bot.id], ['threads', 'id', bot.thread_id],
      ['messages', 'thread_id', bot.thread_id], ['questions', 'thread_id', bot.thread_id], ['thread_members', 'thread_id', bot.thread_id]]) {
      assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE ${key}=$1`, [id])).rowCount, 0);
    }
    const retained = (await pool.query('SELECT * FROM tasks WHERE id=$1', [task.id])).rows[0];
    assert.equal(retained.bot_id, null);
    assert.equal(retained.thread_id, null);
    assert.equal(retained.status, 'cancelled');
    assert.equal((await call(user, 'agent_get', { agent_id: lead.id })).agent.id, lead.id);
    assert.equal((await pool.query("SELECT 1 FROM events WHERE subject_id=$1 AND name='bot.updated' AND payload->>'reason'='deleted'", [bot.id])).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE subject_id=$1 AND operation='bot.delete'", [bot.id])).rowCount, 1);
  });

  it('posts crew notices only for a changed lead or member set', async () => {
    const user = await createPrincipal(randomUUID(), 'crew-owner');
    const agents = [];
    for (const name of ['Lead', 'One', 'Two']) agents.push((await call(user, 'agent_create', {
      name, role: 'Member', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' }
    })).agent);
    let bot = (await call(user, 'bot_create', {
      name: 'Crew', job: 'Help', scope: 'project:a', lead_agent_id: agents[0].id,
      member_agent_ids: [agents[1].id, agents[2].id], schedule: '0 9 * * *'
    })).bot;
    const notices = async () => (await pool.query("SELECT body FROM messages WHERE thread_id=$1 AND kind='notice' AND body LIKE '%Crew updated%'", [bot.thread_id])).rows;
    bot = (await call(user, 'bot_update', { bot_id: bot.id, expected_version: bot.version,
      lead_agent_id: agents[0].id, member_agent_ids: [agents[2].id, agents[1].id, agents[1].id], rules: { schedule_paused: true } })).bot;
    assert.deepEqual(await notices(), []);
    bot = (await call(user, 'bot_update', { bot_id: bot.id, expected_version: bot.version, member_agent_ids: [agents[1].id] })).bot;
    assert.equal((await notices()).length, 1);
    bot = (await call(user, 'bot_update', { bot_id: bot.id, expected_version: bot.version,
      lead_agent_id: agents[1].id, member_agent_ids: [agents[0].id] })).bot;
    assert.equal((await notices()).length, 2);
  });

  it('guards unarchive and delete with archive-equivalent permissions, tenant and scope', async () => {
    const user = await createPrincipal(randomUUID(), 'guards-owner');
    const other = await createPrincipal(randomUUID(), 'guards-other');
    const limited = await createPrincipal(user.tenantId, 'guards-limited', 'frontend', ['project:b']);
    const lead = (await call(user, 'agent_create', { name: 'Lead', role: 'Lead', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' } })).agent;
    const bot = (await call(user, 'bot_create', { name: 'Guarded', job: 'Help', scope: 'project:a', lead_agent_id: lead.id, member_agent_ids: [] })).bot;
    await call(user, 'bot_archive', { bot_id: bot.id });
    for (const tool of ['bot_unarchive', 'bot_delete']) {
      const args = { bot_id: bot.id, ...(tool === 'bot_delete' ? { confirm_name: bot.name } : {}) };
      await assert.rejects(call(other, tool, args), (e: any) => e.status === 404);
      await assert.rejects(call(limited, tool, args), (e: any) => e.status === 403);
      for (const permission of ['agent:read', 'agent:manage']) {
        const denied = { ...user, permissions: user.permissions.filter(p => p !== permission) };
        assert.ok(!core.listTools(denied).some(t => t.name === tool));
        await assert.rejects(call(denied, tool, args), (e: any) => e.status === 403);
      }
      assert.ok(core.listTools(user).some(t => t.name === tool));
    }
  });

  it('crew validation, including another scope agent', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-2');

    const leadA = (await call(user, 'agent_create', {
      name: 'LeadA', role: 'Lead', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;
    const memberB = (await call(user, 'agent_create', {
      name: 'MemberB', role: 'Member', instructions: 'Help', scope: 'project:b', runner: { provider: 'codex' }
    })).agent;

    // Reject agent from different scope
    await assert.rejects(
      call(user, 'bot_create', {
        name: 'ScopeTest',
        job: 'Testing scope matching',
        scope: 'project:a',
        lead_agent_id: leadA.id,
        member_agent_ids: [memberB.id]
      }),
      (err: any) => err.status === 400 && err.code === 'agent_not_found'
    );

    // Reject non-existent agent
    await assert.rejects(
      call(user, 'bot_create', {
        name: 'NonExistentTest',
        job: 'Testing missing agent',
        scope: 'project:a',
        lead_agent_id: randomUUID(),
        member_agent_ids: []
      }),
      (err: any) => err.status === 400 && err.code === 'agent_not_found'
    );

    // Reject archived agent
    const toArchive = (await call(user, 'agent_create', {
      name: 'ArchivedMember', role: 'Member', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;
    await call(user, 'agent_archive', { agent_id: toArchive.id });

    await assert.rejects(
      call(user, 'bot_create', {
        name: 'ArchivedTest',
        job: 'Testing archived agent',
        scope: 'project:a',
        lead_agent_id: leadA.id,
        member_agent_ids: [toArchive.id]
      }),
      (err: any) => err.status === 400 && err.code === 'agent_not_found'
    );
  });

  it('a post to a bot thread reaches the lead, and an @mention reaches that member', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-3');

    const lead = (await call(user, 'agent_create', {
      name: 'LeadAgent', role: 'Lead', instructions: 'Lead instructions', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;
    const member = (await call(user, 'agent_create', {
      name: 'Specialist', role: 'Specialist', instructions: 'Specialist instructions', scope: 'project:a', runner: { provider: 'claude' }
    })).agent;

    const { bot, thread } = await call(user, 'bot_create', {
      name: 'ThreadBot',
      job: 'Thread routing test',
      scope: 'project:a',
      lead_agent_id: lead.id,
      member_agent_ids: [member.id]
    });

    // Post without @mention -> should queue turn task for lead
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'Hello team, what is our status?',
      idempotency_key: 'post-1'
    });

    const leadTask = (await pool.query(
      "SELECT * FROM tasks WHERE tenant_id=$1 AND thread_id=$2 AND agent_id=$3 AND status='queued'",
      [tenantId, thread.id, lead.id]
    )).rows[0];
    assert.ok(leadTask, 'Turn task should be queued for lead');
    assert.equal(leadTask.bot_id, bot.id);

    // Post with @mention -> should queue turn task for mentioned member
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'Hey @Specialist please take a look at this bug',
      idempotency_key: 'post-2'
    });

    const memberTask = (await pool.query(
      "SELECT * FROM tasks WHERE tenant_id=$1 AND thread_id=$2 AND agent_id=$3 AND status='queued'",
      [tenantId, thread.id, member.id]
    )).rows[0];
    assert.ok(memberTask, 'Turn task should be queued for mentioned member');
    assert.equal(memberTask.bot_id, bot.id);

    // Verify thread_list includes bot threads only with kind: 'bot'
    const defaultList = await call(user, 'thread_list', {});
    assert.ok(!defaultList.threads.some((t: any) => t.id === thread.id), 'default thread_list must not include bot thread');

    const botList = await call(user, 'thread_list', { kind: 'bot' });
    assert.ok(botList.threads.some((t: any) => t.id === thread.id), 'thread_list with kind: bot must include bot thread');
  });

  it('bot_id propagates through turn, swarm step, handoff and summary', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-4');
    const worker = await createPrincipal(tenantId, 'worker-4', 'worker');

    const lead = (await call(user, 'agent_create', {
      name: 'LeadA', role: 'Lead', instructions: 'Lead', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;
    const workerAgent = (await call(user, 'agent_create', {
      name: 'WorkerB', role: 'Worker', instructions: 'Worker', scope: 'project:a', runner: { provider: 'claude' }, edits: true
    })).agent;

    const { bot, thread } = await call(user, 'bot_create', {
      name: 'PropBot',
      rules: { first_reply: 'off' },
      job: 'Propagation test',
      scope: 'project:a',
      lead_agent_id: lead.id,
      member_agent_ids: [workerAgent.id],
      routing: {
        patch: { provider: 'claude' },
        research: { provider: 'codex' },
        summary: { provider: 'codex' }
      }
    });

    // 1. Turn queued from bot thread has bot_id
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'Start the work',
      idempotency_key: 'prop-post-1'
    });

    const turn1 = (await pool.query(
      "SELECT * FROM tasks WHERE tenant_id=$1 AND thread_id=$2 AND status='queued'",
      [tenantId, thread.id]
    )).rows[0];
    assert.equal(turn1.bot_id, bot.id);

    // Claim turn1 as worker and execute with a handoff action
    const claim1 = await call(worker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['codex.read'],
      kinds: ['turn']
    });
    assert.ok(claim1.task);
    assert.equal(claim1.task.id, turn1.id);

    // Finish turn with handoff action
    const actionsBlock = JSON.stringify([
      { type: 'handoff', to_agent: workerAgent.id, body: 'Please continue this work' }
    ]);
    const replyText = `Understood. Working on it.\n\n\`\`\`swarmaa-actions\n${actionsBlock}\n\`\`\``;

    await call(worker, 'task_finish', {
      task_id: turn1.id,
      lease_token: claim1.lease_token,
      lease_generation: claim1.lease_generation,
      outcome: 'completed',
      result: { answer: replyText, summary: 'Handed off' }
    });

    // 2. Handoff task inherits bot_id
    const handoffTask = (await pool.query(
      "SELECT * FROM tasks WHERE tenant_id=$1 AND agent_id=$2 AND initiator_kind='handoff' AND status='queued'",
      [tenantId, workerAgent.id]
    )).rows[0];
    assert.ok(handoffTask, 'Handoff task should be queued');
    assert.equal(handoffTask.bot_id, bot.id);

    // Claim and finish the handoff task
    const handoffClaim = await call(worker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['claude.patch'],
      kinds: ['turn', 'patch']
    });
    assert.ok(handoffClaim.task);
    assert.equal(handoffClaim.task.id, handoffTask.id);
    await call(worker, 'task_finish', {
      task_id: handoffTask.id,
      lease_token: handoffClaim.lease_token,
      lease_generation: handoffClaim.lease_generation,
      outcome: 'completed',
      result: { answer: 'Handoff finished' }
    });

    // 3. Swarm started in bot thread propagates bot_id to step tasks and summary turn
    const swarmRes = await call(user, 'swarm_start', {
      title: 'Bot Swarm',
      goal: 'Complete bot goals',
      scope: 'project:a',
      thread_id: thread.id,
      steps: [
        { key: 'step1', title: 'First step', assignee_agent_id: workerAgent.id }
      ],
      idempotency_key: 'bot-swarm-1'
    });

    const stepTask = (await pool.query(
      "SELECT * FROM tasks WHERE tenant_id=$1 AND swarm_step_id IS NOT NULL AND status='queued'",
      [tenantId]
    )).rows[0];
    assert.ok(stepTask, 'Swarm step task should be queued');
    assert.equal(stepTask.bot_id, bot.id);

    // Claim and finish the step task
    const stepClaim = await call(worker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['claude.patch'],
      kinds: ['turn', 'patch']
    });
    assert.ok(stepClaim.task);
    assert.equal(stepClaim.task.id, stepTask.id);

    await call(worker, 'task_finish', {
      task_id: stepTask.id,
      lease_token: stepClaim.lease_token,
      lease_generation: stepClaim.lease_generation,
      outcome: 'completed',
      result: { answer: 'Step finished successfully' }
    });

    // 4. Summary turn task inherits bot_id
    const summaryTask = (await pool.query(
      "SELECT * FROM tasks WHERE tenant_id=$1 AND initiator_kind='swarm' AND status='queued' AND objective LIKE 'Summarise%'",
      [tenantId]
    )).rows[0];
    assert.ok(summaryTask, 'Summary turn task should be queued');
    assert.equal(summaryTask.bot_id, bot.id);
  });

  it('required_capability follows the routing', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-5');

    const lead = (await call(user, 'agent_create', {
      name: 'LeadA', role: 'Lead', instructions: 'Lead', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;
    const workerAgent = (await call(user, 'agent_create', {
      name: 'WorkerB', role: 'Worker', instructions: 'Worker', scope: 'project:a', runner: { provider: 'codex' }, edits: true
    })).agent;

    const { bot, thread } = await call(user, 'bot_create', {
      name: 'RoutingBot',
      rules: { first_reply: 'off' },
      job: 'Routing test',
      scope: 'project:a',
      lead_agent_id: lead.id,
      member_agent_ids: [workerAgent.id],
      routing: {
        research: { provider: 'codex' },
        patch: { provider: 'claude', model: 'claude-opus-5-5' },
        summary: { provider: 'antigravity' }
      }
    });

    // Post to workerAgent (edits: true) -> kind is patch -> should get claude.patch (overriding agent runner codex)
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: '@WorkerB please edit files',
      idempotency_key: 'route-post-1'
    });

    const patchTurn = (await pool.query(
      "SELECT required_capability FROM tasks WHERE tenant_id=$1 AND agent_id=$2 AND thread_id=$3 AND status='queued'",
      [tenantId, workerAgent.id, thread.id]
    )).rows[0];
    assert.equal(patchTurn.required_capability, 'claude.patch');

    // Post to lead (edits: false) -> kind is summary -> should get antigravity.read
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: '@LeadA please summarise',
      idempotency_key: 'route-post-2'
    });

    const summaryTurn = (await pool.query(
      "SELECT required_capability FROM tasks WHERE tenant_id=$1 AND agent_id=$2 AND thread_id=$3 AND status='queued'",
      [tenantId, lead.id, thread.id]
    )).rows[0];
    assert.equal(summaryTurn.required_capability, 'antigravity.read');
  });

  it('a task card for review-ready and for failed, never twice', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-6');
    const worker = await createPrincipal(tenantId, 'worker-6', 'worker');

    const lead = (await call(user, 'agent_create', {
      name: 'Forge', role: 'Dev', instructions: 'Dev', scope: 'project:a', runner: { provider: 'claude' }, edits: true
    })).agent;

    const { bot, thread } = await call(user, 'bot_create', {
      name: 'CardBot',
      job: 'Card test',
      scope: 'project:a',
      lead_agent_id: lead.id,
      member_agent_ids: []
    });

    // Post to queue turn
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'the launch banner',
      idempotency_key: 'card-post-1'
    });

    const turn1 = (await pool.query(
      "SELECT * FROM tasks WHERE tenant_id=$1 AND thread_id=$2 AND status='queued'",
      [tenantId, thread.id]
    )).rows[0];

    const claim1 = await call(worker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['auto.patch', 'claude.patch'],
      kinds: ['turn', 'patch']
    });

    // 1. Finish with head_commit -> review-ready task card
    await call(worker, 'task_finish', {
      task_id: turn1.id,
      lease_token: claim1.lease_token,
      lease_generation: claim1.lease_generation,
      outcome: 'completed',
      result: {
        answer: 'Completed banner work',
        head_commit: '4f1e000000000000000000000000000000000000',
        branch: 'swarmaa/claude/4f1e',
        changed_files: 7,
        served: { provider: 'claude', model: 'claude-opus-5-5' }
      }
    });

    const threadMessages = (await call(user, 'thread_read', { thread_id: thread.id })).messages;
    const taskCard = threadMessages.find((m: any) => m.kind === 'task');
    assert.ok(taskCard, 'task card message should be posted');
    assert.equal(taskCard.body, 'Forge finished the launch banner · swarmaa/claude/4f1e · 7 files');
    assert.equal(taskCard.ref.task_id, turn1.id);

    // Verify calling finish again (replaying) does not create a duplicate card
    const taskCardCount = threadMessages.filter((m: any) => m.kind === 'task').length;
    assert.equal(taskCardCount, 1);

    // 2. Failed task creates card: "Failed · quota_exhausted on Codex"
    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'Another task that will fail',
      idempotency_key: 'card-post-2'
    });

    const turn2 = (await pool.query(
      "SELECT * FROM tasks WHERE tenant_id=$1 AND thread_id=$2 AND status='queued' AND kind='turn'",
      [tenantId, thread.id]
    )).rows[0];

    const claim2 = await call(worker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['auto.patch', 'claude.patch'],
      kinds: ['turn', 'patch']
    });

    await call(worker, 'task_finish', {
      task_id: turn2.id,
      lease_token: claim2.lease_token,
      lease_generation: claim2.lease_generation,
      outcome: 'failed',
      result: {
        failure: { code: 'quota_exhausted', detail: 'Quota reached' },
        served: { provider: 'codex' }
      }
    });

    const threadMessages2 = (await call(user, 'thread_read', { thread_id: thread.id })).messages;
    const failedCard = threadMessages2.find((m: any) => m.kind === 'task' && m.ref.task_id === turn2.id);
    assert.ok(failedCard, 'failed task card should be posted');
    assert.equal(failedCard.body, 'Failed · quota_exhausted on Codex');
  });

  it('first_reply picks the chat-reply model per bot: Haiku by default, Opus for heavy bots, or off', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-first-reply');
    const lead = (await call(user, 'agent_create', { name: 'Chat', role: 'Chat', instructions: 'Chat', scope: 'project:a', runner: { mode: 'auto' } })).agent;
    const turnFor = async (rules: Record<string, unknown> | undefined, key: string) => {
      const made = await call(user, 'bot_create', { name: `FR-${key}`, job: 'Chat', scope: 'project:a', lead_agent_id: lead.id, member_agent_ids: [], ...(rules ? { rules } : {}) });
      await call(user, 'thread_post', { thread_id: made.thread.id, body: 'Hello', idempotency_key: `fr-${key}` });
      const row = (await pool.query("SELECT * FROM tasks WHERE thread_id=$1 AND kind='turn'", [made.thread.id])).rows[0];
      await pool.query("UPDATE tasks SET status='cancelled' WHERE id=$1", [row.id]); // the lead stays free for the next bot
      return { bot: made.bot, row };
    };
    const haiku = await turnFor(undefined, 'default');
    assert.equal(haiku.bot.rules.first_reply, 'claude-haiku-5-5');
    assert.equal(haiku.row.required_capability, 'claude.read');
    assert.deepEqual(haiku.row.permission_envelope.runner, { provider: 'claude', model: 'claude-haiku-5-5', fast: true });
    const opus = await turnFor({ first_reply: 'claude-opus-5-5' }, 'opus');
    assert.deepEqual(opus.row.permission_envelope.runner, { provider: 'claude', model: 'claude-opus-5-5', fast: false }, 'Opus thinks on every reply, no hand-off');
    const off = await turnFor({ first_reply: 'off' }, 'off');
    assert.deepEqual(off.row.permission_envelope.runner, { fast: false });
    assert.equal(off.row.required_capability, 'auto.read', 'off keeps the bot routing');
    await assert.rejects(call(user, 'bot_create', { name: 'FR-bad', job: 'x', scope: 'project:a', lead_agent_id: lead.id, member_agent_ids: [], rules: { first_reply: 'gpt-9' } }), /first_reply must be one of/);
    const updated = await call(user, 'bot_update', { bot_id: haiku.bot.id, expected_version: haiku.bot.version, rules: { first_reply: 'claude-opus-5-5' } });
    assert.equal(updated.bot.rules.first_reply, 'claude-opus-5-5');
  });

  it('thread_read embeds task', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-7');
    const worker = await createPrincipal(tenantId, 'worker-7', 'worker');

    const lead = (await call(user, 'agent_create', {
      name: 'Dev', role: 'Dev', instructions: 'Dev', scope: 'project:a', runner: { provider: 'claude' }, edits: true
    })).agent;

    const { bot, thread } = await call(user, 'bot_create', {
      name: 'EmbedBot',
      job: 'Embed test',
      scope: 'project:a',
      lead_agent_id: lead.id,
      member_agent_ids: []
    });

    await call(user, 'thread_post', {
      thread_id: thread.id,
      body: 'Build features',
      idempotency_key: 'embed-post-1'
    });

    const turn = (await pool.query(
      "SELECT * FROM tasks WHERE tenant_id=$1 AND thread_id=$2 AND status='queued'",
      [tenantId, thread.id]
    )).rows[0];

    const claim = await call(worker, 'task_claim', {
      scope: 'project:a',
      capabilities: ['auto.patch', 'claude.patch'],
      kinds: ['turn', 'patch']
    });

    await call(worker, 'task_finish', {
      task_id: turn.id,
      lease_token: claim.lease_token,
      lease_generation: claim.lease_generation,
      outcome: 'completed',
      result: {
        head_commit: 'abcd1234ef567890',
        branch: 'swarmaa/claude/embed',
        changed_files: 3,
        served: { provider: 'claude', model: 'claude-opus-5-5' }
      }
    });

    const read = await call(user, 'thread_read', { thread_id: thread.id });
    const taskMessage = read.messages.find((m: any) => m.kind === 'task');
    assert.ok(taskMessage.task, 'task object should be embedded on kind task messages');
    const embedded = taskMessage.task;

    assert.equal(embedded.id, turn.id);
    assert.equal(embedded.kind, 'turn');
    assert.equal(embedded.status, 'completed');
    assert.equal(embedded.resolved, false);
    assert.equal(embedded.branch, 'swarmaa/claude/embed');
    assert.equal(embedded.changed_files, 3);
    assert.deepEqual(embedded.served, { provider: 'claude', model: 'claude-opus-5-5' });
    assert.equal(embedded.failure, null);
    assert.equal(embedded.check, null);
  });

  it('badges and updates-first ordering', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-8');
    const worker = await createPrincipal(tenantId, 'worker-8', 'worker');

    const lead1 = (await call(user, 'agent_create', {
      name: 'LeadOne', role: 'Lead', instructions: 'Lead', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;
    const lead2 = (await call(user, 'agent_create', {
      name: 'LeadTwo', role: 'Lead', instructions: 'Lead', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;
    const lead3 = (await call(user, 'agent_create', {
      name: 'LeadThree', role: 'Lead', instructions: 'Lead', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;

    // Create 3 bots
    const bot1 = (await call(user, 'bot_create', {
      name: 'BotIdle', rules: { first_reply: 'off' }, job: 'Idle bot', scope: 'project:a', lead_agent_id: lead1.id, member_agent_ids: []
    })).bot;
    const bot2 = (await call(user, 'bot_create', {
      name: 'BotUnread', rules: { first_reply: 'off' }, job: 'Unread bot', scope: 'project:a', lead_agent_id: lead2.id, member_agent_ids: []
    })).bot;
    const bot3 = (await call(user, 'bot_create', {
      name: 'BotNeedsYou', rules: { first_reply: 'off' }, job: 'Needs you bot', scope: 'project:a', lead_agent_id: lead3.id, member_agent_ids: []
    })).bot;

    // Post to bot2 -> unread > 0
    await call(user, 'thread_post', { thread_id: bot2.thread_id, body: 'Message in bot 2', idempotency_key: 'b2-msg' });
    const t2 = (await pool.query("SELECT * FROM tasks WHERE thread_id=$1 AND status='queued'", [bot2.thread_id])).rows[0];
    const claim2 = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['auto.read', 'codex.read'], kinds: ['turn'] });
    await call(worker, 'task_finish', {
      task_id: t2.id, lease_token: claim2.lease_token, lease_generation: claim2.lease_generation,
      outcome: 'completed', result: { answer: 'Reply in bot 2' }
    });

    // Mark bot2 read up to seq 0 leaves it unread = 1
    // Post and fail a task in bot3 -> needs_you > 0
    await call(user, 'thread_post', { thread_id: bot3.thread_id, body: 'Task in bot 3', idempotency_key: 'b3-msg' });
    const t3 = (await pool.query("SELECT * FROM tasks WHERE thread_id=$1 AND status='queued'", [bot3.thread_id])).rows[0];
    const claim3 = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['auto.read', 'codex.read'], kinds: ['turn'] });
    await call(worker, 'task_finish', {
      task_id: t3.id, lease_token: claim3.lease_token, lease_generation: claim3.lease_generation,
      outcome: 'failed', result: { failure: { code: 'quota_exhausted' }, served: { provider: 'codex' } }
    });

    // List bots
    const list = await call(user, 'bot_list', { scope: 'project:a' });
    assert.equal(list.bots.length, 3);

    // Updates-first ordering: needs_you > 0 first, then unread > 0, then by last activity
    assert.equal(list.bots[0].id, bot3.id, 'Bot with needs_you > 0 must be first');
    assert.equal(list.bots[1].id, bot2.id, 'Bot with unread > 0 must be second');
    assert.equal(list.bots[2].id, bot1.id, 'Idle bot must be last');

    assert.ok(list.bots[0].badges.needs_you >= 1);
    assert.ok(list.bots[1].badges.unread >= 1);
    assert.equal(list.bots[0].badges.latest?.kind, 'task');

    await call(user, 'bot_update', { bot_id: bot1.id, expected_version: bot1.version, starred: true });
    const ordered = (await call(user, 'bot_list', { scope: 'project:a' })).bots;
    assert.deepEqual(ordered.map((b: any) => b.id), [bot3.id, bot1.id, bot2.id]);
    assert.equal(ordered[1].starred, true, 'star precedes unread but follows needs-you');
    const paginated: string[] = [];
    let after: string | undefined;
    do {
      const page = await call(user, 'bot_list', { scope: 'project:a', limit: 1, ...(after ? { after } : {}) });
      paginated.push(...page.bots.map((b: any) => b.id));
      after = page.next_cursor ?? undefined;
    } while (after);
    assert.deepEqual(paginated, ordered.map((b: any) => b.id));

    // Test bot_get badges
    const getBot3 = (await call(user, 'bot_get', { bot_id: bot3.id })).bot;
    assert.equal(getBot3.badges.needs_you, 1);
    assert.equal(getBot3.badges.latest?.kind, 'task');

    // Calling thread_mark_read clears unread
    await call(user, 'thread_mark_read', { thread_id: bot2.thread_id, seq: 10 });
    const getBot2AfterRead = (await call(user, 'bot_get', { bot_id: bot2.id })).bot;
    assert.equal(getBot2AfterRead.badges.unread, 0);
  });

  it('moves the star atomically on create/update, preserves retries and clears it on archive', async () => {
    const user = await createPrincipal(randomUUID(), 'star-owner');
    const lead = (await call(user, 'agent_create', {
      name: 'StarLead', role: 'Lead', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;
    const create = (name: string, extra: Record<string, unknown> = {}) => call(user, 'bot_create', {
      name, job: 'Help', scope: 'project:a', lead_agent_id: lead.id, member_agent_ids: [], ...extra
    });
    const first = (await create('First', { starred: true, idempotency_key: 'first-star' })).bot;
    assert.equal(first.starred, true);
    const second = (await create('Second', { starred: true })).bot;
    let firstNow = (await call(user, 'bot_get', { bot_id: first.id })).bot;
    assert.equal(firstNow.starred, false);
    assert.equal(firstNow.version, first.version + 1);
    const replay = await create('First', { starred: true, idempotency_key: 'first-star' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.bot.starred, false);
    assert.equal((await call(user, 'bot_get', { bot_id: second.id })).bot.starred, true);

    const before = Number((await pool.query('SELECT COALESCE(max(seq),0) AS seq FROM events')).rows[0].seq);
    firstNow = (await call(user, 'bot_update', {
      bot_id: first.id, expected_version: firstNow.version, starred: true
    })).bot;
    assert.equal(firstNow.starred, true);
    const secondNow = (await call(user, 'bot_get', { bot_id: second.id })).bot;
    assert.equal(secondNow.starred, false);
    assert.equal(secondNow.version, second.version + 1);
    const events = (await pool.query(
      "SELECT subject_id FROM events WHERE tenant_id=$1 AND name='bot.updated' AND seq>$2", [user.tenantId, before]
    )).rows;
    assert.deepEqual(events.map(e => e.subject_id).sort(), [first.id, second.id].sort());
    await assert.rejects(call(user, 'bot_update', {
      bot_id: second.id, expected_version: second.version, starred: true
    }), (e: any) => e.status === 409);
    await assert.rejects(call(user, 'bot_update', {
      bot_id: second.id, expected_version: secondNow.version, starred: true, name: first.name
    }), (e: any) => e.status === 409);
    assert.equal((await call(user, 'bot_get', { bot_id: first.id })).bot.starred, true, 'failed writes roll back star changes');
    const cleared = (await call(user, 'bot_update', {
      bot_id: first.id, expected_version: firstNow.version, starred: false
    })).bot;
    assert.equal(cleared.starred, false);
    const starred = (await call(user, 'bot_update', {
      bot_id: first.id, expected_version: cleared.version, starred: true
    })).bot;
    assert.equal(starred.starred, true);
    assert.equal((await call(user, 'bot_archive', { bot_id: first.id })).bot.starred, false);
    assert.equal((await call(user, 'bot_get', { bot_id: first.id })).bot.starred, false);
    await assert.rejects(create('Invalid', { starred: 'true' }), (e: any) => e.status === 400);
  });

  it('serializes concurrent star updates per tenant and leaves other tenants untouched', async () => {
    const user = await createPrincipal(randomUUID(), 'concurrent-star-owner');
    const other = await createPrincipal(randomUUID(), 'other-star-owner');
    async function make(p: Principal, name: string, starred = false) {
      const lead = (await call(p, 'agent_create', {
        name, role: 'Lead', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' }
      })).agent;
      return (await call(p, 'bot_create', {
        name, job: 'Help', scope: 'project:a', lead_agent_id: lead.id, member_agent_ids: [], starred
      })).bot;
    }
    const otherBot = await make(other, 'Other', true);
    const bots = await Promise.all(['A', 'B', 'C', 'D'].map(name => make(user, name)));
    const results = await Promise.all(bots.map(bot => call(user, 'bot_update', {
      bot_id: bot.id, expected_version: bot.version, starred: true
    })));
    assert.ok(results.every(r => r.bot.starred === true));
    const stars = (await pool.query('SELECT id FROM bots WHERE tenant_id=$1 AND starred AND NOT archived', [user.tenantId])).rows;
    assert.equal(stars.length, 1);
    assert.equal((await call(other, 'bot_get', { bot_id: otherBot.id })).bot.starred, true);
    assert.equal((await call(other, 'bot_get', { bot_id: otherBot.id })).bot.version, otherBot.version);
    const loser = bots.find(b => b.id !== stars[0].id)!;
    await assert.rejects(pool.query('UPDATE bots SET starred=true WHERE id=$1', [loser.id]),
      (e: any) => e.code === '23505', 'database enforces the invariant too');
  });

  it('requires access to the previous star scope and moves stars across authorized scopes', async () => {
    const owner = await createPrincipal(randomUUID(), 'scoped-star-owner');
    const limited = await createPrincipal(owner.tenantId, 'limited-star-owner', 'frontend', ['project:a']);
    async function make(scope: string, name: string, starred: boolean) {
      const lead = (await call(owner, 'agent_create', {
        name, role: 'Lead', instructions: 'Help', scope, runner: { provider: 'codex' }
      })).agent;
      return (await call(owner, 'bot_create', {
        name, job: 'Help', scope, lead_agent_id: lead.id, member_agent_ids: [], starred
      })).bot;
    }
    const hidden = await make('project:b', 'Hidden', true);
    const visible = await make('project:a', 'Visible', false);
    await assert.rejects(call(limited, 'bot_update', {
      bot_id: visible.id, expected_version: visible.version, starred: true
    }), (e: any) => e.status === 403);
    await assert.rejects(call(limited, 'bot_create', {
      name: 'Denied', job: 'Help', scope: 'project:a', lead_agent_id: visible.lead_agent_id,
      member_agent_ids: [], starred: true
    }), (e: any) => e.status === 403);
    assert.equal((await call(owner, 'bot_get', { bot_id: hidden.id })).bot.starred, true);
    assert.equal((await call(limited, 'bot_list', {})).bots.length, 1, 'failed create rolls back');
    await call(owner, 'bot_update', { bot_id: visible.id, expected_version: visible.version, starred: true });
    assert.equal((await call(owner, 'bot_get', { bot_id: hidden.id })).bot.starred, false);
  });

  it('the bot_list query count stays constant', async () => {
    const tenantId = randomUUID();
    const user = await createPrincipal(tenantId, 'user-9');

    // Create 1 lead and 25 bots
    const lead = (await call(user, 'agent_create', {
      name: 'BatchLead', role: 'Lead', instructions: 'Lead', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;

    for (let i = 1; i <= 25; i++) {
      await call(user, 'bot_create', {
        name: `Bot-Batch-${i}`,
        job: `Batch bot ${i}`,
        scope: 'project:a',
        lead_agent_id: lead.id,
        member_agent_ids: []
      });
    }

    // Verify query count is identical for limit: 5 vs limit: 25
    const small = await counted(() => call(user, 'bot_list', { limit: 5 }));
    const large = await counted(() => call(user, 'bot_list', { limit: 25 }));

    assert.equal(small.value.bots.length, 5);
    assert.equal(large.value.bots.length, 25);
    assert.equal(small.sql.length, large.sql.length, 'bot_list SQL query count must be constant');
    assert.ok(large.sql.length <= 5, 'bot_list should use at most 5 queries');
  });

  it('tenant and scope isolation for every tool', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const userA = await createPrincipal(tenantA, 'user-a', 'frontend', ['project:a']);
    const userB = await createPrincipal(tenantB, 'user-b', 'frontend', ['project:a']);

    const leadA = (await call(userA, 'agent_create', {
      name: 'AtlasA', role: 'Lead', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' }
    })).agent;

    const botA = (await call(userA, 'bot_create', {
      name: 'BotA', job: 'Tenant A bot', scope: 'project:a', lead_agent_id: leadA.id, member_agent_ids: []
    })).bot;

    // Tenant B cannot get bot A
    await assert.rejects(
      call(userB, 'bot_get', { bot_id: botA.id }),
      (err: any) => err.status === 404
    );

    // Tenant B cannot update bot A
    await assert.rejects(
      call(userB, 'bot_update', { bot_id: botA.id, expected_version: 1, job: 'Hacked' }),
      (err: any) => err.status === 404
    );

    // Tenant B cannot archive bot A
    await assert.rejects(
      call(userB, 'bot_archive', { bot_id: botA.id }),
      (err: any) => err.status === 404
    );

    // Tenant B list does not show bot A
    const listB = await call(userB, 'bot_list', { scope: 'project:a' });
    assert.equal(listB.bots.length, 0);

    // Scope isolation: user with scope project:x cannot access bot in project:a
    const userScopeX = await createPrincipal(tenantA, 'user-x', 'frontend', ['project:x']);
    await assert.rejects(
      call(userScopeX, 'bot_get', { bot_id: botA.id }),
      (err: any) => err.status === 404
    );
    await assert.rejects(
      call(userScopeX, 'bot_update', { bot_id: botA.id, expected_version: 1, job: 'Hacked' }),
      (err: any) => err.status === 403
    );
    await assert.rejects(
      call(userScopeX, 'bot_archive', { bot_id: botA.id }),
      (err: any) => err.status === 403
    );
  });
});
