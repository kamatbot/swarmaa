import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import { createHttpHandler } from '../src/http.js';
import { authorizationHtml, defaultIdentity, type AuthorizationForm } from '../src/oauth.js';
import { accountHtml } from '../src/passkey-ui.js';
import { bindCookie, newBinding, ownerCookie, registrableDomain, rpConfig } from '../src/passkeys.js';
import type { HttpDependencies, ServerConfig, ToolBackend } from '../src/types.js';

test('rpID is the registrable domain of PUBLIC_URL, only on HTTPS, with an optional override', () => {
  assert.equal(registrableDomain('api.swarmaa.com'), 'swarmaa.com');
  assert.equal(registrableDomain('swarmaa.com'), 'swarmaa.com');
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('127.0.0.1'), null);
  assert.equal(registrableDomain('localhost'), null);
  assert.deepEqual(rpConfig('https://api.swarmaa.com'), { rpID: 'swarmaa.com', origins: ['https://api.swarmaa.com', 'https://swarmaa.com'] });
  assert.deepEqual(rpConfig('https://swarmaa.com')?.origins, ['https://swarmaa.com']);
  assert.equal(rpConfig('http://127.0.0.1:8787'), null);
  assert.equal(rpConfig('https://api.swarmaa.com', 'other.com'), null, 'the host must be the rpID or a subdomain of it');
  assert.equal(rpConfig('https://api.swarmaa.com', 'com'), null);
  assert.equal(rpConfig('https://a.b.swarmaa.com', 'b.swarmaa.com')?.rpID, 'b.swarmaa.com');
});

