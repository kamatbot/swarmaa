import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '../db.js';
import { AppError, requireCondition } from '../errors.js';
import { canAccessScope, requirePermission, requireScope } from '../policy.js';
import { fenceUntrusted, SOURCE_EVENT_GUIDANCE } from '../safety/fence.js';
import type { Principal } from '../types.js';
import { integer, object, optionalString, scopeName, string, uuid } from '../validation.js';
import { SecretBox } from '../webhook.js';
import {
  classifyGithubEvent,
  DEFAULT_SOURCE_RULES,
  normalizeGithubEvent,
  parseThreadRef,
  threadRef,
  threadRefs,
  validateSourceRules,
  verifyGithubSignature,
  type NormalizedDigest,
  type SourceRules,
} from './source-filter.js';
import { assertKnownScope, audit, canonicalJson, event, newId, noExtraKeys, requireFound, scopeLock, scopeSql, sha256, type Db } from './shared.js';
import { TaskService, type TaskRow } from './tasks.js';
import { assignThreadSeq, clipUtf8, enqueueAgentTurn, type AgentRow } from './teams.js';

/** A patch branch this service creates. Full task ids are exact; the older 8-hex form is a prefix. */
export function swarmBranchRef(ref: string): { provider: string; taskId: string; exact: boolean } | null {
  const match = /^swarmaa\/(claude|codex|antigravity)\/([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)$/iu.exec(ref);
  if (!match) return null;
  const taskId = match[2]!.toLowerCase();
  return { provider: match[1]!.toLowerCase(), taskId, exact: taskId.includes('-') };
}

export interface TaskSubscriptionRow {
  id: string;
  tenant_id: string;
  scope: string;
  task_id: string;
  source_id: string;
  external_thread_ref: string;
  created_via: 'tool' | 'branch_match';
  created_by: string;
  budget_remaining: number;
  active: boolean;
  expires_at: Date;
  last_delivery_at: Date | null;
  idempotency_key: string | null;
  created_at: Date;
}

export function subscriptionView(row: TaskSubscriptionRow): Record<string, unknown> {
  return {
    id: row.id,
    task_id: row.task_id,
    source_id: row.source_id,
    external_thread_ref: row.external_thread_ref,
    created_via: row.created_via,
    budget_remaining: row.budget_remaining,
    active: row.active,
    expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    last_delivery_at: row.last_delivery_at ? (row.last_delivery_at instanceof Date ? row.last_delivery_at.toISOString() : row.last_delivery_at) : null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

export interface SourceRow {
  id: string;
  tenant_id: string;
  scope: string;
  kind: 'github';
  name: string;
  repo_full_name: string;
  secret_ciphertext: string;
  previous_secret_ciphertext: string | null;
  previous_secret_until: Date | null;
  accept_mode: 'off' | 'observe' | 'auto';
  rules: SourceRules;
  bot_id: string | null;
  cooldown_seconds: number;
  created_by: string;
  version: number;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface SourceDeliveryRow {
  id: string;
  tenant_id: string;
  scope: string;
  source_id: string;
  delivery_id: string;
  event_type: string;
  action: string | null;
  body_sha256: string;
  digest: NormalizedDigest;
  thread_ref: string | null;
  classification: 'explicit' | 'candidate' | 'ignore' | null;
  reason: string | null;
  mode_at_receipt: 'off' | 'observe' | 'auto';
  status: 'received' | 'ignored' | 'observed' | 'deferred' | 'dispatched' | 'continued' | 'failed';
  would_do: Record<string, unknown> | null;
  task_id: string | null;
  message_id: string | null;
  attempts: number;
  next_attempt_at: Date;
  received_at: Date;
  processed_at: Date | null;
}

const MODE_RANK: Record<string, number> = { off: 0, observe: 1, auto: 2 };
const GITHUB_REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export function sourceView(row: SourceRow, counts: Record<string, number> = {}, publicUrl = ''): Record<string, unknown> {
  const base = publicUrl ? publicUrl.replace(/\/$/, '') : '';
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    name: row.name,
    repo_full_name: row.repo_full_name,
    accept_mode: row.accept_mode,
    rules: row.rules,
    bot_id: row.bot_id,
    cooldown_seconds: row.cooldown_seconds ?? 0,
    version: row.version,
    archived: row.archived,
    webhook_url: base ? `${base}/hooks/github/${row.id}` : `/hooks/github/${row.id}`,
    counts_24h: counts,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function deliveryView(row: SourceDeliveryRow): Record<string, unknown> {
  return {
    id: row.id,
    delivery_id: row.delivery_id,
    event_type: row.event_type,
    action: row.action,
    body_sha256: row.body_sha256,
    digest: row.digest,
    thread_ref: row.thread_ref,
    classification: row.classification,
    reason: row.reason,
    mode_at_receipt: row.mode_at_receipt,
    status: row.status,
    would_do: row.would_do,
    task_id: row.task_id,
    message_id: row.message_id,
    attempts: row.attempts,
    next_attempt_at: row.next_attempt_at.toISOString(),
    received_at: row.received_at.toISOString(),
    processed_at: row.processed_at?.toISOString() ?? null,
  };
}

export class SourceService {
  constructor(private readonly pool: Pool) {}

  async createSource(
    p: Principal,
    input: Record<string, unknown>,
    encryptionKey: string,
    publicUrl = ''
  ): Promise<{ id: string; name: string; repo_full_name: string; accept_mode: string; cooldown_seconds: number; webhook_url: string; secret: string }> {
    requireCondition(Boolean(encryptionKey && /^[0-9a-f]{64}$/i.test(encryptionKey)), 503, 'events_not_configured', 'EVENT_ENCRYPTION_KEY is required.');
    noExtraKeys(input, ['scope', 'repo_full_name', 'name', 'bot_id', 'rules', 'cooldown_seconds']);
    const scope = scopeName(input.scope);
    assertKnownScope(p, scope);
    requireScope(p, scope);

    const repoFullName = string(input.repo_full_name, 'repo_full_name', 140);
    requireCondition(GITHUB_REPO_RE.test(repoFullName), 400, 'invalid_arguments', 'repo_full_name must match owner/repo pattern.');

    const name = input.name !== undefined ? string(input.name, 'name', 64) : repoFullName.slice(0, 64);
    const botId = input.bot_id !== undefined ? uuid(input.bot_id, 'bot_id') : null;
    const rules = validateSourceRules(input.rules);
    const cooldownSeconds = input.cooldown_seconds !== undefined
      ? integer(input.cooldown_seconds, 'cooldown_seconds', 0, 86400)
      : 0;

    const id = newId();
    const rawSecret = randomBytes(32).toString('hex');
    const box = new SecretBox(encryptionKey);
    const ciphertext = box.encrypt(rawSecret, `source:${id}`);

    await this.pool.query(
      `INSERT INTO sources
         (id, tenant_id, scope, kind, name, repo_full_name, secret_ciphertext, accept_mode, rules, bot_id, created_by, cooldown_seconds)
       VALUES ($1, $2, $3, 'github', $4, $5, $6, 'observe', $7::jsonb, $8, $9, $10)`,
      [id, p.tenantId, scope, name, repoFullName, ciphertext, JSON.stringify(rules), botId, p.id, cooldownSeconds]
    );

    await audit(this.pool, p, scope, 'source.create', id, { repo: repoFullName, name, cooldown_seconds: cooldownSeconds });

    const base = publicUrl ? publicUrl.replace(/\/$/, '') : '';
    return {
      id,
      name,
      repo_full_name: repoFullName,
      accept_mode: 'observe',
      cooldown_seconds: cooldownSeconds,
      webhook_url: base ? `${base}/hooks/github/${id}` : `/hooks/github/${id}`,
      secret: rawSecret,
    };
  }

  async list(p: Principal, input: Record<string, unknown>): Promise<{ sources: unknown[] }> {
    noExtraKeys(input, ['scope']);
    requirePermission(p, 'task:read');

    const [all, grantedScopes] = scopeSql(p);
    const scope = input.scope !== undefined ? scopeName(input.scope) : null;
    if (scope) {
      assertKnownScope(p, scope);
      requireScope(p, scope);
    }

    const rows = (await this.pool.query<SourceRow>(
      `SELECT * FROM sources
       WHERE tenant_id = $1 AND NOT archived
         AND ($2::boolean OR scope = ANY($3::text[]))
         AND ($4::text IS NULL OR scope = $4)
       ORDER BY created_at DESC`,
      [p.tenantId, all, grantedScopes, scope]
    )).rows;

    const sourceIds = rows.map(r => r.id);
    const countsMap = new Map<string, Record<string, number>>();

    if (sourceIds.length > 0) {
      const countsRes = await this.pool.query<{ source_id: string; status: string; count: string }>(
        `SELECT source_id, status, count(*)::text AS count
         FROM source_deliveries
         WHERE source_id = ANY($1::uuid[]) AND received_at > clock_timestamp() - interval '24 hours'
         GROUP BY source_id, status`,
        [sourceIds]
      );
      for (const c of countsRes.rows) {
        if (!countsMap.has(c.source_id)) countsMap.set(c.source_id, {});
        countsMap.get(c.source_id)![c.status] = Number(c.count);
      }
    }

    const sources = rows.map(r => sourceView(r, countsMap.get(r.id) ?? {}));
    return { sources };
  }

  async get(p: Principal, input: Record<string, unknown>): Promise<{ source: unknown }> {
    noExtraKeys(input, ['source_id']);
    requirePermission(p, 'task:read');

    const sourceId = uuid(input.source_id, 'source_id');
    const [all, grantedScopes] = scopeSql(p);

    const row = (await this.pool.query<SourceRow>(
      `SELECT * FROM sources
       WHERE id = $1 AND tenant_id = $2
         AND ($3::boolean OR scope = ANY($4::text[]))`,
      [sourceId, p.tenantId, all, grantedScopes]
    )).rows[0];
    requireFound(row, 'Source');

    const countsRes = await this.pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
       FROM source_deliveries
       WHERE source_id = $1 AND received_at > clock_timestamp() - interval '24 hours'
       GROUP BY status`,
      [sourceId]
    );
    const counts: Record<string, number> = {};
    for (const c of countsRes.rows) counts[c.status] = Number(c.count);

    return { source: sourceView(row, counts) };
  }

  async update(p: Principal, input: Record<string, unknown>): Promise<{ source: unknown }> {
    noExtraKeys(input, ['source_id', 'expected_version', 'name', 'rules', 'bot_id', 'accept_mode', 'cooldown_seconds']);
    requirePermission(p, 'routing:manage');

    const sourceId = uuid(input.source_id, 'source_id');
    const expectedVersion = integer(input.expected_version, 'expected_version', 1, 2147483647);
    const [all, grantedScopes] = scopeSql(p);

    return await transaction(this.pool, async db => {
      const existing = (await db.query<SourceRow>(
        `SELECT * FROM sources
         WHERE id = $1 AND tenant_id = $2
           AND ($3::boolean OR scope = ANY($4::text[]))
         FOR UPDATE`,
        [sourceId, p.tenantId, all, grantedScopes]
      )).rows[0];
      requireFound(existing, 'Source');
      requireCondition(existing.version === expectedVersion, 409, 'conflict', 'Source version conflict.');

      let nextMode = existing.accept_mode;
      if (input.accept_mode !== undefined) {
        const mode = string(input.accept_mode, 'accept_mode', 16) as 'off' | 'observe' | 'auto';
        requireCondition(['off', 'observe', 'auto'].includes(mode), 400, 'invalid_arguments', 'Invalid accept_mode.');
        if (MODE_RANK[mode] > MODE_RANK[existing.accept_mode]) {
          throw new AppError(403, 'owner_cli_required', 'Raising accept_mode requires the local owner CLI.');
        }
        nextMode = mode;
      }

      const nextName = input.name !== undefined ? string(input.name, 'name', 64) : existing.name;
      const nextRules = input.rules !== undefined ? validateSourceRules(input.rules, existing.rules) : existing.rules;
      const nextBotId = input.bot_id !== undefined ? (input.bot_id === null ? null : uuid(input.bot_id, 'bot_id')) : existing.bot_id;
      const nextCooldownSeconds = input.cooldown_seconds !== undefined
        ? integer(input.cooldown_seconds, 'cooldown_seconds', 0, 86400)
        : (existing.cooldown_seconds ?? 0);

      const updated = (await db.query<SourceRow>(
        `UPDATE sources
         SET name = $1, rules = $2::jsonb, bot_id = $3, accept_mode = $4,
             cooldown_seconds = $5, version = version + 1, updated_at = clock_timestamp()
         WHERE id = $6 RETURNING *`,
        [nextName, JSON.stringify(nextRules), nextBotId, nextMode, nextCooldownSeconds, sourceId]
      )).rows[0]!;

      await audit(db, p, existing.scope, 'source.update', sourceId, {
        name: nextName,
        accept_mode: nextMode,
        cooldown_seconds: nextCooldownSeconds,
        version: updated.version,
      });

      return { source: sourceView(updated, {}) };
    });
  }

  async deliveries(p: Principal, input: Record<string, unknown>): Promise<{ deliveries: unknown[] }> {
    noExtraKeys(input, ['source_id', 'after', 'limit', 'status']);
    requirePermission(p, 'task:read');

    const sourceId = uuid(input.source_id, 'source_id');
    const [all, grantedScopes] = scopeSql(p);

    const source = (await this.pool.query<SourceRow>(
      `SELECT * FROM sources WHERE id = $1 AND tenant_id = $2 AND ($3::boolean OR scope = ANY($4::text[]))`,
      [sourceId, p.tenantId, all, grantedScopes]
    )).rows[0];
    requireFound(source, 'Source');

    const limit = input.limit !== undefined ? integer(input.limit, 'limit', 1, 100) : 50;
    const after = input.after !== undefined ? uuid(input.after, 'after') : null;
    const status = input.status !== undefined ? string(input.status, 'status', 32) : null;

    let cursorRow: SourceDeliveryRow | undefined;
    if (after) {
      cursorRow = (await this.pool.query<SourceDeliveryRow>(
        'SELECT * FROM source_deliveries WHERE id = $1 AND source_id = $2',
        [after, sourceId]
      )).rows[0];
    }

    const rows = (await this.pool.query<SourceDeliveryRow>(
      `SELECT * FROM source_deliveries
       WHERE source_id = $1
         AND ($2::text IS NULL OR status = $2)
         AND ($3::timestamptz IS NULL OR received_at < $3)
       ORDER BY received_at DESC, id DESC
       LIMIT $4`,
      [sourceId, status, cursorRow ? cursorRow.received_at : null, limit]
    )).rows;

    return { deliveries: rows.map(deliveryView) };
  }

  async setMode(p: Principal, sourceId: string, mode: 'off' | 'observe' | 'auto'): Promise<SourceRow> {
    requireCondition(['off', 'observe', 'auto'].includes(mode), 400, 'invalid_arguments', 'Invalid accept_mode.');
    return await transaction(this.pool, async db => {
      const existing = (await db.query<SourceRow>(
        'SELECT * FROM sources WHERE id = $1 FOR UPDATE',
        [sourceId]
      )).rows[0];
      requireFound(existing, 'Source');

      const updated = (await db.query<SourceRow>(
        `UPDATE sources
         SET accept_mode = $1, version = version + 1, updated_at = clock_timestamp()
         WHERE id = $2 RETURNING *`,
        [mode, sourceId]
      )).rows[0]!;

      await audit(db, p, existing.scope, 'source.mode', sourceId, {
        previous_mode: existing.accept_mode,
        mode,
        version: updated.version,
      });

      return updated;
    });
  }

  async rotateSecret(p: Principal, sourceId: string, encryptionKey: string): Promise<{ newSecret: string }> {
    requireCondition(Boolean(encryptionKey && /^[0-9a-f]{64}$/i.test(encryptionKey)), 503, 'events_not_configured', 'EVENT_ENCRYPTION_KEY is required.');
    return await transaction(this.pool, async db => {
      const existing = (await db.query<SourceRow>(
        'SELECT * FROM sources WHERE id = $1 FOR UPDATE',
        [sourceId]
      )).rows[0];
      requireFound(existing, 'Source');

      const newSecret = randomBytes(32).toString('hex');
      const box = new SecretBox(encryptionKey);
      const ciphertext = box.encrypt(newSecret, `source:${sourceId}`);

      await db.query(
        `UPDATE sources
         SET secret_ciphertext = $1,
             previous_secret_ciphertext = $2,
             previous_secret_until = clock_timestamp() + interval '24 hours',
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $3`,
        [ciphertext, existing.secret_ciphertext, sourceId]
      );

      await audit(db, p, existing.scope, 'source.rotate', sourceId, { local_owner: true });
      return { newSecret };
    });
  }

  async archive(p: Principal, sourceId: string): Promise<SourceRow> {
    return await transaction(this.pool, async db => {
      const existing = (await db.query<SourceRow>(
        'SELECT * FROM sources WHERE id = $1 FOR UPDATE',
        [sourceId]
      )).rows[0];
      requireFound(existing, 'Source');

      const updated = (await db.query<SourceRow>(
        `UPDATE sources
         SET archived = true, version = version + 1, updated_at = clock_timestamp()
         WHERE id = $1 RETURNING *`,
        [sourceId]
      )).rows[0]!;

      await audit(db, p, existing.scope, 'source.archive', sourceId, { local_owner: true });
      return updated;
    });
  }

  async taskSubscribe(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['task_id', 'thread_ref', 'idempotency_key']);
    const taskId = uuid(input.task_id, 'task_id');
    const rawRef = string(input.thread_ref, 'thread_ref', 300);
    const parsed = parseThreadRef(rawRef);
    const key = string(input.idempotency_key, 'idempotency_key', 200);

    return transaction(this.pool, async db => {
      const task = (await db.query<{
        id: string;
        tenant_id: string;
        scope: string;
        flow_id: string | null;
        status: string;
      }>('SELECT id, tenant_id, scope, flow_id, status FROM tasks WHERE id = $1 AND tenant_id = $2', [taskId, p.tenantId])).rows[0];
      requireFound(task, 'Task');
      assertKnownScope(p, task.scope);
      requireScope(p, task.scope);

      requireCondition(!task.flow_id, 409, 'flow_managed_task', 'Flow tasks cannot be subscribed.');
      requireCondition(task.status !== 'cancelled', 409, 'task_cancelled', 'Cancelled tasks cannot be subscribed.');

      const source = (await db.query<SourceRow>(
        'SELECT * FROM sources WHERE tenant_id = $1 AND scope = $2 AND lower(repo_full_name) = lower($3) AND NOT archived',
        [p.tenantId, task.scope, parsed.repo]
      )).rows[0];
      requireCondition(Boolean(source), 404, 'source_not_found', 'No source found for repo in task scope.');

      const canonicalRef = parsed.kind === 'commit'
        ? threadRef(source.repo_full_name, 'commit', parsed.sha!)
        : threadRef(source.repo_full_name, parsed.kind, parsed.number!);

      const existingIdem = (await db.query<TaskSubscriptionRow>(
        'SELECT * FROM task_subscriptions WHERE tenant_id = $1 AND created_by = $2 AND idempotency_key = $3',
        [p.tenantId, p.id, key]
      )).rows[0];
      if (existingIdem) {
        requireCondition(
          existingIdem.task_id === taskId && existingIdem.external_thread_ref === canonicalRef,
          409,
          'idempotency_conflict',
          'This key was used for a different subscription.'
        );
        return { subscription: subscriptionView(existingIdem), replayed: true };
      }

      const id = newId();
      const res = await db.query<TaskSubscriptionRow>(
        `INSERT INTO task_subscriptions
           (id, tenant_id, scope, task_id, source_id, external_thread_ref, created_via, created_by, budget_remaining, active, expires_at, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, 'tool', $7, 5, true, clock_timestamp() + interval '14 days', $8)
         ON CONFLICT (task_id, external_thread_ref) DO UPDATE
           SET active = true, budget_remaining = 5, expires_at = clock_timestamp() + interval '14 days', idempotency_key = $8
         RETURNING *`,
        [id, p.tenantId, task.scope, taskId, source.id, canonicalRef, p.id, key]
      );
      return { subscription: subscriptionView(res.rows[0]!), replayed: false };
    });
  }

  async taskUnsubscribe(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['subscription_id']);
    const subId = uuid(input.subscription_id, 'subscription_id');
    return transaction(this.pool, async db => {
      const sub = (await db.query<TaskSubscriptionRow>(
        'SELECT * FROM task_subscriptions WHERE id = $1 AND tenant_id = $2',
        [subId, p.tenantId]
      )).rows[0];
      requireFound(sub, 'Subscription');
      assertKnownScope(p, sub.scope);
      requireScope(p, sub.scope);

      if (!sub.active) {
        return { subscription: subscriptionView(sub), unsubscribed: true };
      }

      const res = await db.query<TaskSubscriptionRow>(
        'UPDATE task_subscriptions SET active = false WHERE id = $1 RETURNING *',
        [subId]
      );
      return { subscription: subscriptionView(res.rows[0]!), unsubscribed: true };
    });
  }

  async taskSubscriptions(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['task_id']);
    const taskId = uuid(input.task_id, 'task_id');
    const task = (await this.pool.query<{ id: string; scope: string }>(
      'SELECT id, scope FROM tasks WHERE id = $1 AND tenant_id = $2',
      [taskId, p.tenantId]
    )).rows[0];
    requireFound(task, 'Task');
    assertKnownScope(p, task.scope);
    requireScope(p, task.scope);

    const rows = (await this.pool.query<TaskSubscriptionRow>(
      'SELECT * FROM task_subscriptions WHERE tenant_id = $1 AND task_id = $2 ORDER BY created_at ASC',
      [p.tenantId, taskId]
    )).rows;
    return { subscriptions: rows.map(subscriptionView) };
  }
}

interface InsertDeliveryParams {
  tenantId: string;
  scope: string;
  sourceId: string;
  deliveryId: string;
  eventType: string;
  action?: string | null;
  bodySha256: string;
  digest: NormalizedDigest | Record<string, unknown>;
  threadRef?: string | null;
  classification: 'explicit' | 'candidate' | 'ignore' | null;
  reason: string | null;
  modeAtReceipt: 'off' | 'observe' | 'auto';
  status: 'received' | 'ignored' | 'observed' | 'deferred' | 'dispatched' | 'continued' | 'failed';
  wouldDo?: Record<string, unknown> | null;
}

async function insertDelivery(
  pool: Db,
  params: InsertDeliveryParams
): Promise<{ inserted: boolean; id: string }> {
  const deliveryDbId = newId();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO source_deliveries
       (id, tenant_id, scope, source_id, delivery_id, event_type, action, body_sha256, digest, thread_ref, classification, reason, mode_at_receipt, status, would_do)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb)
     ON CONFLICT (source_id, delivery_id) DO NOTHING
     RETURNING id`,
    [
      deliveryDbId,
      params.tenantId,
      params.scope,
      params.sourceId,
      params.deliveryId,
      params.eventType,
      params.action ?? null,
      params.bodySha256,
      JSON.stringify(params.digest),
      params.threadRef ?? null,
      params.classification,
      params.reason,
      params.modeAtReceipt,
      params.status,
      params.wouldDo ? JSON.stringify(params.wouldDo) : null,
    ]
  );
  if (res.rowCount === 0) {
    return { inserted: false, id: deliveryDbId };
  }
  return { inserted: true, id: res.rows[0]!.id };
}

export async function receiveGithubDelivery(
  pool: Pool,
  config: { eventEncryptionKey?: string },
  input: {
    sourceId: string;
    eventType: string;
    deliveryId: string;
    signature: string;
    rawBody: Buffer;
  }
): Promise<{ status: 200 | 202 | 401; body: Record<string, unknown> }> {
  const sourceRow = (await pool.query<SourceRow>(
    'SELECT * FROM sources WHERE id = $1',
    [input.sourceId]
  )).rows[0];

  if (!sourceRow || sourceRow.archived) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  if (!config.eventEncryptionKey || !/^[0-9a-f]{64}$/i.test(config.eventEncryptionKey)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  let secret: string;
  let prevSecret: string | null = null;
  try {
    const box = new SecretBox(config.eventEncryptionKey);
    secret = box.decrypt(sourceRow.secret_ciphertext, `source:${sourceRow.id}`);
    if (sourceRow.previous_secret_ciphertext && sourceRow.previous_secret_until) {
      prevSecret = box.decrypt(sourceRow.previous_secret_ciphertext, `source:${sourceRow.id}`);
    }
  } catch {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  const validSig = verifyGithubSignature(secret, input.rawBody, input.signature, prevSecret, sourceRow.previous_secret_until);
  if (!validSig) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  const dup = await pool.query(
    'SELECT id FROM source_deliveries WHERE source_id = $1 AND delivery_id = $2',
    [sourceRow.id, input.deliveryId]
  );
  if (dup.rowCount) {
    return { status: 200, body: { duplicate: true } };
  }

  const bodySha256 = sha256(input.rawBody.toString('utf8'));

  let payload: any;
  try {
    payload = JSON.parse(input.rawBody.toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Not object');
  } catch {
    await insertDelivery(pool, {
      tenantId: sourceRow.tenant_id,
      scope: sourceRow.scope,
      sourceId: sourceRow.id,
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      bodySha256,
      digest: {},
      classification: 'ignore',
      reason: 'bad_json',
      modeAtReceipt: sourceRow.accept_mode,
      status: 'ignored',
    });
    return { status: 202, body: { received: true } };
  }

  if (input.eventType === 'ping') {
    await insertDelivery(pool, {
      tenantId: sourceRow.tenant_id,
      scope: sourceRow.scope,
      sourceId: sourceRow.id,
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      bodySha256,
      digest: {},
      classification: 'ignore',
      reason: 'ping',
      modeAtReceipt: sourceRow.accept_mode,
      status: 'ignored',
    });
    return { status: 202, body: { received: true } };
  }

  const repoName = typeof payload.repository?.full_name === 'string' ? payload.repository.full_name.toLowerCase() : '';
  if (repoName !== sourceRow.repo_full_name.toLowerCase()) {
    await insertDelivery(pool, {
      tenantId: sourceRow.tenant_id,
      scope: sourceRow.scope,
      sourceId: sourceRow.id,
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      bodySha256,
      digest: {},
      classification: 'ignore',
      reason: 'repo_mismatch',
      modeAtReceipt: sourceRow.accept_mode,
      status: 'ignored',
    });
    return { status: 202, body: { received: true } };
  }

  const digest = normalizeGithubEvent(input.eventType, payload);

  const subRows = await pool.query<{ external_thread_ref: string }>(
    `SELECT external_thread_ref FROM task_subscriptions
     WHERE tenant_id = $1 AND scope = $2 AND active = true AND expires_at > clock_timestamp()`,
    [sourceRow.tenant_id, sourceRow.scope]
  );
  const subscribedRefs = new Set(subRows.rows.map(r => r.external_thread_ref));

  let branchAmbiguous = false;
  let branchMatchTaskId: string | null = null;
  const isPrAction = input.eventType === 'pull_request' && ['opened', 'reopened', 'synchronize'].includes(digest.action ?? '');
  // Anyone can name a fork branch like ours; only a same-repo PR by an allowed author may claim a task.
  const headRepo = String(payload.pull_request?.head?.repo?.full_name ?? '').toLowerCase();
  const prAuthor = String(payload.pull_request?.user?.login ?? '').toLowerCase();
  const trustedHead = headRepo === sourceRow.repo_full_name.toLowerCase() && sourceRow.rules.allow_authors.some(a => a.toLowerCase() === prAuthor);
  const headMatch = isPrAction && trustedHead && digest.head_ref ? swarmBranchRef(digest.head_ref) : null;

  if (headMatch && sourceRow.rules.auto_subscribe_branches !== false) {
    const candidateTasks = (await pool.query<{ id: string }>(
      headMatch.exact
        ? `SELECT id FROM tasks
           WHERE tenant_id = $1 AND scope = $2 AND id = $3::uuid
             AND (kind = 'patch' OR (kind = 'turn' AND required_capability LIKE '%.patch'))`
        : `SELECT id FROM tasks
           WHERE tenant_id = $1 AND scope = $2 AND id::text LIKE $3
             AND (kind = 'patch' OR (kind = 'turn' AND required_capability LIKE '%.patch'))`,
      [sourceRow.tenant_id, sourceRow.scope, headMatch.exact ? headMatch.taskId : `${headMatch.taskId}%`]
    )).rows;

    if (candidateTasks.length > 1) {
      branchAmbiguous = true;
    } else if (candidateTasks.length === 1) {
      branchMatchTaskId = candidateTasks[0]!.id;
      const prRef = threadRef(sourceRow.repo_full_name, 'pr', digest.number!);
      if (sourceRow.accept_mode === 'auto') {
        await pool.query(
          `INSERT INTO task_subscriptions
             (id, tenant_id, scope, task_id, source_id, external_thread_ref, created_via, created_by, budget_remaining, active, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'branch_match', $7, 5, true, clock_timestamp() + interval '14 days')
           ON CONFLICT (task_id, external_thread_ref) DO NOTHING`,
          [newId(), sourceRow.tenant_id, sourceRow.scope, branchMatchTaskId, sourceRow.id, prRef, sourceRow.created_by]
        );
        subscribedRefs.add(prRef);
      }
    }
  }

  const ctx = { subscribedRefs, selfLogins: new Set<string>() };
  let { classification, reason } = classifyGithubEvent(sourceRow.rules, digest, ctx);

  let status: 'received' | 'ignored' | 'observed' = 'received';
  let statusReason: string | null = reason;
  let wouldDo: Record<string, unknown> | null = null;

  if (branchAmbiguous) {
    classification = 'ignore';
    statusReason = 'branch_ambiguous';
    status = 'ignored';
  } else if (sourceRow.accept_mode === 'off') {
    status = 'ignored';
    statusReason = 'source_off';
  } else if (sourceRow.accept_mode === 'observe') {
    status = 'observed';
    if (branchMatchTaskId) {
      wouldDo = { subscribe_task: branchMatchTaskId };
    } else if (classification === 'explicit' && reason === 'subscribed_thread') {
      const refs = threadRefs(digest);
      const sub = (await pool.query<{ task_id: string }>(
        `SELECT task_id FROM task_subscriptions
         WHERE source_id = $1 AND external_thread_ref = ANY($2::text[]) AND active = true AND expires_at > clock_timestamp()`,
        [sourceRow.id, refs]
      )).rows[0];
      if (sub) wouldDo = { continue_task: sub.task_id };
    } else if (sourceRow.bot_id && ['explicit', 'candidate'].includes(classification)) {
      wouldDo = { post_bot: sourceRow.bot_id };
    }
  } else if (sourceRow.accept_mode === 'auto') {
    if (classification === 'ignore') {
      if (reason === 'closed' && digest.event === 'pull_request') {
        status = 'received';
      } else {
        status = 'ignored';
      }
    } else {
      status = 'received';
    }
  }

  const refs = threadRefs(digest);
  const threadRefVal = refs.length > 0 ? refs[0]! : null;

  const inserted = await insertDelivery(pool, {
    tenantId: sourceRow.tenant_id,
    scope: sourceRow.scope,
    sourceId: sourceRow.id,
    deliveryId: input.deliveryId,
    eventType: input.eventType,
    action: digest.action ?? null,
    bodySha256,
    digest,
    threadRef: threadRefVal,
    classification,
    reason: statusReason,
    modeAtReceipt: sourceRow.accept_mode,
    status,
    wouldDo,
  });

  if (!inserted.inserted) {
    return { status: 200, body: { duplicate: true } };
  }

  const p: Principal = {
    id: sourceRow.created_by,
    tenantId: sourceRow.tenant_id,
    name: `source:${sourceRow.id}`,
    role: 'admin',
    scopes: [sourceRow.scope],
    permissions: [],
  };

  await event(pool, p, sourceRow.scope, 'source.delivery', inserted.id, {
    source_id: sourceRow.id,
    classification,
    status,
  });

  return { status: 202, body: { received: true, id: inserted.id } };
}

export async function tickSourceDeliveries(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM source_deliveries WHERE received_at < clock_timestamp() - interval '30 days'");

  const candidates = (await pool.query<{ id: string }>(
    `SELECT id FROM source_deliveries
     WHERE status IN ('received', 'deferred') AND next_attempt_at <= clock_timestamp()
     ORDER BY next_attempt_at ASC, id ASC
     LIMIT 50`
  )).rows;

  for (const candidate of candidates) {
    await processOneDelivery(pool, candidate.id);
  }
}

export const RECOVERY_RE = /\b(resolved|recovered|closed|back to normal|ok)\b/i;

export function isRecoveryDelivery(delivery: { action?: string | null; digest?: NormalizedDigest | Record<string, unknown> | string | null }): boolean {
  const parts: string[] = [];
  if (delivery.action) parts.push(delivery.action);
  let d = delivery.digest as any;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      parts.push(d);
    }
  }
  if (d && typeof d === 'object') {
    if (typeof d.title === 'string') parts.push(d.title);
    if (typeof d.body_excerpt === 'string') parts.push(d.body_excerpt);
    if (typeof d.action === 'string') parts.push(d.action);
    if (typeof d.body === 'string') parts.push(d.body);
    if (typeof d.text === 'string') parts.push(d.text);
    if (typeof d.comment === 'string') parts.push(d.comment);
    if (typeof d.message === 'string') parts.push(d.message);
  }
  return RECOVERY_RE.test(parts.join(' '));
}

export async function processOneDelivery(pool: Pool, deliveryId: string): Promise<void> {
  await transaction(pool, async db => {
    const delivery = (await db.query<SourceDeliveryRow>(
      `SELECT * FROM source_deliveries
       WHERE id = $1 AND status IN ('received', 'deferred')
       FOR UPDATE SKIP LOCKED`,
      [deliveryId]
    )).rows[0];
    if (!delivery) return;

    // A failed statement aborts the transaction; roll back to here so the catch can still record the retry.
    await db.query('SAVEPOINT delivery');
    try {
      const source = (await db.query<SourceRow>(
        'SELECT * FROM sources WHERE id = $1 FOR UPDATE',
        [delivery.source_id]
      )).rows[0];

      if (!source || source.archived || source.accept_mode === 'off') {
        await db.query(
          "UPDATE source_deliveries SET status = 'ignored', reason = 'source_off', processed_at = clock_timestamp() WHERE id = $1",
          [delivery.id]
        );
        return;
      }

      if (source.accept_mode === 'observe') {
        let wouldDo: Record<string, unknown> | null = null;
        if (delivery.classification === 'explicit' && delivery.reason === 'subscribed_thread' && delivery.thread_ref) {
          const sub = (await db.query<{ task_id: string }>(
            `SELECT task_id FROM task_subscriptions
             WHERE source_id = $1 AND external_thread_ref = $2 AND active = true AND expires_at > clock_timestamp()`,
            [source.id, delivery.thread_ref]
          )).rows[0];
          if (sub) wouldDo = { continue_task: sub.task_id };
        } else if (source.bot_id && delivery.classification && ['explicit', 'candidate'].includes(delivery.classification)) {
          wouldDo = { post_bot: source.bot_id };
        }

        await db.query(
          "UPDATE source_deliveries SET status = 'observed', would_do = $2::jsonb, processed_at = clock_timestamp() WHERE id = $1",
          [delivery.id, wouldDo ? JSON.stringify(wouldDo) : null]
        );
        return;
      }

      if (delivery.reason === 'closed' || (delivery.event_type === 'pull_request' && delivery.action === 'closed')) {
        if (delivery.thread_ref) {
          await db.query(
            `UPDATE task_subscriptions SET active = false
             WHERE tenant_id = $1 AND source_id = $2 AND external_thread_ref = $3 AND active = true`,
            [source.tenant_id, source.id, delivery.thread_ref]
          );
        }
        await db.query(
          "UPDATE source_deliveries SET status = 'ignored', reason = 'closed', processed_at = clock_timestamp() WHERE id = $1",
          [delivery.id]
        );
        return;
      }

      if (delivery.classification === 'explicit' && delivery.reason === 'subscribed_thread' && delivery.thread_ref) {
        const subs = (await db.query<TaskSubscriptionRow>(
          `SELECT * FROM task_subscriptions
           WHERE source_id = $1 AND external_thread_ref = $2 AND active = true AND expires_at > clock_timestamp() AND budget_remaining > 0
           ORDER BY created_at ASC`,
          [source.id, delivery.thread_ref]
        )).rows;

        if (subs.length > 0) {
          const tasksService = new TaskService(pool);
          let continued = false;
          for (const sub of subs) {
            const task = (await db.query<TaskRow>(
              'SELECT * FROM tasks WHERE id = $1 FOR UPDATE',
              [sub.task_id]
            )).rows[0];
            if (!task) continue;

            if (task.status === 'cancelled' || task.flow_id) {
              // Other tasks on the same PR still get the event.
              await db.query('UPDATE task_subscriptions SET active = false WHERE id = $1', [sub.id]);
              continue;
            }

            const isLiveRunning = task.status === 'running' && task.lease_expires_at && (new Date(task.lease_expires_at).getTime() > Date.now());
            if (task.status === 'queued' || isLiveRunning) {
              await db.query(
                "UPDATE source_deliveries SET status = 'deferred', next_attempt_at = clock_timestamp() + interval '30 seconds' WHERE id = $1",
                [delivery.id]
              );
              return;
            }

            const pending = (await db.query<SourceDeliveryRow>(
              `SELECT * FROM source_deliveries
               WHERE source_id = $1 AND thread_ref = $2
                 AND status IN ('received', 'deferred')
                 AND classification = 'explicit' AND reason = 'subscribed_thread'
               ORDER BY received_at ASC, id ASC
               FOR UPDATE`,
              [source.id, delivery.thread_ref]
            )).rows;

            const allDeliveries = pending.length > 0 ? pending : [delivery];
            const maxBatch = 10;
            const folded = allDeliveries.slice(0, maxBatch);
            const overflowCount = allDeliveries.length - folded.length;

            const fixedSentence = 'Address the review/CI feedback above on the same branch if this is a patch task. Do not push, comment on GitHub, or deploy.';
            const chunks: string[] = [];
            for (const d of folded) {
              const eventAction = d.action ? `.${d.action}` : '';
              const header = `GitHub ${d.event_type}${eventAction} on ${d.thread_ref ?? d.digest?.repo ?? 'unknown'} by ${d.digest?.author_login ?? 'unknown'} — explicit (subscribed_thread)`;
              chunks.push(`${header}\n${SOURCE_EVENT_GUIDANCE}\n${fenceUntrusted(JSON.stringify(d.digest))}`);
            }

            let foldedText = chunks.join('\n\n');
            if (overflowCount > 0) {
              foldedText += `\n\n${overflowCount} more events, see source_deliveries`;
            }
            if (foldedText.length > 15500) {
              foldedText = clipUtf8(foldedText, 15500) + '\n[events truncated]';
            }
            const instruction = `${foldedText}\n\n${fixedSentence}`;

            const idempotencyKey = folded.length === 1
              ? `source:${source.id}:${folded[0]!.delivery_id}`
              : `source:${source.id}:${folded[0]!.delivery_id}:${folded.length}`;

            const foldedIds = folded.map(f => f.id);

            const existingInstruction = (await db.query<{ id: string }>(
              'SELECT id FROM task_instructions WHERE task_id = $1 AND idempotency_key = $2',
              [task.id, idempotencyKey]
            )).rows[0];

            if (existingInstruction) {
              await db.query(
                `UPDATE source_deliveries
                 SET status = 'continued', task_id = $1, processed_at = clock_timestamp()
                 WHERE id = ANY($2::uuid[])`,
                [task.id, foldedIds]
              );
              return;
            }

            const p: Principal = {
              id: source.created_by,
              tenantId: source.tenant_id,
              name: `source:${source.id}`,
              role: 'admin',
              scopes: [task.scope],
              permissions: [],
            };

            const requestHash = sha256(canonicalJson({ instruction, idempotency_key: idempotencyKey }));
            await tasksService.continueInternal(db, p, task, instruction, idempotencyKey, requestHash);
            continued = true;

            await db.query(
              `UPDATE source_deliveries
               SET status = 'continued', task_id = $1, processed_at = clock_timestamp()
               WHERE id = ANY($2::uuid[])`,
              [task.id, foldedIds]
            );

            const newBudget = sub.budget_remaining - 1;
            if (newBudget <= 0) {
              await db.query(
                `UPDATE task_subscriptions
                 SET budget_remaining = 0, active = false, last_delivery_at = clock_timestamp()
                 WHERE id = $1`,
                [sub.id]
              );

              let botThreadId: string | null = null;
              if (task.bot_id) {
                const bot = (await db.query<{ thread_id: string }>(
                  'SELECT thread_id FROM bots WHERE id = $1 AND NOT archived',
                  [task.bot_id]
                )).rows[0];
                if (bot) botThreadId = bot.thread_id;
              }

              if (botThreadId) {
                const seq = await assignThreadSeq(db, task.tenant_id, botThreadId);
                const noticeId = newId();
                const noticeBody = `Stopped auto-continuing ${task.id} after 5 GitHub events; resubscribe to continue.`;
                const noticeAuthor = { kind: 'system', id: 'service' };

                await db.query(
                  `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body)
                   VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'notice', $7)`,
                  [noticeId, task.tenant_id, task.scope, botThreadId, seq, JSON.stringify(noticeAuthor), noticeBody]
                );

                await event(db, p, task.scope, 'message.created', noticeId, {
                  thread_id: botThreadId,
                  message_id: noticeId,
                  seq: Number(seq),
                  kind: 'notice',
                  author: noticeAuthor,
                });
              }
            } else {
              await db.query(
                `UPDATE task_subscriptions
                 SET budget_remaining = $1, last_delivery_at = clock_timestamp()
                 WHERE id = $2`,
                [newBudget, sub.id]
              );
            }
          }
          if (!continued) {
            await db.query(
              "UPDATE source_deliveries SET status = 'ignored', reason = 'task_not_continuable', processed_at = clock_timestamp() WHERE id = $1",
              [delivery.id]
            );
          }
          return;
        }
      }

      if (delivery.classification && ['explicit', 'candidate'].includes(delivery.classification) && source.bot_id) {
        const target = (await db.query<{
          bot_id: string;
          thread_id: string;
          routing: Record<string, unknown>;
          rules: Record<string, unknown>;
          lead_agent_id: string;
          lead_name: string;
          lead_scope: string;
          lead_edits: boolean;
          lead_runner: Record<string, unknown> | null;
        }>(
          `SELECT b.id AS bot_id, b.thread_id, b.routing, b.rules, b.lead_agent_id,
                  a.name AS lead_name, a.scope AS lead_scope, a.edits AS lead_edits, a.runner AS lead_runner
           FROM bots b
           JOIN agents a ON a.id = b.lead_agent_id AND NOT a.archived
           WHERE b.id = $1 AND NOT b.archived`,
          [source.bot_id]
        )).rows[0];

        if (target) {
          if (delivery.classification === 'explicit' && (source.cooldown_seconds ?? 0) > 0) {
            const isRecovery = isRecoveryDelivery(delivery);
            if (!isRecovery) {
              const recentRun = (await db.query<{ id: string }>(
                `SELECT id FROM source_deliveries
                 WHERE source_id = $1
                   AND id != $2
                   AND status = 'dispatched'
                   AND classification = 'explicit'
                   AND processed_at IS NOT NULL
                   AND processed_at >= clock_timestamp() - ($3 * interval '1 second')
                 LIMIT 1`,
                [source.id, delivery.id, source.cooldown_seconds]
              )).rows[0];

              if (recentRun) {
                await db.query(
                  "UPDATE source_deliveries SET status = 'ignored', reason = 'cooldown', processed_at = clock_timestamp() WHERE id = $1",
                  [delivery.id]
                );
                return;
              }
            }
          }

          const bot = {
            id: target.bot_id,
            thread_id: target.thread_id,
            lead_agent_id: target.lead_agent_id,
            routing: target.routing,
            rules: target.rules,
          };
          const leadAgent = {
            id: target.lead_agent_id,
            name: target.lead_name,
            scope: target.lead_scope,
            edits: target.lead_edits,
            runner: target.lead_runner as any,
          } as AgentRow;

          const seq = await assignThreadSeq(db, source.tenant_id, bot.thread_id);
          const msgId = newId();
          const refName = delivery.thread_ref ?? delivery.digest?.repo ?? 'unknown';
          const authorLogin = delivery.digest?.author_login ?? 'unknown';
          const eventAction = delivery.action ? `.${delivery.action}` : '';
          const header = `GitHub ${delivery.event_type}${eventAction} on ${refName} by ${authorLogin} — classified ${delivery.classification} (${delivery.reason ?? 'none'})`;
          const messageBody = clipUtf8(
            `${header}\n${SOURCE_EVENT_GUIDANCE}\n${fenceUntrusted(JSON.stringify(delivery.digest))}`,
            16384
          );

          await db.query(
            `INSERT INTO messages
               (id, tenant_id, scope, thread_id, seq, author, kind, body)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'source_event', $7)`,
            [
              msgId,
              source.tenant_id,
              source.scope,
              bot.thread_id,
              seq,
              JSON.stringify({ kind: 'system', id: `source:${source.id}` }),
              messageBody,
            ]
          );

          const p: Principal = {
            id: source.created_by,
            tenantId: source.tenant_id,
            name: `source:${source.id}`,
            role: 'admin',
            scopes: [source.scope],
            permissions: [],
          };

          await event(db, p, source.scope, 'message.created', msgId, {
            thread_id: bot.thread_id,
            message_id: msgId,
            seq: Number(seq),
            kind: 'source_event',
          });

          let turnTaskId: string | null = null;
          if (delivery.classification === 'explicit') {
            turnTaskId = await enqueueAgentTurn(db, p, {
              thread: { id: bot.thread_id, kind: 'bot' },
              agent: leadAgent,
              bot,
              seq,
              initiatorKind: 'source',
              objective: `GitHub event: ${delivery.event_type} on ${delivery.digest?.repo ?? 'repo'}`,
            });
          }

          await db.query(
            "UPDATE source_deliveries SET status = 'dispatched', message_id = $2, task_id = $3, processed_at = clock_timestamp() WHERE id = $1",
            [delivery.id, msgId, turnTaskId]
          );
          return;
        }
      }

      await db.query(
        "UPDATE source_deliveries SET status = 'ignored', reason = 'no_target', processed_at = clock_timestamp() WHERE id = $1",
        [delivery.id]
      );
    } catch {
      await db.query('ROLLBACK TO SAVEPOINT delivery');
      const nextAttempts = delivery.attempts + 1;
      const failed = nextAttempts >= 8;
      const delaySec = Math.min(30 * Math.pow(2, delivery.attempts), 3600);

      await db.query(
        `UPDATE source_deliveries
         SET attempts = $1,
             status = $2,
             next_attempt_at = clock_timestamp() + ($3 * interval '1 second'),
             processed_at = CASE WHEN $4 THEN clock_timestamp() ELSE processed_at END
         WHERE id = $5`,
        [nextAttempts, failed ? 'failed' : 'deferred', delaySec, failed, delivery.id]
      );

      if (failed) {
        const source = (await db.query<{ bot_id: string | null; scope: string; created_by: string }>(
          'SELECT bot_id, scope, created_by FROM sources WHERE id = $1',
          [delivery.source_id]
        )).rows[0];

        if (source?.bot_id) {
          const bot = (await db.query<{ thread_id: string }>(
            'SELECT thread_id FROM bots WHERE id = $1 AND NOT archived',
            [source.bot_id]
          )).rows[0];

          if (bot) {
            const seq = await assignThreadSeq(db, delivery.tenant_id, bot.thread_id);
            const noticeId = newId();
            const author = { kind: 'system', id: 'service' };
            const body = `GitHub delivery ${delivery.delivery_id} failed after 8 attempts.`;

            await db.query(
              `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'notice', $7)`,
              [noticeId, delivery.tenant_id, delivery.scope, bot.thread_id, seq, JSON.stringify(author), body]
            );

            const p: Principal = {
              id: source.created_by,
              tenantId: delivery.tenant_id,
              name: `source:${delivery.source_id}`,
              role: 'admin',
              scopes: [delivery.scope],
              permissions: [],
            };

            await event(db, p, delivery.scope, 'message.created', noticeId, {
              thread_id: bot.thread_id,
              message_id: noticeId,
              seq: Number(seq),
              kind: 'notice',
              author,
            });
          }
        }
      }
    }
  });
}
