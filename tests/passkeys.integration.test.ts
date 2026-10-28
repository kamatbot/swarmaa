import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import pg from 'pg';
import { AuthService } from '../src/auth.js';
import { createHttpHandler } from '../src/http.js';
import { LEGACY_VERSION } from '../src/mcp.js';
import { pkceChallenge, tokenHash } from '../src/oauth.js';
import { PASSKEY_TENANT, PasskeyService } from '../src/passkeys.js';
import type { ServerConfig, ToolBackend } from '../src/types.js';

const ORIGIN = 'https://api.swarmaa.com';
const RP_ID = 'swarmaa.com';
const b64 = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url');
const sha = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();

/** Minimal CBOR writer for the few shapes WebAuthn 'none' attestation needs. */
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
}
const cbText = (s: string): Buffer => Buffer.concat([head(3, s.length), Buffer.from(s)]);
const cbBytes = (b: Buffer): Buffer => Buffer.concat([head(2, b.length), b]);

/** A software ES256 authenticator: enough of WebAuthn to run registration and login without a browser. */
class SoftAuthenticator {
  readonly key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly credentialId = randomBytes(32);
  counter = 0;

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  register(challenge: string, origin = ORIGIN, flags = 0x45) {
    const jwk = this.key.publicKey.export({ format: 'jwk' });
    const cose = Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x!, 'base64url'),
      Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y!, 'base64url'),
    ]);
    const idLength = Buffer.alloc(2); idLength.writeUInt16BE(this.credentialId.length);
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha(RP_ID), Buffer.from([flags]), counter, Buffer.alloc(16), idLength, this.credentialId, cose]);
    const attestationObject = Buffer.concat([Buffer.from([0xa3]), cbText('fmt'), cbText('none'), cbText('attStmt'), Buffer.from([0xa0]), cbText('authData'), cbBytes(authData)]);
    return {
      id: b64(this.credentialId), rawId: b64(this.credentialId), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(this.clientData('webauthn.create', challenge, origin)), attestationObject: b64(attestationObject), transports: ['internal'] },
    };
  }

  assert(challenge: string, options: { counter?: number; origin?: string; key?: KeyObject } = {}) {
    this.counter = options.counter ?? this.counter + 1;
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter);
    const authenticatorData = Buffer.concat([sha(RP_ID), Buffer.from([0x05]), counter]);
    const clientDataJSON = this.clientData('webauthn.get', challenge, options.origin ?? ORIGIN);
    const signature = createSign('sha256').update(Buffer.concat([authenticatorData, sha(clientDataJSON)])).sign(options.key ?? this.key.privateKey);
    return {
      id: b64(this.credentialId), rawId: b64(this.credentialId), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature: b64(signature), userHandle: b64(randomBytes(32)) },
    };
  }
}

const core: ToolBackend = { listTools: () => [], call: async () => ({}) };