test('owner cookie is HttpOnly, SameSite=Lax, Path=/ and Secure on https; binding cookie is scoped to /account', () => {
  const secure = ownerCookie('t'.repeat(43), true);
  for (const part of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Secure', 'Max-Age=43200']) assert.ok(secure.includes(part), part);
  assert.ok(!ownerCookie('t'.repeat(43), false).includes('Secure'));
  assert.ok(ownerCookie(null, true).includes('Max-Age=0'));
  assert.ok(bindCookie('b'.repeat(43), true).includes('Path=/account'));
  assert.equal(newBinding('b'.repeat(43)), 'b'.repeat(43));
  assert.match(newBinding('bad value'), /^[A-Za-z0-9_-]{43}$/u);
});

test('default connection identity: client name match, else routing-capable, else broadest', () => {
  const ids = [{ id: '1', name: 'dot' }, { id: '2', name: 'grok' }, { id: '3', name: 'grok-pro' }];
  assert.equal(defaultIdentity('Grok Bot', ids), '2');
  assert.equal(defaultIdentity('GROK-PRO app', ids), '3');
  assert.equal(defaultIdentity('Something else', ids), '1');
  assert.equal(defaultIdentity('x', []), '');
  const owned = [{ id: 'a', name: 'antigravity-interactive', scopes: ['p:1', 'p:2'] }, { id: 'm', name: 'macbook', scopes: ['p:1', 'p:2'], permissions: ['routing:manage'] }, { id: 'o', name: 'other', scopes: ['p:other'] }, { id: 'g', name: 'grok', scopes: ['p:1', 'p:2', 'p:3'] }];
  assert.equal(defaultIdentity('Swarmaa for Mac', owned), 'm');
  assert.equal(defaultIdentity('Swarmaa for Mac', owned.filter(i => i.id !== 'm')), 'g');
});

const base: AuthorizationForm = { kind: 'form', requestId: '11111111-1111-4111-8111-111111111111', csrf: 'csrf', browserCookie: 'b', clientName: 'Grok <b>', redirectUri: 'https://grok.example/cb' };

test('consent page: signed-in owner picks an identity; signed-out gets passkey with token fallback', () => {
  const owner = authorizationHtml({ ...base, owner: { identities: [{ id: 'a', name: 'dot' }, { id: 'b', name: '<grok>' }], defaultId: 'b' } });
  assert.match(owner, /<option value="b" selected>&lt;grok&gt;<\/option>/u);
  assert.match(owner, /value="identify_owner"/u);
  assert.ok(!owner.includes('connection_token'), 'a signed-in owner never sees the token field');
  assert.ok(owner.includes('Grok &lt;b&gt;'));
  const ready = authorizationHtml({ ...base, passkey: 'ready', nonce: 'N0nce' });
  assert.ok(ready.includes('Sign in with passkey') && ready.includes('Use a connection token instead'));
  assert.match(ready, /<script nonce="N0nce">/u);
  assert.ok(!/<script src|https?:\/\/cdn/u.test(ready));
  assert.ok(authorizationHtml({ ...base, passkey: 'none' }).includes('npm run setup'));
  const fallback = authorizationHtml({ ...base, passkey: 'unavailable' });
  assert.ok(fallback.includes('connection_token') && !fallback.includes('Sign in with passkey'));
});

test('account page states', () => {
  assert.ok(accountHtml({ kind: 'unavailable' }, 'n').includes('public HTTPS address'));
  assert.ok(accountHtml({ kind: 'guest', hasPasskeys: false, codeInvalid: false }, 'n').includes('signup link'));
  const created = accountHtml({ kind: 'guest', hasPasskeys: true, code: 'c'.repeat(43), codeInvalid: false }, 'n');
  assert.ok(created.includes('Create your Swarmaa passkey') && created.includes('Sign in with passkey'));
  assert.ok(accountHtml({ kind: 'guest', hasPasskeys: true, codeInvalid: true }, 'n').includes('expired or was already used'));
  const one = { id: 'x', name: 'Mac', createdAt: new Date(0), lastUsedAt: null };
  const single = accountHtml({ kind: 'owner', passkeys: [one] }, 'n');
  assert.ok(!single.includes('data-pk="remove"'), 'the last passkey has no Remove button');
  const two = accountHtml({ kind: 'owner', passkeys: [one, { ...one, id: 'y' }] }, 'n');
  assert.ok(two.includes('data-pk="remove"') && two.includes('Add another passkey') && two.includes('Sign out'));
});

const core: ToolBackend = { listTools: () => [], call: async () => ({}) };
async function serve(t: TestContext, publicUrl: string, insecure: boolean): Promise<string> {
  const server: Server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const config: ServerConfig = {
    host: '127.0.0.1', port, publicUrl, allowedOrigins: ['https://swarmaa.com'], // CORS-allowed, but not the service origin
    allowInsecureLocalhost: insecure, maxBodyBytes: 4096,
    oauthEnabled: false, oauthRedirectHosts: [], eventCallbackHosts: [], eventEncryptionKey: '',
  };
  const dependencies: HttpDependencies = { config, core, pool: { query: async () => ({ rows: [] }) } as unknown as Pool, auth: { authenticate: async () => null, getPrincipal: async () => null } };
  server.on('request', createHttpHandler(dependencies));
  return `http://127.0.0.1:${port}`;
}

test('passkey POSTs require the exact PUBLIC_URL origin and a JSON body', async t => {
  const url = await serve(t, 'https://api.swarmaa.com', false);
  const post = (headers: Record<string, string>) => fetch(`${url}/account/passkeys/login/options`, { method: 'POST', headers, body: '{}' });
  assert.equal((await post({ 'content-type': 'application/json' })).status, 403, 'no Origin');
  assert.equal((await post({ 'content-type': 'application/json', origin: 'https://attacker.example' })).status, 403);
  assert.equal((await post({ 'content-type': 'application/json', origin: 'https://swarmaa.com' })).status, 403, 'a CORS-allowed origin that is not PUBLIC_URL is still refused');
  assert.equal((await post({ 'content-type': 'text/plain', origin: 'https://api.swarmaa.com' })).status, 415);
  assert.equal((await fetch(`${url}/account/logout`, { method: 'GET' })).status, 405);
  const page = await fetch(`${url}/account`);
  assert.equal(page.status, 200);
  const nonce = /nonce-([A-Za-z0-9_-]+)/u.exec(page.headers.get('content-security-policy') ?? '')?.[1];
  assert.ok(nonce);
  assert.ok((await page.text()).includes(`<script nonce="${nonce}">`));
});

test('over plain HTTP loopback passkey routes answer 409', async t => {
  const local = await serve(t, 'http://127.0.0.1:8787', true);
  const post = await fetch(`${local}/account/passkeys/register/options`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8787' }, body: '{}' });
  assert.equal(post.status, 409);
  assert.match(JSON.stringify(await post.json()), /Passkeys need the public HTTPS address/u);
  const page = await fetch(`${local}/account`);
  assert.equal(page.status, 409);
  assert.ok((await page.text()).includes('public HTTPS address'));
});
