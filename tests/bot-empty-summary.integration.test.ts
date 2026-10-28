/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { hashToken, newToken } from '../src/auth.js';
import { CoreService } from '../src/core/index.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal } from '../src/types.js';

const connectionString = process.env.TEST_DATABASE_URL;

describe('bot empty-turn summary', { skip: !connectionString, concurrency: false }, () => {
  const schema = `bot_summary_test_${randomUUID().replaceAll('-', '')}`;
  let control: Pool;
  let pool: Pool;
  let core: CoreService;

  before(async () => {
    control = new pg.Pool({ connectionString, max: 1 });
    await control.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` });

    for (const file of (await readdir(new URL('../db/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
    }

    core = new CoreService(pool);

  });

  after(async () => {
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

  for (const result of [{}, { answer: '' }, { answer: '  \n ' }, { answer: '\n```swarmaa-actions\n[]\n```' }, { summary: 'A real summary' }, { answer: 'A real answer' }]) {
    it(`posts one appropriate reply on completion and replay: ${JSON.stringify(result)}`, async () => {
      const tenant = randomUUID();
      const user = await createPrincipal(tenant, 'user');
      const worker = await createPrincipal(tenant, 'worker', 'worker');
      const lead = (await call(user, 'agent_create', {
        name: 'Lead', role: 'Lead', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' }
      })).agent;
      const { thread } = await call(user, 'bot_create', {
        name: 'Summary bot', job: 'Help', scope: 'project:a', lead_agent_id: lead.id,
        member_agent_ids: [], rules: { first_reply: 'off' }, routing: { summary: { provider: 'codex' } }
      });
      await call(user, 'thread_post', { thread_id: thread.id, body: 'Please help', idempotency_key: 'post' });
      const claim = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['codex.read'], kinds: ['turn'] });
      assert.ok(claim.task);
      const input = { task_id: claim.task.id, lease_token: claim.lease_token,
        lease_generation: claim.lease_generation, outcome: 'completed', result };
      await call(worker, 'task_finish', input);
      assert.equal((await call(worker, 'task_finish', input)).replayed, true);
      const read = await call(user, 'thread_read', { thread_id: thread.id });
      const replies = read.messages.filter((m: any) => m.author.kind !== 'human');
      assert.equal(replies.length, 1);
      const real = 'summary' in result || result.answer === 'A real answer';
      assert.equal(replies[0].kind, real ? 'text' : 'notice');
      assert.equal(replies[0].body, real ? (result.summary ?? result.answer) : 'Finished without a summary');
      assert.equal(replies[0].author.kind, real ? 'agent' : 'system');
      const events = await pool.query("SELECT payload FROM events WHERE subject_id=$1 AND name='message.created'", [replies[0].id]);
      assert.equal(events.rows.length, 1);
      assert.equal(events.rows[0].payload.kind, replies[0].kind);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM tasks WHERE tenant_id=$1 AND status='queued'", [tenant])).rows[0].n, 0);
    });
  }
});
