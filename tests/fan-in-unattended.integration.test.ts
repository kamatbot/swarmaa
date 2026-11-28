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

describe('fan-in counting and unattended inheritance', { skip: !connectionString, concurrency: false }, () => {
  const schema = `fanin_${randomUUID().replaceAll('-', '')}`;
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

  const mk = async (owner: any, scope: string, name: string, rules: Record<string, unknown> = {}) => {
    const { agent } = await call(owner, 'agent_create', { name: `${name}Lead`, role: 'Lead', instructions: 'Help', scope, runner: { provider: 'codex' } });
    return call(owner, 'bot_create', { name, job: name, scope, lead_agent_id: agent.id, member_agent_ids: [], rules });
  };
  const dispatch = async (worker: any, coord: any, owner: any, acts: any[], key: string) => {
    await call(owner, 'thread_post', { thread_id: coord.thread.id, body: 'go', idempotency_key: key });
    const cc = await call(worker, 'task_claim', { scope: 'project:coord', capabilities: ['codex.read'], kinds: ['turn'] });
    await call(worker, 'task_finish', { task_id: cc.task.id, lease_token: cc.lease_token, lease_generation: cc.lease_generation, outcome: 'completed',
      result: { answer: `x\n\n\`\`\`swarmaa-actions\n${JSON.stringify(acts)}\n\`\`\`` } });
  };
  const finishOne = async (worker: any, scope: string, answer: string) => {
    const c = await call(worker, 'task_claim', { scope, capabilities: ['codex.read'], kinds: ['turn'] });
    assert.ok(c.task, 'claimable');
    await call(worker, 'task_finish', { task_id: c.task.id, lease_token: c.lease_token, lease_generation: c.lease_generation, outcome: 'completed', result: { answer } });
    return c.task.id as string;
  };
  const group = async (t: string) => (await pool.query('SELECT total, completed, failed, synthesized FROM dispatch_groups WHERE tenant_id=$1', [t])).rows[0];

  it('two dispatches to the same bot merge into one task, and the group still synthesizes', async () => {
    const t = randomUUID(); const owner = await createPrincipal(t, 'o'); const worker = await createPrincipal(t, 'w', 'worker', ['project:coord','project:alpha']);
    const coord = await mk(owner, 'project:coord', 'Coordinator', { dispatch_all_projects: true, first_reply: 'off' });
    await mk(owner, 'project:alpha', 'Alpha', { first_reply: 'off' });
    await dispatch(worker, coord, owner, [{ type: 'project_dispatch', bot: 'Alpha', body: 'a1' }, { type: 'project_dispatch', bot: 'Alpha', body: 'a2' }], 'k1');
    const n = (await pool.query("SELECT count(*)::int n FROM tasks WHERE tenant_id=$1 AND scope='project:alpha' AND status='queued'", [t])).rows[0].n;
    assert.equal(n, 1, 'the second dispatch merged into the queued turn');
    assert.equal((await group(t)).total, 1, 'total counts tasks, not dispatch actions');
    await finishOne(worker, 'project:alpha', 'done');
    assert.equal((await group(t)).synthesized, true);
  });

  it('a continued dispatched task counts once, so synthesis waits for every bot', async () => {
    const t = randomUUID(); const owner = await createPrincipal(t, 'o'); const worker = await createPrincipal(t, 'w', 'worker', ['project:coord','project:alpha','project:beta']);
    const coord = await mk(owner, 'project:coord', 'Coordinator', { dispatch_all_projects: true, first_reply: 'off' });
    await mk(owner, 'project:alpha', 'Alpha', { first_reply: 'off' }); await mk(owner, 'project:beta', 'Beta', { first_reply: 'off' });
    await dispatch(worker, coord, owner, [{ type: 'project_dispatch', bot: 'Alpha', body: 'a' }, { type: 'project_dispatch', bot: 'Beta', body: 'b' }], 'k2');
    const id = await finishOne(worker, 'project:alpha', 'alpha1');
    const row = (await pool.query('SELECT version FROM tasks WHERE id=$1', [id])).rows[0];
    await call(owner, 'task_continue', { task_id: id, expected_version: row.version, instruction: 'more', idempotency_key: 'c1' });
    await finishOne(worker, 'project:alpha', 'alpha2');
    assert.deepEqual({ ...(await group(t)) }, { total: 2, completed: 1, failed: 0, synthesized: false }, 'Beta has not answered yet');
    await finishOne(worker, 'project:beta', 'beta');
    assert.equal((await group(t)).synthesized, true);
  });

  it('a cancelled dispatched task still lets the group finish', async () => {
    const t = randomUUID(); const owner = await createPrincipal(t, 'o'); const worker = await createPrincipal(t, 'w', 'worker', ['project:coord','project:alpha','project:beta']);
    const coord = await mk(owner, 'project:coord', 'Coordinator', { dispatch_all_projects: true, first_reply: 'off' });
    await mk(owner, 'project:alpha', 'Alpha', { first_reply: 'off' }); await mk(owner, 'project:beta', 'Beta', { first_reply: 'off' });
    await dispatch(worker, coord, owner, [{ type: 'project_dispatch', bot: 'Alpha', body: 'a' }, { type: 'project_dispatch', bot: 'Beta', body: 'b' }], 'k3');
    await finishOne(worker, 'project:alpha', 'alpha');
    const beta = (await pool.query("SELECT id, version FROM tasks WHERE tenant_id=$1 AND scope='project:beta' AND status='queued'", [t])).rows[0];
    await call(owner, 'task_cancel', { task_id: beta.id, expected_version: beta.version });
    assert.deepEqual({ ...(await group(t)) }, { total: 2, completed: 1, failed: 1, synthesized: true });
  });

  it('turns spawned by scheduled work never go to Antigravity, down to the fan-in synthesis', async () => {
    const t = randomUUID(); const owner = await createPrincipal(t, 'o'); const worker = await createPrincipal(t, 'w', 'worker', ['project:coord','project:alpha']);
    const coord = await mk(owner, 'project:coord', 'Coordinator', { dispatch_all_projects: true, first_reply: 'off' });
    await mk(owner, 'project:alpha', 'Alpha', { first_reply: 'off' });
    await call(owner, 'thread_post', { thread_id: coord.thread.id, body: 'go', idempotency_key: 'k4' });
    // As if a schedule had queued the coordinator's turn.
    await pool.query("UPDATE tasks SET initiator_kind='schedule' WHERE tenant_id=$1 AND scope='project:coord' AND status='queued'", [t]);
    const cc = await call(worker, 'task_claim', { scope: 'project:coord', capabilities: ['codex.read'], kinds: ['turn'] });
    await call(worker, 'task_finish', { task_id: cc.task.id, lease_token: cc.lease_token, lease_generation: cc.lease_generation, outcome: 'completed',
      result: { answer: `x\n\n\`\`\`swarmaa-actions\n${JSON.stringify([{ type: 'project_dispatch', bot: 'Alpha', body: 'a' }])}\n\`\`\`` } });
    const alpha = (await pool.query("SELECT initiator_kind, excluded_providers FROM tasks WHERE tenant_id=$1 AND scope='project:alpha'", [t])).rows[0];
    assert.equal(alpha.initiator_kind, 'handoff');
    assert.ok(alpha.excluded_providers.includes('antigravity'), 'the dispatched turn inherits unattended');
    await finishOne(worker, 'project:alpha', 'done');
    const synth = (await pool.query("SELECT excluded_providers FROM tasks WHERE tenant_id=$1 AND scope='project:coord' AND idempotency_key LIKE 'dispatch-synth:%'", [t])).rows[0];
    assert.ok(synth, 'synthesis turn queued');
    assert.ok(synth.excluded_providers.includes('antigravity'), 'two hops down it is still unattended');
  });

  it('turns spawned by person-started work may still use Antigravity', async () => {
    const t = randomUUID(); const owner = await createPrincipal(t, 'o'); const worker = await createPrincipal(t, 'w', 'worker', ['project:coord','project:alpha']);
    const coord = await mk(owner, 'project:coord', 'Coordinator', { dispatch_all_projects: true, first_reply: 'off' });
    await mk(owner, 'project:alpha', 'Alpha', { first_reply: 'off' });
    await dispatch(worker, coord, owner, [{ type: 'project_dispatch', bot: 'Alpha', body: 'a' }], 'k5');
    const alpha = (await pool.query("SELECT excluded_providers FROM tasks WHERE tenant_id=$1 AND scope='project:alpha'", [t])).rows[0];
    assert.deepEqual(alpha.excluded_providers, []);
  });
});
