import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { OAuthError, OAuthService } from '../src/oauth.js';
import type { AuthBackend, ServerConfig } from '../src/types.js';

const config: ServerConfig = {
  host: '127.0.0.1', port: 8080, publicUrl: 'https://memory.example', allowedOrigins: [],
  allowInsecureLocalhost: false, maxBodyBytes: 1_048_576, oauthEnabled: true,
  oauthRedirectHosts: ['claude.ai'], eventCallbackHosts: [], eventEncryptionKey: '',
};
const PRINCIPAL = '54e48519-9cef-4a50-9faa-5855a309be11';

test('client registration: expiry, per-IP limit, global cap', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const admin = new pg.Pool({ connectionString, max: 1 });
  const schema = `oauth_reg_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema},public`, max: 4 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  for (const m of ['001_identity.sql', '003_oauth.sql', '007_passkeys.sql', '009_oauth_client_cleanup.sql', '015_gateway_tenants.sql']) await pool.query(await readFile(new URL(`../db/migrations/${m}`, import.meta.url), 'utf8'));
  await pool.query("INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,'t','p','frontend','{project:alpha}','{memory:read}','h')", [PRINCIPAL]);
  const service = new OAuthService(pool, { authenticate: async () => null, getPrincipal: async () => null } as AuthBackend, config);
  const register = (ip?: string) => service.registerClient({ client_name: 'c', redirect_uris: ['https://claude.ai/cb'] }, ip);
  const ids = async () => new Set((await pool.query<{ client_id: string }>('SELECT client_id FROM oauth_clients')).rows.map(r => r.client_id));
  const grant = (client: string, extra: string) => pool.query(
    `INSERT INTO oauth_grants(id,principal_id,client_id,resource,grant_snapshot,expires_at,revoked_at) VALUES (gen_random_uuid(),$1,$2,'r','{}'::jsonb,${extra})`, [PRINCIPAL, client]);
  const add = async (id: string, age: string) => pool.query(`INSERT INTO oauth_clients(client_id,client_name,redirect_uris,created_at) VALUES ($1,'x','{https://claude.ai/cb}', now()-interval '${age}')`, [id]);

  // Expiry deletes only unused/stale clients.
  await add('old_unused', '25 hours'); await add('new_unused', '1 hour'); await add('old_used', '40 days'); await add('old_dead', '90 days'); await add('old_revoked_recent', '90 days');
  await grant('old_used', "now()+interval '10 days', NULL");
  await grant('old_dead', "now()-interval '60 days', NULL");
  await grant('old_revoked_recent', "now()+interval '10 days', now()-interval '2 days'");
  await register('ip-a');
  const after = await ids();
  assert.ok(!after.has('old_unused') && !after.has('old_dead'));
  assert.ok(after.has('new_unused') && after.has('old_used') && after.has('old_revoked_recent'));

  // Pending authorization protects an old client.
  await add('old_pending', '30 hours');
  await pool.query("INSERT INTO oauth_pending(id,client_id,redirect_uri,challenge,resource,csrf_hash,browser_hash,expires_at) VALUES (gen_random_uuid(),'old_pending','u','c','r','a','b',now()+interval '5 minutes')");
  await register('ip-a');
  assert.ok((await ids()).has('old_pending'));

  // Per-IP: 20 live unused registrations; other IPs and absent IP unaffected.
  const before = Number((await pool.query("SELECT count(*) FROM oauth_clients WHERE created_ip_hash='ip-b'")).rows[0].count);
  assert.equal(before, 0);
  for (let i = 0; i < 20; i++) await register('ip-b');
  await assert.rejects(register('ip-b'), (e: unknown) => e instanceof OAuthError && e.status === 429);
  await register('ip-c'); await register();
  // A used client no longer counts toward its IP's unused limit.
  const used = (await pool.query<{ client_id: string }>("SELECT client_id FROM oauth_clients WHERE created_ip_hash='ip-b' LIMIT 1")).rows[0]!.client_id;
  await grant(used, "now()+interval '1 day', NULL");
  await register('ip-b');

  // Global cap: 5000 recent-or-used; error is RFC temporarily_unavailable, 503.
  await pool.query("DELETE FROM oauth_clients WHERE client_id NOT IN (SELECT client_id FROM oauth_grants)");
  await pool.query("INSERT INTO oauth_clients(client_id,client_name,redirect_uris) SELECT 'bulk_'||g,'x','{https://claude.ai/cb}' FROM generate_series(1,5000) g");
  await assert.rejects(register('ip-z'), (e: unknown) => e instanceof OAuthError && e.status === 503 && e.code === 'temporarily_unavailable');
  // Stale rows don't count: age them out and registration works again (cleanup runs first, 500 per call).
  await pool.query("UPDATE oauth_clients SET created_at=now()-interval '2 days' WHERE client_id LIKE 'bulk_%'");
  const ok = await register('ip-z');
  assert.ok(String(ok.client_id).startsWith('cn_client'));
  assert.ok(Number((await pool.query("SELECT count(*) FROM oauth_clients WHERE client_id LIKE 'bulk_%'")).rows[0].count) >= 4500);
});
