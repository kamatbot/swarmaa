import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { test, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import { AppError } from '../src/errors.js';
import { createHttpHandler } from '../src/http.js';
import { decodeMcpHeader, handleMcp, LEGACY_VERSION, MODERN_VERSION } from '../src/mcp.js';
import type { HttpDependencies, Principal, ServerConfig, ToolBackend } from '../src/types.js';

const principal: Principal = {
  id: 'ee17ef58-b999-4d7d-b5d6-6f7ad988514f', tenantId: 'test', name: 'claude',
  role: 'frontend', scopes: ['project:demo'], permissions: ['memory:read', 'task:submit'],
};
const definition = { name: 'context_get', description: 'Get context.', inputSchema: { type: 'object', properties: {} } };
const core: ToolBackend = { listTools: () => [definition], call: async () => ({ context: 'test context' }) };
const modernParams = {
  _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} },
};

test('legacy initialize and modern discover use their own response framing', async () => {
  const legacy = await handleMcp(principal, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  }, {}, { core });
  assert.equal(legacy.status, 200);
  const legacyResult = legacy.body?.result as Record<string, unknown>;
  assert.equal(legacyResult.protocolVersion, LEGACY_VERSION);
  assert.equal(legacyResult.resultType, undefined);

  const modern = await handleMcp(principal, { jsonrpc: '2.0', id: 2, method: 'server/discover', params: modernParams },
    { protocolVersion: MODERN_VERSION, method: 'server/discover' }, { core, events: { handle: async () => ({ events: [] }) } });
  assert.equal(modern.status, 200);
  const modernResult = modern.body?.result as Record<string, unknown>;
  assert.equal(modernResult.resultType, 'complete');
  assert.deepEqual(modernResult.capabilities, { tools: {}, events: {} });
  assert.ok((modernResult.supportedVersions as string[]).includes(MODERN_VERSION));
});

test('modern header mismatches and malformed capabilities never dispatch a tool', async () => {
  let calls = 0;
  const countingCore: ToolBackend = { listTools: () => [definition], call: async () => { calls++; return {}; } };
  const request = { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { ...modernParams, name: 'context_get', arguments: {} } };
  for (const headers of [
    { protocolVersion: MODERN_VERSION, method: 'tools/list', name: 'context_get' },
    { protocolVersion: MODERN_VERSION, method: 'tools/call', name: 'memory_promote' },
    { protocolVersion: MODERN_VERSION, method: 'tools/call' },
  ]) {
    const reply = await handleMcp(principal, request, headers, { core: countingCore });
    assert.equal(reply.status, 400);
    assert.equal((reply.body?.error as { code: number }).code, -32020);
  }
  const missing = await handleMcp(principal, { ...request, params: { name: 'context_get' } },
    { protocolVersion: MODERN_VERSION, method: 'tools/call', name: 'context_get' }, { core: countingCore });
  assert.equal((missing.body?.error as { code: number }).code, -32602);
  assert.equal(calls, 0);
});

test('notifications cannot invoke mutations, and batches/null ids are rejected', async () => {
  let calls = 0;
  const countingCore: ToolBackend = { listTools: () => [definition], call: async () => { calls++; return {}; } };
  const notification = await handleMcp(principal, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'context_get' } },
    { protocolVersion: LEGACY_VERSION }, { core: countingCore });
  assert.equal(notification.status, 400);
  assert.equal(notification.body, undefined);
  for (const payload of [[], { jsonrpc: '2.0', id: null, method: 'ping' }]) {
    const reply = await handleMcp(principal, payload, { protocolVersion: LEGACY_VERSION }, { core: countingCore });
    assert.equal(reply.status, 400);
  }
  assert.equal(calls, 0);
});

test('tool application failures are repairable results and internal errors are redacted', async () => {
  for (const error of [new AppError(409, 'conflict', 'Expected revision changed.'), new Error('DATABASE_PASSWORD=do-not-return')]) {
    const reply = await handleMcp(principal, {
      jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'context_get', arguments: {} },
    }, { protocolVersion: LEGACY_VERSION }, { core: { ...core, call: async () => { throw error; } } });
    assert.equal(reply.status, 200);
    assert.equal((reply.body?.result as { isError: boolean }).isError, true);
    assert.ok(!JSON.stringify(reply).includes('DATABASE_PASSWORD'));
  }
});

test('modern event results and unknown methods use MCP2 framing/status', async () => {
  const events = await handleMcp(principal, { jsonrpc: '2.0', id: 1, method: 'events/list', params: modernParams },
    { protocolVersion: MODERN_VERSION, method: 'events/list' }, { core, events: { handle: async () => ({ events: [] }) } });
  assert.equal((events.body?.result as Record<string, unknown>).resultType, 'complete');
  const missing = await handleMcp(principal, { jsonrpc: '2.0', id: 2, method: 'not/a/method', params: modernParams },
    { protocolVersion: MODERN_VERSION, method: 'not/a/method' }, { core });
  assert.equal(missing.status, 404);
  assert.equal((missing.body?.error as { code: number }).code, -32601);
});

