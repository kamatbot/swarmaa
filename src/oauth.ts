import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from './db.js';
import { hashToken, newToken, principalFromRow } from './auth.js';
import { AppError } from './errors.js';
import { escapeHtml, INVITE_ONLY, shell } from './passkey-ui.js';
import { ROLE_PERMISSIONS } from './policy.js';
import type { AuthBackend, Principal, ServerConfig } from './types.js';

const ACCESS_SECONDS = 3600;
const GRANT_SECONDS = 30 * 24 * 3600;
const PENDING_SECONDS = 600;
const CODE_SECONDS = 120;
export const OAUTH_COOKIE = 'collective_oauth_browser';

export class OAuthError extends AppError {
  constructor(code: string, message: string, status = 400) {
    super(status, code, message);
  }
}

export interface AuthorizationForm {
  kind: 'form';
  requestId: string;
  csrf: string;
  browserCookie: string;
  clientName: string;
  redirectUri: string;
  principal?: Principal;
  /** Signed-in owner: connection identities that may be chosen, and the default pick. */
  owner?: { identities: Identity[]; defaultId: string; createFirst?: boolean };
  signupUrl?: string;
  /** Passkey sign-in state for a browser without an owner session. */
  passkey?: 'ready' | 'none' | 'unavailable';
  /** CSP nonce for the inline passkey script. */
  nonce?: string;
}

export type AuthorizationReply = AuthorizationForm | { kind: 'redirect'; location: string };

interface PendingRow {
  id: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  state: string | null;
  challenge: string;
  resource: string;
  csrf_hash: string;
  browser_hash: string;
  grant_snapshot: Principal | null;
  owner_tenant: string | null;
}

function opaque(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function tokenHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OAuthError('invalid_request', 'Expected an object.');
  }
  return value as Record<string, unknown>;
}

function field(value: unknown, name: string, max = 2048): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OAuthError('invalid_request', `Invalid ${name}.`);
  }
  return value;
}

function optionalField(value: unknown, name: string, max = 2048): string | undefined {
  return value === undefined ? undefined : field(value, name, max);
}

function requiredParameter(params: URLSearchParams, name: string, max = 2048): string {
  if (params.getAll(name).length !== 1) throw new OAuthError('invalid_request', `Exactly one ${name} is required.`);
  return field(params.get(name), name, max);
}

function parameter(params: URLSearchParams, name: string, max = 2048): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) throw new OAuthError('invalid_request', `Duplicate ${name}.`);
  return values.length ? field(values[0], name, max) : undefined;
}

function allowedScope(scope: string | undefined): void {
  if (scope !== undefined && scope !== 'mcp') throw new OAuthError('invalid_scope', 'The only OAuth scope is mcp. Project grants come from the connection identity.');
}

/** Never widen a grant when the underlying principal changes. */
export function narrowGrant(snapshot: Principal, current: Principal | null): Principal | null {
  if (!current || current.role === 'admin' || snapshot.role === 'admin' ||
      snapshot.id !== current.id || snapshot.tenantId !== current.tenantId ||
      snapshot.credentialVersion !== current.credentialVersion ||
      snapshot.role !== current.role || snapshot.permissions.includes('admin') ||
      current.permissions.includes('admin') || snapshot.scopes.includes('*')) return null;
  const scopes = snapshot.scopes.filter(scope => current.scopes.includes(scope));
  const permissions = snapshot.permissions.filter(permission => current.permissions.includes(permission));
  if (!scopes.length || !permissions.length) return null;
  return { ...current, scopes, permissions };
}

/** Only non-admin, non-wildcard identities can be delegated to an OAuth client. */
function connectable(principal: Principal): boolean {
  return principal.role !== 'admin' && !principal.permissions.includes('admin') && !principal.scopes.includes('*');
}

export interface Identity { id: string; name: string; scopes?: string[]; permissions?: string[] }

/**
 * Default identity: the one whose name appears in the client name (longest match); else one that can
 * manage routing (the owner's own app identities), then the one with the most projects. A narrow
 * identity such as a single-project one is never the silent default over a broader one.
 */
