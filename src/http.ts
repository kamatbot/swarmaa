import { eventWakeup } from './event-wakeup.js';
import { isIP } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import ipaddr from 'ipaddr.js';
import { AppError, publicError, requireCondition } from './errors.js';
import { waitForInbox } from './inbox-wait.js';
import { handleMcp } from './mcp.js';
import { OAuthError, OAuthService, OAUTH_COOKIE, authorizationHtml, type AuthorizationForm } from './oauth.js';
import { accountHtml, type AccountView } from './passkey-ui.js';
import { BIND_COOKIE, OWNER_COOKIE, PasskeyService, bindCookie, newBinding, ownerCookie } from './passkeys.js';
import { canAccessScope, hasPermission, requirePermission } from './policy.js';
import type { HttpDependencies, Principal } from './types.js';

const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;

function oneHeader(request: IncomingMessage, name: string): string | undefined {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i]?.toLowerCase() === name) count++;
  if (count > 1) throw new AppError(400, 'duplicate_header', `Duplicate ${name} header.`);
  const value = request.headers[name];
  if (Array.isArray(value)) throw new AppError(400, 'duplicate_header', `Duplicate ${name} header.`);
  return value;
}

function json(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) { response.statusCode = status; response.end(); return; }
  const serialized = JSON.stringify(body);
  if (serialized === undefined) throw new AppError(500, 'invalid_response', 'The service could not serialize its response.');
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new AppError(413, 'response_too_large', 'Response exceeds 6 MiB. Reduce list, history_limit, or proposal_limit values and retry.');
  }
  // Serialize and enforce the wire limit before committing status/headers. The
  // caller can still replace an oversized result with a small repairable error.
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(serialized);
}

function onlyMethod(request: IncomingMessage, response: ServerResponse, allowed: string[]): void {
  if (!allowed.includes(request.method ?? '')) {
    response.setHeader('Allow', allowed.join(', '));
    throw new AppError(405, 'method_not_allowed', 'Method not allowed.');
  }
}

function requireType(request: IncomingMessage, type: string): void {
  const received = oneHeader(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (received !== type) throw new AppError(415, 'unsupported_media_type', `Content-Type must be ${type}.`);
  if (request.headers['content-encoding']) throw new AppError(415, 'unsupported_media_type', 'Compressed request bodies are not supported.');
}

async function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  const length = oneHeader(request, 'content-length');
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
    throw new AppError(413, 'body_too_large', 'Request body exceeds the configured limit.');
  }
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => finish(new AppError(408, 'request_timeout', 'Request body timed out.')), 15_000);
    timer.unref();
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      // Keep the once-error listener until close: Node can emit ECONNRESET just
      // after 'aborted', and an unhandled request error must not crash the server.
      request.removeListener('aborted', onAborted);
      if (error) { request.pause(); reject(error); return; }
      try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { reject(new AppError(400, 'invalid_encoding', 'Request body must be UTF-8.')); }
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maximum) { finish(new AppError(413, 'body_too_large', 'Request body exceeds the configured limit.')); return; }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish();
    const onError = (): void => finish(new AppError(400, 'request_failed', 'Request body could not be read.'));
    const onAborted = (): void => finish(new AppError(400, 'request_aborted', 'Request was aborted.'));
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { throw new AppError(400, 'invalid_json', 'Request body is not valid JSON.'); }
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const header = oneHeader(request, 'cookie');
  if (!header) return undefined;
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  return values[0]?.slice(name.length + 1);
}

class RateLimiter {
  private readonly windows = new Map<string, { until: number; count: number }>();

  accept(key: string, maximum: number): void {
    const now = Date.now();
    const entry = this.windows.get(key);
    if (entry && entry.until > now) {
      entry.count++;
      if (entry.count > maximum) throw new AppError(429, 'rate_limited', 'Too many requests. Retry after one minute.');
      return;
    }
    if (this.windows.size >= 10_000) {
      for (const [candidate, value] of this.windows) if (value.until <= now) this.windows.delete(candidate);
      if (this.windows.size >= 10_000) throw new AppError(429, 'rate_limited', 'Service request capacity reached. Retry after one minute.');
    }
    this.windows.set(key, { until: now + 60_000, count: 1 });
  }
}

