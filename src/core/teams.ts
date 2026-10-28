import type { Pool, PoolClient } from 'pg';
import { transaction } from '../db.js';
import { AppError, requireCondition } from '../errors.js';
import { canAccessScope, hasPermission, requirePermission, requireScope } from '../policy.js';
import { redactSecrets } from '../safety/redact.js';
import type { Principal } from '../types.js';
import { integer, object, optionalString, scopeName, string, uuid } from '../validation.js';
import { booleanOption } from './memory.js';
import { assertKnownScope, audit, canonicalJson, event, newId, noExtraKeys, requireFound, scopeLock, scopeSql, sha256, teamsLock, type Db } from './shared.js';
import { runnerCapability, type RunnerConfig } from '../bridge/adapters.js';
import { sectionView, swarmView, type SwarmRow, type SwarmStepRow, type QuestionRow, type SectionRow } from './swarms.js';
import { botCapability } from './bots.js';
import type { TaskRow } from './tasks.js';

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

/** A clear 409 instead of the unique index's 500; callers hold teamsLock, so the check cannot race. */
async function requireFreeName(db: Db, tenantId: string, scope: string, name: string): Promise<void> {
  const taken = await db.query('SELECT 1 FROM agents WHERE tenant_id=$1 AND scope=$2 AND lower(name)=lower($3) AND NOT archived', [tenantId, scope, name]);
  requireCondition(!taken.rowCount, 409, 'name_taken', `An agent named ${name} already exists in ${scope}.`);
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
  kind: 'agent_main' | 'agent_side' | 'channel' | 'bot';
  title: string | null;
  lead_agent_id?: string | null;
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
  kind: 'text' | 'handoff' | 'swarm' | 'run' | 'question' | 'answer' | 'notice' | 'task';
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

export function agentView(row: AgentRow, status = 'idle', unreadCount = 0): Record<string, unknown> {
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

export function threadView(
  row: ThreadRow,
  unreadCount = 0,
  members?: string[],
  leadAgentId?: string | null
): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    agent_id: row.agent_id,
    kind: row.kind,
    title: row.title,
    lead_agent_id: leadAgentId !== undefined ? leadAgentId : (row.lead_agent_id ?? null),
    ...(members !== undefined ? { members } : {}),
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
      await teamsLock(db, p.tenantId);
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

      await requireFreeName(db, p.tenantId, scope, name);
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
      await teamsLock(db, p.tenantId);
      await db.query(`SELECT 1 FROM threads WHERE id=(SELECT main_thread_id FROM agents WHERE id=$1 AND tenant_id=$2) FOR UPDATE`, [agentId, p.tenantId]);
      const existing = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [agentId, p.tenantId])).rows[0];
      requireFound(existing, 'Agent');
      requireScope(p, existing.scope);
      requireCondition(existing.version === expected, 409, 'version_conflict', 'Agent has changed; reload before updating.');

      const nextName = input.name !== undefined ? string(input.name, 'name', 64) : existing.name;
      if (nextName.toLowerCase() !== existing.name.toLowerCase()) await requireFreeName(db, existing.tenant_id, existing.scope, nextName);
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

    const running = new Set((await this.pool.query<{ agent_id: string }>(
      "SELECT DISTINCT agent_id FROM tasks WHERE tenant_id=$1 AND agent_id=ANY($2::uuid[]) AND status='running'",
      [p.tenantId, paged.map(a => a.id)]
    )).rows.map(r => r.agent_id));
    const liveScopes = new Set((await this.pool.query<{ scope: string }>(
      `SELECT DISTINCT unnest(scopes) AS scope FROM principals
       WHERE tenant_id=$1 AND role='worker' AND NOT disabled
         AND scopes && $2::text[] AND last_seen_at>clock_timestamp()-interval '60 seconds'`,
      [p.tenantId, [...new Set(paged.map(a => a.scope))]]
    )).rows.map(r => r.scope));
    const agents = paged.map(r => agentView(r,
      r.archived ? 'offline' : running.has(r.id) ? 'working' : liveScopes.has(r.scope) ? 'idle' : 'offline',
      Number(r.unread_count)));

    const sections = (await this.pool.query<SectionRow>(
      'SELECT * FROM sections WHERE tenant_id=$1 AND principal_id=$2 ORDER BY order_index ASC, created_at ASC',
      [p.tenantId, p.id]
    )).rows;

    return {
      agents,
      sections: sections.map(sectionView),
      has_more: hasMore,
      next_cursor: hasMore ? paged.at(-1)?.id ?? null : null
    };
  }

  async agentArchive(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['agent_id']);
    requirePermission(p, 'agent:manage');
    const agentId = uuid(input.agent_id, 'agent_id');

    return transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);
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
      await teamsLock(db, p.tenantId);
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

      if (thread.kind === 'channel' || thread.kind === 'bot') {
        let bot: { id: string; routing: Record<string, unknown> } | undefined;
        if (thread.kind === 'bot') {
          bot = (await db.query<{ id: string; routing: Record<string, unknown> }>(
            'SELECT id, routing FROM bots WHERE thread_id=$1',
            [threadId]
          )).rows[0];
        }

        const members = (await db.query<{ agent_id: string; name: string }>(
          `SELECT m.agent_id, a.name
           FROM thread_members m
           JOIN agents a ON a.id = m.agent_id
           WHERE m.thread_id=$1 AND NOT a.archived`,
          [threadId]
        )).rows;

        const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
        const mentionedNames = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = mentionRegex.exec(body)) !== null) {
          if (match[1]) mentionedNames.add(match[1].toLowerCase());
        }

        const targetAgents: string[] = [];
        if (mentionedNames.size > 0) {
          for (const m of members) {
            if (mentionedNames.has(m.name.toLowerCase())) {
              targetAgents.push(m.agent_id);
            }
          }
        } else if (thread.lead_agent_id) {
          targetAgents.push(thread.lead_agent_id);
        }

        for (const agentId of targetAgents) {
          const queuedTurn = (await db.query<{ id: string; context_versions: Record<string, unknown> }>(
            "SELECT id, context_versions FROM tasks WHERE tenant_id=$1 AND agent_id=$2 AND thread_id=$3 AND kind='turn' AND status='queued' ORDER BY id ASC LIMIT 1 FOR UPDATE",
            [p.tenantId, agentId, threadId]
          )).rows[0];

          if (queuedTurn) {
            const updatedVersions = { ...(queuedTurn.context_versions ?? {}), message_seq: Number(nextSeq) };
            await db.query(
              'UPDATE tasks SET context_versions=$1::jsonb, updated_at=clock_timestamp() WHERE id=$2',
              [JSON.stringify(updatedVersions), queuedTurn.id]
            );
          } else {
            const agent = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [agentId])).rows[0];
            if (!agent) continue;

            const botId = bot?.id ?? null;
            const turnKind = agent.edits ? 'patch' : 'summary';
            const requiredCap = bot ? botCapability(bot, turnKind, agent.edits) : runnerCapability(agent.runner, agent.edits);
            const taskId = newId();
            const cleanBody = clipUtf8(body.replace(/@[a-zA-Z0-9_-]+\s*/g, '').trim(), 256);
            const turnObjective = thread.kind === 'bot'
              ? (cleanBody || `Turn for agent ${agent.name} in ${thread.title ?? 'bot'}`)
              : `Turn for agent ${agent.name} in #${thread.title ?? 'channel'}`;
            const envelope = {
              deploy: false, publish: false, purchase: false, local_patch: agent.edits,
              read_project: true, send_messages: false, permission_changes: false, external_side_effects: false
            };
            const contextVersions = { message_seq: Number(nextSeq), hop_depth: 0 };
            const reqHash = sha256(canonicalJson({
              kind: 'turn', scope: agent.scope, agent_id: agent.id, thread_id: threadId, seq: Number(nextSeq)
            }));

            await db.query(
              `INSERT INTO tasks
                 (id, tenant_id, scope, kind, agent_id, thread_id, bot_id, objective, constraints, acceptance_criteria,
                  permission_envelope, required_capability, resource_key, context_versions, status, created_by,
                  idempotency_key, request_hash, max_attempts)
               VALUES ($1, $2, $3, 'turn', $4, $5, $6, $7, '[]'::jsonb, '[]'::jsonb, $8::jsonb, $9, $10, $11::jsonb, 'queued', $12, $13, $14, 3)`,
              [taskId, p.tenantId, agent.scope, agent.id, threadId, botId, turnObjective, JSON.stringify(envelope),
               requiredCap, `agent:${agent.id}`, JSON.stringify(contextVersions), p.id, newId(), reqHash]
            );

            await audit(db, p, agent.scope, 'task.submitted', taskId, { kind: 'turn', agent_id: agent.id });
            await event(db, p, agent.scope, 'task.updated', taskId, { task_id: taskId, status: 'queued', action: 'submitted' });
          }
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
        `SELECT * FROM messages WHERE thread_id=$1 ORDER BY seq DESC LIMIT $2`,
        [threadId, limit + 1]
      );
      hasMore = res.rows.length > limit;
      rows = res.rows.slice(0, limit).reverse();
    }

    // Reference ids are untrusted; constrain every batch to this tenant and thread scope.
    const questionIds = rows.filter(r => r.kind === 'question' || r.kind === 'answer')
      .flatMap(r => typeof r.ref?.question_id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(r.ref.question_id) ? [r.ref.question_id] : []);
    const questions = new Map((questionIds.length ? (await this.pool.query<QuestionRow>(
      'SELECT * FROM questions WHERE id=ANY($1::uuid[]) AND tenant_id=$2 AND scope=$3',
      [questionIds, p.tenantId, thread.scope]
    )).rows : []).map(q => [q.id, q]));
    const swarmIds = rows.filter(r => r.kind === 'swarm' && hasPermission(p, 'task:read'))
      .flatMap(r => typeof r.ref?.swarm_id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(r.ref.swarm_id) ? [r.ref.swarm_id] : []);
    // A join keeps swarm headers and ordered steps in one round trip and preserves pg Date parsing.
    const swarmRows = swarmIds.length ? (await this.pool.query<SwarmStepRow & { card: SwarmRow }>(
      `SELECT st.*, row_to_json(s) AS card FROM swarms s
       LEFT JOIN swarm_steps st ON st.swarm_id=s.id
       WHERE s.id=ANY($1::uuid[]) AND s.tenant_id=$2 AND s.scope=$3
       ORDER BY st.order_index ASC`, [swarmIds, p.tenantId, thread.scope]
    )).rows : [];
    const swarms = new Map<string, { swarm: SwarmRow; steps: SwarmStepRow[] }>();
    for (const r of swarmRows) {
      const s = r.card;
      if (!swarms.has(s.id)) swarms.set(s.id, { swarm: { ...s,
        created_at: new Date(s.created_at), updated_at: new Date(s.updated_at),
        closed_at: s.closed_at ? new Date(s.closed_at) : null }, steps: [] });
      if (r.id) swarms.get(s.id)!.steps.push(r);
    }
    const taskCardIds = rows.filter(r => r.kind === 'task')
      .flatMap(r => typeof r.ref?.task_id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(r.ref.task_id) ? [r.ref.task_id] : []);
    const taskRows = taskCardIds.length ? (await this.pool.query<TaskRow>(
      'SELECT * FROM tasks WHERE id=ANY($1::uuid[]) AND tenant_id=$2 AND scope=$3',
      [taskCardIds, p.tenantId, thread.scope]
    )).rows : [];
    const taskMap = new Map(taskRows.map(t => [t.id, t]));
    const messages = rows.map(r => {
      const view = messageView(r);
      const q = questions.get(String(r.ref?.question_id));
      if (q && r.kind === 'question') view.question = {
        id: q.id, prompt: q.prompt, options: q.options, multi: q.multi, free_text: q.free_text,
        status: q.status, swarm_step_id: q.swarm_step_id, created_at: q.created_at.toISOString(),
        answer: q.status === 'answered' ? { choices: q.choices, text: q.answer_text } : null
      };
      if (q && r.kind === 'answer') view.answer = { question_id: q.id, choices: q.choices, text: q.answer_text };
      const sw = swarms.get(String(r.ref?.swarm_id));
      if (sw && r.kind === 'swarm') view.swarm = swarmView(sw.swarm, sw.steps);
      if (r.kind === 'task') {
        const t = taskMap.get(String(r.ref?.task_id));
        if (t) {
          const res = (t.result ?? {}) as Record<string, unknown>;
          const served = (res.served ?? (res.provider ? { provider: res.provider, model: res.model } : null)) as { provider?: string; model?: string } | null;
          const failure = res.failure as { code?: string; detail?: string } | undefined;
          view.task = {
            id: t.id,
            title: t.objective,
            kind: t.kind,
            status: t.status,
            resolved: Boolean(t.resolved_at),
            branch: typeof res.branch === 'string' ? res.branch : null,
            changed_files: typeof res.changed_files === 'number' ? res.changed_files : null,
            served: served ? { provider: served.provider, model: served.model } : null,
            failure: failure ? { code: failure.code, detail: failure.detail } : null,
            check: null
          };
        }
      }
      return view;
    });
    return {
      thread_id: threadId,
      messages,
      has_more: hasMore
    };
  }

  async threadMarkRead(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['thread_id', 'seq']);
    requirePermission(p, 'thread:read');
    const threadId = uuid(input.thread_id, 'thread_id');
    const seq = integer(input.seq, 'seq', 0, 9223372036854775807);

    return transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);
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

    const rows = (await this.pool.query<ThreadRow & { unread_count: number; members?: string[] }>(
      `SELECT t.*,
         (SELECT array_agg(m.agent_id::text) FROM thread_members m WHERE m.thread_id = t.id) AS members,
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
         AND (
           CASE
             WHEN $6::text IS NOT NULL THEN t.kind = $6
             ELSE t.kind != 'bot'
           END
         )
         AND ($7::boolean OR NOT t.archived)
         AND ($8::uuid IS NULL OR t.created_at < (SELECT created_at FROM threads WHERE id = $8))
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT $9`,
      [p.id, p.tenantId, all, grantedScopes, agentId, kind, includeArchived, after, limit + 1]
    )).rows;

    const hasMore = rows.length > limit;
    const paged = rows.slice(0, limit);

    return {
      threads: paged.map(r => threadView(r, Number(r.unread_count), r.members ?? undefined, r.lead_agent_id)),
      has_more: hasMore,
      next_cursor: hasMore ? paged.at(-1)?.id ?? null : null
    };
  }

  async channelCreate(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['name', 'scope', 'members', 'lead_agent_id']);
    requirePermission(p, 'agent:manage');
    const name = string(input.name, 'name', 64);
    const scope = scopeName(input.scope);
    assertKnownScope(p, scope);
    requireScope(p, scope);
    if (!Array.isArray(input.members)) throw new AppError(400, 'invalid_arguments', 'members must be an array of agent ids.');
    const memberIds = input.members.map(m => uuid(m, 'member'));
    const leadAgentId = input.lead_agent_id !== undefined && input.lead_agent_id !== null ? uuid(input.lead_agent_id, 'lead_agent_id') : null;

    return transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);
      for (const mId of memberIds) {
        const a = (await db.query('SELECT id FROM agents WHERE id=$1 AND tenant_id=$2 AND scope=$3 AND NOT archived', [mId, p.tenantId, scope])).rows[0];
        requireCondition(Boolean(a), 400, 'agent_not_found', `Member agent ${mId} not found or archived in scope ${scope}`);
      }
      if (leadAgentId) {
        const lead = (await db.query('SELECT id FROM agents WHERE id=$1 AND tenant_id=$2 AND scope=$3 AND NOT archived', [leadAgentId, p.tenantId, scope])).rows[0];
        requireCondition(Boolean(lead), 400, 'agent_not_found', `Lead agent ${leadAgentId} not found or archived in scope ${scope}`);
      }

      const threadId = newId();
      await db.query(
        `INSERT INTO threads (id, tenant_id, scope, agent_id, kind, title, lead_agent_id)
         VALUES ($1, $2, $3, NULL, 'channel', $4, $5)`,
        [threadId, p.tenantId, scope, name, leadAgentId]
      );

      for (const mId of memberIds) {
        await db.query(
          `INSERT INTO thread_members (tenant_id, thread_id, agent_id) VALUES ($1, $2, $3)`,
          [p.tenantId, threadId, mId]
        );
      }

      const thread = (await db.query<ThreadRow>('SELECT * FROM threads WHERE id=$1', [threadId])).rows[0]!;
      await audit(db, p, scope, 'channel.create', threadId, { name, members: memberIds });

      return { channel: threadView(thread, 0, memberIds, leadAgentId) };
    });
  }

  async channelUpdate(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['channel_id', 'expected_version', 'name', 'members', 'lead_agent_id']);
    requirePermission(p, 'agent:manage');
    const channelId = uuid(input.channel_id, 'channel_id');
    const expected = integer(input.expected_version, 'expected_version', 1, 2147483647);

    return transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);
      const thread = (await db.query<ThreadRow>('SELECT * FROM threads WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [channelId, p.tenantId])).rows[0];
      requireFound(thread, 'Channel');
      requireCondition(thread.kind === 'channel', 400, 'invalid_arguments', 'Target thread is not a channel.');
      requireScope(p, thread.scope);
      requireCondition(thread.version === expected, 409, 'version_conflict', 'Channel has changed; reload before updating.');

      const nextTitle = input.name !== undefined ? string(input.name, 'name', 64) : thread.title;
      let nextLead = thread.lead_agent_id;
      if (input.lead_agent_id !== undefined) {
        nextLead = input.lead_agent_id ? uuid(input.lead_agent_id, 'lead_agent_id') : null;
        if (nextLead) {
          const lead = (await db.query('SELECT id FROM agents WHERE id=$1 AND tenant_id=$2 AND scope=$3 AND NOT archived', [nextLead, p.tenantId, thread.scope])).rows[0];
          requireCondition(Boolean(lead), 400, 'agent_not_found', `Lead agent ${nextLead} not found or archived in scope ${thread.scope}`);
        }
      }

      let memberIds: string[];
      if (input.members !== undefined) {
        if (!Array.isArray(input.members)) throw new AppError(400, 'invalid_arguments', 'members must be an array.');
        memberIds = input.members.map(m => uuid(m, 'member'));
        for (const mId of memberIds) {
          const a = (await db.query('SELECT id FROM agents WHERE id=$1 AND tenant_id=$2 AND scope=$3 AND NOT archived', [mId, p.tenantId, thread.scope])).rows[0];
          requireCondition(Boolean(a), 400, 'agent_not_found', `Member agent ${mId} not found or archived in scope ${thread.scope}`);
        }
        await db.query('DELETE FROM thread_members WHERE thread_id=$1', [channelId]);
        for (const mId of memberIds) {
          await db.query('INSERT INTO thread_members (tenant_id, thread_id, agent_id) VALUES ($1, $2, $3)', [p.tenantId, channelId, mId]);
        }
      } else {
        const existingMembers = await db.query<{ agent_id: string }>('SELECT agent_id FROM thread_members WHERE thread_id=$1', [channelId]);
        memberIds = existingMembers.rows.map(r => r.agent_id);
      }

      const updated = (await db.query<ThreadRow>(
        `UPDATE threads SET title=$1, lead_agent_id=$2, version=version+1, updated_at=clock_timestamp()
         WHERE id=$3 RETURNING *`,
        [nextTitle, nextLead, channelId]
      )).rows[0]!;

      await audit(db, p, updated.scope, 'channel.update', channelId, { version: updated.version });
      return { channel: threadView(updated, 0, memberIds, nextLead) };
    });
  }

  async sectionSet(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['sections']);
    requirePermission(p, 'thread:read');
    if (!Array.isArray(input.sections)) throw new AppError(400, 'invalid_arguments', 'sections must be an array.');
    const rawSections = input.sections as Array<Record<string, unknown>>;
    return transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);
      await db.query('DELETE FROM sections WHERE tenant_id=$1 AND principal_id=$2', [p.tenantId, p.id]);
      const inserted: SectionRow[] = [];
      for (let i = 0; i < rawSections.length; i++) {
        const s = object(rawSections[i]);
        const secId = s.id !== undefined ? uuid(s.id, `sections[${i}].id`) : newId();
        const name = string(s.name, `sections[${i}].name`, 100);
        const items = Array.isArray(s.items) ? s.items.map(it => String(it)) : [];
        const collapsed = s.collapsed !== undefined ? booleanOption(s.collapsed, 'collapsed') : false;
        const row = (await db.query<SectionRow>(
          `INSERT INTO sections (id, tenant_id, principal_id, name, order_index, items, collapsed)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
          [secId, p.tenantId, p.id, name, i, JSON.stringify(items), collapsed]
        )).rows[0]!;
        inserted.push(row);
      }
      return { sections: inserted.map(sectionView) };
    });
  }

  async sectionList(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, []);
    requirePermission(p, 'thread:read');
    const rows = (await this.pool.query<SectionRow>(
      'SELECT * FROM sections WHERE tenant_id=$1 AND principal_id=$2 ORDER BY order_index ASC, created_at ASC',
      [p.tenantId, p.id]
    )).rows;
    return { sections: rows.map(sectionView) };
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
