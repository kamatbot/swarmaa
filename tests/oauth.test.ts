import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { authorizationHtml, narrowGrant, OAuthError, pkceChallenge, validateRedirectUri } from '../src/oauth.js';
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

