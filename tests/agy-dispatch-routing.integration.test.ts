/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { AuthService, hashToken, newToken } from '../src/auth.js';
import { CoreService } from '../src/core/index.js';
import { createHttpHandler } from '../src/http.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal, ServerConfig } from '../src/types.js';

const connectionString = process.env.TEST_DATABASE_URL;

describe('agy dispatch routing', { skip: !connectionString, concurrency: false }, () => {
  const schema = `agyroute_${randomUUID().replaceAll('-', '')}`;
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
  const caps = ['codex.read', 'claude.read', 'antigravity.read'];
  const claimIn = (worker: any, scope: string) => call(worker, 'task_claim', { scope, capabilities: caps, kinds: ['turn'] });

  it('agy keeps explicit turns whether or not the thread has photos', async () => {
    const t = randomUUID(); const owner = await createPrincipal(t, 'o'); const worker = await createPrincipal(t, 'w', 'worker', ['project:a']);
    const bot = await mk(owner, 'project:a', 'Alpha', { first_reply: 'off' });
    await call(owner, 'thread_post', { thread_id: bot.thread.id, body: 'look at this', idempotency_key: 'p1' });
    await pool.query("UPDATE messages SET has_attachments=true, created_at=clock_timestamp()-interval '2 days' WHERE thread_id=$1", [bot.thread.id]);
    await pool.query("UPDATE tasks SET status='cancelled' WHERE tenant_id=$1", [t]);
    await call(owner, 'thread_post', { thread_id: bot.thread.id, body: 'Run a test. Use agy to research camera apps.', idempotency_key: 'p2' });
    const c1 = await claimIn(worker, 'project:a');
    assert.equal(c1.task?.required_capability, 'antigravity.read', 'old photo ignored');
    await call(worker, 'task_finish', { task_id: c1.task.id, lease_token: c1.lease_token, lease_generation: c1.lease_generation, outcome: 'completed', result: { answer: 'ok' } });

    await call(owner, 'thread_post', { thread_id: bot.thread.id, body: 'use agy to read this screenshot', idempotency_key: 'p3' });
    await pool.query('UPDATE messages SET has_attachments=true WHERE thread_id=$1 AND seq=(SELECT max(seq) FROM messages WHERE thread_id=$1)', [bot.thread.id]);
    const c2 = await claimIn(worker, 'project:a');
    assert.equal(c2.task?.required_capability, 'antigravity.read', 'agy takes photo turns over ACP');
  });

  it('a turn that dispatched to a project bot does not also delegate a "fuller answer"; long options are clipped', async () => {
    const t = randomUUID(); const owner = await createPrincipal(t, 'o'); const worker = await createPrincipal(t, 'w', 'worker', ['project:coord', 'project:alpha']);
    const coord = await mk(owner, 'project:coord', 'Coordinator', { dispatch_all_projects: true, first_reply: 'off' });
    await mk(owner, 'project:alpha', 'Alpha', { first_reply: 'off' });
    await call(owner, 'thread_post', { thread_id: coord.thread.id, body: 'Run a test. Use agy with neon.', idempotency_key: 'k1' });
    const cc = await claimIn(worker, 'project:coord');
    assert.equal(cc.task?.required_capability, 'codex.read', 'the coordinator keeps its runner; the dispatch carries "use agy"');
    const acts = [{ type: 'project_dispatch', bot: 'Alpha', body: 'a1' },
      { type: 'question_ask', prompt: 'Which?', options: ['x'.repeat(120), 'short'] }];
    await call(worker, 'task_finish', { task_id: cc.task.id, lease_token: cc.lease_token, lease_generation: cc.lease_generation, outcome: 'completed',
      result: { answer: `Sending it.\n\n\`\`\`swarmaa-actions\n${JSON.stringify(acts)}\n\`\`\``, delegate: { objective: 'Give a fuller answer' } } });
    const queuedCoord = (await pool.query("SELECT count(*)::int n FROM tasks WHERE tenant_id=$1 AND scope='project:coord' AND status='queued'", [t])).rows[0].n;
    assert.equal(queuedCoord, 0, 'no delegated follow-up turn');
    const notices = (await pool.query("SELECT body FROM messages WHERE thread_id=$1 AND kind='notice'", [coord.thread.id])).rows.map(r => r.body as string);
    assert.ok(!notices.some(b => /fuller answer|Turn action rejected/.test(b)), notices.join(' | '));
    const alpha = (await pool.query("SELECT count(*)::int n FROM tasks WHERE tenant_id=$1 AND scope='project:alpha' AND status='queued'", [t])).rows[0].n;
    assert.equal(alpha, 1, 'dispatch still went out');
  });
});
