import type { Pool, PoolClient } from 'pg';
import { transaction } from '../db.js';
import { requireCondition } from '../errors.js';
import type { Principal } from '../types.js';
import { enumValue, integer, optionalString, scopeName, string, uuid } from '../validation.js';
import { assertKnownScope, audit, event, newId, noExtraKeys, optionalDate, requireFound, scopeLock, scopeSql, sourceInput, type Db } from './shared.js';

export const MEMORY_KINDS = ['note','observation','preference','decision','procedure','hypothesis'] as const;
type MemoryKind = typeof MEMORY_KINDS[number];
export interface MemoryRow {
  id: string; tenant_id: string; scope: string; kind: MemoryKind; key: string;
  content: string; source: Record<string, unknown>; status: 'active'|'proposed'|'retracted';
  version: number; created_by: string; reviewed_by: string|null; reviewed_at: Date|null;
  expires_at: Date|null; created_at: Date; updated_at: Date;
}
interface ProposalRow {
  id: string; memory_id: string; tenant_id: string; scope: string;
  expected_version: number|null; observed_version: number; proposed_content: string;
  proposed_source: Record<string, unknown>; proposed_expires_at: Date|null;
  status: 'proposed'|'conflict'|'accepted'|'superseded'|'retracted';
  actor_id: string; resolved_by: string|null; created_at: Date; resolved_at: Date|null;
}
const directive = (kind: MemoryKind): boolean => kind !== 'note' && kind !== 'observation';
const date = (value: Date|null): string|null => value?.toISOString() ?? null;

export function booleanOption(value: unknown, name: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  requireCondition(typeof value === 'boolean', 400, 'invalid_arguments', `${name} must be a boolean.`);
  return value;
}

export function memoryView(row: MemoryRow): Record<string, unknown> {
  const base = { id: row.id, scope: row.scope, status: row.status, version: row.version,
    created_at: date(row.created_at), updated_at: date(row.updated_at) };
  if (row.status === 'retracted') return { ...base, content: null, source: null };
  return { ...base, kind: row.kind, key: row.key, content: row.content, source: row.source,
    created_by: row.created_by, reviewed_by: row.reviewed_by, reviewed_at: date(row.reviewed_at),
    expires_at: date(row.expires_at), authority: row.reviewed_by ? 'owner_reviewed' : 'reported' };
}

function proposalView(row: ProposalRow, includeContent = true): Record<string, unknown> {
  return { id: row.id, memory_id: row.memory_id, expected_version: row.expected_version,
    observed_version: row.observed_version, status: row.status, actor_id: row.actor_id,
    created_at: date(row.created_at), resolved_at: date(row.resolved_at), resolved_by: row.resolved_by,
    ...(includeContent && row.status !== 'retracted' ? { content: row.proposed_content,
      source: row.proposed_source, expires_at: date(row.proposed_expires_at) } : {}) };
}

export async function findMemory(db: Db, p: Principal, id: string, lock = false): Promise<MemoryRow> {
  const [all, scopes] = scopeSql(p);
  const result = await db.query<MemoryRow>(`SELECT * FROM memories WHERE id=$1 AND tenant_id=$2
    AND ($3::boolean OR scope=ANY($4::text[])) ${lock ? 'FOR UPDATE' : ''}`, [id, p.tenantId, all, scopes]);
  return requireFound(result.rows[0], 'Memory');
}

async function revision(db: PoolClient, row: MemoryRow, actor: string): Promise<void> {
  await db.query(`INSERT INTO memory_revisions (memory_id,version,content,source,status,expires_at,actor_id)
    VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`, [row.id, row.version, row.content, JSON.stringify(row.source), row.status, row.expires_at, actor]);
}

async function memoryChanged(db: PoolClient, p: Principal, row: MemoryRow, action: string, proposalId?: string): Promise<void> {
  const details = { memory_id: row.id, version: row.version, status: row.status, action,
    ...(proposalId ? { proposal_id: proposalId } : {}) };
  await audit(db, p, row.scope, `memory.${action}`, row.id, details);
  await event(db, p, row.scope, 'memory.changed', row.id, details);
}

export class MemoryService {
  constructor(private readonly pool: Pool) {}

