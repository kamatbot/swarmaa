import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { authorizationHtml, narrowGrant, OAuthError, OAuthService, pkceChallenge, validateRedirectUri } from '../src/oauth.js';
import type { Principal, ServerConfig } from '../src/types.js';

const base: Principal = {
  id: '54e48519-9cef-4a50-9faa-5855a309be11', tenantId: 'test', name: 'claude', role: 'frontend',
  scopes: ['project:alpha', 'project:beta'], permissions: ['memory:read', 'memory:write', 'task:submit'],
};
const config: ServerConfig = {
  host: '127.0.0.1', port: 8080, publicUrl: 'https://memory.example', allowedOrigins: [],
  allowInsecureLocalhost: false, maxBodyBytes: 1_048_576, oauthEnabled: true,
  oauthRedirectHosts: ['claude.ai', 'chatgpt.com'], eventCallbackHosts: [], eventEncryptionKey: '',
};

test('a saved OAuth grant only intersects current grants and never becomes admin', () => {
  assert.deepEqual(narrowGrant(base, { ...base, scopes: ['project:alpha', 'project:new'], permissions: ['memory:read', 'task:claim'] }),
    { ...base, scopes: ['project:alpha'], permissions: ['memory:read'] });
  assert.equal(narrowGrant(base, { ...base, role: 'admin', scopes: ['*'], permissions: ['admin'] }), null);
  assert.equal(narrowGrant(base, { ...base, tenantId: 'other' }), null);
  assert.equal(narrowGrant(base, { ...base, role: 'worker' }), null);
  assert.equal(narrowGrant({ ...base, credentialVersion: 1 }, { ...base, credentialVersion: 2 }), null);
  assert.equal(narrowGrant(base, null), null);
});

test('redirect validation requires an exact allowlisted host and safe canonical URI', () => {
  assert.equal(validateRedirectUri('https://claude.ai/api/mcp/auth_callback', config), 'https://claude.ai/api/mcp/auth_callback');
  for (const uri of [
    'https://claude.ai.attacker.example/callback', 'https://user@claude.ai/callback',
    'https://claude.ai/callback#fragment', 'https://claude.ai/callback#', 'http://claude.ai/callback',
    'https://CLAUDE.AI/callback', 'https://claude.ai', 'file:///callback',
  ]) assert.throws(() => validateRedirectUri(uri, config), OAuthError);
  const local = { ...config, allowInsecureLocalhost: true, oauthRedirectHosts: ['127.0.0.1'] };
  assert.equal(validateRedirectUri('http://127.0.0.1:1234/callback', local), 'http://127.0.0.1:1234/callback');
  assert.throws(() => validateRedirectUri('http://127.0.0.1:1234/callback', config), OAuthError);
});

test('PKCE matches the RFC 7636 S256 example and HTML escapes untrusted metadata', () => {
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const html = authorizationHtml({
    kind: 'form', requestId: randomUUID(), csrf: 'csrf', browserCookie: 'cookie',
    clientName: '<script>alert(1)</script>', redirectUri: 'https://claude.ai/callback',
    principal: { ...base, name: '<img src=x onerror=alert(1)>' },
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('project:alpha'));
});

test('scheduled OAuth cleanup reclaims unused registrations and expired tokens while preserving live refresh-replay tokens', async () => {
  const executed: { sql: string; params: unknown[] }[] = [];
  const fakePool = {
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        return { rows: [], rowCount: 2 };
      },
      release: () => undefined,
    }),
  } as unknown as Pool;
  const service = new OAuthService(fakePool, { authenticate: async () => base, getPrincipal: async () => base }, config);
  service.start(20);
  await new Promise(resolve => setTimeout(resolve, 60));
  await service.stop();

  const sqls = executed.map(e => e.sql);
  // Verifies scheduled cleanup ran and executed bounded deletes for pending, codes, access tokens, refresh tokens, and unused clients.
  assert.ok(sqls.some(s => s.includes('DELETE FROM oauth_access_tokens') && s.includes('LIMIT $1')));
  const refreshDelete = sqls.find(s => s.includes('DELETE FROM oauth_refresh_tokens'));
  assert.ok(refreshDelete, 'scheduled cleanup must clean up expired refresh tokens');
  assert.ok(
    refreshDelete.includes("r.expires_at <> '-infinity'::timestamptz AND r.used_at IS NULL"),
    'refresh token cleanup must preserve used and abandoned tokens on live grant families for replay detection',
  );
  const clientDelete = sqls.find(s => s.includes('DELETE FROM oauth_clients'));
  assert.ok(clientDelete, 'scheduled cleanup must reclaim unused dynamic client registrations');
  assert.ok(clientDelete.includes("interval '24 hours'") && clientDelete.includes('p.expires_at > now()'));
});


