import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Pool, PoolClient } from 'pg';
import { hashToken, newToken } from './auth.js';
import { transaction } from './db.js';
import { AppError } from './errors.js';
import { tokenHash } from './oauth.js';
import { INVITE_ONLY, type PasskeySummary } from './passkey-ui.js';
import { ROLE_PERMISSIONS } from './policy.js';
import type { ServerConfig } from './types.js';

/** Single owner per tenant for now. */
export const PASSKEY_TENANT = 'personal';
export const OWNER_COOKIE = 'swarmaa_owner';
export const BIND_COOKIE = 'swarmaa_pk';
const SESSION_SECONDS = 12 * 3600;
const CHALLENGE_SECONDS = 300;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{43}$/u;

// ponytail: tiny second-level-suffix list instead of the full public suffix list; set PASSKEY_RP_ID for anything else.
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

export function registrableDomain(host: string): string | null {
  const h = host.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(h) || /^\d+(\.\d+){3}$/u.test(h)) return null;
  const labels = h.split('.');
  const n = labels.length;
  const take = n >= 3 && labels[n - 1]!.length === 2 && SECOND_LEVEL.has(labels[n - 2]!) ? 3 : 2;
  return labels.slice(-take).join('.');
}

export interface RpConfig { rpID: string; origins: string[] }

/** Passkeys need an HTTPS origin whose host is the rpID or a subdomain of it. */
export function rpConfig(publicUrl: string, override?: string): RpConfig | null {
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:') return null;
  const wanted = override?.trim().toLowerCase();
  const rpID = wanted ? (wanted.includes('.') ? wanted : null) : registrableDomain(url.hostname);
  if (!rpID || (url.hostname !== rpID && !url.hostname.endsWith(`.${rpID}`))) return null;
  return { rpID, origins: [...new Set([url.origin, `https://${rpID}`])] };
}

/** Owner cookie: HttpOnly, SameSite=Lax, Secure on https. Pass null to clear it. */
export function ownerCookie(token: string | null, secure: boolean): string {
  return `${OWNER_COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? SESSION_SECONDS : 0}${secure ? '; Secure' : ''}`;
}

/** Binds WebAuthn challenges to this browser; only sent to /account routes. */
export function bindCookie(value: string, secure: boolean): string {
  return `${BIND_COOKIE}=${value}; Path=/account; HttpOnly; SameSite=Lax; Max-Age=${CHALLENGE_SECONDS}${secure ? '; Secure' : ''}`;
}

export function newBinding(existing?: string): string {
  return existing && COOKIE_VALUE.test(existing) ? existing : randomBytes(32).toString('base64url');
}

const failed = (): AppError => new AppError(403, 'passkey_failed', 'Passkey verification failed.');
const forbidden = (): AppError => new AppError(403, 'forbidden', INVITE_ONLY);

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'invalid_request', 'Invalid request.');
  return value as Record<string, unknown>;
}

/** Reads the challenge the browser signed so the matching single-use row can be consumed. */
function signedChallenge(response: unknown): string {
  try {
    const raw = (response as { response?: { clientDataJSON?: unknown } }).response?.clientDataJSON;
    if (typeof raw !== 'string' || raw.length > 4096) throw new Error();
    const challenge = (JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { challenge?: unknown }).challenge;
    if (typeof challenge !== 'string' || challenge.length > 256) throw new Error();
    return challenge;
  } catch { throw failed(); }
}

export class PasskeyService {
  readonly rp: RpConfig | null;

  constructor(private readonly pool: Pool, config: ServerConfig) {
    this.rp = rpConfig(config.publicUrl, config.passkeyRpId);
  }

  private need(): RpConfig {
    if (!this.rp) throw new AppError(409, 'passkeys_unavailable', 'Passkeys need the public HTTPS address.');
    return this.rp;
  }

  async hasPasskeys(): Promise<boolean> {
    return (await this.pool.query('SELECT 1 FROM owner_passkeys LIMIT 1')).rows.length > 0;
  }

  /** One-time signup code. Only its hash is stored; the caller prints the code once. */
  async createInvite(minutes = 30): Promise<string> {
    return this.mintInvite(PASSKEY_TENANT, minutes);
  }

  async createGatewayInvite(minutes = 30): Promise<{ code: string; tenantId: string }> {
    const tenantId = `t_${randomBytes(16).toString('hex')}`;
    return { code: await this.mintInvite(tenantId, minutes), tenantId };
  }

  private async mintInvite(tenantId: string, minutes: number): Promise<string> {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw new AppError(400, 'invalid_minutes', 'Minutes must be between 1 and 1440.');
    const code = randomBytes(32).toString('base64url');
    await this.pool.query(
      'INSERT INTO passkey_invites(id,tenant_id,code_hash,expires_at) VALUES ($1,$2,$3,now()+make_interval(secs=>$4))',
      [randomUUID(), tenantId, tokenHash(code), Math.round(minutes * 60)],
    );
    return code;
  }

