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
import { assignThreadSeq, clipUtf8, enqueueAgentTurn, type AgentRow } from './teams.js';

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
  ): Promise<{ id: string; name: string; repo_full_name: string; accept_mode: string; webhook_url: string; secret: string }> {
    requireCondition(Boolean(encryptionKey && /^[0-9a-f]{64}$/i.test(encryptionKey)), 503, 'events_not_configured', 'EVENT_ENCRYPTION_KEY is required.');
    noExtraKeys(input, ['scope', 'repo_full_name', 'name', 'bot_id', 'rules']);
    const scope = scopeName(input.scope);
    assertKnownScope(p, scope);
    requireScope(p, scope);

    const repoFullName = string(input.repo_full_name, 'repo_full_name', 140);
    requireCondition(GITHUB_REPO_RE.test(repoFullName), 400, 'invalid_arguments', 'repo_full_name must match owner/repo pattern.');

    const name = input.name !== undefined ? string(input.name, 'name', 64) : repoFullName.slice(0, 64);
    const botId = input.bot_id !== undefined ? uuid(input.bot_id, 'bot_id') : null;
    const rules = validateSourceRules(input.rules);

    const id = newId();
    const rawSecret = randomBytes(32).toString('hex');
    const box = new SecretBox(encryptionKey);
    const ciphertext = box.encrypt(rawSecret, `source:${id}`);

    await this.pool.query(
      `INSERT INTO sources
         (id, tenant_id, scope, kind, name, repo_full_name, secret_ciphertext, accept_mode, rules, bot_id, created_by)
       VALUES ($1, $2, $3, 'github', $4, $5, $6, 'observe', $7::jsonb, $8, $9)`,
      [id, p.tenantId, scope, name, repoFullName, ciphertext, JSON.stringify(rules), botId, p.id]
    );

    await audit(this.pool, p, scope, 'source.create', id, { repo: repoFullName, name });

    const base = publicUrl ? publicUrl.replace(/\/$/, '') : '';
    return {
      id,
      name,
      repo_full_name: repoFullName,
      accept_mode: 'observe',
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
    noExtraKeys(input, ['source_id', 'expected_version', 'name', 'rules', 'bot_id', 'accept_mode']);
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

      const updated = (await db.query<SourceRow>(
        `UPDATE sources
         SET name = $1, rules = $2::jsonb, bot_id = $3, accept_mode = $4,
             version = version + 1, updated_at = clock_timestamp()
         WHERE id = $5 RETURNING *`,
        [nextName, JSON.stringify(nextRules), nextBotId, nextMode, sourceId]
      )).rows[0]!;

      await audit(db, p, existing.scope, 'source.update', sourceId, {
        name: nextName,
        accept_mode: nextMode,
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
  const ctx = { subscribedRefs: new Set<string>(), selfLogins: new Set<string>() };
  const { classification, reason } = classifyGithubEvent(sourceRow.rules, digest, ctx);

  let status: 'received' | 'ignored' | 'observed' = 'received';
  let statusReason: string | null = reason;
  let wouldDo: Record<string, unknown> | null = null;

  if (sourceRow.accept_mode === 'off') {
    status = 'ignored';
    statusReason = 'source_off';
  } else if (classification === 'ignore') {
    status = 'ignored';
  } else if (sourceRow.accept_mode === 'observe') {
    status = 'observed';
    if (sourceRow.bot_id && ['explicit', 'candidate'].includes(classification)) {
      wouldDo = { post_bot: sourceRow.bot_id };
    }
  } else if (sourceRow.accept_mode === 'auto') {
    status = 'received';
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

async function processOneDelivery(pool: Pool, deliveryId: string): Promise<void> {
  await transaction(pool, async db => {
    const delivery = (await db.query<SourceDeliveryRow>(
      `SELECT * FROM source_deliveries
       WHERE id = $1 AND status IN ('received', 'deferred')
       FOR UPDATE SKIP LOCKED`,
      [deliveryId]
    )).rows[0];
    if (!delivery) return;

    try {
      const source = (await db.query<SourceRow>(
        'SELECT * FROM sources WHERE id = $1',
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
        const wouldDo = source.bot_id && delivery.classification && ['explicit', 'candidate'].includes(delivery.classification)
          ? { post_bot: source.bot_id }
          : null;

        await db.query(
          "UPDATE source_deliveries SET status = 'observed', would_do = $2::jsonb, processed_at = clock_timestamp() WHERE id = $1",
          [delivery.id, wouldDo ? JSON.stringify(wouldDo) : null]
        );
        return;
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

          if (delivery.classification === 'explicit') {
            await enqueueAgentTurn(db, p, {
              thread: { id: bot.thread_id, kind: 'bot' },
              agent: leadAgent,
              bot,
              seq,
              initiatorKind: 'source',
              objective: `GitHub event: ${delivery.event_type} on ${delivery.digest?.repo ?? 'repo'}`,
            });
          }

          await db.query(
            "UPDATE source_deliveries SET status = 'dispatched', message_id = $2, processed_at = clock_timestamp() WHERE id = $1",
            [delivery.id, msgId]
          );
          return;
        }
      }

      await db.query(
        "UPDATE source_deliveries SET status = 'ignored', reason = 'no_target', processed_at = clock_timestamp() WHERE id = $1",
        [delivery.id]
      );
    } catch {
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
