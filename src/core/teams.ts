import type { Pool, PoolClient } from 'pg';
import { transaction } from '../db.js';
import { AppError, requireCondition } from '../errors.js';
import { canAccessScope, requirePermission, requireScope } from '../policy.js';
import { redactSecrets } from '../safety/redact.js';
import type { Principal } from '../types.js';
import { integer, object, optionalString, scopeName, string, uuid } from '../validation.js';
import { booleanOption } from './memory.js';
import { assertKnownScope, audit, canonicalJson, event, newId, noExtraKeys, requireFound, scopeLock, scopeSql, sha256, type Db } from './shared.js';
import { runnerCapability, type RunnerConfig } from '../bridge/adapters.js';

export function clipUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value.replaceAll('\0', '\uFFFD'), 'utf8');
  if (buf.byteLength <= maxBytes) return buf.toString('utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xC0) === 0x80) {
    end--;
  }
  const byte = buf[end]!;
  let seqLen = 1;
  if ((byte & 0xE0) === 0xC0) seqLen = 2;
  else if ((byte & 0xF0) === 0xE0) seqLen = 3;
  else if ((byte & 0xF8) === 0xF0) seqLen = 4;
  if (end + seqLen > maxBytes) {
    return buf.subarray(0, end).toString('utf8');
  }
  return buf.subarray(0, end + seqLen).toString('utf8');
}

export async function assignThreadSeq(db: Db, tenantId: string, threadId: string): Promise<bigint> {
  const row = (await db.query<{ id: string }>(
    'SELECT id FROM threads WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
    [tenantId, threadId]
  )).rows[0];
  requireFound(row, 'Thread');
  const seqRes = await db.query<{ next_seq: string }>(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE thread_id=$1',
    [threadId]
  );
  return BigInt(seqRes.rows[0]!.next_seq);
}

export async function getTurnWindow(db: Db, threadId: string): Promise<Record<string, unknown>[]> {
  const mRes = await db.query<MessageRow>(
    'SELECT * FROM messages WHERE thread_id=$1 ORDER BY seq DESC LIMIT 40',
    [threadId]
  );
  const rows = mRes.rows;
  const window: Record<string, unknown>[] = [];
  let totalBytes = 0;
  for (const row of rows) {
    const bytes = Buffer.byteLength(row.body ?? '', 'utf8');
    if (window.length > 0 && totalBytes + bytes > 24 * 1024) break;
    window.push(messageView(row));
    totalBytes += bytes;
  }
  window.reverse();
  return window;
}

export interface AgentRow {
  id: string;
  tenant_id: string;
  scope: string;
  name: string;
  role: string;
  instructions: string;
  runner: RunnerConfig;
  edits: boolean;
  avatar: string | null;
  main_thread_id: string | null;
  archived: boolean;
  version: number;
  created_by: string;
  idempotency_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ThreadRow {
  id: string;
  tenant_id: string;
  scope: string;
  agent_id: string | null;
  kind: 'agent_main' | 'agent_side' | 'channel';
  title: string | null;
  archived: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface MessageRow {
  id: string;
  tenant_id: string;
  scope: string;
  thread_id: string;
  seq: string | number | bigint;
  author: { kind: 'human' | 'agent' | 'system'; id: string };
  kind: 'text' | 'handoff' | 'swarm' | 'run' | 'question' | 'answer' | 'notice';
  body: string;
  ref: Record<string, unknown> | null;
  idempotency_key: string | null;
  created_at: Date;
  edited_at: Date | null;
}

function parseRunner(raw: unknown): RunnerConfig {
  const obj = object(raw);
  noExtraKeys(obj, ['mode', 'provider', 'model', 'effort']);
  if (obj.mode !== undefined) {
    requireCondition(obj.mode === 'auto', 400, 'invalid_arguments', 'mode must be auto');
    return { mode: 'auto' };
  }
  const provider = string(obj.provider, 'runner.provider', 32);
  requireCondition(['claude', 'codex', 'antigravity'].includes(provider), 400, 'invalid_arguments', 'runner.provider must be claude, codex or antigravity');
  const res: RunnerConfig = { provider };
  if (obj.model !== undefined) res.model = string(obj.model, 'runner.model', 100);
  if (obj.effort !== undefined) res.effort = string(obj.effort, 'runner.effort', 40);
  return res;
}

function runnerDisplayName(runner: RunnerConfig): string {
  if (runner.mode === 'auto') return 'Auto';
  if (runner.provider === 'codex') return 'Codex';
  if (runner.provider === 'claude') return 'Claude';
  if (runner.provider === 'antigravity') return 'Antigravity';
  return runner.provider ?? 'Auto';
}

function agentView(row: AgentRow, status = 'idle', unreadCount = 0): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    role: row.role,
    instructions: row.instructions,
    runner: row.runner,
    edits: row.edits,
    avatar: row.avatar,
    main_thread_id: row.main_thread_id,
    status,
    unread_count: unreadCount,
    archived: row.archived,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString()
  };
}