  async inviteUsable(code: string | undefined): Promise<boolean> {
    if (!code || !COOKIE_VALUE.test(code)) return false;
    return (await this.pool.query('SELECT 1 FROM passkey_invites WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now()', [tokenHash(code)])).rows.length > 0;
  }

  /** Returns the signed-in tenant for an owner cookie value, or null. */
  async session(token: string | undefined): Promise<{ tenantId: string } | null> {
    if (!token || !COOKIE_VALUE.test(token)) return null;
    const result = await this.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM owner_sessions WHERE token_hash=$1 AND expires_at>now()', [tokenHash(token)]);
    return result.rows[0] ? { tenantId: result.rows[0].tenant_id } : null;
  }

  async endSession(token: string | undefined): Promise<void> {
    if (token && COOKIE_VALUE.test(token)) await this.pool.query('DELETE FROM owner_sessions WHERE token_hash=$1', [tokenHash(token)]);
  }

  private async startSession(client: Pick<PoolClient, 'query'>, tenantId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await client.query('DELETE FROM owner_sessions WHERE expires_at<=now()');
    await client.query(
      'INSERT INTO owner_sessions(id,tenant_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+make_interval(secs=>$4))',
      [randomUUID(), tenantId, tokenHash(token), SESSION_SECONDS],
    );
    return token;
  }

  private async storeChallenge(purpose: 'register' | 'authenticate', challenge: string, browser: string, tenantId: string | null): Promise<void> {
    await this.pool.query("DELETE FROM webauthn_challenges WHERE expires_at<=now()-interval '1 hour'");
    await this.pool.query(
      'INSERT INTO webauthn_challenges(id,tenant_id,purpose,challenge,bound_to,expires_at) VALUES ($1,$2,$3,$4,$5,now()+make_interval(secs=>$6))',
      [randomUUID(), tenantId, purpose, challenge, tokenHash(browser), CHALLENGE_SECONDS],
    );
  }

  /** Single use, unexpired, and only for the browser that asked for it. */
  private async consumeChallenge(purpose: 'register' | 'authenticate', challenge: string, browser: string, tenantId: string | null): Promise<void> {
    const used = await this.pool.query(
      `UPDATE webauthn_challenges SET used_at=now(),tenant_id=$4 WHERE purpose=$1 AND challenge=$2 AND bound_to=$3
       AND (tenant_id=$4 OR (purpose='authenticate' AND tenant_id IS NULL)) AND used_at IS NULL AND expires_at>now() RETURNING id`,
      [purpose, challenge, tokenHash(browser), tenantId],
    );
    if (!used.rows.length) throw failed();
  }

  /** Registration needs an unused invite or an owner session (a session wins and leaves the invite alone). */
  private async authorizeRegistration(code: string | undefined, sessionToken: string | undefined): Promise<{ mode: 'session' | 'invite'; tenantId: string }> {
    const session = await this.session(sessionToken);
    if (session) return { mode: 'session', tenantId: session.tenantId };
    if (code && COOKIE_VALUE.test(code)) {
      const invite = await this.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM passkey_invites WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now()', [tokenHash(code)]);
      if (invite.rows[0]) return { mode: 'invite', tenantId: invite.rows[0].tenant_id };
    }
    throw forbidden();
  }

