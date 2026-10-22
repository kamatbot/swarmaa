import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError, publicError } from './errors.js';
import { handleMcp } from './mcp.js';
import { OAuthError, OAuthService, OAUTH_COOKIE, authorizationHtml, type AuthorizationForm } from './oauth.js';
import { accountHtml, type AccountView } from './passkey-ui.js';
import { BIND_COOKIE, OWNER_COOKIE, PasskeyService, bindCookie, newBinding, ownerCookie } from './passkeys.js';
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
  const oauth = config.oauthEnabled ? new OAuthService(dependencies.pool, dependencies.auth, config) : undefined;
  const passkeys = new PasskeyService(dependencies.pool, config);
  const limiter = new RateLimiter();
  let inFlight = 0;
  const secureCookies = publicUrl.protocol === 'https:';

  /** Passkey routes: JSON POSTs are same-origin only (exact PUBLIC_URL origin), JSON-typed and small. */
  async function account(request: IncomingMessage, response: ServerResponse, url: URL, path: string, origin: string | undefined, remote: string): Promise<void> {
    limiter.accept(`passkey:${remote}`, 30);
    const owner = cookieValue(request, OWNER_COOKIE);
    if (request.method === 'GET' && path === '/account') {
      response.statusCode = passkeys.rp ? 200 : 409;
      const nonce = randomBytes(16).toString('base64url');
      let view: AccountView = { kind: 'unavailable' };
      if (passkeys.rp) {
        if (await passkeys.session(owner)) view = { kind: 'owner', passkeys: await passkeys.list(owner) };
        else {
          const codes = url.searchParams.getAll('code');
          const code = codes.length === 1 ? codes[0] : undefined;
          const usable = await passkeys.inviteUsable(code);
          view = { kind: 'guest', hasPasskeys: await passkeys.hasPasskeys(), code: usable ? code : undefined, codeInvalid: codes.length > 0 && !usable };
        }
      }
      response.setHeader('Content-Security-Policy', pageCsp(nonce, "'self'"));
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(accountHtml(view, nonce));
      return;
    }
    const routes = ['/account/logout', '/account/passkeys/delete', '/account/passkeys/register/options', '/account/passkeys/register/verify', '/account/passkeys/login/options', '/account/passkeys/login/verify'];
    if (!routes.includes(path)) throw new AppError(404, 'not_found', 'Endpoint not found.');
    onlyMethod(request, response, ['POST']);
    if (!passkeys.rp) throw new AppError(409, 'passkeys_unavailable', 'Passkeys need the public HTTPS address.');
    if (origin !== publicUrl.origin) throw new AppError(403, 'invalid_origin', 'Origin is not allowed.');
    requireType(request, 'application/json');
    const raw = parseJson(await readBody(request, 32_768));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'invalid_request', 'Invalid request.');
    const body = raw as Record<string, unknown>;
    const code = typeof body.code === 'string' ? body.code : undefined;
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
    const remote = request.socket.remoteAddress ?? 'unknown';
    // Same-machine clients (bridges, stdio proxies) keep the fast loopback path when PUBLIC_URL is a
    // tunnel origin. A literal loopback Host from a loopback socket cannot be a DNS-rebinding name.
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) &&
      localNames.some(name => host === `${name}:${config.port}` || (config.port === 80 && host === name));
    if (host !== publicUrl.host.toLowerCase() && !loopback) throw new AppError(403, 'invalid_host', 'Host is not allowed.');
    const origin = oneHeader(request, 'origin');
    if (origin !== undefined && !allowedOrigins.has(origin)) throw new AppError(403, 'invalid_origin', 'Origin is not allowed.');
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, X-Request-Id');
    }
    // Forwarded headers are intentionally ignored. Configure limits at your TLS
    // proxy too; all users behind a proxy share its socket IP in this limiter.
    limiter.accept(`ip:${remote}`, 600);
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
      limiter.accept(`registration:${remote}`, 6);
      requireType(request, 'application/json');
      json(response, 201, await oauth.registerClient(parseJson(await readBody(request, Math.min(config.maxBodyBytes, 16_384)))));
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
    response.setHeader('Referrer-Policy', 'no-referrer');
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
      if (error instanceof OAuthError) json(response, safe.status, { error: safe.code, error_description: safe.message });
      else if (request.url?.split('?', 1)[0] === '/mcp' && safe.code === 'invalid_json') {
        json(response, 400, { jsonrpc: '2.0', error: { code: -32700, message: safe.message } });
      } else json(response, safe.status, { error: { code: safe.code, message: safe.message, requestId } });
    }).finally(() => { inFlight--; });
  };
}
