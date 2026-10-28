import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError, requireCondition } from '../errors.js';
import { canAccessScope } from '../policy.js';
import type { Principal } from '../types.js';
import { object, string, uuid } from '../validation.js';

export type Db = Pool | PoolClient;
export const newId = randomUUID;
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export function canonicalJson(value: unknown): string {
  function normalize(v: unknown, depth: number): unknown {
    requireCondition(depth <= 16, 400, 'invalid_arguments', 'JSON nesting exceeds 16 levels.');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      requireCondition(!v.includes('\u0000'),400,'invalid_arguments','JSON strings must not contain NUL.');
      return v;
    }
    if (typeof v === 'number') {
      requireCondition(Number.isFinite(v),400,'invalid_arguments','JSON numbers must be finite.');
      return v;
    }
    requireCondition(typeof v === 'object',400,'invalid_arguments','Values must be representable as JSON.');
    if (Array.isArray(v)) return v.map(item => normalize(item, depth + 1));
    requireCondition(Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null,400,'invalid_arguments','JSON objects must contain plain data.');
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a<b ? -1 : a>b ? 1 : 0).map(([k, item]) => {
      requireCondition(!k.includes('\u0000'),400,'invalid_arguments','JSON keys must not contain NUL.');
      return [k, normalize(item, depth + 1)];
    }));
  }
  const serialized = JSON.stringify(normalize(value, 0));
  requireCondition(typeof serialized === 'string',400,'invalid_arguments','Value must be representable as JSON.');
  return serialized;
}

export function jsonObject(value: unknown, name: string, limit = 65536): Record<string, unknown> {
  const obj = object(value);
  const serialized = canonicalJson(obj);
  requireCondition(Buffer.byteLength(serialized,'utf8')<=limit,400,'invalid_arguments',`${name} exceeds the allowed size.`);
  return obj;
}

export function noExtraKeys(input: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(input)) {
    requireCondition(allowed.includes(key), 400, 'invalid_arguments', `Unknown argument: ${key}.`);
  }
}

export function optionalDate(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  const text = string(value, name, 64);
  const time = Date.parse(text);
  requireCondition(Number.isFinite(time) && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(text), 400, 'invalid_arguments', `${name} must be an ISO-8601 timestamp with timezone.`);
  return new Date(time).toISOString();
}

export function sourceInput(value: unknown, principal: Principal): Record<string, unknown> {
  const input = object(value);
  noExtraKeys(input, ['type', 'reference', 'observed_at']);
  const type = string(input.type, 'source.type', 20);
  requireCondition(['user', 'tool', 'document', 'agent'].includes(type), 400, 'invalid_source', 'source.type must be user, tool, document, or agent.');
  return {
    type,
    reference: string(input.reference, 'source.reference', 2048),
    observed_at: optionalDate(input.observed_at, 'source.observed_at'),
    reported_by: principal.id,
    assurance: 'reported',
  };
}

export function uuidArray(value: unknown, name: string, max = 32): string[] {
  if (value === undefined) return [];
  requireCondition(Array.isArray(value) && value.length <= max, 400, 'invalid_arguments', `${name} must be an array of at most ${max} UUIDs.`);
  return [...new Set(value.map(v => uuid(v, name)))];
}

export function scopeSql(principal: Principal): [boolean, string[]] {
  return [principal.role === 'admin' && principal.scopes.includes('*'), principal.scopes];
}

export async function audit(db: Db, p: Principal, scope: string, operation: string, subjectId: string, details: Record<string, unknown> = {}): Promise<void> {
  await db.query('INSERT INTO audit_log (id,tenant_id,actor_id,scope,operation,subject_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [newId(), p.tenantId, p.id, scope, operation, subjectId, JSON.stringify(details)]);
}

export type EventType = 'task.updated' | 'memory.changed' | 'message.created' | 'message.updated' | 'swarm.updated' | 'agent.updated' | 'question.created' | 'question.answered' | 'thread.read' | 'bot.updated';

export async function event(db: Db, p: Principal, scope: string, name: EventType, subjectId: string, metadata: Record<string, unknown>): Promise<void> {
  // Other subsystems also emit task updates; fill their identifiers without a round trip on the hot checkpoint path.
  if (name === 'task.updated' && metadata.kind === undefined) {
    const task = (await db.query<{ kind: string; thread_id: string | null }>(
      'SELECT kind,thread_id FROM tasks WHERE id=$1 AND tenant_id=$2 AND scope=$3',
      [subjectId, p.tenantId, scope]
    )).rows[0];
    if (task) metadata = { ...metadata, kind: task.kind, ...(task.thread_id ? { thread_id: task.thread_id } : {}) };
  }
  await db.query('INSERT INTO events (id,tenant_id,scope,name,subject_id,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [newId(), p.tenantId, scope, name, subjectId, JSON.stringify(metadata)]);
  await db.query("SELECT pg_notify('swarmaa_events', $1)", [p.tenantId]);
}

export async function scopeLock(db: PoolClient, namespace: string, p: Principal, scope: string, key = ''): Promise<void> {
  // Advisory hash collisions serialize unrelated work; they cannot authorize access.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([namespace, p.tenantId, scope, key])]);
}

// ponytail: one Teams writer per tenant; per-swarm or per-agent keys if one tenant's throughput ever matters.
export async function teamsLock(db: Db, tenantId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('teams:' || $1, 0))", [tenantId]);
}

export function requireFound<T>(row: T | undefined, label: string): T {
  if (!row) throw new AppError(404, 'not_found', `${label} was not found in your permitted scopes.`);
  return row;
}

export function assertKnownScope(p: Principal, scope: string): void {
  if (!canAccessScope(p, scope)) throw new AppError(403, 'scope_forbidden', 'This connection does not have access to that scope.');
}
