import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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
  for (const migration of ['001_identity.sql', '003_oauth.sql', '007_passkeys.sql', '009_oauth_client_cleanup.sql']) {
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