/** Inline passkey script and styles run only with this per-response nonce; fetch is same-origin only. */
function pageCsp(nonce: string, formAction: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action ${formAction}`;
}

function authorizationPage(response: ServerResponse, form: AuthorizationForm, secure: boolean, passkey?: AuthorizationForm['passkey']): void {
  const nonce = randomBytes(16).toString('base64url');
  response.setHeader('Set-Cookie', `${OAUTH_COOKIE}=${form.browserCookie}; Path=/oauth/authorize; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`);
  // Some browsers also apply form-action to a POST's 303 redirect. The exact
  // registered callback is already validated; allow its origin for that return.
  response.setHeader('Content-Security-Policy', pageCsp(nonce, `'self' ${new URL(form.redirectUri).origin}`));
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.statusCode = 200;
  response.end(authorizationHtml({ ...form, passkey: form.principal || form.owner ? undefined : passkey, nonce }));
}

function normalizeIp(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || !isIP(trimmed)) return null;
  try { return ipaddr.process(trimmed).toString(); } catch { return null; }
}

function isLoopbackIp(ip: string | null): boolean {
  if (!ip) return false;
  try { return ipaddr.process(ip).range() === 'loopback'; } catch { return false; }
}

function isForwardableClientIp(ip: string | null): ip is string {
  if (!ip) return false;
  try {
    const range = ipaddr.process(ip).range();
    return range !== 'loopback' && range !== 'unspecified';
  } catch { return false; }
}

/** Node's HTTP server is deliberately the only HTTP framework dependency. */
export function createHttpHandler(dependencies: HttpDependencies): (request: IncomingMessage, response: ServerResponse) => void {
  const { config } = dependencies;
  const publicUrl = new URL(config.publicUrl);
  const localNames = ['localhost', '127.0.0.1', '[::1]'];
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password ||
      (publicUrl.protocol !== 'https:' && !(config.allowInsecureLocalhost && publicUrl.protocol === 'http:' && localNames.includes(publicUrl.hostname)))) {
    throw new Error('PUBLIC_URL must be an HTTPS origin, or explicitly enabled HTTP loopback origin.');
  }
  const allowedOrigins = new Set([publicUrl.origin, ...config.allowedOrigins]);
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol)) throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins.');
  }
  const trustedProxyIps = new Set<string>();
  const proxyEntries = config.trustedProxies?.length ? config.trustedProxies : (config.trustProxy ? ['loopback'] : []);
  for (const entry of proxyEntries) {
    if (entry.toLowerCase() === 'loopback') {
      trustedProxyIps.add('127.0.0.1');
      trustedProxyIps.add('::1');
    } else {
      const normalized = normalizeIp(entry);
      if (normalized) trustedProxyIps.add(normalized);
    }
  }
  const proxyEnabled = Boolean(config.trustProxy || trustedProxyIps.size > 0);
  const oauth = config.oauthEnabled ? new OAuthService(dependencies.pool, dependencies.auth, config) : undefined;
  const passkeys = new PasskeyService(dependencies.pool, config);
  const limiter = new RateLimiter();
  let inFlight = 0;
  let inboxWaiters = 0;
  const principalWaiters = new Map<string,number>();
  const principalStreams = new Map<string,number>();
  const secureCookies = publicUrl.protocol === 'https:';

  /** Passkey routes: JSON POSTs are same-origin only (exact PUBLIC_URL origin), JSON-typed and small. */
  async function account(request: IncomingMessage, response: ServerResponse, url: URL, path: string, origin: string | undefined, remote: string): Promise<void> {
    limiter.accept(`passkey:${remote}`, 30);
    const owner = cookieValue(request, OWNER_COOKIE);
    if (request.method === 'GET' && path === '/account') {
      const nextValues = url.searchParams.getAll('next');
      const next = nextValues.length === 1 && nextValues[0]!.startsWith('/oauth/authorize?') && !/[\u0000-\u0020\\#]/u.test(nextValues[0]!) ? nextValues[0] : undefined;
      response.statusCode = passkeys.rp ? 200 : 409;
      const nonce = randomBytes(16).toString('base64url');
      let view: AccountView = { kind: 'unavailable' };
      if (passkeys.rp) {
        if (await passkeys.session(owner)) {
          if (next) { response.statusCode = 303; response.setHeader('Location', next); response.end(); return; }
          view = { kind: 'owner', passkeys: await passkeys.list(owner) };
        }
        else {
          const codes = url.searchParams.getAll('code');
          const code = codes.length === 1 ? codes[0] : undefined;
          const usable = await passkeys.inviteUsable(code);
          view = { kind: 'guest', hasPasskeys: await passkeys.hasPasskeys(), code: usable ? code : undefined, codeInvalid: codes.length > 0 && !usable, next };
        }
      }
      response.setHeader('Content-Security-Policy', pageCsp(nonce, "'self'"));
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(accountHtml(view, nonce));
      return;
    }
    const routes = ['/account/logout', '/account/workers', '/account/passkeys/delete', '/account/passkeys/register/options', '/account/passkeys/register/verify', '/account/passkeys/login/options', '/account/passkeys/login/verify'];
    if (!routes.includes(path)) throw new AppError(404, 'not_found', 'Endpoint not found.');
    onlyMethod(request, response, ['POST']);
    if (!passkeys.rp) throw new AppError(409, 'passkeys_unavailable', 'Passkeys need the public HTTPS address.');
    if (origin !== publicUrl.origin) throw new AppError(403, 'invalid_origin', 'Origin is not allowed.');
    requireType(request, 'application/json');
    const raw = parseJson(await readBody(request, 32_768));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'invalid_request', 'Invalid request.');
    const body = raw as Record<string, unknown>;
    const code = typeof body.code === 'string' ? body.code : undefined;
    if (path === '/account/workers') {
      if (Object.keys(body).some(key => key !== 'name')) throw new AppError(400, 'invalid_request', 'Only a worker name is accepted.');
      limiter.accept(`worker:${remote}`, 5);
      const worker = await passkeys.createWorker(owner, body.name);
      json(response, 201, { ...worker, bridge: {
        service_url: publicUrl.origin, token_env: 'COLLECTIVE_WORKER_TOKEN',
        agents: [{ id: 'codex', provider: 'codex', binary: '/opt/homebrew/bin/codex', sandbox: true, enable_patch: false }],
        projects: worker.scopes.map(scope => ({ scope, root: '/absolute/path/to/project', agents: ['codex'], allow_patch: false })),
      } });
      return;
    }
    if (path === '/account/logout') {
      await passkeys.endSession(owner);
      response.setHeader('Set-Cookie', ownerCookie(null, secureCookies));
      json(response, 200, { ok: true });
      return;
    }
    if (path === '/account/passkeys/delete') {
      await passkeys.remove(owner, body.id);
      json(response, 200, { ok: true });
      return;
    }
    const browser = newBinding(cookieValue(request, BIND_COOKIE));
    if (path.endsWith('/options')) {
      const options = path.includes('/register/')
        ? await passkeys.registrationOptions({ code, sessionToken: owner, browser })
        : await passkeys.authenticationOptions(browser);
      response.setHeader('Set-Cookie', bindCookie(browser, secureCookies));
      json(response, 200, { options });
      return;
    }
    const token = path.includes('/register/')
      ? await passkeys.verifyRegistration({ code, sessionToken: owner, browser, response: body.response, name: body.name })
      : await passkeys.verifyAuthentication({ browser, response: body.response });
    response.setHeader('Set-Cookie', ownerCookie(token, secureCookies));
    json(response, 200, { ok: true });
  }

  async function authenticate(request: IncomingMessage, response: ServerResponse, mcp: boolean): Promise<Principal> {
    const header = oneHeader(request, 'authorization');
    const match = header?.match(/^Bearer ([A-Za-z0-9._~+\/-]+=*)$/iu);
    const token = match?.[1];
    let principal: Principal | null = null;
    if (token && token.length <= 4096) {
      if (token.startsWith('cn_access_')) principal = mcp && oauth ? await oauth.authenticate(token) : null;
      else principal = await dependencies.auth.authenticate(token);
    }
    if (!principal) {
      response.setHeader('WWW-Authenticate', oauth && mcp
        ? `Bearer resource_metadata="${publicUrl.origin}/.well-known/oauth-protected-resource/mcp", scope="mcp"`
        : 'Bearer realm="collective-network"');
      throw new AppError(401, 'unauthorized', 'A valid connection token is required.');
    }
    limiter.accept(`principal:${principal.id}`, 600);
    return principal;
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = request.url ?? '/';
    if (!target.startsWith('/') || target.startsWith('//') || target.length > 8192) throw new AppError(400, 'invalid_target', 'Invalid request target.');
    const url = new URL(target, publicUrl);
    const path = url.pathname;
    const host = oneHeader(request, 'host')?.toLowerCase();
    const rawSocket = request.socket.remoteAddress ?? 'unknown';
    const socketIp = normalizeIp(rawSocket);
    const localHost = localNames.some(name => host === `${name}:${config.port}` || (config.port === 80 && host === name));
    // Only trust forwarded-IP headers when proxy trust is explicitly configured, the socket belongs to the
    // configured proxy (Cloudflare Tunnel on loopback or explicit proxy IP), and the request targets the
    // public origin rather than the direct local loopback fast path.
    const fromTrustedProxy = proxyEnabled && socketIp !== null && trustedProxyIps.has(socketIp) && !localHost;
    const cfIp = normalizeIp(oneHeader(request, 'cf-connecting-ip'));
    const xffIp = normalizeIp(oneHeader(request, 'x-forwarded-for')?.split(',', 1)[0]);
    const forwardedIp = fromTrustedProxy ? (isForwardableClientIp(cfIp) ? cfIp : isForwardableClientIp(xffIp) ? xffIp : null) : null;
    const remote = forwardedIp ?? socketIp ?? rawSocket;
    // Same-machine clients (bridges, stdio proxies) keep the fast loopback path when PUBLIC_URL is a
    // tunnel origin. A literal loopback Host from a loopback socket without forwarded IP cannot be DNS-rebound.
    const loopback = isLoopbackIp(socketIp) && forwardedIp === null && localHost;
    if (host !== publicUrl.host.toLowerCase() && !loopback) throw new AppError(403, 'invalid_host', 'Host is not allowed.');
    const origin = oneHeader(request, 'origin');
    // Cookie pages (consent, account) accept only their own origins. Bearer/PKCE endpoints carry no ambient
    // credentials (CORS never allows credentials here), so browser-based clients may call them cross-origin.
    const cookieRoute = (request.url ?? '').startsWith('/oauth/authorize') || (request.url ?? '').startsWith('/account');
    if (origin !== undefined && !allowedOrigins.has(origin) && cookieRoute) {
      console.error(JSON.stringify({ event: 'origin_rejected', origin: origin.slice(0, 200), path: (request.url ?? '').split('?', 1)[0]!.slice(0, 100) }));
      throw new AppError(403, 'invalid_origin', 'Origin is not allowed.');
    }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, X-Request-Id');
    }
    // Per-address limit for visitors (through the tunnel, keyed by their own address). Same-machine clients
    // (bridges, the notch, stdio proxies) share 127.0.0.1, so they skip it; each identity keeps its own limit below.
    if (!loopback) limiter.accept(`ip:${remote}`, 600);
    if (request.method === 'OPTIONS') {
      const requestedMethod = oneHeader(request, 'access-control-request-method');
      const requestedHeaders = oneHeader(request, 'access-control-request-headers')?.split(',').map(header => header.trim().toLowerCase()) ?? [];
      const allowedHeaders = ['authorization', 'content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name'];
      if (!origin || !['GET', 'POST'].includes(requestedMethod ?? '') || requestedHeaders.some(header => !allowedHeaders.includes(header))) {
        throw new AppError(403, 'invalid_preflight', 'Preflight request is not allowed.');
      }
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      response.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '));
      response.setHeader('Access-Control-Max-Age', '600');
      json(response, 204);
      return;
    }
    if (path === '/healthz') {
      onlyMethod(request, response, ['GET']);
      json(response, 200, { status: 'ok' });
      return;
    }
    if (path === '/readyz') {
      onlyMethod(request, response, ['GET']);
      try { await dependencies.pool.query('SELECT 1'); json(response, 200, { status: 'ready' }); }
      catch { json(response, 503, { status: 'unavailable' }); }
      return;
    }
    if (oauth && path === '/.well-known/oauth-authorization-server') {
      onlyMethod(request, response, ['GET']);
      json(response, 200, oauth.authorizationMetadata());
      return;
    }
    if (oauth && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(path)) {
      onlyMethod(request, response, ['GET']);
      json(response, 200, oauth.resourceMetadata());
      return;
    }
    if (oauth && path === '/oauth/register') {
      onlyMethod(request, response, ['POST']);
      limiter.accept(`registration:${remote}`, 30);
      requireType(request, 'application/json');
      json(response, 201, await oauth.registerClient(parseJson(await readBody(request, Math.min(config.maxBodyBytes, 16_384))), createHash('sha256').update(remote).digest('hex')));
      return;
    }
    if (path === '/account' || path.startsWith('/account/')) {
      await account(request, response, url, path, origin, remote);
      return;
    }
    if (oauth && path === '/oauth/authorize') {
      onlyMethod(request, response, ['GET', 'POST']);
      limiter.accept(`authorization:${remote}`, 30);
      // The owner cookie only identifies the approving human; it is never read as an API credential.
      const ownerTenant = (await passkeys.session(cookieValue(request, OWNER_COOKIE)))?.tenantId;
      if (request.method === 'GET') {
        const form = await oauth.beginAuthorize(url.searchParams, cookieValue(request, OAUTH_COOKIE), ownerTenant);
        if (!ownerTenant) {
          const signup = new URLSearchParams({ next: `${url.pathname}${url.search}` });
          const codes = url.searchParams.getAll('code');
          if (codes.length === 1) signup.set('code', codes[0]!);
          form.signupUrl = `/account?${signup}`;
        }
        const passkey = ownerTenant ? undefined : !passkeys.rp ? 'unavailable' : await passkeys.hasPasskeys() ? 'ready' : 'none';
        authorizationPage(response, form, secureCookies, passkey);
        return;
      }
      // Browser approval is same-origin even when API CORS allows other clients.
      if (origin !== publicUrl.origin) throw new OAuthError('invalid_request', 'Authorization forms require the service origin.', 403);
      requireType(request, 'application/x-www-form-urlencoded');
      const reply = await oauth.respondAuthorize(new URLSearchParams(await readBody(request, 16_384)), cookieValue(request, OAUTH_COOKIE), ownerTenant);
      if (reply.kind === 'form') authorizationPage(response, reply, secureCookies);
      else { response.statusCode = 303; response.setHeader('Location', reply.location); response.end(); }
      return;
    }
    if (oauth && ['/oauth/token', '/oauth/revoke'].includes(path)) {
      onlyMethod(request, response, ['POST']);
      limiter.accept(`token:${remote}`, 60);
      if (oneHeader(request, 'authorization')) throw new OAuthError('invalid_client', 'Public clients must send client_id in the form, without Authorization.');
      requireType(request, 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(await readBody(request, 16_384));
      if (path === '/oauth/token') json(response, 200, await oauth.exchangeToken(form));
      else { await oauth.revokeToken(form); json(response, 200, {}); }
      return;
    }
    if (path === '/mcp') {
      onlyMethod(request, response, ['POST']); // GET and DELETE are 405: stateless, no SSE session.
      const principal = await authenticate(request, response, true);
      requireType(request, 'application/json');
      const accept = oneHeader(request, 'accept') ?? '';
      if (!/(?:^|,)\s*application\/json(?:\s*;[^,]*)?(?:,|$)/iu.test(accept) || !/(?:^|,)\s*text\/event-stream(?:\s*;[^,]*)?(?:,|$)/iu.test(accept)) {
        throw new AppError(406, 'not_acceptable', 'Accept must include application/json and text/event-stream.');
      }
      const payload = parseJson(await readBody(request, config.maxBodyBytes));
      const reply = await handleMcp(principal, payload, {
        protocolVersion: oneHeader(request, 'mcp-protocol-version'),
        method: oneHeader(request, 'mcp-method'),
        name: oneHeader(request, 'mcp-name'),
      }, dependencies);
      json(response, reply.status, reply.body);
      return;
    }
    if (path === '/api/inbox/wait') {
      onlyMethod(request, response, ['GET']);
      const principal = await authenticate(request, response, false);
      if ([...url.searchParams.keys()].some(k => !['session','timeout'].includes(k) || url.searchParams.getAll(k).length!==1)) {
        throw new AppError(400,'invalid_arguments','Only one session and timeout may be supplied.');
      }
      const count = principalWaiters.get(principal.id) ?? 0;
      if (inboxWaiters>=32 || count>=4) throw new AppError(429,'wait_limit','Too many inbox waiters.');
      const abort = new AbortController();
      const closed = () => abort.abort();
      response.on('close',closed);
      inboxWaiters++;
      principalWaiters.set(principal.id,count+1);
      try {
        const result = await waitForInbox(dependencies.pool,dependencies.core,principal,url.searchParams.get('session'),
          Number(url.searchParams.get('timeout') ?? '25'),abort.signal,() => authenticate(request,response,false));
        if (!response.destroyed) json(response,200,{result});
      } finally {
        response.off('close',closed);
        inboxWaiters--;
        const remaining = (principalWaiters.get(principal.id) ?? 1)-1;
        if (remaining) principalWaiters.set(principal.id,remaining); else principalWaiters.delete(principal.id);
      }
      return;
    }
    if (path === '/api/stream') {
      onlyMethod(request, response, ['GET']);
      const principal = await authenticate(request, response, false);
      requirePermission(principal, 'events:read');

      const afterParam = url.searchParams.get('after') ?? (oneHeader(request, 'last-event-id') || '0.0');
      const isNow = afterParam === 'now';
      let legacy = false;
      let curXid = '0';
      let curSeq = '0';
      if (!isNow) {
        const parts = /^(?:([0-9]{1,20})\.)?([0-9]{1,19})$/.exec(afterParam);
        requireCondition(parts !== null && BigInt(parts[2]!) <= 9223372036854775807n &&
          (parts[1] === undefined || BigInt(parts[1]) <= 18446744073709551615n), 400, 'invalid_arguments', 'after must be an xid.seq decimal cursor, legacy nonnegative bigint sequence, or now.');
        legacy = parts[1] === undefined;
        curXid = legacy ? '0' : parts[1]!;
        curSeq = parts[2]!;
      }

      const scopeParam = url.searchParams.get('scopes') ?? url.searchParams.get('scope');
      let scopes: string[];
      let allScopes = false;
      if (scopeParam) {
        scopes = scopeParam.split(',').map(s => s.trim()).filter(Boolean);
        for (const s of scopes) requireCondition(canAccessScope(principal, s), 403, 'scope_forbidden', 'Cannot access requested scope.');
      } else {
        allScopes = principal.role === 'admin' && principal.scopes.includes('*');
        scopes = principal.scopes;
      }

      const names: string[] = [];
      if (hasPermission(principal, 'thread:read')) names.push('message.created', 'message.updated', 'thread.read', 'question.created', 'question.answered');
      if (hasPermission(principal, 'agent:read')) names.push('agent.updated', 'bot.updated');
      if (hasPermission(principal, 'task:read')) names.push('task.updated', 'swarm.updated');
      if (hasPermission(principal, 'memory:read')) names.push('memory.changed');

      // Counted only once every check has passed, so a rejected request cannot leak a slot.
      const count = principalStreams.get(principal.id) ?? 0;
      if (count >= 4) throw new AppError(429, 'too_many_streams', 'Too many concurrent streams for this principal.');
      principalStreams.set(principal.id, count + 1);
      request.socket.setNoDelay(true);
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders?.();

      if (isNow) {
        const xminRes = await dependencies.pool.query<{ xmin: string }>('SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin');
        const xmin = xminRes.rows[0]?.xmin ?? '0';
        curXid = xmin;
        curSeq = '0';
        const cursorStr = `${xmin}.0`;
        response.write(`id: ${cursorStr}\nevent: cursor\ndata: ${JSON.stringify({ cursor: cursorStr })}\n\n`);
      }

      let active = true;
      let pollTimer: NodeJS.Timeout | undefined;
      let polling = false;
      let pending = false;
      let unsubscribe: (() => void) | undefined;
      const heartbeatTimer = setInterval(async () => {
        if (!active || response.destroyed) return;
        try {
          // Re-check without spending the request rate limit: revoked tokens, lost permission or lost scopes end the stream.
          const fresh = await dependencies.auth.authenticate(oneHeader(request, 'authorization')?.match(/^Bearer (\S+)$/iu)?.[1] ?? '');
          if (!fresh || !hasPermission(fresh, 'events:read')
            || (allScopes ? !(fresh.role === 'admin' && fresh.scopes.includes('*')) : !scopes.every(s => canAccessScope(fresh, s)))) {
            cleanup();
            response.end();
            return;
          }
        } catch {
          cleanup();
          response.end();
          return;
        }
        if (active && !response.destroyed) response.write(': heartbeat\n\n');
      }, dependencies.streamHeartbeatMs ?? 15_000);

      const maxDurationTimer = setTimeout(() => {
        cleanup();
        if (!response.destroyed) response.end();
      }, dependencies.streamMaxDurationMs ?? 3600_000);

      const cleanup = () => {
        if (!active) return;
        active = false;
        unsubscribe?.();
        clearInterval(heartbeatTimer);
        clearTimeout(maxDurationTimer);
        if (pollTimer) clearTimeout(pollTimer);
        response.off('close', cleanup);
        const remaining = (principalStreams.get(principal.id) ?? 1) - 1;
        if (remaining) principalStreams.set(principal.id, remaining);
        else principalStreams.delete(principal.id);
      };
      response.on('close', cleanup);

      const wake = () => {
        if (!active || response.destroyed) return;
        if (polling) { pending = true; return; }
        clearTimeout(pollTimer);
        void poll();
      };
      const poll = async () => {
        if (!active || response.destroyed) return;
        polling = true;
        pending = false;
        try {
          if (names.length === 0) {
            return;
          }
          const sql = legacy
            ? `SELECT id, xid::text || '.' || seq::text AS cursor, xid::text AS xid_str, seq, scope, name, subject_id, payload, created_at
               FROM events
               WHERE tenant_id = $1
                 AND ($2::boolean OR scope = ANY($3::text[]))
                 AND seq > $4::bigint
                 AND name = ANY($5::text[])
                 AND xid < pg_snapshot_xmin(pg_current_snapshot())
               ORDER BY xid, seq LIMIT 50`
            : `SELECT id, xid::text || '.' || seq::text AS cursor, xid::text AS xid_str, seq, scope, name, subject_id, payload, created_at
               FROM events
               WHERE tenant_id = $1
                 AND ($2::boolean OR scope = ANY($3::text[]))
                 AND (xid, seq) > ($4::xid8, $5::bigint)
                 AND name = ANY($6::text[])
                 AND xid < pg_snapshot_xmin(pg_current_snapshot())
               ORDER BY xid, seq LIMIT 50`;

          const queryParams = legacy
            ? [principal.tenantId, allScopes, scopes, curSeq, names]
            : [principal.tenantId, allScopes, scopes, curXid, curSeq, names];

          const result = await dependencies.pool.query<{
            id: string; cursor: string; xid_str: string; seq: string; scope: string; name: string;
            subject_id: string; payload: Record<string, unknown>; created_at: Date;
          }>(sql, queryParams);

          if (!active || response.destroyed) return;

          for (const row of result.rows) {
            const data = JSON.stringify({
              id: row.id,
              cursor: row.cursor,
              scope: row.scope,
              name: row.name,
              subject_id: row.subject_id,
              payload: row.payload,
              created_at: row.created_at.toISOString()
            });
            response.write(`id: ${row.cursor}\nevent: ${row.name}\ndata: ${data}\n\n`);
            legacy = false;
            curXid = row.xid_str;
            curSeq = row.seq;
          }

          if (result.rows.length === 50) pending = true;
        } catch {
          // The safety poll also recovers from transient read failures.
        } finally {
          polling = false;
          if (active && !response.destroyed) {
            if (pending) void poll();
            else pollTimer = setTimeout(wake, 2000);
          }
        }
      };

      const subscription = eventWakeup(dependencies.pool).subscribe(wake, principal.tenantId);
      wake(); // Poll independently while LISTEN connects (or reconnects).
      unsubscribe = await subscription;
      if (!active || response.destroyed) unsubscribe();
      return;
    }
    const toolMatch = path.match(/^\/api\/tools\/([a-z][a-z0-9_]{0,127})$/u);
    if (toolMatch) {
      onlyMethod(request, response, ['POST']);
      const principal = await authenticate(request, response, false);
      requireType(request, 'application/json');
      const result = await dependencies.core.call(principal, toolMatch[1]!, parseJson(await readBody(request, config.maxBodyBytes)));
      json(response, 200, { result });
      return;
    }
    throw new AppError(404, 'not_found', 'Endpoint not found.');
  }

  return (request, response): void => {
    const requestId = randomUUID();
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // same-origin, not no-referrer: with no-referrer browsers send `Origin: null` on form POSTs, which the
    // consent page's own origin check then rejects. Cross-site requests still get no referrer.
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (inFlight >= 64) {
      response.setHeader('Connection', 'close');
      response.setHeader('Retry-After', '1');
      json(response, 503, { error: { code: 'busy', message: 'Service concurrency limit reached.', requestId } });
      return;
    }
    inFlight++;
    void route(request, response).catch((error: unknown) => {
      const safe = publicError(error);
      // The response promises the logs explain the failure; record the cause (bounded) next to the request ID.
      if (safe.status >= 500) console.error(JSON.stringify({ event: 'request_failed', requestId, code: safe.code,
        cause: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : 'non-error thrown' }));
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      response.setHeader('Connection', 'close');
      if (safe.status === 429) response.setHeader('Retry-After', '60');
      // OAuth endpoints answer in the RFC 6749 flat shape, including rate-limit and body errors.
      if (error instanceof OAuthError || request.url?.startsWith('/oauth/')) json(response, safe.status, { error: safe.code, error_description: safe.message });
      else if (request.url?.split('?', 1)[0] === '/mcp' && safe.code === 'invalid_json') {
        json(response, 400, { jsonrpc: '2.0', error: { code: -32700, message: safe.message } });
      } else json(response, safe.status, { error: { code: safe.code, message: safe.message, requestId } });
    }).finally(() => { inFlight--; });
  };
}