export function defaultIdentity(clientName: string, identities: Identity[]): string {
  const lower = clientName.toLowerCase();
  const hit = identities.filter(i => lower.includes(i.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0];
  if (hit) return hit.id;
  const rank = (i: Identity) => (i.permissions?.includes('routing:manage') ? 1000 : 0) + (i.scopes?.length ?? 0);
  return identities.slice().sort((a, b) => rank(b) - rank(a))[0]?.id ?? '';
}

export function validateRedirectUri(value: unknown, config: ServerConfig): string {
  const raw = field(value, 'redirect_uri');
  let url: URL;
  try { url = new URL(raw); } catch { throw new OAuthError('invalid_redirect_uri', 'Redirect URI must be an absolute URL.'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname.toLowerCase());
  // Standard dynamic registration, as MCP clients expect: any HTTPS redirect, or http on loopback for
  // native apps (RFC 8252). The owner's passkey consent (which shows the redirect host) and PKCE are the
  // gate. A non-empty OAUTH_REDIRECT_HOSTS still restricts registration to those hosts.
  const safeScheme = url.protocol === 'https:' || (loopback && url.protocol === 'http:');
  const allowed = config.oauthRedirectHosts.length === 0
    || config.oauthRedirectHosts.map(host => host.toLowerCase()).includes(url.hostname.toLowerCase());
  if (!safeScheme || !allowed || url.username || url.password || raw.includes('#') || raw !== url.href) {
    if (!allowed) console.error(JSON.stringify({ event: 'oauth_redirect_host_rejected', host: url.hostname.toLowerCase().slice(0, 253) }));
    throw new OAuthError('invalid_redirect_uri', 'Redirect URI must be https (or http on localhost), canonical, and have no credentials or fragment.');
  }
  // Exact URI matching is enforced again on authorization and code exchange.
  return raw;
}

export class OAuthService {
  readonly issuer: string;
  readonly resource: string;

  constructor(private readonly pool: Pool, private readonly auth: AuthBackend, private readonly config: ServerConfig) {
    const url = new URL(config.publicUrl);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      throw new Error('PUBLIC_URL must be an origin with no path, credentials, query or fragment.');
    }
    this.issuer = url.origin;
    this.resource = `${this.issuer}/mcp`;
  }

  authorizationMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp'],
      authorization_response_iss_parameter_supported: true,
    };
  }

  resourceMetadata(): Record<string, unknown> {
    return { resource: this.resource, authorization_servers: [this.issuer], scopes_supported: ['mcp'], bearer_methods_supported: ['header'] };
  }

  async registerClient(input: unknown, ipHash?: string): Promise<Record<string, unknown>> {
    const data = record(input);
    if (!Array.isArray(data.redirect_uris) || data.redirect_uris.length < 1 || data.redirect_uris.length > 8) {
      throw new OAuthError('invalid_client_metadata', 'Provide between one and eight redirect URIs.');
    }
    // Hostnames only (no paths or query), so the owner can allowlist a client's callback host.
    const hosts = data.redirect_uris.map(uri => { try { return new URL(String(uri)).hostname.toLowerCase().slice(0, 253); } catch { return 'unparseable'; } });
    console.error(JSON.stringify({ event: 'oauth_client_registering', client_name: String(data.client_name ?? '').slice(0, 80), redirect_hosts: hosts }));
    const redirects = [...new Set(data.redirect_uris.map(uri => validateRedirectUri(uri, this.config)))];
    if (data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== 'none') {
      throw new OAuthError('invalid_client_metadata', 'Only public clients with token_endpoint_auth_method none are supported.');
    }
    const grants = data.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grants) || !grants.includes('authorization_code') || grants.some(grant => !['authorization_code', 'refresh_token'].includes(grant))) {
      throw new OAuthError('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported.');
    }
    if (data.response_types !== undefined && (!Array.isArray(data.response_types) || data.response_types.length !== 1 || data.response_types[0] !== 'code')) {
      throw new OAuthError('invalid_client_metadata', 'Only the code response type is supported.');
    }
    allowedScope(optionalField(data.scope, 'scope', 128));
    const name = data.client_name === undefined ? 'MCP client' : field(data.client_name, 'client_name', 160);
    const id = opaque('cn_client');
    await transaction(this.pool, async client => {
      // Serialize registration so the ceilings hold across API replicas.
      await client.query("SELECT pg_advisory_xact_lock(420315903)");
      // Opportunistic expiry, bounded per call; cascades remove codes/pending/grants. No background timer.
      await client.query(
        `DELETE FROM oauth_clients WHERE client_id IN (
           SELECT c.client_id FROM oauth_clients c
           WHERE (c.created_at < now() - interval '24 hours'
                  AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)
                  AND NOT EXISTS (SELECT 1 FROM oauth_pending p WHERE p.client_id = c.client_id))
              OR (EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)
                  AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id
                                  AND LEAST(COALESCE(g.revoked_at, 'infinity'::timestamptz), g.expires_at) >= now() - interval '30 days'))
           LIMIT 500)`,
      );
      if (ipHash) {
        const mine = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM oauth_clients c WHERE c.created_ip_hash=$1 AND c.created_at > now() - interval '24 hours'
             AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)`, [ipHash],
        );
        if (Number(mine.rows[0]?.count ?? 0) >= 20) throw new OAuthError('temporarily_unavailable', 'Too many unused registrations from this address. Try again later.', 429);
      }
      const total = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM oauth_clients c WHERE c.created_at > now() - interval '24 hours'
           OR EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)`,
      );
      if (Number(total.rows[0]?.count ?? 0) >= 5000) throw new OAuthError('temporarily_unavailable', 'Client registration capacity reached. Try again later.', 503);
      await client.query('INSERT INTO oauth_clients(client_id, client_name, redirect_uris, created_ip_hash) VALUES ($1,$2,$3,$4)', [id, name, redirects, ipHash ?? null]);
    });
    return {
      client_id: id, client_name: name, redirect_uris: redirects,
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], scope: 'mcp', client_id_issued_at: Math.floor(Date.now() / 1000),
    };
  }

  async beginAuthorize(params: URLSearchParams, browserCookie?: string, ownerTenant?: string): Promise<AuthorizationForm> {
    const clientId = requiredParameter(params, 'client_id', 128);
    const redirectUri = requiredParameter(params, 'redirect_uri');
    const responseType = requiredParameter(params, 'response_type', 64);
    const resource = requiredParameter(params, 'resource');
    const challenge = requiredParameter(params, 'code_challenge', 128);
    const method = requiredParameter(params, 'code_challenge_method', 32);
    const state = parameter(params, 'state');
    allowedScope(parameter(params, 'scope', 128));
    if (responseType !== 'code') throw new OAuthError('unsupported_response_type', 'Only authorization code flow is supported.');
    if (resource !== this.resource) throw new OAuthError('invalid_target', 'Resource must match this server MCP endpoint.');
    if (method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/u.test(challenge)) throw new OAuthError('invalid_request', 'A valid S256 PKCE challenge is required.');
    const client = await this.pool.query<{ client_name: string; redirect_uris: string[] }>('SELECT client_name, redirect_uris FROM oauth_clients WHERE client_id=$1', [clientId]);
    const registered = client.rows[0];
    if (!registered || !registered.redirect_uris.includes(redirectUri)) throw new OAuthError('invalid_request', 'Client and redirect URI do not match a registration.');
    validateRedirectUri(redirectUri, this.config); // Allowlist changes take effect immediately.
    await this.pool.query('UPDATE oauth_clients SET last_used_at=now() WHERE client_id=$1', [clientId]);
    const browser = browserCookie && /^[A-Za-z0-9_-]{43}$/u.test(browserCookie) ? browserCookie : randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const requestId = randomUUID();
    await this.pool.query('DELETE FROM oauth_pending WHERE expires_at <= now()');
    await this.pool.query(
      'INSERT INTO oauth_pending(id,client_id,redirect_uri,state,challenge,resource,csrf_hash,browser_hash,expires_at,owner_tenant) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+make_interval(secs=>$9),$10)',
      [requestId, clientId, redirectUri, state ?? null, challenge, resource, tokenHash(csrf), tokenHash(browser), PENDING_SECONDS, ownerTenant ?? null],
    );
    const form: AuthorizationForm = { kind: 'form', requestId, csrf, browserCookie: browser, clientName: registered.client_name, redirectUri };
    if (ownerTenant) {
      const rows = await this.pool.query<Identity>(
        "SELECT id,name,scopes,permissions FROM principals WHERE tenant_id=$1 AND role='frontend' AND disabled=false AND NOT ('admin'=ANY(permissions)) AND NOT ('*'=ANY(scopes)) ORDER BY name",
        [ownerTenant],
      );
      form.owner = { identities: rows.rows, defaultId: defaultIdentity(registered.client_name, rows.rows) };
      if (!rows.rows.length && /^t_[0-9a-f]{32}$/u.test(ownerTenant)) {
        form.owner.createFirst = !(await this.pool.query("SELECT 1 FROM principals WHERE tenant_id=$1 AND role='frontend' LIMIT 1", [ownerTenant])).rows.length;
      }
    }
    return form;
  }

  async respondAuthorize(form: URLSearchParams, browserCookie?: string, ownerTenant?: string): Promise<AuthorizationReply> {
    const requestId = requiredParameter(form, 'request_id', 64);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)) throw new OAuthError('invalid_request', 'Invalid authorization request.');
    const csrf = requiredParameter(form, 'csrf', 128);
    const action = requiredParameter(form, 'action', 32);
    if (!['identify', 'identify_owner', 'create_first', 'approve', 'deny'].includes(action)) throw new OAuthError('invalid_request', 'Invalid authorization action.');
    if (action === 'create_first' && (!ownerTenant || !/^t_[0-9a-f]{32}$/u.test(ownerTenant))) throw new OAuthError('access_denied', 'Sign in to your invited space first.', 403);
    if (!browserCookie || !/^[A-Za-z0-9_-]{43}$/u.test(browserCookie)) throw new OAuthError('invalid_request', 'Authorization browser cookie is missing.', 403);
    const browser = browserCookie;
    let identifyingPrincipal: Principal | null = null;
    let identifyingTokenHash: string | undefined;
    if (action === 'identify') {
      const token = requiredParameter(form, 'connection_token', 4096);
      identifyingPrincipal = await this.auth.authenticate(token);
      if (!identifyingPrincipal || !connectable(identifyingPrincipal)) {
        throw new OAuthError('access_denied', 'Use a valid non-admin connection token issued for this client.', 403);
      }
      identifyingTokenHash = tokenHash(token);
    }
    let ownerChoice: string | undefined;
    if (action === 'identify_owner') {
      if (!ownerTenant) throw new OAuthError('access_denied', 'Sign in with your passkey first.', 403);
      ownerChoice = requiredParameter(form, 'principal_id', 64);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(ownerChoice)) throw new OAuthError('invalid_request', 'Invalid connection identity.');
    }
    return transaction<AuthorizationReply>(this.pool, async client => {
      if (ownerChoice) {
        // Same lock order as rotation/revocation. The chosen identity must be an
        // enabled, non-admin frontend principal of the owner's own tenant.
        const locked = await client.query(
          "SELECT * FROM principals WHERE id=$1 AND tenant_id=$2 AND role='frontend' AND disabled=false FOR SHARE",
          [ownerChoice, ownerTenant],
        );
        const chosen = locked.rows[0] ? principalFromRow(locked.rows[0]) : null;
        if (!chosen || !connectable(chosen)) throw new OAuthError('access_denied', 'Choose an enabled, non-admin connection identity.', 403);
        identifyingPrincipal = chosen;
      }
      if (identifyingPrincipal && !ownerChoice) {
        // The owner rotates/revokes by locking the principal before pending
        // requests. Use the same order and recheck the credential after taking
        // the lock: an old token cannot outlive rotation through an in-flight
        // identity step whose pending grant_snapshot was still null.
        const locked = await client.query(
          'SELECT id FROM principals WHERE id=$1 AND token_hash=$2 AND disabled=false FOR SHARE',
          [identifyingPrincipal.id, identifyingTokenHash],
        );
        if (!locked.rows.length) throw new OAuthError('access_denied', 'This connection token was rotated or revoked.', 403);
      }
      const selected = await client.query<PendingRow>(
        'SELECT p.*, c.client_name FROM oauth_pending p JOIN oauth_clients c USING(client_id) WHERE p.id=$1 AND p.expires_at>now() FOR UPDATE OF p', [requestId],
      );
      const pending = selected.rows[0];
      if (!pending || !equalHash(pending.csrf_hash, tokenHash(csrf)) || !equalHash(pending.browser_hash, tokenHash(browser))) {
        throw new OAuthError('invalid_request', 'Authorization request expired or verification failed.', 403);
      }
      if (pending.owner_tenant && pending.owner_tenant !== ownerTenant) throw new OAuthError('access_denied', 'Sign in with the same owner passkey to approve.', 403);
      validateRedirectUri(pending.redirect_uri, this.config);
      if (action === 'deny') {
        await client.query('DELETE FROM oauth_pending WHERE id=$1', [requestId]);
        return { kind: 'redirect', location: this.redirect(pending, { error: 'access_denied' }) };
      }
      if (action === 'identify' || action === 'identify_owner') {
        // Connection tokens are checked but never stored or re-rendered.
        const principal = identifyingPrincipal!;
        const nextCsrf = randomBytes(32).toString('base64url');
        await client.query('UPDATE oauth_pending SET grant_snapshot=$2::jsonb,csrf_hash=$3,owner_tenant=$4 WHERE id=$1', [requestId, JSON.stringify(principal), tokenHash(nextCsrf), ownerChoice ? ownerTenant : pending.owner_tenant]);
        return { kind: 'form', requestId, csrf: nextCsrf, browserCookie: browser, clientName: pending.client_name, redirectUri: pending.redirect_uri, principal };
      }
      let principal: Principal | null;
      if (action === 'create_first') {
        // Serialize first-identity creation across simultaneous approval tabs.
        await client.query('SELECT pg_advisory_xact_lock(420315904,hashtext($1))', [ownerTenant]);
        const existing = await client.query("SELECT 1 FROM principals WHERE tenant_id=$1 AND role='frontend' LIMIT 1", [ownerTenant]);
        if (existing.rows.length) throw new OAuthError('access_denied', 'An app identity already exists. Reload and choose it.', 409);
        const name = `${pending.client_name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').slice(0, 70) || 'app'}-${randomBytes(6).toString('hex')}`;
        const created = await client.query(
          "INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,'frontend',$4,$5,$6) RETURNING *",
          [randomUUID(), ownerTenant, name, ['project:general'], ROLE_PERMISSIONS.frontend, hashToken(newToken())],
        );
        principal = principalFromRow(created.rows[0]);
      } else {
        if (!pending.grant_snapshot) throw new OAuthError('invalid_request', 'Identify the connection before approving.');
        principal = narrowGrant(pending.grant_snapshot, await this.auth.getPrincipal(pending.grant_snapshot.id));
      }
      if (!principal) throw new OAuthError('access_denied', 'This connection identity is no longer authorized.', 403);
      const code = opaque('cn_code');
      await client.query(
        'INSERT INTO oauth_codes(code_hash,client_id,principal_id,redirect_uri,challenge,resource,grant_snapshot,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now()+make_interval(secs=>$8))',
        [tokenHash(code), pending.client_id, principal.id, pending.redirect_uri, pending.challenge, pending.resource, JSON.stringify(principal), CODE_SECONDS],
      );
      await client.query('DELETE FROM oauth_pending WHERE id=$1', [requestId]);
      return { kind: 'redirect', location: this.redirect(pending, { code }) };
    });
  }

  private redirect(pending: PendingRow, fields: Record<string, string>): string {
    const redirect = new URL(pending.redirect_uri);
    for (const [key, value] of Object.entries(fields)) redirect.searchParams.set(key, value);
    if (pending.state !== null) redirect.searchParams.set('state', pending.state);
    redirect.searchParams.set('iss', this.issuer);
    return redirect.href;
  }

  async exchangeToken(form: URLSearchParams): Promise<Record<string, unknown>> {
    const grantType = requiredParameter(form, 'grant_type', 64);
    const clientId = requiredParameter(form, 'client_id', 128);
    const resource = requiredParameter(form, 'resource');
    if (form.has('client_secret')) throw new OAuthError('invalid_client', 'This server supports public clients without client secrets.');
    allowedScope(parameter(form, 'scope', 128));
    if (resource !== this.resource) throw new OAuthError('invalid_target', 'Resource must match this server MCP endpoint.');
    if (grantType === 'authorization_code') {
      const code = requiredParameter(form, 'code', 256);
      const redirect = requiredParameter(form, 'redirect_uri');
      const verifier = requiredParameter(form, 'code_verifier', 128);
      if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) throw new OAuthError('invalid_grant', 'Invalid authorization code or PKCE verifier.');
      validateRedirectUri(redirect, this.config);
      return transaction(this.pool, async client => {
        const result = await client.query<{
          client_id: string; principal_id: string; redirect_uri: string; challenge: string;
          resource: string; grant_snapshot: Principal; used_at: Date | null;
        }>('SELECT * FROM oauth_codes WHERE code_hash=$1 AND expires_at>now() FOR UPDATE', [tokenHash(code)]);
        const row = result.rows[0];
        if (!row || row.used_at || row.client_id !== clientId || row.redirect_uri !== redirect || row.resource !== resource ||
            !equalHash(tokenHash(row.challenge), tokenHash(pkceChallenge(verifier)))) {
          throw new OAuthError('invalid_grant', 'Invalid authorization code or PKCE verifier.');
        }
        const principal = narrowGrant(row.grant_snapshot, await this.auth.getPrincipal(row.principal_id));
        if (!principal) throw new OAuthError('invalid_grant', 'The connection identity is no longer authorized.');
        await client.query('UPDATE oauth_codes SET used_at=now() WHERE code_hash=$1', [tokenHash(code)]);
        await client.query('UPDATE oauth_clients SET last_used_at=now() WHERE client_id=$1', [clientId]);
        const grantId = randomUUID();
        await client.query(
          'INSERT INTO oauth_grants(id,principal_id,client_id,resource,grant_snapshot,expires_at) VALUES ($1,$2,$3,$4,$5::jsonb,now()+make_interval(secs=>$6))',
          [grantId, principal.id, clientId, resource, JSON.stringify(principal), GRANT_SECONDS],
        );
        return this.issueTokens(client, grantId);
      });
    }
    if (grantType !== 'refresh_token') throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token grants are supported.');
    const refreshToken = requiredParameter(form, 'refresh_token', 256);
    const reply = await transaction(this.pool, async client => {
      const result = await client.query<{
        id: string; client_id: string; principal_id: string; resource: string;
        grant_snapshot: Principal; used_at: Date | null; revoked_at: Date | null; live: boolean; abandoned: boolean;
      }>(
        "SELECT g.*, r.used_at, (g.expires_at>now() AND r.expires_at>now()) AS live, r.expires_at='-infinity'::timestamptz AS abandoned FROM oauth_refresh_tokens r JOIN oauth_grants g ON g.id=r.grant_id WHERE r.token_hash=$1 FOR UPDATE OF g, r",
        [tokenHash(refreshToken)],
      );
      const row = result.rows[0];
      if (row && row.client_id === clientId && row.resource === resource && row.abandoned && !row.revoked_at) {
        // A reply given up as lost (below) has turned up after all: someone else holds this family. Revoke it.
        await client.query('UPDATE oauth_grants SET revoked_at=now() WHERE id=$1', [row.id]);
        return null;
      }
      if (!row || row.client_id !== clientId || row.resource !== resource || !row.live || row.revoked_at) return null;
      if (row.used_at) {
        // A lost reply (a laptop sleeping mid-refresh, dropped Wi-Fi) leaves the client holding the token it just
        // spent. If that is the token right before the newest one and the newest was never used, the client never
        // saw it: abandon that pair and issue a new one. The abandoned token is marked, so if it shows up later
        // (a thief replaying the old token got here first) the family is still revoked.
        const next = await client.query<{ token_hash: string }>(
          "SELECT n.token_hash FROM oauth_refresh_tokens n, oauth_refresh_tokens r WHERE r.token_hash=$1 AND n.grant_id=r.grant_id AND n.created_at=r.used_at AND n.used_at IS NULL AND n.expires_at>now() AND r.used_at>now()-interval '1 day'",
          [tokenHash(refreshToken)]);
        if (!next.rows[0]) {
          // Commit revocation before returning invalid_grant: throwing here would roll it back.
          await client.query('UPDATE oauth_grants SET revoked_at=now() WHERE id=$1', [row.id]);
          return null;
        }
        await client.query("UPDATE oauth_refresh_tokens SET expires_at='-infinity' WHERE token_hash=$1", [next.rows[0].token_hash]);
        await client.query('UPDATE oauth_access_tokens SET expires_at=now() WHERE grant_id=$1 AND created_at=(SELECT used_at FROM oauth_refresh_tokens WHERE token_hash=$2)', [row.id, tokenHash(refreshToken)]);
      }
      const principal = narrowGrant(row.grant_snapshot, await this.auth.getPrincipal(row.principal_id));
      if (!principal) {
        await client.query('UPDATE oauth_grants SET revoked_at=now() WHERE id=$1', [row.id]);
        return null;
      }
      await client.query('UPDATE oauth_refresh_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL', [tokenHash(refreshToken)]);
      // Persist narrowing: a removed permission cannot reappear later in this family.
      await client.query('UPDATE oauth_grants SET grant_snapshot=$2::jsonb WHERE id=$1', [row.id, JSON.stringify(principal)]);
      return this.issueTokens(client, row.id);
    });
    if (!reply) throw new OAuthError('invalid_grant', 'Refresh token expired, was already used, or was revoked. Reconnect the client.');
    return reply;
  }

  private async issueTokens(client: PoolClient, grantId: string): Promise<Record<string, unknown>> {
    const access = opaque('cn_access');
    const refresh = opaque('cn_refresh');
    await client.query(
      'INSERT INTO oauth_access_tokens(token_hash,grant_id,expires_at) SELECT $1,id,LEAST(expires_at,now()+make_interval(secs=>$3)) FROM oauth_grants WHERE id=$2',
      [tokenHash(access), grantId, ACCESS_SECONDS],
    );
    await client.query('INSERT INTO oauth_refresh_tokens(token_hash,grant_id,expires_at) SELECT $1,id,expires_at FROM oauth_grants WHERE id=$2', [tokenHash(refresh), grantId]);
    const remaining = await client.query<{ remaining: number }>(
      'SELECT GREATEST(0,FLOOR(EXTRACT(EPOCH FROM expires_at-now())))::int AS remaining FROM oauth_access_tokens WHERE token_hash=$1', [tokenHash(access)],
    );
    return { access_token: access, token_type: 'Bearer', expires_in: remaining.rows[0]?.remaining ?? ACCESS_SECONDS, refresh_token: refresh, scope: 'mcp' };
  }

  async authenticate(token: string): Promise<Principal | null> {
    if (!/^cn_access_[A-Za-z0-9_-]{43}$/u.test(token)) return null;
    const result = await this.pool.query<{ grant_id: string; principal_id: string; grant_snapshot: Principal }>(
      'SELECT g.id AS grant_id,g.principal_id,g.grant_snapshot FROM oauth_access_tokens a JOIN oauth_grants g ON g.id=a.grant_id WHERE a.token_hash=$1 AND a.expires_at>now() AND g.expires_at>now() AND g.revoked_at IS NULL AND g.resource=$2',
      [tokenHash(token), this.resource],
    );
    const row = result.rows[0];
    if (!row) return null;
    const principal = narrowGrant(row.grant_snapshot, await this.auth.getPrincipal(row.principal_id));
    return principal ? { ...principal, oauthGrantId: row.grant_id } : null;
  }

  async revokeToken(form: URLSearchParams): Promise<void> {
    const clientId = requiredParameter(form, 'client_id', 128);
    const token = requiredParameter(form, 'token', 4096);
    if (form.has('client_secret')) throw new OAuthError('invalid_client', 'Client secrets are not supported.');
    // RFC 7009: success is deliberately indistinguishable for unknown tokens.
    await this.pool.query(
      'UPDATE oauth_grants g SET revoked_at=now() WHERE g.client_id=$1 AND g.id IN (SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash=$2 UNION SELECT grant_id FROM oauth_access_tokens WHERE token_hash=$2)',
      [clientId, tokenHash(token)],
    );
  }
}

