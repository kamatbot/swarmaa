import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hashToken, newToken } from './auth.js';
import type { Permission, Role } from './types.js';

type Database = Pick<Pool | PoolClient, 'query'>;
export async function provisionConnection(db: Database, input: {
  tenant: string; name: string; role: Role; scopes: string[]; permissions: Permission[];
}) {
  const id = randomUUID(), token = newToken();
  const { tenant, name, role, scopes, permissions } = input;
  await db.query('INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [id, tenant, name, role, scopes, permissions, hashToken(token)]);
  return { id, ...input, token };
}

export async function provisionRelayConnection(db: Database, template: string, device: string): Promise<string> {
  // Names are tenant-local. Refuse ambiguity rather than selecting an arbitrary tenant.
  const result = await db.query('SELECT tenant_id,role,scopes,permissions FROM principals WHERE name=$1 AND NOT disabled', [template]);
  if (result.rows.length !== 1) throw new Error('template_missing');
  const row = result.rows[0];
  if (row.role !== 'frontend' || row.permissions.includes('admin') || row.scopes.includes('*')) throw new Error('template_invalid');
  const name = `relay-${device.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'device'}-${randomBytes(2).toString('hex')}`;
  return (await provisionConnection(db, { tenant: row.tenant_id, name, role: 'frontend', scopes: row.scopes, permissions: row.permissions })).token;
}