test('Mcp-Name base64 decoding is canonical and rejects invalid UTF-8', () => {
  const value = 'Hello, 世界';
  assert.equal(decodeMcpHeader(`=?base64?${Buffer.from(value).toString('base64')}?=`), value);
  assert.equal(decodeMcpHeader('=?base64?__notbase64?='), null);
  assert.equal(decodeMcpHeader('=?base64?/w==?='), null);
  assert.equal(decodeMcpHeader(' padded '), null);
});

async function listeningServer(t: TestContext, maxBodyBytes = 4096, toolBackend: ToolBackend = core, publicUrl?: string, overrides: Partial<ServerConfig> = {}): Promise<{ url: string; server: Server; recordedIpHashes: string[] }> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const config: ServerConfig = {
    host: '127.0.0.1', port: address.port, publicUrl: publicUrl ?? url, allowedOrigins: [], allowInsecureLocalhost: true,
    maxBodyBytes, oauthEnabled: false, oauthRedirectHosts: [], eventCallbackHosts: [], eventEncryptionKey: '',
    ...overrides,
  };
  const recordedIpHashes: string[] = [];
  const dependencies: HttpDependencies = {
    config, core: toolBackend,
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO oauth_clients')) {
          recordedIpHashes.push(String(params?.[3] ?? ''));
        }
        return { rows: [{ count: '0' }] };
      },
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          if (typeof sql === 'string' && sql.includes('INSERT INTO oauth_clients')) {
            recordedIpHashes.push(String(params?.[3] ?? ''));
          }
          return { rows: [{ count: '0' }] };
        },
        release: () => undefined,
      }),
    } as unknown as Pool,
    auth: { authenticate: async token => token === 'test-connection-token' ? principal : null, getPrincipal: async () => principal },
  };
  server.on('request', createHttpHandler(dependencies));
  return { url, server, recordedIpHashes };
}

const rpcHeaders = { authorization: 'Bearer test-connection-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': LEGACY_VERSION };

test('HTTP rejects hostile origins, absent auth, and unsupported GET streams', async t => {
  const { url } = await listeningServer(t);
  // Cookie pages refuse foreign origins; bearer routes accept them but never allow credentials cross-origin.
  const hostile = await fetch(`${url}/account`, { headers: { origin: 'https://attacker.example' } });
  assert.equal(hostile.status, 403);
  const crossOrigin = await fetch(`${url}/api/tools/context_get`, {
    method: 'POST', headers: { ...rpcHeaders, origin: 'https://client.example' }, body: '{}',
  });
  assert.equal(crossOrigin.status, 200);
  assert.equal(crossOrigin.headers.get('access-control-allow-credentials'), null);
  const crossNoAuth = await fetch(`${url}/api/tools/context_get`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://client.example' }, body: '{}',
  });
  assert.equal(crossNoAuth.status, 401);
  const unauthenticated = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauthenticated.status, 401);
  assert.ok(unauthenticated.headers.has('www-authenticate'));
  const stream = await fetch(`${url}/mcp`);
  assert.equal(stream.status, 405);
  assert.equal(stream.headers.get('allow'), 'POST');
});

test('tunnel PUBLIC_URL keeps loopback clients working and still rejects foreign hosts', async t => {
  const { url } = await listeningServer(t, 4096, core, 'https://swarma.example.com');
  const local = await fetch(`${url}/api/tools/context_get`, { method: 'POST', headers: rpcHeaders, body: '{}' });
  assert.equal(local.status, 200);
  const port = new URL(url).port;
  const foreign = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/tools/context_get', method: 'POST', headers: { ...rpcHeaders, host: 'rebind.attacker.example' } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(foreign, 403);
});

test('HTTP bounds bodies, reports JSON parse errors, and returns legacy RPC results', async t => {
  const { url } = await listeningServer(t, 256);
  const oversized = await fetch(`${url}/mcp`, { method: 'POST', headers: rpcHeaders, body: JSON.stringify({ text: 'a'.repeat(400) }) });
  assert.equal(oversized.status, 413);
  const malformed = await fetch(`${url}/mcp`, { method: 'POST', headers: rpcHeaders, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as { error: { code: number } }).error.code, -32700);
  const ok = await fetch(`${url}/mcp`, {
    method: 'POST', headers: rpcHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.has('x-request-id'));
  assert.equal((await ok.json() as { id: number }).id, 7);
});

test('OAuth-shaped access tokens cannot authenticate REST tool routes', async t => {
  const { url } = await listeningServer(t);
  const rejected = await fetch(`${url}/api/tools/context_get`, {
    method: 'POST', headers: { ...rpcHeaders, authorization: `Bearer cn_access_${'a'.repeat(43)}` }, body: '{}',
  });
  assert.equal(rejected.status, 401);
  const accepted = await fetch(`${url}/api/tools/context_get`, { method: 'POST', headers: rpcHeaders, body: '{}' });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { result: { context: 'test context' } });
});

