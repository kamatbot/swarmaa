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

describe('concurrent task_finish in one tenant', { skip: !connectionString, concurrency: false }, () => {
  const schema = `finish_conc_test_${randomUUID().replaceAll('-', '')}`;
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

  async function createPrincipal(tenantId: string, name: string, role: Principal['role'], scopes = ['project:a']) {
    const p: Principal = { id: randomUUID(), tenantId, name, role, scopes, permissions: [...ROLE_PERMISSIONS[role]] };
    await pool.query(
      `INSERT INTO principals(id, tenant_id, name, role, scopes, permissions, token_hash, last_seen_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, clock_timestamp())`,
      [p.id, p.tenantId, name, role, scopes, p.permissions, hashToken(newToken())]
    );
    return p;
  }

  it('20 finishes across threads and swarms in one tenant land in the right final state', async () => {
    const tenant = randomUUID();
    const user = await createPrincipal(tenant, 'user', 'admin');
    const worker = await createPrincipal(tenant, 'worker', 'worker');
    const agent = async (name: string) =>
      (await call(user, 'agent_create', { name, role: 'Helper', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' } })).agent;

    // 12 plain agent turns, each on its own thread.
    const plain = [];
    for (let i = 0; i < 12; i++) {
      const a = await agent(`Plain${i}`);
      await call(user, 'thread_post', { thread_id: a.main_thread_id, body: `Help ${i}`, idempotency_key: `p${i}` });
      plain.push(a);
    }
    // 4 swarms with two parallel steps each = 8 step tasks.
    const swarms = [];
    for (let i = 0; i < 4; i++) {
      const [a, b] = [await agent(`SwA${i}`), await agent(`SwB${i}`)];
      const { swarm } = await call(user, 'swarm_start', {
        title: `Swarm ${i}`, goal: 'Concurrent finish', scope: 'project:a', thread_id: a.main_thread_id,
        steps: [
          { key: 's1', title: 'One', assignee_agent_id: a.id, needs: [], check: 'ok' },
          { key: 's2', title: 'Two', assignee_agent_id: b.id, needs: [], check: 'ok' }
        ]
      });
      swarms.push(swarm);
    }

    const claims = [];
    for (let i = 0; i < 20; i++) {
      const c = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['codex.read'] });
      assert.ok(c.task, `claim ${i}`);
      claims.push(c);
    }
    assert.equal(new Set(claims.map(c => c.task.id)).size, 20);

    const finishes = await Promise.all(claims.map(c => call(worker, 'task_finish', {
      task_id: c.task.id, lease_token: c.lease_token, lease_generation: c.lease_generation,
      outcome: 'completed', result: { answer: `done ${c.task.id}` }
    })));
    for (const f of finishes) { assert.equal(f.task.status, 'completed'); assert.equal(f.replayed, false); }

    const done = await pool.query<{ status: string; n: string }>(
      `SELECT r.status, count(*)::int AS n FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.tenant_id=$1 GROUP BY r.status`, [tenant]);
    assert.deepEqual(done.rows, [{ status: 'completed', n: 20 }]);
    // Every task's reply landed exactly once, on its own thread, with its own task id.
    for (const c of claims) {
      const msgs = await pool.query(`SELECT body FROM messages WHERE thread_id=$1 AND kind='text' AND body=$2`, [c.task.thread_id, `done ${c.task.id}`]);
      assert.equal(msgs.rowCount, 1, `reply for ${c.task.id}`);
    }
    for (const a of plain) {
      assert.equal((await pool.query(`SELECT 1 FROM tasks WHERE agent_id=$1 AND status<>'completed'`, [a.id])).rowCount, 0);
    }
    for (const s of swarms) {
      const got = (await call(user, 'swarm_get', { swarm_id: s.id })).swarm;
      assert.ok(got.steps.every((x: any) => x.status === got.steps[0].status && x.status !== 'running'), JSON.stringify(got.steps.map((x: any) => x.status)));
      assert.notEqual(got.status, 'running');
    }
    // Replays after the burst are idempotent.
    const again = await call(worker, 'task_finish', {
      task_id: claims[0]!.task.id, lease_token: claims[0]!.lease_token, lease_generation: claims[0]!.lease_generation,
      outcome: 'completed', result: { answer: `done ${claims[0]!.task.id}` }
    });
    assert.equal(again.replayed, true);
  });
});