export function authorizationHtml(form: AuthorizationForm): string {
  const hidden = `<input type="hidden" name="request_id" value="${escapeHtml(form.requestId)}"><input type="hidden" name="csrf" value="${escapeHtml(form.csrf)}">`;
  const tokenField = (open: boolean): string => `<details${open ? ' open' : ''}><summary>Use a connection token instead</summary><p>Enter the non-admin connection token your service owner issued for this client.</p><label>Connection token <input name="connection_token" type="password" autocomplete="off" spellcheck="false" required maxlength="4096"></label><button name="action" value="identify">Review permissions</button></details>`;
  const grant = form.principal;
  let fields: string;
  if (grant) {
    fields = `<div class="card"><p>Identity: <strong>${escapeHtml(grant.name)}</strong> (${escapeHtml(grant.role)})</p><p>Projects: ${grant.scopes.map(escapeHtml).join(', ')}</p><p>Permissions: ${grant.permissions.map(escapeHtml).join(', ')}</p></div><p>This client will receive only these grants. Authorization expires in at most 30 days. Disabling the connection identity revokes its access.</p><button class="primary" name="action" value="approve">Approve connection</button>`;
  } else if (form.owner) {
    const options = form.owner.identities.map(i => `<option value="${escapeHtml(i.id)}"${i.id === form.owner!.defaultId ? ' selected' : ''}>${escapeHtml(i.name)}${i.scopes ? ` · ${i.scopes.length} project${i.scopes.length === 1 ? '' : 's'}` : ''}</option>`).join('');
    fields = form.owner.identities.length
      ? `<p>Choose which connection identity this client gets. The next screen shows its exact projects and permissions.</p><label>Connection identity <select name="principal_id">${options}</select></label><button class="primary" name="action" value="identify_owner">Review permissions</button>`
      : form.owner.createFirst
        ? `<p>Create your first app identity and approve this connection.</p><div class="card"><p>Role: <strong>frontend</strong></p><p>Project: <strong>project:general</strong></p><p>Permissions: ${ROLE_PERMISSIONS.frontend.map(escapeHtml).join(', ')}</p></div><p>Authorization expires in at most 30 days.</p><button class="primary" name="action" value="create_first">Create identity and approve connection</button>`
        : '<p>No enabled connection identity exists yet. Create one with <code>npm run admin -- create</code>.</p>';
  } else if (form.passkey === 'ready' || form.passkey === 'none') {
    fields = `<p>${escapeHtml(INVITE_ONLY)}</p><div id="pk-msg" role="status"></div>${form.passkey === 'ready'
      ? '<button type="button" class="primary" data-pk="login" data-next="reload">Sign in with passkey</button>'
      : ''}${form.signupUrl ? `<p><a href="${escapeHtml(form.signupUrl)}">Have an invite? Create your passkey</a></p>` : ''}${tokenField(false)}`;
  } else {
    fields = `<p>Enter the non-admin connection token your service owner issued for this client. The next screen shows the exact projects and permissions before you approve.</p><label>Connection token <input name="connection_token" type="password" autocomplete="off" spellcheck="false" required maxlength="4096"></label><button class="primary" name="action" value="identify">Review permissions</button>`;
  }
  const body = `<h1>Connect to Swarmaa</h1><p>Client: <strong>${escapeHtml(form.clientName)}</strong>. This client name is self-reported.</p><p>Return address: <code>${escapeHtml(form.redirectUri)}</code></p><form method="post" action="/oauth/authorize">${hidden}${fields}<button class="quiet" name="action" value="deny" formnovalidate>Deny</button></form>`;
  return shell('Connect to Swarmaa', body, form.nonce);
}