  async registrationOptions(input: { code?: string; sessionToken?: string; browser: string }) {
    const rp = this.need();
    const { tenantId } = await this.authorizeRegistration(input.code, input.sessionToken);
    const existing = await this.pool.query<{ credential_id: string; transports: string[] }>('SELECT credential_id,transports FROM owner_passkeys WHERE tenant_id=$1', [tenantId]);
    const options = await generateRegistrationOptions({
      rpName: 'Swarmaa', rpID: rp.rpID, userName: 'owner', userDisplayName: 'Swarmaa owner',
      userID: createHash('sha256').update(`swarmaa-owner:${tenantId}`).digest(),
      attestationType: 'none', timeout: CHALLENGE_SECONDS * 1000,
      excludeCredentials: existing.rows.map(row => ({ id: row.credential_id, transports: row.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    await this.storeChallenge('register', options.challenge, input.browser, tenantId);
    return options;
  }

  /** Verifies the attestation, stores the credential, spends the invite, and returns a new owner session token. */
  async verifyRegistration(input: { code?: string; sessionToken?: string; browser: string; response: unknown; name?: unknown }): Promise<string> {
    const rp = this.need();
    const { mode, tenantId } = await this.authorizeRegistration(input.code, input.sessionToken);
    const response = input.response as RegistrationResponseJSON;
    plainObject(response);
    await this.consumeChallenge('register', signedChallenge(response), input.browser, tenantId);
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response, expectedChallenge: signedChallenge(response), expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: true,
      });
    } catch { throw failed(); }
    if (!verified.verified) throw failed();
    const { credential } = verified.registrationInfo;
    const name = typeof input.name === 'string' && input.name.trim() && input.name.length <= 60
      ? input.name.trim() : `Passkey ${new Date().toISOString().slice(0, 10)}`;
    try {
      return await transaction(this.pool, async client => {
        if (mode === 'invite') {
          const spent = await client.query('UPDATE passkey_invites SET used_at=now() WHERE code_hash=$1 AND tenant_id=$2 AND used_at IS NULL AND expires_at>now() RETURNING id', [tokenHash(input.code!), tenantId]);
          if (!spent.rows.length) throw forbidden();
        }
        await client.query(
          'INSERT INTO owner_passkeys(id,tenant_id,credential_id,public_key,counter,transports,name) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(), tenantId, credential.id, Buffer.from(credential.publicKey), credential.counter, credential.transports ?? [], name],
        );
        return this.startSession(client, tenantId);
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw failed(); // e.g. the credential is already registered
    }
  }

  async authenticationOptions(browser: string) {
    const rp = this.need();
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required', timeout: CHALLENGE_SECONDS * 1000 });
    await this.storeChallenge('authenticate', options.challenge, browser, null);
    return options;
  }

  /** Verifies the assertion (rejecting counter regression) and returns a new owner session token. */
  async verifyAuthentication(input: { browser: string; response: unknown }): Promise<string> {
    const rp = this.need();
    const response = input.response as AuthenticationResponseJSON;
    plainObject(response);
    const challenge = signedChallenge(response);
    if (typeof response.id !== 'string' || response.id.length > 1400) throw failed();
    const found = await this.pool.query<{ id: string; tenant_id: string; public_key: Buffer; counter: string; transports: string[] }>(
      'SELECT id,tenant_id,public_key,counter,transports FROM owner_passkeys WHERE credential_id=$1', [response.id],
    );
    const row = found.rows[0];
    await this.consumeChallenge('authenticate', challenge, input.browser, row?.tenant_id ?? null);
    if (!row) throw failed();
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: true,
        credential: { id: response.id, publicKey: new Uint8Array(row.public_key), counter: Number(row.counter), transports: row.transports },
      });
    } catch { throw failed(); }
    if (!verified.verified) throw failed();
    return transaction(this.pool, async client => {
      // Compare-and-set: a concurrent replay of the same assertion cannot also advance the counter.
      const updated = await client.query('UPDATE owner_passkeys SET counter=$2,last_used_at=now() WHERE id=$1 AND counter=$3 RETURNING id', [row.id, verified.authenticationInfo.newCounter, row.counter]);
      if (!updated.rows.length) throw failed();
      return this.startSession(client, row.tenant_id);
    });
  }

  async list(sessionToken: string | undefined): Promise<PasskeySummary[]> {
    const session = await this.session(sessionToken);
    if (!session) throw forbidden();
    const rows = await this.pool.query<{ id: string; name: string; created_at: Date; last_used_at: Date | null }>(
      'SELECT id,name,created_at,last_used_at FROM owner_passkeys WHERE tenant_id=$1 ORDER BY created_at', [session.tenantId],
    );
    return rows.rows.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }

  async createWorker(sessionToken: string | undefined, name: unknown): Promise<{ id: string; token: string; scopes: string[] }> {
    const session = await this.session(sessionToken);
    if (!session) throw forbidden();
    if (typeof name !== 'string' || name.length > 100 || !/^[a-z][a-z0-9_.-]+$/u.test(name)) throw new AppError(400, 'invalid_name', 'Use a lowercase worker name, such as worker-mac.');
    const rows = await this.pool.query<{ scope: string }>(
      "SELECT DISTINCT unnest(scopes) AS scope FROM principals WHERE tenant_id=$1 AND role='frontend' AND disabled=false AND NOT ('admin'=ANY(permissions)) AND NOT ('*'=ANY(scopes)) ORDER BY scope", [session.tenantId],
    );
    const scopes = rows.rows.length ? rows.rows.map(row => row.scope) : ['project:general'];
    if (scopes.length > 512) throw new AppError(409, 'too_many_scopes', 'A bridge can connect at most 512 projects.');
    const id = randomUUID(), token = newToken();
    const created = await this.pool.query(
      "INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,'worker',$4,$5,$6) ON CONFLICT (tenant_id,name) DO NOTHING RETURNING id",
      [id, session.tenantId, name, scopes, ROLE_PERMISSIONS.worker, hashToken(token)],
    );
    if (!created.rows.length) throw new AppError(409, 'name_taken', 'That connection name is already in use.');
    return { id, token, scopes };
  }

  async remove(sessionToken: string | undefined, id: unknown): Promise<void> {
    const session = await this.session(sessionToken);
    if (!session) throw forbidden();
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(id)) throw new AppError(400, 'invalid_request', 'Invalid request.');
    await transaction(this.pool, async client => {
      const all = await client.query('SELECT id FROM owner_passkeys WHERE tenant_id=$1 FOR UPDATE', [session.tenantId]);
      if (all.rows.length <= 1) throw new AppError(409, 'last_passkey', 'You cannot remove your last passkey.');
      await client.query('DELETE FROM owner_passkeys WHERE id=$1 AND tenant_id=$2', [id, session.tenantId]);
    });
  }
}