function threadView(row: ThreadRow, unreadCount = 0): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    agent_id: row.agent_id,
    kind: row.kind,
    title: row.title,
    archived: row.archived,
    version: row.version,
    unread_count: unreadCount,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString()
  };
}

function messageView(row: MessageRow): Record<string, unknown> {
  return {
    id: row.id,
    thread_id: row.thread_id,
    seq: Number(row.seq),
    author: row.author,
    kind: row.kind,
    body: row.body,
    ref: row.ref,
    created_at: row.created_at.toISOString(),
    edited_at: row.edited_at ? row.edited_at.toISOString() : null
  };
}

export class TeamService {
  constructor(private readonly pool: Pool) {}

  async agentCreate(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['name', 'role', 'instructions', 'scope', 'runner', 'edits', 'avatar', 'idempotency_key']);
    requirePermission(p, 'agent:manage');
    const name = string(input.name, 'name', 64);
    const role = string(input.role, 'role', 64);
    const rawInstructions = string(input.instructions, 'instructions', 8192);
    requireCondition(Buffer.byteLength(rawInstructions, 'utf8') <= 8192, 400, 'invalid_arguments', 'instructions exceeds maximum size of 8192 bytes.');
    const instructions = rawInstructions;
    const scope = scopeName(input.scope);
    assertKnownScope(p, scope);
    requireScope(p, scope);
    const runner = parseRunner(input.runner);
    const edits = input.edits !== undefined ? booleanOption(input.edits, 'edits') : false;
    const avatar = input.avatar !== undefined ? string(input.avatar, 'avatar', 200) : null;
    const idempotency = input.idempotency_key !== undefined ? string(input.idempotency_key, 'idempotency_key', 200) : null;