// Creates only a uniquely named disposable schema; skipped without TEST_DATABASE_URL.
test('passkey registration, login, sessions and the OAuth owner consent flow', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const admin = new pg.Pool({ connectionString, max: 1 });
  const schema = `passkey_test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema},public`, max: 6 });
  const server = createServer();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  for (const migration of ['001_identity.sql', '003_oauth.sql', '007_passkeys.sql', '009_oauth_client_cleanup.sql', '015_gateway_tenants.sql','018_events_xid.sql']) {
    await pool.query(await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'));
  }

  // Nothing secret may reach stdout/stderr/console while these flows run.
  const logged: string[] = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  const capture = (...args: unknown[]): void => { logged.push(args.map(String).join(' ')); };
  console.log = capture; console.error = capture; console.warn = capture;
  t.after(() => { console.log = originals.log; console.error = originals.error; console.warn = originals.warn; });

  const config: ServerConfig = {
    host: '127.0.0.1', port: 0, publicUrl: ORIGIN, allowedOrigins: [], allowInsecureLocalhost: false, maxBodyBytes: 65536,
    oauthEnabled: true, oauthRedirectHosts: ['grok.example'], eventCallbackHosts: [], eventEncryptionKey: '',
  };
  const svc = new PasskeyService(pool, config);
  assert.equal(svc.rp?.rpID, RP_ID);
  const secrets: string[] = [];
  const browser = randomBytes(32).toString('base64url');
  const device = new SoftAuthenticator();

  // --- invites: hashed at rest, single use, expiring
  const code = await svc.createInvite(30);
  secrets.push(code);
  const stored = await pool.query<{ code_hash: string }>('SELECT code_hash FROM passkey_invites');
  assert.deepEqual(stored.rows, [{ code_hash: tokenHash(code) }]);
  await assert.rejects(svc.registrationOptions({ browser }), { code: 'forbidden' }, 'no code and no session');
  await assert.rejects(svc.registrationOptions({ code: randomBytes(32).toString('base64url'), browser }), { code: 'forbidden' });
  const expiring = await svc.createInvite(30);
  await pool.query("UPDATE passkey_invites SET expires_at=now()-interval '1 second' WHERE code_hash=$1", [tokenHash(expiring)]);
  assert.equal(await svc.inviteUsable(expiring), false);
  await assert.rejects(svc.registrationOptions({ code: expiring, browser }), { code: 'forbidden' });

  // --- challenges: bound to the browser, single use, expiring
  const first = await svc.registrationOptions({ code, browser });
  secrets.push(first.challenge);
  assert.equal(first.authenticatorSelection?.residentKey, 'required');
  assert.equal(first.authenticatorSelection?.userVerification, 'required');
  assert.equal(first.attestation, 'none');
  assert.equal(first.rp.id, RP_ID);
  const otherBrowser = randomBytes(32).toString('base64url');
  await assert.rejects(svc.verifyRegistration({ code, browser: otherBrowser, response: device.register(first.challenge) }), { code: 'passkey_failed' }, 'challenge is bound to the browser');
  // The failed attempt did not consume it for the rightful browser, but a wrong origin and a missing UV flag are rejected (and burn it).
  await assert.rejects(svc.verifyRegistration({ code, browser, response: device.register(first.challenge, 'https://evil.example') }), { code: 'passkey_failed' });
  await assert.rejects(svc.verifyRegistration({ code, browser, response: device.register(first.challenge) }), { code: 'passkey_failed' }, 'burned by the failed attempt');
  const noUv = await svc.registrationOptions({ code, browser });
  await assert.rejects(svc.verifyRegistration({ code, browser, response: device.register(noUv.challenge, ORIGIN, 0x41) }), { code: 'passkey_failed' }, 'user verification is required');
  const stale = await svc.registrationOptions({ code, browser });
  await pool.query("UPDATE webauthn_challenges SET expires_at=now()-interval '1 second' WHERE challenge=$1", [stale.challenge]);
  await assert.rejects(svc.verifyRegistration({ code, browser, response: device.register(stale.challenge) }), { code: 'passkey_failed' }, 'expired challenge');

  // --- successful registration spends the invite and starts a session
  const options = await svc.registrationOptions({ code, browser });
  const response = device.register(options.challenge);
  const sessionToken = await svc.verifyRegistration({ code, browser, response });
  secrets.push(sessionToken);
  await assert.rejects(svc.verifyRegistration({ code, browser, response }), { code: 'forbidden' }, 'invite is single use');
  await assert.rejects(svc.registrationOptions({ code, browser }), { code: 'forbidden' });
  assert.deepEqual(await svc.session(sessionToken), { tenantId: PASSKEY_TENANT });
  const sessions = await pool.query<{ token_hash: string }>('SELECT token_hash FROM owner_sessions');
  assert.deepEqual(sessions.rows, [{ token_hash: tokenHash(sessionToken) }]);
  assert.equal((await svc.list(sessionToken)).length, 1);
  await pool.query("UPDATE owner_sessions SET expires_at=now()-interval '1 second'");
  assert.equal(await svc.session(sessionToken), null, 'session expires server-side');
  await assert.rejects(svc.list(sessionToken), { code: 'forbidden' });

  // --- login: discoverable options, counter checked and stored
  const loginOptions = await svc.authenticationOptions(browser);
  assert.deepEqual(loginOptions.allowCredentials ?? [], []);
  assert.equal(loginOptions.userVerification, 'required');
  const assertion = device.assert(loginOptions.challenge);
  await assert.rejects(svc.verifyAuthentication({ browser: otherBrowser, response: assertion }), { code: 'passkey_failed' }, 'bound to the browser');
  const loginToken = await svc.verifyAuthentication({ browser, response: assertion });
  secrets.push(loginToken);
  const row = await pool.query<{ counter: string; last_used_at: Date | null }>('SELECT counter,last_used_at FROM owner_passkeys');
  assert.equal(row.rows[0]?.counter, '1');
  assert.ok(row.rows[0]?.last_used_at);
  await assert.rejects(svc.verifyAuthentication({ browser, response: assertion }), { code: 'passkey_failed' }, 'replayed assertion / used challenge');
  const regress = await svc.authenticationOptions(browser);
  await assert.rejects(svc.verifyAuthentication({ browser, response: device.assert(regress.challenge, { counter: 1 }) }), { code: 'passkey_failed' }, 'counter must increase');
  const rogue = await svc.authenticationOptions(browser);
  await assert.rejects(svc.verifyAuthentication({ browser, response: device.assert(rogue.challenge, { counter: 5, key: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey }) }), { code: 'passkey_failed' }, 'bad signature');
  const wrongOrigin = await svc.authenticationOptions(browser);
  await assert.rejects(svc.verifyAuthentication({ browser, response: device.assert(wrongOrigin.challenge, { counter: 6, origin: 'https://evil.example' }) }), { code: 'passkey_failed' });
  const unknown = await svc.authenticationOptions(browser);
  await assert.rejects(svc.verifyAuthentication({ browser, response: { ...new SoftAuthenticator().assert(unknown.challenge) } }), { code: 'passkey_failed' }, 'unknown credential looks like any other failure');
  const good = await svc.authenticationOptions(browser);
  secrets.push(await svc.verifyAuthentication({ browser, response: device.assert(good.challenge, { counter: 7 }) }));
  assert.equal((await pool.query('SELECT counter FROM owner_passkeys')).rows[0].counter, '7');

  // --- second passkey via session; removing the last one is refused
  const owner = secrets[secrets.length - 1]!;
  const second = new SoftAuthenticator();
  const addOptions = await svc.registrationOptions({ sessionToken: owner, browser });
  assert.equal(addOptions.excludeCredentials?.length, 1);
  await svc.verifyRegistration({ sessionToken: owner, browser, response: second.register(addOptions.challenge), name: 'Phone' });
  const listed = await svc.list(owner);
  assert.deepEqual(listed.map(p => p.name).sort(), ['Passkey ' + new Date().toISOString().slice(0, 10), 'Phone'].sort());
  await assert.rejects(svc.remove(undefined, listed[0]!.id), { code: 'forbidden' });
  await svc.remove(owner, listed[1]!.id);
  await assert.rejects(svc.remove(owner, listed[0]!.id), { code: 'last_passkey' });

  // --- OAuth consent through the HTTP handler, signed in with the passkey
  const principals = await pool.query.bind(pool);
  const addPrincipal = async (name: string, role: string, extra: { tenant?: string; disabled?: boolean; scopes?: string[]; permissions?: string[] } = {}): Promise<string> => {
    const id = randomUUID();
    await principals(
      'INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash,disabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, extra.tenant ?? PASSKEY_TENANT, name, role, extra.scopes ?? ['project:alpha'], extra.permissions ?? ['memory:read', 'task:submit'], tokenHash(randomUUID()), extra.disabled ?? false],
    );
    return id;
  };
  const grok = await addPrincipal('grok', 'frontend');
  await addPrincipal('dot', 'frontend', { scopes: ['project:beta'] });
  const rootAdmin = await addPrincipal('root', 'admin', { scopes: ['*'], permissions: ['admin'] });
  const worker = await addPrincipal('worker1', 'worker');
  const disabled = await addPrincipal('old', 'frontend', { disabled: true });
  const foreign = await addPrincipal('grok', 'frontend', { tenant: 'other' });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  // The handler allows the literal loopback Host only on its configured port.
  server.on('request', createHttpHandler({ pool, core, auth: new AuthService(pool), config: { ...config, port } }));

  const cookies = (res: Response): Record<string, string> => Object.fromEntries(res.headers.getSetCookie().map(c => [c.split('=')[0]!, c]));
  const jsonPost = (path: string, body: unknown, cookie: string, origin: string | null = ORIGIN) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), cookie }, body: JSON.stringify(body) });

  // Sign in over HTTP.
  const bind = browser;
  const loginRes = await jsonPost('/account/passkeys/login/options', {}, `swarmaa_pk=${bind}`);
  assert.equal(loginRes.status, 200);
  assert.ok(cookies(loginRes).swarmaa_pk?.includes('Path=/account'));
  const httpChallenge = ((await loginRes.json()) as { options: { challenge: string } }).options.challenge;
  assert.equal((await jsonPost('/account/passkeys/login/verify', { response: device.assert(httpChallenge, { counter: 8 }) }, `swarmaa_pk=${bind}`, null)).status, 403, 'missing Origin');
  const again = ((await (await jsonPost('/account/passkeys/login/options', {}, `swarmaa_pk=${bind}`)).json()) as { options: { challenge: string } }).options.challenge;
  const verified = await jsonPost('/account/passkeys/login/verify', { response: device.assert(again, { counter: 9 }) }, `swarmaa_pk=${bind}`);
  assert.equal(verified.status, 200);
  const ownerSet = cookies(verified).swarmaa_owner!;
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=43200']) assert.ok(ownerSet.includes(attribute), attribute);
  const ownerValue = /^swarmaa_owner=([^;]+)/u.exec(ownerSet)![1]!;
  secrets.push(ownerValue);
  const ownerCookie = `swarmaa_owner=${ownerValue}`;
  const failedLogin = await jsonPost('/account/passkeys/login/verify', { response: { id: 'x' } }, `swarmaa_pk=${bind}`);
  assert.equal(failedLogin.status, 403);
  assert.match(JSON.stringify(await failedLogin.json()), /Passkey verification failed/u, 'generic message');

  // The owner session is not an API credential.
  for (const [path, headers] of [
    ['/api/tools/context_get', { cookie: ownerCookie }], ['/mcp', { cookie: ownerCookie, accept: 'application/json, text/event-stream' }],
    ['/api/tools/context_get', { authorization: `Bearer ${ownerValue}` }], ['/mcp', { authorization: `Bearer ${ownerValue}`, accept: 'application/json, text/event-stream' }],
  ] as const) {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.equal(res.status, 401, `${path} must not accept the owner session`);
  }

  // Register an OAuth client and start authorization.
  const registered = await (await fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Grok Bot', redirect_uris: ['https://grok.example/callback'], token_endpoint_auth_method: 'none' }),
  })).json() as { client_id: string };
  const verifier = randomBytes(48).toString('base64url');
  const authorizeUrl = `${base}/oauth/authorize?${new URLSearchParams({
    client_id: registered.client_id, response_type: 'code', redirect_uri: 'https://grok.example/callback', resource: `${ORIGIN}/mcp`,
    state: 's1', code_challenge_method: 'S256', code_challenge: pkceChallenge(verifier),
  })}`;
  const start = async (cookie: string): Promise<{ html: string; res: Response; form: { request_id: string; csrf: string }; browser: string }> => {
    const res = await fetch(authorizeUrl, { headers: { cookie } });
    const html = await res.text();
    return {
      html, res, browser: /collective_oauth_browser=([^;]+)/u.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '',
      form: { request_id: /name="request_id" value="([^"]+)"/u.exec(html)?.[1] ?? '', csrf: /name="csrf" value="([^"]+)"/u.exec(html)?.[1] ?? '' },
    };
  };
  const formPost = (cookie: string, fields: Record<string, string>, origin: string | null = ORIGIN) => fetch(`${base}/oauth/authorize`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...(origin ? { origin } : {}) }, body: new URLSearchParams(fields),
  });

  // Signed out: passkey primary, token secondary.
  const signedOut = await start('');
  assert.ok(signedOut.html.includes('Sign in with passkey') && signedOut.html.includes('Use a connection token instead'));
  const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/u.exec(signedOut.res.headers.get('content-security-policy') ?? '')?.[1];
  assert.ok(nonce && signedOut.html.includes(`<script nonce="${nonce}">`));

  // Signed in: identity select, default from the client name, only enabled non-admin frontend principals of this tenant.
  const signedIn = await start(ownerCookie);
  assert.ok(!signedIn.html.includes('connection_token'));
  assert.match(signedIn.html, new RegExp(`<option value="${grok}" selected>grok · \\d+ projects?</option>`, 'u'));
  for (const hidden of [rootAdmin, worker, disabled, foreign]) assert.ok(!signedIn.html.includes(hidden), 'ineligible principal listed');
  const jar = `${ownerCookie}; collective_oauth_browser=${signedIn.browser}`;
  const pick = (id: string, over: Record<string, string> = {}) => ({ ...signedIn.form, action: 'identify_owner', principal_id: id, ...over });
  for (const bad of [rootAdmin, worker, disabled, foreign]) assert.equal((await formPost(jar, pick(bad))).status, 403, 'cannot pick an ineligible principal');
  assert.equal((await formPost(jar, pick(grok, { csrf: 'wrong' }))).status, 403, 'CSRF required');
  assert.equal((await formPost(ownerCookie, pick(grok))).status, 403, 'authorize browser cookie required');
  assert.equal((await formPost(`collective_oauth_browser=${signedIn.browser}`, pick(grok))).status, 403, 'owner session required');
  assert.equal((await formPost(jar, pick(grok), null)).status, 403, 'same-origin required');
  const reviewed = await formPost(jar, pick(grok));
  assert.equal(reviewed.status, 200);
  const reviewHtml = await reviewed.text();
  assert.ok(reviewHtml.includes('project:alpha') && reviewHtml.includes('Approve connection'));
  const next = { request_id: signedIn.form.request_id, csrf: /name="csrf" value="([^"]+)"/u.exec(reviewHtml)![1]! };
  assert.equal((await formPost(jar, { ...next, csrf: signedIn.form.csrf, action: 'approve' })).status, 403, 'old CSRF consumed');
  const approved = await formPost(jar, { ...next, action: 'approve' });
  assert.equal(approved.status, 303);
  const callback = new URL(approved.headers.get('location')!);
  assert.equal(callback.searchParams.get('state'), 's1');
  const token = await (await fetch(`${base}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registered.client_id, code: callback.searchParams.get('code')!, redirect_uri: 'https://grok.example/callback', resource: `${ORIGIN}/mcp`, code_verifier: verifier }),
  })).json() as { access_token: string };
  const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', 'mcp-protocol-version': LEGACY_VERSION, accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(mcp.status, 200);
  const grant = await pool.query<{ principal_id: string }>('SELECT principal_id FROM oauth_grants');
  assert.deepEqual(grant.rows, [{ principal_id: grok }]);

  // Logout ends the server-side session.
  assert.equal((await jsonPost('/account/logout', {}, ownerCookie)).status, 200);
  assert.equal(await svc.session(ownerValue), null);
  assert.ok(!(await start(ownerCookie)).html.includes('identify_owner'));

  for (const secret of secrets) for (const line of logged) assert.ok(!line.includes(secret), 'secret appeared in console output');
});

// Exercises the same HTTP boundaries as the hosted signup, with real signed WebAuthn responses.
test('gateway invite, first consent and worker tokens stay inside the invited tenant', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, max: 1 });
  const schema = `gateway_test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, options: `-c search_path=${schema},public`, max: 8 });
  const server = createServer();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  for (const migration of ['001_identity.sql', '002_core.sql', '003_oauth.sql', '005_swarm.sql', '006_sessions.sql', '007_passkeys.sql', '008_lessons.sql', '009_oauth_client_cleanup.sql', '010_routing_policy.sql', '011_patch_routing.sql', '012_session_task.sql', '013_worker_slots.sql','016_worker_slots_drain.sql','019_inbox.sql','020_inbox_receipts.sql','021_flows.sql', '015_gateway_tenants.sql','018_events_xid.sql','023_failure_routing.sql','024_teams.sql','025_teams_swarms.sql']) {
    await pool.query(await readFile(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const logged: string[] = [], secrets: string[] = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  const capture = (...args: unknown[]): void => { logged.push(args.map(String).join(' ')); };
  console.log = capture; console.error = capture; console.warn = capture;
  t.after(() => { console.log = originals.log; console.error = originals.error; console.warn = originals.warn; });
  const { CoreService } = await import('../src/core/index.js');
  const { OAuthService } = await import('../src/oauth.js');
  const { ROLE_PERMISSIONS } = await import('../src/policy.js');
  const { INVITE_ONLY, escapeHtml } = await import('../src/passkey-ui.js');
  const { parseBridgeConfig } = await import('../src/bridge/config.js');
  const backend = new CoreService(pool), auth = new AuthService(pool);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const config: ServerConfig = {
    host: '127.0.0.1', port, publicUrl: ORIGIN, allowedOrigins: [], allowInsecureLocalhost: false, maxBodyBytes: 65536,
    oauthEnabled: true, oauthRedirectHosts: ['grok.example'], eventCallbackHosts: [], eventEncryptionKey: '',
    // Requests arrive like the Cloudflare Tunnel's: loopback socket, visitor address in cf-connecting-ip.
    trustProxy: true, trustedProxies: ['loopback'],
  };
  server.on('request', createHttpHandler({ pool, core: backend, auth, config }));
  const svc = new PasskeyService(pool, config), oauth = new OAuthService(pool, auth, config);
  const base = `http://127.0.0.1:${port}`, browser = randomBytes(32).toString('base64url');
  const binding = `swarmaa_pk=${browser}`;
  // Node fetch ignores Host; use the native client to model tunnel Host + visitor-IP headers.
  const fetchGateway = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string | URLSearchParams; redirect?: 'manual' } = {}) => new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: init.method, headers: init.headers }, res => {
      const chunks: Buffer[] = [], headers = new Headers();
      for (let n = 0; n < res.rawHeaders.length; n += 2) headers.append(res.rawHeaders[n]!, res.rawHeaders[n + 1]!);
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers })));
      res.on('error', reject);
    });
    req.setTimeout(30_000, () => req.destroy(new Error('Gateway test request timed out.')));
    req.on('error', reject); req.end(init.body?.toString());
  });
  let address = 1;
  const headers = () => ({ host: new URL(ORIGIN).host, 'cf-connecting-ip': `192.0.2.${address++}` });
  const post = (path: string, body: unknown, cookie = '', origin: string | null = ORIGIN, extra: Record<string, string> = {}) => fetchGateway(`${base}${path}`, {
    method: 'POST', headers: { ...headers(), 'content-type': 'application/json', ...(origin ? { origin } : {}), cookie, ...extra }, body: JSON.stringify(body),
  });
  const sessionFrom = (res: Response): string => {
    const token = /swarmaa_owner=([^;]+)/u.exec(res.headers.get('set-cookie') ?? '')?.[1];
    assert.ok(token, 'registration must set an owner cookie'); secrets.push(token); return token;
  };
  const options = async (code?: string, cookie = binding) => {
    const res = await post('/account/passkeys/register/options', code ? { code } : {}, cookie);
    if (res.status !== 200) assert.fail(`register/options returned ${res.status}: ${((await res.json()) as { error: { code: string } }).error.code}`);
    return ((await res.json()) as { options: { challenge: string; user: { id: string }; excludeCredentials: unknown[] } }).options;
  };
  const signup = async (code: string, device: SoftAuthenticator): Promise<string> => {
    const o = await options(code);
    const res = await post('/account/passkeys/register/verify', { code, response: device.register(o.challenge) }, binding);
    assert.equal(res.status, 200); return sessionFrom(res);
  };
  const personalDevice = new SoftAuthenticator();
  let device = new SoftAuthenticator();
  const personalCode = await svc.createInvite(); secrets.push(personalCode);
  const personalOwner = await signup(personalCode, personalDevice);
  const personal = `swarmaa_owner=${personalOwner}`;
  const invite = await svc.createGatewayInvite(), secondInvite = await svc.createGatewayInvite();
  secrets.push(invite.code, secondInvite.code);
  assert.match(invite.tenantId, /^t_[0-9a-f]{32}$/u);
  assert.notEqual(invite.tenantId, secondInvite.tenantId);
  const stored = await pool.query('SELECT tenant_id,code_hash FROM passkey_invites WHERE tenant_id=$1', [invite.tenantId]);
  assert.deepEqual(stored.rows, [{ tenant_id: invite.tenantId, code_hash: tokenHash(invite.code) }]);

  await t.test('admin gateway-invite returns a fresh tenant and private signup output; passkey-invite stays personal', async () => {
    await mkdir('.local', { recursive: true });
    const directory = await mkdtemp(resolve('.local/gateway-admin-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    for (const command of ['gateway-invite', 'passkey-invite']) {
      const file = `${directory}/${command}.json`;
      const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/admin.ts', command, '--minutes', '15', '--out', file], {
        timeout: 120_000, env: { PATH: process.env.PATH, DATABASE_URL: process.env.TEST_DATABASE_URL, PUBLIC_URL: ORIGIN, PGOPTIONS: `-c search_path=${schema},public` },
      });
      assert.equal(result.stdout, '');
      assert.equal((await stat(file)).mode & 0o077, 0);
      const output = JSON.parse(await readFile(file, 'utf8')) as { code?: string; tenant?: string; url: string; expires_in_minutes: number };
      const code = new URL(output.url).searchParams.get('code')!; secrets.push(code);
      assert.equal(output.expires_in_minutes, 15);
      assert.equal(new URL(output.url).origin, ORIGIN);
      assert.equal(new URL(output.url).pathname, '/account');
      assert.ok(!result.stderr.includes(code));
      const row = (await pool.query('SELECT tenant_id,expires_at>now() AS usable FROM passkey_invites WHERE code_hash=$1', [tokenHash(code)])).rows[0];
      assert.equal(row.usable, true);
      if (command === 'gateway-invite') {
        assert.equal(output.code, code); assert.equal(row.tenant_id, output.tenant);
        assert.match(output.tenant!, /^t_[0-9a-f]{32}$/u); assert.notEqual(output.tenant, invite.tenantId);
      } else {
        assert.equal(row.tenant_id, 'personal'); assert.equal(output.tenant, undefined);
      }
    }
  });

  let ownerToken = '';
  await t.test('registration requires an unexpired invite, binds its tenant, and spends it atomically', async () => {
    const refusal = await post('/account/passkeys/register/options', {}, binding);
    assert.equal(refusal.status, 403);
    assert.equal(((await refusal.json()) as { error: { message: string } }).error.message, INVITE_ONLY);
    assert.equal((await post('/account/passkeys/register/verify', { response: {} }, binding)).status, 403);
    const guest = await (await fetch(`${base}/account`)).text();
    assert.ok(guest.includes(escapeHtml(INVITE_ONLY)) && !guest.includes('data-pk="register"'));
    const expired = await svc.createGatewayInvite(); secrets.push(expired.code);
    await pool.query("UPDATE passkey_invites SET expires_at=now()-interval '1 second' WHERE code_hash=$1", [tokenHash(expired.code)]);
    assert.equal((await post('/account/passkeys/register/options', { code: expired.code }, binding)).status, 403);
    assert.equal(await svc.inviteUsable(expired.code), false);
    const staleCode = await svc.createGatewayInvite(); secrets.push(staleCode.code);
    const stale = await options(staleCode.code);
    await pool.query("UPDATE passkey_invites SET expires_at=now()-interval '1 second' WHERE code_hash=$1", [tokenHash(staleCode.code)]);
    assert.equal((await post('/account/passkeys/register/verify', { code: staleCode.code, response: new SoftAuthenticator().register(stale.challenge) }, binding)).status, 403);
    const o = await options(invite.code);
    assert.equal(o.excludeCredentials.length, 0, 'personal passkeys are not disclosed');
    const personalOptions = await options(undefined, `${binding}; ${personal}`);
    assert.notEqual(o.user.id, personalOptions.user.id, 'resident user handles differ by tenant');
    assert.equal((await post('/account/passkeys/register/verify', { code: secondInvite.code, response: device.register(o.challenge) }, binding)).status, 403, 'cannot swap tenants after challenge issuance');
    // Independent challenges race for one invite: only one credential/session may survive.
    const other = await options(invite.code), racingDevice = new SoftAuthenticator();
    const attempts = await Promise.all([
      post('/account/passkeys/register/verify', { code: invite.code, response: device.register(o.challenge) }, binding),
      post('/account/passkeys/register/verify', { code: invite.code, response: racingDevice.register(other.challenge) }, binding),
    ]);
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 403]);
    ownerToken = sessionFrom(attempts.find(r => r.status === 200)!);
    if (attempts[1]!.status === 200) device = racingDevice;
    assert.equal((await svc.session(ownerToken))?.tenantId, invite.tenantId);
    assert.equal((await pool.query('SELECT id FROM owner_passkeys WHERE tenant_id=$1', [invite.tenantId])).rows.length, 1);
    assert.equal((await pool.query('SELECT id FROM owner_sessions WHERE tenant_id=$1', [invite.tenantId])).rows.length, 1);
    assert.equal((await post('/account/passkeys/register/options', { code: invite.code }, binding)).status, 403);
    assert.equal(await svc.inviteUsable(invite.code), false);
  });

  let owner = `swarmaa_owner=${ownerToken}`;
  await t.test('credential lookup, owner sessions and passkey management resolve the invited tenant', async () => {
    const login = await post('/account/passkeys/login/options', {}, binding);
    const challenge = ((await login.json()) as { options: { challenge: string } }).options.challenge;
    assert.equal((await pool.query('SELECT tenant_id FROM webauthn_challenges WHERE challenge=$1', [challenge])).rows[0].tenant_id, null);
    const signedIn = await post('/account/passkeys/login/verify', { response: device.assert(challenge) }, binding);
    assert.equal(signedIn.status, 200);
    ownerToken = sessionFrom(signedIn); owner = `swarmaa_owner=${ownerToken}`;
    assert.equal((await svc.session(ownerToken))?.tenantId, invite.tenantId);
    assert.equal((await pool.query('SELECT tenant_id FROM webauthn_challenges WHERE challenge=$1', [challenge])).rows[0].tenant_id, invite.tenantId);
    const second = new SoftAuthenticator();
    const o = await options(secondInvite.code, `${binding}; ${owner}`);
    assert.equal(o.excludeCredentials.length, 1);
    const added = await post('/account/passkeys/register/verify', { code: secondInvite.code, response: second.register(o.challenge), name: '<Phone>' }, `${binding}; ${owner}`);
    assert.equal(added.status, 200);
    assert.equal((await svc.session(sessionFrom(added)))?.tenantId, invite.tenantId);
    assert.equal(await svc.inviteUsable(secondInvite.code), true, 'an owner session wins and does not consume another invite');
    const mine = await svc.list(ownerToken), theirs = await svc.list(personalOwner);
    assert.equal(mine.length, 2); assert.equal(theirs.length, 1);
    const page = await (await fetch(`${base}/account`, { headers: { cookie: owner } })).text();
    assert.ok(page.includes('&lt;Phone&gt;') && page.includes('Add a worker Mac') && !page.includes(theirs[0]!.id));
    await svc.remove(ownerToken, theirs[0]!.id);
    assert.equal((await svc.list(personalOwner)).length, 1, 'foreign passkey is untouched');
    await svc.remove(ownerToken, mine.find(p => p.name === '<Phone>')!.id);
    await assert.rejects(svc.remove(ownerToken, mine[0]!.id), { code: 'last_passkey' });
    const forged = randomBytes(32).toString('base64url');
    assert.equal(await svc.session(forged), null);
  });

  const registered = await oauth.registerClient({ client_name: 'New <App>', redirect_uris: ['https://grok.example/callback'] });
  const verifier = randomBytes(48).toString('base64url');
  const query = new URLSearchParams({ client_id: String(registered.client_id), response_type: 'code', redirect_uri: 'https://grok.example/callback', resource: `${ORIGIN}/mcp`, state: 'gateway-state', code_challenge_method: 'S256', code_challenge: pkceChallenge(verifier) });
  const authorizePath = `/oauth/authorize?${query}`;
  const start = async (cookie = '') => {
    const res = await fetchGateway(`${base}${authorizePath}`, { headers: { ...headers(), cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    return {
      html, jar: `${cookie}; collective_oauth_browser=${/collective_oauth_browser=([^;]+)/u.exec(res.headers.get('set-cookie') ?? '')![1]}`,
      form: { request_id: /name="request_id" value="([^"]+)"/u.exec(html)![1]!, csrf: /name="csrf" value="([^"]+)"/u.exec(html)![1]! },
    };
  };
  const consent = (cookie: string, fields: Record<string, string>, origin: string | null = ORIGIN) => fetchGateway(`${base}/oauth/authorize`, {
    method: 'POST', redirect: 'manual', headers: { ...headers(), cookie, 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) }, body: new URLSearchParams(fields),
  });
  let frontend: import('../src/types.js').Principal;
  await t.test('signup returns to consent, which creates exactly one frontend after explicit approval', async () => {
    const guest = await start();
    assert.ok(guest.html.includes(escapeHtml(INVITE_ONLY)) && guest.html.includes('Have an invite?'));
    for (const action of ['approve', 'create_first']) assert.ok((await consent(guest.jar, { ...guest.form, action })).status >= 400);
    const signupUrl = /href="(\/account\?[^"]+)"/u.exec(guest.html)![1]!.replaceAll('&amp;', '&');
    assert.equal(new URL(signupUrl, ORIGIN).searchParams.get('next'), authorizePath);
    const signupPage = await (await fetch(`${base}${signupUrl}&code=${secondInvite.code}`)).text();
    assert.ok(signupPage.includes(`data-next="${escapeHtml(authorizePath)}"`) && signupPage.includes('data-pk="register"'));
    const resume = await fetch(`${base}${signupUrl}`, { headers: { cookie: owner }, redirect: 'manual' });
    assert.equal(resume.status, 303); assert.equal(resume.headers.get('location'), authorizePath);
    const unsafe = await fetch(`${base}/account?next=${encodeURIComponent('//evil.example')}`, { headers: { cookie: owner }, redirect: 'manual' });
    assert.equal(unsafe.status, 200); assert.equal(unsafe.headers.get('location'), null);
    const pending = await start(owner), concurrent = await start(owner);
    assert.ok(pending.html.includes('Create identity and approve connection') && pending.html.includes('New &lt;App&gt;'));
    assert.ok(pending.html.includes('project:general'));
    for (const permission of ROLE_PERMISSIONS.frontend) assert.ok(pending.html.includes(permission));
    const body = { ...pending.form, action: 'create_first' };
    assert.equal((await consent(pending.jar, body, null)).status, 403);
    assert.equal((await consent(pending.jar, { ...body, csrf: 'bad' })).status, 403);
    assert.equal((await consent(owner, body)).status, 403);
    assert.equal((await consent(pending.jar.replace(owner, personal), body)).status, 403);
    assert.equal((await consent(pending.jar.replace(owner, ''), body)).status, 403);
    assert.equal((await pool.query('SELECT id FROM principals WHERE tenant_id=$1', [invite.tenantId])).rows.length, 0, 'no mutation before valid consent');
    const approvals = await Promise.all([consent(pending.jar, body), consent(concurrent.jar, { ...concurrent.form, action: 'create_first' })]);
    assert.deepEqual(approvals.map(r => r.status).sort(), [303, 409]);
    const approved = approvals.find(r => r.status === 303)!;
    const callback = new URL(approved.headers.get('location')!);
    assert.equal(callback.searchParams.get('state'), 'gateway-state');
    const issued = await oauth.exchangeToken(new URLSearchParams({ grant_type: 'authorization_code', client_id: String(registered.client_id), code: callback.searchParams.get('code')!, redirect_uri: 'https://grok.example/callback', resource: `${ORIGIN}/mcp`, code_verifier: verifier }));
    secrets.push(String(issued.access_token), String(issued.refresh_token));
    frontend = (await oauth.authenticate(String(issued.access_token)))!;
    assert.equal(frontend.tenantId, invite.tenantId);
    assert.equal(frontend.role, 'frontend');
    assert.deepEqual(frontend.scopes, ['project:general']);
    assert.deepEqual(frontend.permissions, ROLE_PERMISSIONS.frontend);
    assert.equal((await pool.query("SELECT id FROM principals WHERE tenant_id=$1 AND role='frontend'", [invite.tenantId])).rows.length, 1);
    assert.ok((await consent(pending.jar, body)).status >= 400, 'cannot replay creation');
    const existing = await start(owner);
    assert.ok(existing.html.includes('identify_owner') && !existing.html.includes('value="create_first"'));
    const identified = await consent(existing.jar, { ...existing.form, action: 'identify_owner', principal_id: frontend.id });
    assert.equal(identified.status, 200);
    const review = await identified.text();
    const approve = { request_id: existing.form.request_id, csrf: /name="csrf" value="([^"]+)"/u.exec(review)![1]!, action: 'approve' };
    assert.equal((await consent(existing.jar.replace(owner, personal), approve)).status, 403, 'owner cannot change between review and approval');
    assert.equal((await consent(existing.jar.replace(owner, ''), approve)).status, 403, 'review requires owner to remain signed in');
    assert.equal((await consent(existing.jar, approve)).status, 303);
    const emptyPersonal = await start(personal);
    assert.ok(!emptyPersonal.html.includes('value="create_first"') && emptyPersonal.html.includes('npm run admin -- create'));
  });

  let worker: import('../src/types.js').Principal, workerToken = '';
  await t.test('owner worker minting enforces origin, session, input, cookie and one-time output protections', async () => {
    const path = '/account/workers';
    assert.equal((await post(path, { name: 'worker-mac' })).status, 403);
    assert.equal((await post(path, { name: 'worker-mac' }, owner, null)).status, 403);
    assert.equal((await post(path, { name: 'worker-mac' }, owner, 'https://evil.example')).status, 403);
    assert.equal((await post(path, { name: 'worker-mac' }, owner, ORIGIN, { 'content-type': 'text/plain' })).status, 415);
    for (const body of [{ name: '<script>' }, { name: 'x'.repeat(101) }, { name: 'worker-mac', tenant: 'personal' }, { name: 'worker-mac', scopes: ['*'] }, { name: 'worker-mac', permissions: ['admin'] }]) {
      assert.equal((await post(path, body, owner)).status, 400);
    }
    const res = await post(path, { name: 'worker-mac' }, owner);
    assert.equal(res.status, 201); assert.equal(res.headers.get('cache-control'), 'no-store');
    const minted = await res.json() as { id: string; token: string; scopes: string[]; bridge: unknown };
    secrets.push(minted.token);
    workerToken = minted.token;
    assert.equal(parseBridgeConfig(minted.bridge).service_url, ORIGIN);
    worker = (await auth.authenticate(minted.token))!;
    assert.equal(worker.tenantId, invite.tenantId); assert.equal(worker.role, 'worker');
    assert.deepEqual(worker.scopes, frontend.scopes);
    assert.deepEqual(worker.permissions, ROLE_PERMISSIONS.worker);
    assert.equal((await pool.query('SELECT token_hash FROM principals WHERE id=$1', [minted.id])).rows[0].token_hash, tokenHash(minted.token));
    const reload = await (await fetch(`${base}/account`, { headers: { cookie: owner } })).text();
    assert.ok(!reload.includes(minted.token), 'no redisplay on reload');
    assert.equal((await post(path, { name: 'worker-mac' }, owner)).status, 409);
    const rateHeaders = { 'cf-connecting-ip': '198.51.100.1' };
    for (let n = 0; n < 5; n++) assert.equal((await post(path, { name: 'worker-mac' }, owner, ORIGIN, rateHeaders)).status, 409);
    assert.equal((await post(path, { name: 'worker-mac' }, owner, ORIGIN, rateHeaders)).status, 429);
  });

  await t.test('invited identities cannot list, read or claim personal tasks, memories, sessions or identities', async () => {
    const id = randomUUID();
    await pool.query("INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,'personal','private-personal','frontend',$2,$3,$4)", [id, ['project:general', 'project:private'], ROLE_PERMISSIONS.frontend, tokenHash(randomUUID())]);
    const personalFront = (await auth.getPrincipal(id))!;
    const call = (p: import('../src/types.js').Principal, name: string, args: Record<string, unknown>) => backend.call(p, name, args) as Promise<Record<string, any>>;
    const submission = { scope: 'project:general', kind: 'research', objective: 'Read the project.', constraints: ['Read only.'], acceptance_criteria: ['Return a summary.'], required_capability: 'codex.read', idempotency_key: 'same-task-key' };
    const personalTask = (await call(personalFront, 'task_submit', submission)).task;
    const memory = (await call(personalFront, 'memory_propose', { scope: 'project:general', kind: 'note', key: 'same-memory-key', content: 'Private personal memory', source: { type: 'agent', reference: 'test://gateway' } })).memory;
    const session = (await call(personalFront, 'session_record', { harness: 'codex', session_id: 'same-session-key', scope: 'project:general', turns: [{ role: 'user', text: 'Private personal conversation' }] })).session;
    for (const p of [frontend, worker]) {
      for (const [name, args] of [['task_get', { task_id: personalTask.id }], ['memory_get', { memory_id: memory.id }], ['session_get', { id: session.id }]] as const) await assert.rejects(call(p, name, args), { code: 'not_found' });
      assert.deepEqual((await call(p, 'task_list', { scope: 'project:general' })).tasks, []);
      assert.deepEqual((await call(p, 'memory_search', { scope: 'project:general' })).memories, []);
      assert.deepEqual((await call(p, 'session_list', {})).sessions, []);
    }
    const claimArgs = { scope: 'project:general', capabilities: ['codex.read'], lease_seconds: 30 };
    const claim = async () => {
      const res = await post('/api/tools/task_claim', claimArgs, '', ORIGIN, { authorization: `Bearer ${workerToken}` });
      assert.equal(res.status, 200);
      return ((await res.json()) as { result: { task: { id: string } | null } }).result;
    };
    assert.equal((await claim()).task, null, 'never claims a personal task, even with matching capability and scope');
    const mine = (await call(frontend, 'task_submit', submission)).task;
    assert.notEqual(mine.id, personalTask.id);
    assert.equal((await claim()).task?.id, mine.id);
    assert.equal((await call(personalFront, 'task_get', { task_id: personalTask.id })).task.status, 'queued');
    await assert.rejects(call(personalFront, 'task_get', { task_id: mine.id }), { code: 'not_found' });
    const selection = await start(owner);
    assert.ok(!selection.html.includes(id) && !selection.html.includes('private-personal'));
    assert.equal((await consent(selection.jar, { ...selection.form, action: 'identify_owner', principal_id: id })).status, 403);
    const ownSelection = await start(personal);
    assert.ok(ownSelection.html.includes(id) && !ownSelection.html.includes(frontend.id));
    assert.equal((await pool.query('SELECT tenant_id FROM principals WHERE id=$1', [worker.id])).rows[0].tenant_id, invite.tenantId);
    const personalWorker = await svc.createWorker(personalOwner, 'worker-mac'); secrets.push(personalWorker.token);
    assert.deepEqual(personalWorker.scopes, ['project:general', 'project:private']);
    assert.equal((await auth.authenticate(personalWorker.token))?.tenantId, 'personal');
  });
  await t.test('owner worker minting accepts 512 scopes and rejects a 513-scope union', async () => {
    const scopes = Array.from({length:512}, (_, i) => `project:wide${i}`);
    const extra = randomUUID();
    await pool.query('UPDATE principals SET scopes=$2 WHERE id=$1', [frontend.id, scopes]);
    try {
      const wide = await svc.createWorker(ownerToken, 'wide-worker'); secrets.push(wide.token);
      assert.equal(wide.scopes.length, 512);
      assert.deepEqual(new Set(wide.scopes), new Set(scopes));
      await pool.query("INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,'extra-front','frontend',$3,$4,$5)",
        [extra, frontend.tenantId, ['project:overflow'], ROLE_PERMISSIONS.frontend, tokenHash(randomUUID())]);
      await assert.rejects(svc.createWorker(ownerToken, 'overflow-worker'), {code:'too_many_scopes'});
      assert.equal((await pool.query("SELECT id FROM principals WHERE tenant_id=$1 AND name='overflow-worker'", [frontend.tenantId])).rowCount, 0);
    } finally {
      await pool.query('UPDATE principals SET scopes=$2 WHERE id=$1', [frontend.id, frontend.scopes]);
      await pool.query('DELETE FROM principals WHERE id=$1', [extra]);
    }
  });
  for (const secret of secrets) for (const line of logged) assert.ok(!line.includes(secret), 'secret appeared in console output');
});
