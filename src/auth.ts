import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuthBackend, Principal } from './types.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newToken(): string {
  return `cn_${randomBytes(32).toString('base64url')}`;
}

export function principalFromRow(row: Record<string, unknown>): Principal {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), name: String(row.name),
    role: row.role as Principal['role'], scopes: row.scopes as string[],
    permissions: row.permissions as Principal['permissions'],
    credentialVersion: Number(row.credential_version),
  };
}

export class AuthService implements AuthBackend {
  constructor(private readonly pool: Pool) {}

  async authenticate(token: string): Promise<Principal | null> {
    if (!/^cn_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const result = await this.pool.query('SELECT * FROM principals WHERE token_hash = $1 AND disabled = false', [hashToken(token)]);
    return result.rows[0] ? principalFromRow(result.rows[0]) : null;
  }

  async getPrincipal(id: string): Promise<Principal | null> {
    const result = await this.pool.query('SELECT * FROM principals WHERE id = $1 AND disabled = false', [id]);
    return result.rows[0] ? principalFromRow(result.rows[0]) : null;
  }
}