    return transaction(this.pool, async db => {
      if (idempotency) {
        const existing = await db.query<AgentRow>(
          'SELECT * FROM agents WHERE tenant_id=$1 AND created_by=$2 AND idempotency_key=$3',
          [p.tenantId, p.id, idempotency]
        );
        if (existing.rows[0]) {
          const thread = (await db.query<ThreadRow>('SELECT * FROM threads WHERE id=$1', [existing.rows[0].main_thread_id])).rows[0]!;
          return { agent: agentView(existing.rows[0]), thread: threadView(thread), replayed: true };
        }
      }

      const agentId = newId();
      const threadId = newId();

      await db.query(
        `INSERT INTO agents (id, tenant_id, scope, name, role, instructions, runner, edits, avatar, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
        [agentId, p.tenantId, scope, name, role, instructions, JSON.stringify(runner), edits, avatar, p.id, idempotency]
      );

      await db.query(
        `INSERT INTO threads (id, tenant_id, scope, agent_id, kind, title)
         VALUES ($1, $2, $3, $4, 'agent_main', $5)`,
        [threadId, p.tenantId, scope, agentId, name]
      );

      const agentRes = await db.query<AgentRow>(
        'UPDATE agents SET main_thread_id=$1 WHERE id=$2 RETURNING *',
        [threadId, agentId]
      );
      const agent = agentRes.rows[0]!;
      const threadRes = await db.query<ThreadRow>('SELECT * FROM threads WHERE id=$1', [threadId]);
      const thread = threadRes.rows[0]!;

      await audit(db, p, scope, 'agent.create', agentId, { name, role });
      await event(db, p, scope, 'agent.updated', agentId, { agent_id: agentId, version: 1, name });

      return { agent: agentView(agent), thread: threadView(thread), replayed: false };
    });
  }

  async agentUpdate(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['agent_id', 'expected_version', 'name', 'role', 'instructions', 'runner', 'edits', 'avatar']);
    requirePermission(p, 'agent:manage');
    const agentId = uuid(input.agent_id, 'agent_id');
    const expected = integer(input.expected_version, 'expected_version', 1, 2147483647);

    return transaction(this.pool, async db => {
      // Lock order is thread, then agent, as in thread_post and task_finish, so a runner notice cannot deadlock a post.
      await db.query(`SELECT 1 FROM threads WHERE id=(SELECT main_thread_id FROM agents WHERE id=$1 AND tenant_id=$2) FOR UPDATE`, [agentId, p.tenantId]);
      const existing = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [agentId, p.tenantId])).rows[0];
      requireFound(existing, 'Agent');
      requireScope(p, existing.scope);
      requireCondition(existing.version === expected, 409, 'version_conflict', 'Agent has changed; reload before updating.');

      const nextName = input.name !== undefined ? string(input.name, 'name', 64) : existing.name;
      const nextRole = input.role !== undefined ? string(input.role, 'role', 64) : existing.role;
      let nextInstructions = existing.instructions;
      if (input.instructions !== undefined) {
        const rawInstructions = string(input.instructions, 'instructions', 8192);
        requireCondition(Buffer.byteLength(rawInstructions, 'utf8') <= 8192, 400, 'invalid_arguments', 'instructions exceeds maximum size of 8192 bytes.');
        nextInstructions = rawInstructions;
      }
      const nextRunner = input.runner !== undefined ? parseRunner(input.runner) : existing.runner;
      const nextEdits = input.edits !== undefined ? booleanOption(input.edits, 'edits') : existing.edits;
      const nextAvatar = input.avatar !== undefined ? (input.avatar === null ? null : string(input.avatar, 'avatar', 200)) : existing.avatar;

      const runnerChanged = input.runner !== undefined && canonicalJson(nextRunner) !== canonicalJson(existing.runner);

      const updated = (await db.query<AgentRow>(
        `UPDATE agents SET name=$1, role=$2, instructions=$3, runner=$4::jsonb, edits=$5, avatar=$6,
           version=version+1, updated_at=clock_timestamp()
         WHERE id=$7 RETURNING *`,
        [nextName, nextRole, nextInstructions, JSON.stringify(nextRunner), nextEdits, nextAvatar, agentId]
      )).rows[0]!;

      if (runnerChanged && existing.main_thread_id) {
        const display = runnerDisplayName(nextRunner);
        const noticeBody = clipUtf8(`${updated.name} now runs on ${display}`, 16384);
        const nextSeq = await assignThreadSeq(db, existing.tenant_id, existing.main_thread_id);
        const msgId = newId();
        await db.query(
          `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'notice', $7)`,
          [msgId, existing.tenant_id, existing.scope, existing.main_thread_id, nextSeq, JSON.stringify({ kind: 'system', id: 'service' }), noticeBody]
        );
        await event(db, p, existing.scope, 'message.created', msgId, {
          thread_id: existing.main_thread_id,
          message_id: msgId,
          seq: Number(nextSeq),
          kind: 'notice',
          author: { kind: 'system', id: 'service' }
        });
      }

      await audit(db, p, updated.scope, 'agent.update', agentId, { version: updated.version });
      await event(db, p, updated.scope, 'agent.updated', agentId, { agent_id: agentId, version: updated.version });

      const status = await this.computeAgentStatus(db, updated);
      return { agent: agentView(updated, status) };
    });
  }

  async agentGet(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['agent_id']);
    requirePermission(p, 'agent:read');
    const agentId = uuid(input.agent_id, 'agent_id');
    const [all, scopes] = scopeSql(p);

    const agent = (await this.pool.query<AgentRow>(
      `SELECT * FROM agents WHERE id=$1 AND tenant_id=$2 AND ($3::boolean OR scope=ANY($4::text[]))`,
      [agentId, p.tenantId, all, scopes]
    )).rows[0];
    requireFound(agent, 'Agent');

    const status = await this.computeAgentStatus(this.pool, agent);
    return { agent: agentView(agent, status) };
  }

  async agentList(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['scope', 'after', 'limit', 'include_archived']);
    requirePermission(p, 'agent:read');
    const [all, grantedScopes] = scopeSql(p);
    const scope = input.scope !== undefined ? scopeName(input.scope) : null;
    if (scope) {
      assertKnownScope(p, scope);
      requireScope(p, scope);
    }
    const after = input.after !== undefined ? uuid(input.after, 'after') : null;
    const limit = input.limit !== undefined ? integer(input.limit, 'limit', 1, 100) : 50;
    const includeArchived = input.include_archived !== undefined ? booleanOption(input.include_archived, 'include_archived') : false;

    const rows = (await this.pool.query<AgentRow & { unread_count: number }>(
      `SELECT a.*,
         COALESCE((
           SELECT count(*)::int FROM messages m
           WHERE m.thread_id = a.main_thread_id
             AND m.seq > COALESCE((
               SELECT r.last_read_seq FROM thread_reads r
               WHERE r.tenant_id = a.tenant_id AND r.principal_id = $1 AND r.thread_id = a.main_thread_id
             ), 0)
         ), 0) AS unread_count
       FROM agents a
       WHERE a.tenant_id = $2
         AND ($3::boolean OR a.scope = ANY($4::text[]))
         AND ($5::text IS NULL OR a.scope = $5)
         AND ($6::boolean OR NOT a.archived)
         AND ($7::uuid IS NULL OR a.created_at < (SELECT created_at FROM agents WHERE id = $7))
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $8`,
      [p.id, p.tenantId, all, grantedScopes, scope, includeArchived, after, limit + 1]
    )).rows;

    const hasMore = rows.length > limit;
    const paged = rows.slice(0, limit);

    const agents = await Promise.all(
      paged.map(async r => {
        const status = await this.computeAgentStatus(this.pool, r);
        return agentView(r, status, Number(r.unread_count));
      })
    );

    return {
      agents,
      has_more: hasMore,
      next_cursor: hasMore ? paged.at(-1)?.id ?? null : null
    };
  }

  async agentArchive(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['agent_id']);
    requirePermission(p, 'agent:manage');
    const agentId = uuid(input.agent_id, 'agent_id');

    return transaction(this.pool, async db => {
      const existing = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [agentId, p.tenantId])).rows[0];
      requireFound(existing, 'Agent');
      requireScope(p, existing.scope);

      const updated = (await db.query<AgentRow>(
        'UPDATE agents SET archived=true, version=version+1, updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
        [agentId]
      )).rows[0]!;

      await audit(db, p, updated.scope, 'agent.archive', agentId, { version: updated.version });
      await event(db, p, updated.scope, 'agent.updated', agentId, { agent_id: agentId, version: updated.version, archived: true });

      return { agent: agentView(updated, 'offline') };
    });
  }

  async threadPost(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['thread_id', 'body', 'idempotency_key', 'reply_to']);
    requirePermission(p, 'thread:write');
    const threadId = uuid(input.thread_id, 'thread_id');
    const rawBody = string(input.body, 'body', 16384);
    requireCondition(Buffer.byteLength(rawBody, 'utf8') <= 16384, 400, 'invalid_arguments', 'body exceeds maximum size of 16384 bytes.');
    const body = clipUtf8(redactSecrets(rawBody), 16384);
    const idempotency = string(input.idempotency_key, 'idempotency_key', 200);
    const replyTo = input.reply_to !== undefined ? uuid(input.reply_to, 'reply_to') : null;

    return transaction(this.pool, async db => {
      const thread = (await db.query<ThreadRow>('SELECT * FROM threads WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [threadId, p.tenantId])).rows[0];
      requireFound(thread, 'Thread');
      requireScope(p, thread.scope);

      const author = { kind: 'human' as const, id: p.id };

      const existingMsg = (await db.query<MessageRow>(
        'SELECT * FROM messages WHERE tenant_id=$1 AND thread_id=$2 AND author=$3::jsonb AND idempotency_key=$4',
        [p.tenantId, threadId, JSON.stringify(author), idempotency]
      )).rows[0];
      if (existingMsg) {
        requireCondition(existingMsg.body === body, 409, 'idempotency_conflict', 'Idempotency key reused with different message body.');
        return { message: messageView(existingMsg), replayed: true };
      }

      const nextSeq = await assignThreadSeq(db, p.tenantId, threadId);
      const msgId = newId();
      const ref = replyTo ? { reply_to: replyTo } : null;

      const inserted = (await db.query<MessageRow>(
        `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body, ref, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'text', $7, $8::jsonb, $9) RETURNING *`,
        [msgId, p.tenantId, thread.scope, threadId, nextSeq, JSON.stringify(author), body, ref ? JSON.stringify(ref) : null, idempotency]
      )).rows[0]!;

      await db.query('UPDATE threads SET updated_at=clock_timestamp() WHERE id=$1', [threadId]);

      await audit(db, p, thread.scope, 'message.create', msgId, { thread_id: threadId, seq: Number(nextSeq) });
      await event(db, p, thread.scope, 'message.created', msgId, {
        thread_id: threadId,
        message_id: msgId,
        seq: Number(nextSeq),
        kind: 'text',
        author
      });

      // If posting to an agent thread by a human, queue a turn task if none is currently active
      if (thread.agent_id) {
        const agent = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [thread.agent_id])).rows[0]!;
        const activeTurn = (await db.query(
          "SELECT id FROM tasks WHERE tenant_id=$1 AND agent_id=$2 AND status IN ('queued', 'running') LIMIT 1",
          [p.tenantId, thread.agent_id]
        )).rows[0];

        if (!activeTurn) {
          const requiredCap = runnerCapability(agent.runner, agent.edits);
          const taskId = newId();
          const turnObjective = `Turn for agent ${agent.name}`;
          const envelope = {
            deploy: false, publish: false, purchase: false, local_patch: agent.edits,
            read_project: true, send_messages: false, permission_changes: false, external_side_effects: false
          };
          const contextVersions = { message_seq: Number(nextSeq) };
          const reqHash = sha256(canonicalJson({
            kind: 'turn', scope: agent.scope, agent_id: agent.id, thread_id: threadId, seq: Number(nextSeq)
          }));

          await db.query(
            `INSERT INTO tasks
               (id, tenant_id, scope, kind, agent_id, thread_id, objective, constraints, acceptance_criteria,
                permission_envelope, required_capability, resource_key, context_versions, status, created_by,
                idempotency_key, request_hash, max_attempts)
             VALUES ($1, $2, $3, 'turn', $4, $5, $6, '[]'::jsonb, '[]'::jsonb, $7::jsonb, $8, $9, $10::jsonb, 'queued', $11, $12, $13, 3)`,
            [taskId, p.tenantId, agent.scope, agent.id, threadId, turnObjective, JSON.stringify(envelope),
             requiredCap, `agent:${agent.id}`, JSON.stringify(contextVersions), p.id, newId(), reqHash]
          );

          await audit(db, p, agent.scope, 'task.submitted', taskId, { kind: 'turn', agent_id: agent.id });
          await event(db, p, agent.scope, 'task.updated', taskId, { task_id: taskId, status: 'queued', action: 'submitted' });
        }
      }

      return { message: messageView(inserted), replayed: false };
    });
  }

  async threadRead(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['thread_id', 'after_seq', 'before_seq', 'limit']);
    requirePermission(p, 'thread:read');
    const threadId = uuid(input.thread_id, 'thread_id');
    const limit = input.limit !== undefined ? integer(input.limit, 'limit', 1, 100) : 50;
    const afterSeq = input.after_seq !== undefined ? integer(input.after_seq, 'after_seq', 0, 9223372036854775807) : null;
    const beforeSeq = input.before_seq !== undefined ? integer(input.before_seq, 'before_seq', 1, 9223372036854775807) : null;

    const [all, grantedScopes] = scopeSql(p);
    const thread = (await this.pool.query<ThreadRow>(
      `SELECT * FROM threads WHERE id=$1 AND tenant_id=$2 AND ($3::boolean OR scope=ANY($4::text[]))`,
      [threadId, p.tenantId, all, grantedScopes]
    )).rows[0];
    requireFound(thread, 'Thread');

    let rows: MessageRow[];
    let hasMore = false;

    if (beforeSeq !== null) {
      const res = await this.pool.query<MessageRow>(
        `SELECT * FROM messages WHERE thread_id=$1 AND seq < $2 ORDER BY seq DESC LIMIT $3`,
        [threadId, beforeSeq, limit + 1]
      );
      hasMore = res.rows.length > limit;
      rows = res.rows.slice(0, limit).reverse();
    } else if (afterSeq !== null) {
      const res = await this.pool.query<MessageRow>(
        `SELECT * FROM messages WHERE thread_id=$1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
        [threadId, afterSeq, limit + 1]
      );
      hasMore = res.rows.length > limit;
      rows = res.rows.slice(0, limit);
    } else {
      const res = await this.pool.query<MessageRow>(
        `SELECT * FROM messages WHERE thread_id=$1 ORDER BY seq ASC LIMIT $2`,
        [threadId, limit + 1]
      );
      hasMore = res.rows.length > limit;
      rows = res.rows.slice(0, limit);
    }

    return {
      thread_id: threadId,
      messages: rows.map(messageView),
      has_more: hasMore
    };
  }

  async threadMarkRead(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['thread_id', 'seq']);
    requirePermission(p, 'thread:read');
    const threadId = uuid(input.thread_id, 'thread_id');
    const seq = integer(input.seq, 'seq', 0, 9223372036854775807);

    return transaction(this.pool, async db => {
      const thread = (await db.query<ThreadRow>('SELECT * FROM threads WHERE id=$1 AND tenant_id=$2', [threadId, p.tenantId])).rows[0];
      requireFound(thread, 'Thread');
      requireScope(p, thread.scope);

      await db.query(
        `INSERT INTO thread_reads (tenant_id, principal_id, thread_id, last_read_seq, read_at)
         VALUES ($1, $2, $3, $4, clock_timestamp())
         ON CONFLICT (tenant_id, principal_id, thread_id)
         DO UPDATE SET last_read_seq = GREATEST(thread_reads.last_read_seq, EXCLUDED.last_read_seq), read_at = clock_timestamp()`,
        [p.tenantId, p.id, threadId, seq]
      );

      await event(db, p, thread.scope, 'thread.read', threadId, {
        thread_id: threadId,
        seq,
        principal_id: p.id
      });

      return { thread_id: threadId, last_read_seq: seq };
    });
  }

  async threadList(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['agent_id', 'kind', 'include_archived', 'after', 'limit']);
    requirePermission(p, 'thread:read');
    const [all, grantedScopes] = scopeSql(p);
    const agentId = input.agent_id !== undefined ? uuid(input.agent_id, 'agent_id') : null;
    const kind = input.kind !== undefined ? string(input.kind, 'kind', 32) : null;
    const includeArchived = input.include_archived !== undefined ? booleanOption(input.include_archived, 'include_archived') : false;
    const after = input.after !== undefined ? uuid(input.after, 'after') : null;
    const limit = input.limit !== undefined ? integer(input.limit, 'limit', 1, 100) : 50;

    const rows = (await this.pool.query<ThreadRow & { unread_count: number }>(
      `SELECT t.*,
         COALESCE((
           SELECT count(*)::int FROM messages m
           WHERE m.thread_id = t.id
             AND m.seq > COALESCE((
               SELECT r.last_read_seq FROM thread_reads r
               WHERE r.tenant_id = t.tenant_id AND r.principal_id = $1 AND r.thread_id = t.id
             ), 0)
         ), 0) AS unread_count
       FROM threads t
       WHERE t.tenant_id = $2
         AND ($3::boolean OR t.scope = ANY($4::text[]))
         AND ($5::uuid IS NULL OR t.agent_id = $5)
         AND ($6::text IS NULL OR t.kind = $6)
         AND ($7::boolean OR NOT t.archived)
         AND ($8::uuid IS NULL OR t.created_at < (SELECT created_at FROM threads WHERE id = $8))
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT $9`,
      [p.id, p.tenantId, all, grantedScopes, agentId, kind, includeArchived, after, limit + 1]
    )).rows;

    const hasMore = rows.length > limit;
    const paged = rows.slice(0, limit);

    return {
      threads: paged.map(r => threadView(r, Number(r.unread_count))),
      has_more: hasMore,
      next_cursor: hasMore ? paged.at(-1)?.id ?? null : null
    };
  }

  private async computeAgentStatus(db: Db, agent: AgentRow): Promise<string> {
    if (agent.archived) return 'offline';

    // 1. Check if running turn task
    const running = await db.query(
      "SELECT 1 FROM tasks WHERE tenant_id=$1 AND agent_id=$2 AND status='running' LIMIT 1",
      [agent.tenant_id, agent.id]
    );
    if (running.rowCount) return 'working';

    // 2. Check live workers serving the scope
    const workers = await db.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM principals w
       WHERE w.tenant_id=$1 AND w.role='worker' AND NOT w.disabled
         AND $2=ANY(w.scopes) AND w.last_seen_at>clock_timestamp()-interval '60 seconds'`,
      [agent.tenant_id, agent.scope]
    );
    if (Number(workers.rows[0]?.count ?? 0) === 0) return 'offline';

    return 'idle';
  }
}
