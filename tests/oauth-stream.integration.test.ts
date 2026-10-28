import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import pg from 'pg';
import { AuthService, hashToken } from '../src/auth.js';
import { CoreService } from '../src/core/index.js';
import { createHttpHandler } from '../src/http.js';
import { OAuthService, pkceChallenge } from '../src/oauth.js';
import type { ServerConfig } from '../src/types.js';

// Remote Mac app sign-ins use OAuth; their live window needs /api/stream.
test('an OAuth access token opens the event stream but still cannot call REST tools', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const admin = new pg.Pool({ connectionString, max: 1 });
  const schema = `oauth_stream_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema},public`, max: 6 });
  const server = createServer();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  for (const file of (await readdir(new URL('../db/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const connection = `cn_${randomBytes(32).toString('base64url')}`;
  await pool.query('INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [
    '6a1f0d2e-0b7c-4d61-9a55-2f1a7c3e9b10', 'test', 'mac', 'frontend', ['project:alpha'], ['events:read', 'memory:read'], hashToken(connection),
  ]);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config: ServerConfig = {
    host: '127.0.0.1', port: 0, publicUrl: origin, allowedOrigins: [], allowInsecureLocalhost: true, maxBodyBytes: 131072,
    oauthEnabled: true, oauthRedirectHosts: ['127.0.0.1'], eventCallbackHosts: [], eventEncryptionKey: '0'.repeat(64),
  };
  const auth = new AuthService(pool);
  server.on('request', createHttpHandler({ pool, core: new CoreService(pool), auth, config, streamHeartbeatMs: 50 }));

  // Mint a real access token through the same service the HTTP routes use.
  const oauth = new OAuthService(pool, auth, config);
  const redirect = 'http://127.0.0.1:53123/callback';
  const clientId = String((await oauth.registerClient({ client_name: 'Swarmaa for Mac', redirect_uris: [redirect], token_endpoint_auth_method: 'none' })).client_id);
  const verifier = randomBytes(48).toString('base64url');
  const start = await oauth.beginAuthorize(new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirect, resource: oauth.resource, state: 's',
    code_challenge_method: 'S256', code_challenge: pkceChallenge(verifier),
  }));
  const identified = await oauth.respondAuthorize(new URLSearchParams({ request_id: start.requestId, csrf: start.csrf, action: 'identify', connection_token: connection }), start.browserCookie);
  assert.equal(identified.kind, 'form');
  if (identified.kind !== 'form') return;
  const approved = await oauth.respondAuthorize(new URLSearchParams({ request_id: identified.requestId, csrf: identified.csrf, action: 'approve' }), identified.browserCookie);
  assert.equal(approved.kind, 'redirect');
  if (approved.kind !== 'redirect') return;
  const issued = await oauth.exchangeToken(new URLSearchParams({
    grant_type: 'authorization_code', client_id: clientId, code: new URL(approved.location).searchParams.get('code')!,
    redirect_uri: redirect, resource: oauth.resource, code_verifier: verifier,
  }));
  const bearer = { authorization: `Bearer ${String(issued.access_token)}` };

  const controller = new AbortController();
  const stream = await fetch(`${origin}/api/stream?after=now`, { headers: { ...bearer, accept: 'text/event-stream' }, signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /^text\/event-stream/);
  // Heartbeats re-check the token every 50 ms here: the OAuth stream must survive them...
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  while ((seen.match(/: heartbeat/g) ?? []).length < 3) {
    const { value, done } = await reader.read();
    assert.equal(done, false, 'the server ended an OAuth stream at a heartbeat');
    seen += decoder.decode(value);
  }
  // ...and end once the token is revoked.
  await oauth.revokeToken(new URLSearchParams({ client_id: clientId, token: String(issued.access_token) }));
  for (;;) { const { done } = await reader.read(); if (done) break; }
  controller.abort();

  const tool = await fetch(`${origin}/api/tools/context_get`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(tool.status, 401);
  const forged = await fetch(`${origin}/api/stream?after=now`, { headers: { authorization: `Bearer cn_access_${'a'.repeat(43)}` } });
  assert.equal(forged.status, 401);
});