test('oversized serialized results produce bounded repairable errors before headers commit', async t => {
  const hugeCore: ToolBackend = { ...core, call: async () => ({ text: 'x'.repeat(6 * 1024 * 1024) }) };
  const { url } = await listeningServer(t, 4096, hugeCore);
  for (const [path, body] of [
    ['/api/tools/context_get', '{}'],
    ['/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'context_get', arguments: {} } })],
  ]) {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: rpcHeaders, body });
    assert.equal(response.status, 413);
    const text = await response.text();
    assert.ok(Buffer.byteLength(text) < 1024);
    const error = (JSON.parse(text) as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'response_too_large');
    assert.match(error.message, /history_limit/u);
  }
});

test('forwarded-IP headers are ignored from non-trusted sources and honored only from configured trusted proxies', async t => {
  const registerRequest = (port: string, hostHeader: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({ client_name: 'c', redirect_uris: ['https://claude.ai/cb'] });
      const req = request({
        host: '127.0.0.1', port, path: '/oauth/register', method: 'POST',
        headers: { host: hostHeader, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers },
      }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end(body);
    });

  // 1. Default (trustProxy disabled): spoofed CF-Connecting-IP / X-Forwarded-For cannot bypass rate limiting or rotate IP hashes.
  const untrusted = await listeningServer(t, 4096, core, 'https://swarma.example.com', { oauthEnabled: true, oauthRedirectHosts: ['claude.ai'] });
  const untrustedPort = new URL(untrusted.url).port;
  for (let i = 0; i < 30; i++) {
    const status = await registerRequest(untrustedPort, 'swarma.example.com', { 'cf-connecting-ip': `198.51.100.${i + 1}` });
    assert.equal(status, 201);
  }
  // 31st request with a fresh spoofed CF-Connecting-IP is still rate-limited because all shared socket IP 127.0.0.1.
  const limited = await registerRequest(untrustedPort, 'swarma.example.com', { 'cf-connecting-ip': '198.51.100.250' });
  assert.equal(limited, 429);
  assert.equal(new Set(untrusted.recordedIpHashes).size, 1, 'spoofed headers must not vary client IP hash when proxy is untrusted');

  // 2. Trusted proxy configured to a different proxy IP (10.0.0.9): loopback socket is not in trustedProxies, so headers are ignored.
  const wrongProxy = await listeningServer(t, 4096, core, 'https://swarma.example.com', {
    oauthEnabled: true, oauthRedirectHosts: ['claude.ai'], trustProxy: true, trustedProxies: ['10.0.0.9'],
  });
  const wrongProxyPort = new URL(wrongProxy.url).port;
  await registerRequest(wrongProxyPort, 'swarma.example.com', { 'cf-connecting-ip': '198.51.100.10' });
  await registerRequest(wrongProxyPort, 'swarma.example.com', { 'cf-connecting-ip': '198.51.100.11' });
  assert.equal(new Set(wrongProxy.recordedIpHashes).size, 1, 'socket not in trustedProxies must ignore forwarded IP');

  // 3. Trusted loopback proxy (Cloudflare tunnel mode): public Host honors distinct public forwarded IPs,
  // but direct loopback Host or spoofed loopback CF-Connecting-IP is ignored.
  const trusted = await listeningServer(t, 4096, core, 'https://swarma.example.com', {
    oauthEnabled: true, oauthRedirectHosts: ['claude.ai'], trustProxy: true,
  });
  const trustedPort = new URL(trusted.url).port;
  for (let i = 0; i < 35; i++) {
    const status = await registerRequest(trustedPort, 'swarma.example.com', { 'cf-connecting-ip': `203.0.113.${(i % 50) + 1}` });
    assert.equal(status, 201);
  }
  assert.equal(new Set(trusted.recordedIpHashes).size, 35, 'trusted proxy requests use visitor CF-Connecting-IP');

  // Direct local loopback Host (127.0.0.1:port) ignores spoofed CF-Connecting-IP even when trustProxy is true.
  const beforeDirect = trusted.recordedIpHashes.length;
  await registerRequest(trustedPort, `127.0.0.1:${trustedPort}`, { 'cf-connecting-ip': '198.51.100.99' });
  await registerRequest(trustedPort, `127.0.0.1:${trustedPort}`, { 'cf-connecting-ip': '198.51.100.100' });
  assert.equal(trusted.recordedIpHashes[beforeDirect], trusted.recordedIpHashes[beforeDirect + 1]);
});