  async search(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['scope','query','kinds','include_proposed','limit']);
    const scope = scopeName(input.scope);
    assertKnownScope(p, scope);
    const query = optionalString(input.query, 'query', 512) ?? null;
    const include = booleanOption(input.include_proposed, 'include_proposed');
    const limit = input.limit === undefined ? 20 : integer(input.limit, 'limit', 1, 50);
    let kinds: string[] = [...MEMORY_KINDS];
    if (input.kinds !== undefined) {
      requireCondition(Array.isArray(input.kinds) && input.kinds.length <= 6, 400, 'invalid_arguments', 'kinds must be an array of at most six kinds.');
      kinds = [...new Set(input.kinds.map(v => enumValue(v, 'kinds', MEMORY_KINDS)))];
    }
    const result = await this.pool.query<MemoryRow>(`SELECT * FROM memories
      WHERE tenant_id=$1 AND scope=$2 AND kind=ANY($3::text[])
      AND (status='active' OR ($4::boolean AND status='proposed'))
      AND (expires_at IS NULL OR expires_at>clock_timestamp())
      AND ($5::text IS NULL OR search_vector @@ plainto_tsquery('simple',$5))
      ORDER BY CASE WHEN $5::text IS NULL THEN 0 ELSE ts_rank(search_vector,plainto_tsquery('simple',$5)) END DESC,
        updated_at DESC, id DESC LIMIT $6`, [p.tenantId, scope, kinds, include, query, limit]);
    return { scope, memories: result.rows.map(memoryView) };
  }

  async get(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['memory_id','include_history','proposal_limit','history_limit']);
    const id = uuid(input.memory_id, 'memory_id');
    const include = booleanOption(input.include_history, 'include_history');
    const proposalLimit = input.proposal_limit === undefined ? 10 : integer(input.proposal_limit, 'proposal_limit', 0, 50);
    const historyLimit = input.history_limit === undefined ? 10 : integer(input.history_limit, 'history_limit', 0, 100);
    // A single transaction prevents returning a pre-retraction head with a post-retraction history.
    return transaction(this.pool, async db => {
      const row = await findMemory(db, p, id, true);
      const memory = memoryView(row);
      if (row.status === 'retracted') return { memory, proposals: [], proposal_limit: proposalLimit, proposals_has_more: false,
        ...(include ? { revisions: [], history_limit: historyLimit, history_has_more: false } : {}) };
      const proposals = await db.query<ProposalRow>(`SELECT * FROM memory_proposals WHERE memory_id=$1
        ORDER BY created_at DESC,id DESC LIMIT $2`, [row.id, proposalLimit + 1]);
      const result = { memory, proposals: proposals.rows.slice(0, proposalLimit).map(r => proposalView(r)),
        proposal_limit: proposalLimit, proposals_has_more: proposals.rows.length > proposalLimit };
      if (!include) return result;
      const revisions = await db.query(`SELECT version,content,source,status,expires_at,actor_id,created_at
        FROM memory_revisions WHERE memory_id=$1 ORDER BY version DESC LIMIT $2`, [row.id, historyLimit + 1]);
      return { ...result, revisions: revisions.rows.slice(0, historyLimit),
        history_limit: historyLimit, history_has_more: revisions.rows.length > historyLimit };
    });
  }

  async propose(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['scope','kind','key','content','source','expected_version','expires_at']);
    const scope = scopeName(input.scope);
    assertKnownScope(p, scope);
    const kind = enumValue(input.kind, 'kind', MEMORY_KINDS);
    const key = string(input.key, 'key', 240);
    const content = string(input.content, 'content', 32768);
    requireCondition(Buffer.byteLength(content, 'utf8') <= 32768, 400, 'invalid_arguments', 'content exceeds 32 KiB in UTF-8.');
    const source = sourceInput(input.source, p);
    const expected = input.expected_version === undefined ? null : integer(input.expected_version, 'expected_version', 1, 2147483647);
    const expires = optionalDate(input.expires_at, 'expires_at');
    return transaction(this.pool, async db => {
      await scopeLock(db, 'memory', p, scope, key);
      const found = await db.query<MemoryRow>('SELECT * FROM memories WHERE tenant_id=$1 AND scope=$2 AND key=$3 FOR UPDATE', [p.tenantId, scope, key]);
      if (!found.rows[0]) {
        requireCondition(expected === null, 409, 'version_conflict', 'Memory does not exist; omit expected_version to create it.');
        const id = newId();
        const result = await db.query<MemoryRow>(`INSERT INTO memories
          (id,tenant_id,scope,kind,key,content,source,status,version,created_by,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,1,$9,$10) RETURNING *`,
        [id, p.tenantId, scope, kind, key, content, JSON.stringify(source), directive(kind) ? 'proposed' : 'active', p.id, expires]);
        const created = result.rows[0]!;
        await revision(db, created, p.id);
        await memoryChanged(db, p, created, 'created');
        return { memory: memoryView(created), proposal: null, conflict: false };
      }
      const row = found.rows[0];
      requireCondition(row.status !== 'retracted', 409, 'memory_retracted', 'This key is a retracted tombstone. Use a new key for a new fact.');
      requireCondition(row.kind === kind, 409, 'kind_immutable', 'Existing memory kind cannot change; create another key.');
      const conflict = expected !== row.version;
      if (conflict || (directive(row.kind) && row.status === 'active')) {
        const proposals = await db.query<ProposalRow>(`INSERT INTO memory_proposals
          (id,memory_id,tenant_id,scope,expected_version,observed_version,proposed_content,proposed_source,proposed_expires_at,status,actor_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING *`,
        [newId(), row.id, p.tenantId, scope, expected, row.version, content, JSON.stringify(source), expires, conflict ? 'conflict' : 'proposed', p.id]);
        const proposal = proposals.rows[0]!;
        await memoryChanged(db, p, row, conflict ? 'conflict' : 'proposed', proposal.id);
        // Success response deliberately commits the competing evidence. A thrown error would roll it back.
        return { memory: memoryView(row), proposal: proposalView(proposal), conflict };
      }
      const changed = await db.query<MemoryRow>(`UPDATE memories SET content=$2,source=$3::jsonb,
        expires_at=$4,version=version+1,reviewed_by=NULL,reviewed_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`, [row.id, content, JSON.stringify(source), expires]);
      const updated = changed.rows[0]!;
      await revision(db, updated, p.id);
      await memoryChanged(db, p, updated, 'updated');
      return { memory: memoryView(updated), proposal: null, conflict: false };
    });
  }

  async promote(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['memory_id','expected_version','proposal_id']);
    requireCondition(p.role === 'admin', 403, 'owner_required', 'Only an owner/admin connection can review shared memory.');
    const id = uuid(input.memory_id, 'memory_id');
    const expected = integer(input.expected_version, 'expected_version', 1, 2147483647);
    const proposalId = input.proposal_id === undefined ? null : uuid(input.proposal_id, 'proposal_id');
    return transaction(this.pool, async db => {
      const row = await findMemory(db, p, id, true);
      requireCondition(row.status !== 'retracted', 409, 'memory_retracted', 'Retracted content cannot be promoted.');
      requireCondition(row.version === expected, 409, 'version_conflict', 'Memory changed; review the current version before promoting.');
      let content = row.content;
      let source = row.source;
      let expires: Date|string|null = row.expires_at;
      if (proposalId) {
        const proposals = await db.query<ProposalRow>(`SELECT * FROM memory_proposals WHERE id=$1 AND memory_id=$2
          AND tenant_id=$3 AND scope=$4 FOR UPDATE`, [proposalId, row.id, p.tenantId, row.scope]);
        const proposal = requireFound(proposals.rows[0], 'Proposal');
        requireCondition(['proposed','conflict'].includes(proposal.status), 409, 'proposal_resolved', 'This proposal has already been resolved.');
        content = proposal.proposed_content;
        source = proposal.proposed_source;
        expires = proposal.proposed_expires_at;
        await db.query(`UPDATE memory_proposals SET status='accepted',resolved_by=$2,resolved_at=clock_timestamp() WHERE id=$1`, [proposalId, p.id]);
      }
      const result = await db.query<MemoryRow>(`UPDATE memories SET content=$2,source=$3::jsonb,
        expires_at=$4,status='active',version=version+1,reviewed_by=$5,reviewed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`, [row.id, content, JSON.stringify(source), expires, p.id]);
      const updated = result.rows[0]!;
      // Other competing proposals stay visible as conflicts; accepting one never discards the others.
      await db.query(`UPDATE memory_proposals SET status='conflict' WHERE memory_id=$1 AND status='proposed'`, [row.id]);
      await revision(db, updated, p.id);
      await memoryChanged(db, p, updated, 'promoted', proposalId ?? undefined);
      return { memory: memoryView(updated), accepted_proposal_id: proposalId };
    });
  }

  async retract(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['memory_id','expected_version']);
    requireCondition(p.role === 'admin', 403, 'owner_required', 'Only an owner/admin connection can retract shared memory.');
    const id = uuid(input.memory_id, 'memory_id');
    const expected = integer(input.expected_version, 'expected_version', 1, 2147483647);
    return transaction(this.pool, async db => {
      const visible = await findMemory(db, p, id);
      // Queue mutations take this lock before task row locks; follow the same order when clearing references.
      await scopeLock(db, 'tasks', p, visible.scope);
      const row = await findMemory(db, p, id, true);
      requireCondition(row.version === expected, 409, 'version_conflict', 'Memory changed; review the current version before retracting.');
      if (row.status === 'retracted') return { memory: memoryView(row) };
      const result = await db.query<MemoryRow>(`UPDATE memories SET content='',source='{}'::jsonb,status='retracted',
        expires_at=NULL,reviewed_by=$2,reviewed_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`, [row.id, p.id]);
      const updated = result.rows[0]!;
      await db.query(`UPDATE memory_revisions SET content='',source='{}'::jsonb,status='retracted',expires_at=NULL WHERE memory_id=$1`, [row.id]);
      await db.query(`UPDATE memory_proposals SET proposed_content='',proposed_source='{}'::jsonb,
        proposed_expires_at=NULL,status='retracted',resolved_by=$2,resolved_at=clock_timestamp() WHERE memory_id=$1`, [row.id, p.id]);
      await revision(db, updated, p.id);
      // References are structured; unstructured copies in completed reports/backups are outside this deletion boundary.
      const tasks = await db.query<{id:string;version:number;status:string}>(`UPDATE tasks SET
        context_refs=array_remove(context_refs,$1::uuid), context_versions=context_versions-$1::text,
        version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$2 AND scope=$3 AND $1::uuid=ANY(context_refs)
        RETURNING id,version,status`, [row.id, p.tenantId, row.scope]);
      for (const task of tasks.rows) {
        await event(db, p, row.scope, 'task.updated', task.id, { task_id: task.id, version: task.version, status: task.status, action: 'context_retracted', memory_id: row.id });
      }
      await memoryChanged(db, p, updated, 'retracted');
      return { memory: memoryView(updated), cleared_task_references: tasks.rowCount ?? 0 };
    });
  }

  /** Called inside context_get's transaction; memory/task scope has already been checked. */
  async contextMemories(db: PoolClient, p: Principal, scope: string, query: string|null, includeProposed: boolean,
    limit: number, refs: string[], versions: Record<string, number>): Promise<{memories:Record<string,unknown>[];conflicts:Record<string,unknown>[]}> {
    const records = await db.query<MemoryRow>(`SELECT * FROM memories WHERE tenant_id=$1 AND scope=$2
      AND (status='active' OR ($3::boolean AND status='proposed'))
      AND (expires_at IS NULL OR expires_at>clock_timestamp())
      AND ($4::text IS NULL OR id=ANY($5::uuid[]) OR search_vector @@ plainto_tsquery('simple',$4))
      ORDER BY (id=ANY($5::uuid[])) DESC,
        CASE WHEN $4::text IS NULL THEN 0 ELSE ts_rank(search_vector,plainto_tsquery('simple',$4)) END DESC,
        updated_at DESC,id DESC LIMIT $6 FOR SHARE`, [p.tenantId, scope, includeProposed, query, refs, limit]);
    let remaining = 20000;
    const memories: Record<string, unknown>[] = [];
    for (const row of records.rows) {
      if (remaining <= 0) break;
      const text = row.content.slice(0, Math.min(2000, remaining));
      remaining -= text.length;
      memories.push({ ...memoryView(row), content: text, content_truncated: text.length !== row.content.length,
        input_version: versions[row.id] ?? null,
        changed_since_task: versions[row.id] !== undefined && versions[row.id] !== row.version });
    }
    const ids = memories.map(m => m.id as string);
    if (!ids.length) return { memories, conflicts: [] };
    const proposals = await db.query<ProposalRow>(`SELECT * FROM memory_proposals WHERE tenant_id=$1 AND scope=$2
      AND memory_id=ANY($3::uuid[]) AND status IN ('proposed','conflict') ORDER BY created_at DESC,id DESC LIMIT 50`, [p.tenantId, scope, ids]);
    return { memories, conflicts: proposals.rows.map(r => proposalView(r, false)) };
  }
}
