import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { OAuthError, OAuthService, pkceChallenge, tokenHash, type AuthorizationForm } from '../src/oauth.js';
import type { AuthBackend, Principal, ServerConfig } from '../src/types.js';

const base: Principal = {
  id: '54e48519-9cef-4a50-9faa-5855a309be11', tenantId: 'test', name: 'claude', role: 'frontend',
  scopes: ['project:alpha', 'project:beta'], permissions: ['memory:read', 'memory:write', 'task:submit'],
};
const config: ServerConfig = {
  host: '127.0.0.1', port: 8080, publicUrl: 'https://memory.example', allowedOrigins: [],
  allowInsecureLocalhost: false, maxBodyBytes: 1_048_576, oauthEnabled: true,
  oauthRedirectHosts: ['claude.ai', 'chatgpt.com'], eventCallbackHosts: [], eventEncryptionKey: '',
};

// This integration test creates only a uniquely named disposable schema. It is
// skipped without TEST_DATABASE_URL and has not been executed during authoring.
test('OAuth authorization, PKCE, code single-use, refresh replay and revocation', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const admin = new pg.Pool({ connectionString, max: 1 });
  const schema = `oauth_test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema},public`, max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  for (const migration of ['001_identity.sql', '003_oauth.sql', '009_oauth_client_cleanup.sql']) {
    await pool.query(await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  await pool.query(
    'INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [base.id, base.tenantId, base.name, base.role, base.scopes, base.permissions, tokenHash('connection-secret')],
  );
  let current: Principal | null = { ...base };
  const auth: AuthBackend = {
    authenticate: async token => token === 'connection-secret' ? current : token === 'admin-secret' ? { ...base, role: 'admin', permissions: ['admin'], scopes: ['*'] } : null,
    getPrincipal: async id => id === base.id ? current : null,
  };
  const service = new OAuthService(pool, auth, config);
  const registration = await service.registerClient({ client_name: 'Claude test', redirect_uris: ['https://claude.ai/callback'], token_endpoint_auth_method: 'none' });
  const clientId = String(registration.client_id);
  const verifier = randomBytes(48).toString('base64url');
  const authorizationParams = (): URLSearchParams => new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: 'https://claude.ai/callback',
    resource: service.resource, state: 'test-state', code_challenge_method: 'S256', code_challenge: pkceChallenge(verifier),
  });
  const formData = (form: AuthorizationForm, action: string, additional: Record<string, string> = {}): URLSearchParams =>
    new URLSearchParams({ request_id: form.requestId, csrf: form.csrf, action, ...additional });
  const getCode = async (): Promise<string> => {
    const start = await service.beginAuthorize(authorizationParams());
    await assert.rejects(service.respondAuthorize(formData(start, 'identify', { connection_token: 'connection-secret' }), 'bad-cookie'), OAuthError);
    await assert.rejects(service.respondAuthorize(formData(start, 'identify', { connection_token: 'admin-secret' }), start.browserCookie), OAuthError);
    const identified = await service.respondAuthorize(formData(start, 'identify', { connection_token: 'connection-secret' }), start.browserCookie);
    assert.equal(identified.kind, 'form');
    if (identified.kind !== 'form') throw new Error('Expected consent form.');
    assert.deepEqual(identified.principal?.scopes, base.scopes);
    // The old CSRF nonce is consumed by the identity step.
    await assert.rejects(service.respondAuthorize(formData(start, 'approve'), start.browserCookie), OAuthError);
    const approved = await service.respondAuthorize(formData(identified, 'approve'), identified.browserCookie);
    assert.equal(approved.kind, 'redirect');
    if (approved.kind !== 'redirect') throw new Error('Expected redirect.');
    const callback = new URL(approved.location);
    assert.equal(callback.searchParams.get('state'), 'test-state');
    assert.equal(callback.searchParams.get('iss'), service.issuer);
    await assert.rejects(service.respondAuthorize(formData(identified, 'approve'), identified.browserCookie), OAuthError);
    return callback.searchParams.get('code')!;
  };
  const exchange = (code: string, overrides: Record<string, string> = {}): URLSearchParams => new URLSearchParams({
    grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: 'https://claude.ai/callback', resource: service.resource, code_verifier: verifier, ...overrides,
  });
  const code = await getCode();
  await assert.rejects(service.exchangeToken(exchange(code, { resource: 'https://attacker.example/mcp' })), OAuthError);
  await assert.rejects(service.exchangeToken(exchange(code, { code_verifier: 'a'.repeat(64) })), OAuthError);
  const issued = await service.exchangeToken(exchange(code));
  await assert.rejects(service.exchangeToken(exchange(code)), OAuthError);
  const authorized = await service.authenticate(String(issued.access_token));
  assert.equal(authorized?.id, base.id);
  assert.match(authorized?.oauthGrantId ?? '', /^[0-9a-f-]{36}$/u);
  const family = await pool.query<{ id: string }>('SELECT id FROM oauth_grants WHERE id=$1', [authorized?.oauthGrantId]);
  assert.equal(family.rows.length, 1);
  const persisted = await pool.query<{ token_hash: string }>('SELECT token_hash FROM oauth_access_tokens');
  assert.ok(persisted.rows.every(row => /^[0-9a-f]{64}$/u.test(row.token_hash)));
  assert.ok(!JSON.stringify(persisted.rows).includes(String(issued.access_token)));
  const refreshParams = (token: unknown): URLSearchParams => new URLSearchParams({
    grant_type: 'refresh_token', client_id: clientId, resource: service.resource, refresh_token: String(token),
  });
  current = { ...base, scopes: ['project:alpha'], permissions: ['memory:read'] };
  assert.deepEqual((await service.authenticate(String(issued.access_token)))?.scopes, ['project:alpha']);
  const rotated = await service.exchangeToken(refreshParams(issued.refresh_token));
  current = { ...base }; // Restoring permissions cannot widen the refresh snapshot.
  assert.deepEqual((await service.authenticate(String(rotated.access_token)))?.permissions, ['memory:read']);
  await assert.rejects(service.exchangeToken(refreshParams(issued.refresh_token)), OAuthError);
  assert.equal(await service.authenticate(String(rotated.access_token)), null);
  await assert.rejects(service.exchangeToken(refreshParams(rotated.refresh_token)), OAuthError);

  const second = await service.exchangeToken(exchange(await getCode()));
  await service.revokeToken(new URLSearchParams({ client_id: clientId, token: String(second.access_token) }));
  assert.equal(await service.authenticate(String(second.access_token)), null);
  await service.revokeToken(new URLSearchParams({ client_id: clientId, token: 'unknown-token' }));

  const third = await service.exchangeToken(exchange(await getCode()));
  current = null;
  assert.equal(await service.authenticate(String(third.access_token)), null);

  current = { ...base };
  const expiredCode = await getCode();
  await pool.query("UPDATE oauth_codes SET expires_at=now()-interval '1 second' WHERE code_hash=$1", [tokenHash(expiredCode)]);
  await assert.rejects(service.exchangeToken(exchange(expiredCode)), OAuthError);
  const expiryTokens = await service.exchangeToken(exchange(await getCode()));
  await pool.query("UPDATE oauth_access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [tokenHash(String(expiryTokens.access_token))]);
  assert.equal(await service.authenticate(String(expiryTokens.access_token)), null);
  await pool.query("UPDATE oauth_grants SET expires_at=now()-interval '1 second' WHERE id IN (SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash=$1)", [tokenHash(String(expiryTokens.refresh_token))]);
  await assert.rejects(service.exchangeToken(refreshParams(expiryTokens.refresh_token)), OAuthError);

  const concurrentCode = await getCode();
  const races = await Promise.allSettled([service.exchangeToken(exchange(concurrentCode)), service.exchangeToken(exchange(concurrentCode))]);
  assert.equal(races.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(races.filter(result => result.status === 'rejected').length, 1);
});
