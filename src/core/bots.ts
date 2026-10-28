import type { Pool } from 'pg';
import { transaction } from '../db.js';
import { AppError, requireCondition } from '../errors.js';
import { requirePermission, requireScope } from '../policy.js';
import { redactSecrets } from '../safety/redact.js';
import type { Principal } from '../types.js';
import { integer, object, scopeName, string, uuid } from '../validation.js';
import { booleanOption } from './memory.js';
import { assertKnownScope, audit, canonicalJson, event, newId, noExtraKeys, requireFound, scopeSql, teamsLock, type Db } from './shared.js';
import { agentView, assignThreadSeq, clipUtf8, threadView, type AgentRow, type ThreadRow } from './teams.js';
import { cancelTask, type TaskRow } from './tasks.js';
import { AUTO_PATCH, AUTO_READ } from './swarm.js';
import type { RunnerConfig } from '../bridge/adapters.js';

export interface BotRow {
  id: string;
  tenant_id: string;
  scope: string;
  name: string;
  job: string;
  avatar: string | null;
  thread_id: string;
  lead_agent_id: string;
  routing: Record<string, unknown>;
  rules: Record<string, unknown>;
  schedule: string | null;
  next_run_at: Date | null;
  archived: boolean;
  version: number;
  created_by: string;
  idempotency_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface BotBadges {
  unread: number;
  needs_you: number;
  latest: { kind: string; line: string; at: string } | null;
}

export interface BotRules {
  quota_floor_pct: number;
  approve_public: boolean;
  review_edits: boolean;
  require_tests: boolean;
}

export const VALID_ROUTING_KINDS = ['research', 'patch', 'review', 'summary'] as const;
export const VALID_ROUTING_PROVIDERS = ['claude', 'codex', 'antigravity'] as const;

export const DEFAULT_BOT_RULES: BotRules = {
  quota_floor_pct: 0,
  approve_public: true,
  review_edits: true,
  require_tests: false
};

export function validateRouting(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  const obj = object(raw);
  noExtraKeys(obj, [...VALID_ROUTING_KINDS]);
  const result: Record<string, unknown> = {};

  for (const kind of VALID_ROUTING_KINDS) {
    if (obj[kind] === undefined) continue;
    const runner = object(obj[kind]);
    noExtraKeys(runner, ['mode', 'provider', 'model', 'effort']);

    if (runner.mode !== undefined) {
      if (kind === 'review') {
        requireCondition(
          runner.mode === 'auto' || runner.mode === 'different_from_author',
          400,
          'invalid_arguments',
          'review mode must be auto or different_from_author'
        );
      } else {
        requireCondition(
          runner.mode === 'auto',
          400,
          'invalid_arguments',
          `${kind} mode must be auto`
        );
      }
      requireCondition(
        runner.provider === undefined && runner.model === undefined && runner.effort === undefined,
        400,
        'invalid_arguments',
        'runner with mode cannot specify provider, model or effort'
      );
      result[kind] = { mode: runner.mode };
    } else {
      const provider = string(runner.provider, `${kind}.runner.provider`, 32);
      requireCondition(
        (VALID_ROUTING_PROVIDERS as readonly string[]).includes(provider),
        400,
        'invalid_arguments',
        `${kind}.runner.provider must be claude, codex or antigravity`
      );
      const runnerObj: Record<string, unknown> = { provider };
      if (runner.model !== undefined) runnerObj.model = string(runner.model, `${kind}.runner.model`, 100);
      if (runner.effort !== undefined) runnerObj.effort = string(runner.effort, `${kind}.runner.effort`, 40);
      result[kind] = runnerObj;
    }
  }
  return result;
}

export function validateRules(raw: unknown, existing?: Record<string, unknown>): BotRules {
  const base: BotRules = existing ? {
    quota_floor_pct: typeof existing.quota_floor_pct === 'number' ? existing.quota_floor_pct : DEFAULT_BOT_RULES.quota_floor_pct,
    approve_public: typeof existing.approve_public === 'boolean' ? existing.approve_public : DEFAULT_BOT_RULES.approve_public,
    review_edits: typeof existing.review_edits === 'boolean' ? existing.review_edits : DEFAULT_BOT_RULES.review_edits,
    require_tests: typeof existing.require_tests === 'boolean' ? existing.require_tests : DEFAULT_BOT_RULES.require_tests
  } : { ...DEFAULT_BOT_RULES };

  if (raw === undefined || raw === null) return base;
  const obj = object(raw);
  noExtraKeys(obj, ['quota_floor_pct', 'approve_public', 'review_edits', 'require_tests']);

  if (obj.quota_floor_pct !== undefined) {
    base.quota_floor_pct = integer(obj.quota_floor_pct, 'quota_floor_pct', 0, 50);
  }
  if (obj.approve_public !== undefined) {
    base.approve_public = booleanOption(obj.approve_public, 'approve_public');
  }
  if (obj.review_edits !== undefined) {
    base.review_edits = booleanOption(obj.review_edits, 'review_edits');
  }
  if (obj.require_tests !== undefined) {
    base.require_tests = booleanOption(obj.require_tests, 'require_tests');
  }
  return base;
}

export function validateSchedule(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const str = string(raw, 'schedule', 120).trim();
  requireCondition(
    str.length >= 9 && str.length <= 120,
    400,
    'invalid_arguments',
    'schedule length must be between 9 and 120 characters'
  );
  const match = /^(?:CRON_TZ=([A-Za-z0-9_+\/-]+)\s+)?(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/.exec(str);
  requireCondition(
    match !== null,
    400,
    'invalid_arguments',
    'schedule must be a valid 5-field cron expression, optionally prefixed with CRON_TZ=<zone>'
  );
  for (let i = 2; i <= 6; i++) {
    requireCondition(
      /^[0-9A-Za-z*,\/-]+$/.test(match![i]!),
      400,
      'invalid_arguments',
      `invalid cron field: ${match![i]!}`
    );
  }
  return str;
}

/**
 * Static mapping of bot routing to required_capability.
 * - a provider runner gives <provider>.read or .patch;
 * - auto, or a missing kind, gives auto.read or auto.patch.
 */
export function botCapability(
  bot: { routing?: Record<string, unknown> } | null | undefined,
  kind: string,
  edits = false
): string {
  const routing = bot?.routing;
  const runner = (routing && typeof routing === 'object') ? (routing[kind] as { mode?: string; provider?: string } | undefined) : undefined;
  if (!runner || runner.mode === 'auto' || runner.mode === 'different_from_author' || !runner.provider) {
    return edits ? AUTO_PATCH : AUTO_READ;
  }
  return `${runner.provider}.${edits ? 'patch' : 'read'}`;
}

export function formatTaskCardBody(
  agentName: string | null,
  botName: string,
  objective: string,
  outcome: 'completed' | 'failed' | 'blocked',
  result: Record<string, unknown>
): string {
  if (outcome === 'failed') {
    const failureObj = result.failure as { code?: string; detail?: string } | undefined;
    const failCode = failureObj?.code || 'error';
    const servedObj = result.served as { provider?: string } | undefined;
    const rawProvider = servedObj?.provider || (typeof result.provider === 'string' ? result.provider : null);
    const providerName = rawProvider === 'codex' ? 'Codex' : rawProvider === 'claude' ? 'Claude' : rawProvider === 'antigravity' ? 'Antigravity' : rawProvider ? (rawProvider.charAt(0).toUpperCase() + rawProvider.slice(1)) : null;
    return providerName ? `Failed · ${failCode} on ${providerName}` : `Failed · ${failCode}`;
  }

  const who = agentName || botName || 'Bot';
  let clean = (objective || 'the task').trim();
  clean = clean.replace(/^Turn for agent \S+ in #\S+:?\s*/i, '');
  clean = clean.replace(/^Turn for agent \S+:?\s*/i, '');
  clean = clean.replace(/^Turn in channel #\S+:?\s*/i, '');
  if (!clean || /^Turn for agent \S+$/i.test(clean)) clean = 'the task';
  clean = clean.replace(/^finished\s+/i, '');

  const desc = `${who} finished ${clean}`;
  const branch = typeof result.branch === 'string' ? result.branch : null;
  const files = typeof result.changed_files === 'number'
    ? `${result.changed_files} file${result.changed_files === 1 ? '' : 's'}`
    : null;

  return [desc, branch, files].filter(Boolean).join(' · ');
}

export function botView(
  row: BotRow,
  memberAgentIds: string[],
  badges?: BotBadges
): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    job: row.job,
    avatar: row.avatar,
    thread_id: row.thread_id,
    lead_agent_id: row.lead_agent_id,
    member_agent_ids: memberAgentIds,
    routing: row.routing,
    rules: row.rules,
    schedule: row.schedule,
    next_run_at: row.next_run_at ? row.next_run_at.toISOString() : null,
    archived: row.archived,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    ...(badges !== undefined ? { badges } : {})
  };
}

async function requireFreeBotName(db: Db, tenantId: string, scope: string, name: string, excludeId?: string): Promise<void> {
  const taken = await db.query(
    'SELECT 1 FROM bots WHERE tenant_id=$1 AND scope=$2 AND lower(name)=lower($3) AND NOT archived' + (excludeId ? ' AND id<>$4' : ''),
    excludeId ? [tenantId, scope, name, excludeId] : [tenantId, scope, name]
  );
  requireCondition(!taken.rowCount, 409, 'name_taken', `A bot named ${name} already exists in ${scope}.`);
}

export async function postBotTaskCard(
  db: Db,
  p: Principal,
  row: TaskRow,
  outcome: 'completed' | 'failed' | 'blocked',
  result: Record<string, unknown>
): Promise<void> {
  const isReviewReady = outcome === 'completed' && typeof result.head_commit === 'string' && result.head_commit.length > 0;
  const isFailed = outcome === 'failed';
  if (!isReviewReady && !isFailed) return;
  if (!row.bot_id) return;

  const botRow = (await db.query<{ thread_id: string; name: string; scope: string }>(
    'SELECT thread_id, name, scope FROM bots WHERE id=$1 AND tenant_id=$2',
    [row.bot_id, p.tenantId]
  )).rows[0];
  if (!botRow) return;

  // Turn grant rule: scope must match
  requireCondition(botRow.scope === row.scope, 403, 'turn_grant_forbidden', 'Turn grant refuses posting to a bot thread in a different scope.');

  // Idempotency: never post two cards for one task and one outcome
  const existingCards = (await db.query<{ id: string; body: string }>(
    `SELECT id, body FROM messages WHERE tenant_id=$1 AND thread_id=$2 AND kind='task' AND (ref->>'task_id')=$3`,
    [p.tenantId, botRow.thread_id, row.id]
  )).rows;
  const alreadyPosted = existingCards.some(c => isFailed ? c.body.startsWith('Failed') : !c.body.startsWith('Failed'));
  if (alreadyPosted) return;

  let agentName: string | null = null;
  if (row.agent_id) {
    const agentRow = (await db.query<{ name: string }>('SELECT name FROM agents WHERE id=$1', [row.agent_id])).rows[0];
    if (agentRow) agentName = agentRow.name;
  }

  const body = formatTaskCardBody(agentName, botRow.name, row.objective, outcome, result);
  const nextSeq = await assignThreadSeq(db, p.tenantId, botRow.thread_id);
  const cardMsgId = newId();

  await db.query(
    `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body, ref)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'task', $7, $8::jsonb)`,
    [cardMsgId, p.tenantId, row.scope, botRow.thread_id, nextSeq,
     JSON.stringify({ kind: 'system', id: 'service' }),
     body,
     JSON.stringify({ task_id: row.id })]
  );

  await event(db, p, row.scope, 'message.created', cardMsgId, {
    thread_id: botRow.thread_id,
    message_id: cardMsgId,
    seq: Number(nextSeq),
    kind: 'task',
    author: { kind: 'system', id: 'service' }
  });

  await event(db, p, row.scope, 'bot.updated', row.bot_id, {
    bot_id: row.bot_id,
    reason: 'task_card'
  });
}

function formatTaskBadgeLine(
  objective: string,
  status: string,
  result: Record<string, unknown> | null
): string {
  const res = result ?? {};
  if (status === 'failed') {
    const failureObj = res.failure as { code?: string; detail?: string } | undefined;
    const failCode = failureObj?.code || 'error';
    const servedObj = res.served as { provider?: string } | undefined;
    const rawProvider = servedObj?.provider || (typeof res.provider === 'string' ? res.provider : null);
    const providerName = rawProvider === 'codex' ? 'Codex' : rawProvider === 'claude' ? 'Claude' : rawProvider === 'antigravity' ? 'Antigravity' : rawProvider ? (rawProvider.charAt(0).toUpperCase() + rawProvider.slice(1)) : null;
    return providerName ? `Failed · ${failCode} on ${providerName}` : `Failed · ${failCode}`;
  }
  let clean = (objective || 'the task').trim();
  clean = clean.replace(/^Turn for agent \S+ in #\S+:?\s*/i, '');
  clean = clean.replace(/^Turn for agent \S+:?\s*/i, '');
  clean = clean.replace(/^Turn in channel #\S+:?\s*/i, '');
  if (!clean || /^Turn for agent \S+$/i.test(clean)) clean = 'the task';
  clean = clean.replace(/^finished\s+/i, '');

  const branch = typeof res.branch === 'string' ? res.branch : null;
  const files = typeof res.changed_files === 'number' ? `${res.changed_files} file${res.changed_files === 1 ? '' : 's'}` : null;
  const desc = `Finished ${clean}`;
  return [desc, branch, files].filter(Boolean).join(' · ');
}

export class BotService {
  constructor(private readonly pool: Pool) {}

  async computeBadgesForBots(
    pool: Pool,
    p: Principal,
    bots: BotRow[]
  ): Promise<Map<string, BotBadges>> {
    const badgesMap = new Map<string, BotBadges>();
    if (!bots.length) return badgesMap;

    const botIds = bots.map(b => b.id);
    const threadIds = bots.map(b => b.thread_id);

    // 1. Unread counts
    const unreadRes = await pool.query<{ bot_id: string; unread_count: number }>(
      `SELECT b.id AS bot_id,
         COALESCE((
           SELECT count(*)::int FROM messages m
           WHERE m.thread_id = b.thread_id
             AND m.seq > COALESCE((
               SELECT r.last_read_seq FROM thread_reads r
               WHERE r.tenant_id = b.tenant_id AND r.principal_id = $1 AND r.thread_id = b.thread_id
             ), 0)
         ), 0) AS unread_count
       FROM bots b
       WHERE b.id = ANY($2::uuid[])`,
      [p.id, botIds]
    );
    const unreadMap = new Map(unreadRes.rows.map(r => [r.bot_id, Number(r.unread_count)]));

    // 2. Open questions per thread
    const questionsRes = await pool.query<{
      thread_id: string;
      q_count: number;
      latest_prompt: string;
      latest_created_at: Date;
    }>(
      `SELECT thread_id, count(*)::int AS q_count,
         (array_agg(prompt ORDER BY created_at DESC))[1] AS latest_prompt,
         max(created_at) AS latest_created_at
       FROM questions
       WHERE thread_id = ANY($1::uuid[]) AND tenant_id = $2 AND status = 'open'
       GROUP BY thread_id`,
      [threadIds, p.tenantId]
    );
    const questionsMap = new Map(questionsRes.rows.map(r => [r.thread_id, {
      count: Number(r.q_count),
      prompt: r.latest_prompt,
      at: new Date(r.latest_created_at)
    }]));

    // 3. Needs-you tasks per bot
    const tasksRes = await pool.query<{
      bot_id: string;
      t_count: number;
      latest_objective: string;
      latest_status: string;
      latest_result: Record<string, unknown> | null;
      latest_updated_at: Date;
    }>(
      `SELECT bot_id, count(*)::int AS t_count,
         (array_agg(objective ORDER BY updated_at DESC))[1] AS latest_objective,
         (array_agg(status ORDER BY updated_at DESC))[1] AS latest_status,
         (array_agg(result ORDER BY updated_at DESC))[1] AS latest_result,
         max(updated_at) AS latest_updated_at
       FROM tasks
       WHERE bot_id = ANY($1::uuid[]) AND tenant_id = $2 AND resolved_at IS NULL
         AND (status = 'failed' OR (status = 'completed' AND result->>'head_commit' IS NOT NULL))
       GROUP BY bot_id`,
      [botIds, p.tenantId]
    );
    const tasksMap = new Map(tasksRes.rows.map(r => [r.bot_id, {
      count: Number(r.t_count),
      objective: r.latest_objective,
      status: r.latest_status,
      result: r.latest_result,
      at: new Date(r.latest_updated_at)
    }]));

    // 4. Latest messages for threads
    const messagesRes = await pool.query<{
      thread_id: string;
      latest_kind: string;
      latest_body: string;
      latest_created_at: Date;
    }>(
      `SELECT thread_id,
         (array_agg(kind ORDER BY seq DESC))[1] AS latest_kind,
         (array_agg(body ORDER BY seq DESC))[1] AS latest_body,
         max(created_at) AS latest_created_at
       FROM messages
       WHERE thread_id = ANY($1::uuid[])
       GROUP BY thread_id`,
      [threadIds]
    );
    const messagesMap = new Map(messagesRes.rows.map(r => [r.thread_id, {
      kind: r.latest_kind,
      body: r.latest_body,
      at: new Date(r.latest_created_at)
    }]));

    for (const b of bots) {
      const unread = unreadMap.get(b.id) ?? 0;
      const q = questionsMap.get(b.thread_id);
      const t = tasksMap.get(b.id);
      const qCount = q ? q.count : 0;
      const tCount = t ? t.count : 0;
      const needsYou = qCount + tCount;

      let latest: { kind: string; line: string; at: string } | null = null;
      if (needsYou > 0) {
        if (q && t) {
          if (q.at.getTime() >= t.at.getTime()) {
            latest = { kind: 'question', line: q.prompt, at: q.at.toISOString() };
          } else {
            latest = { kind: 'task', line: formatTaskBadgeLine(t.objective, t.status, t.result), at: t.at.toISOString() };
          }
        } else if (q) {
          latest = { kind: 'question', line: q.prompt, at: q.at.toISOString() };
        } else if (t) {
          latest = { kind: 'task', line: formatTaskBadgeLine(t.objective, t.status, t.result), at: t.at.toISOString() };
        }
      } else {
        const msg = messagesMap.get(b.thread_id);
        if (msg) {
          latest = { kind: msg.kind, line: msg.body, at: msg.at.toISOString() };
        }
      }

      badgesMap.set(b.id, { unread, needs_you: needsYou, latest });
    }

    return badgesMap;
  }

  async botCreate(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['name', 'job', 'scope', 'lead_agent_id', 'member_agent_ids', 'routing', 'rules', 'schedule', 'avatar', 'idempotency_key']);
    requirePermission(p, 'agent:manage');

    const name = string(input.name, 'name', 64);
    const rawJob = string(input.job, 'job', 8192);
    requireCondition(Buffer.byteLength(rawJob, 'utf8') <= 8192, 400, 'invalid_arguments', 'job exceeds maximum size of 8192 bytes.');
    const job = rawJob;
    const scope = scopeName(input.scope);
    assertKnownScope(p, scope);
    requireScope(p, scope);

    const leadAgentId = uuid(input.lead_agent_id, 'lead_agent_id');
    if (!Array.isArray(input.member_agent_ids)) {
      throw new AppError(400, 'invalid_arguments', 'member_agent_ids must be an array of agent ids.');
    }
    const memberAgentIds = input.member_agent_ids.map(m => uuid(m, 'member_agent_ids'));
    const routing = validateRouting(input.routing);
    const rules = validateRules(input.rules);
    const schedule = validateSchedule(input.schedule);
    const avatar = input.avatar !== undefined ? string(input.avatar, 'avatar', 200) : null;
    const idempotency = input.idempotency_key !== undefined ? string(input.idempotency_key, 'idempotency_key', 200) : null;

    return transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);

      if (idempotency) {
        const existing = (await db.query<BotRow>(
          'SELECT * FROM bots WHERE tenant_id=$1 AND created_by=$2 AND idempotency_key=$3',
          [p.tenantId, p.id, idempotency]
        )).rows[0];
        if (existing) {
          const thread = (await db.query<ThreadRow>('SELECT * FROM threads WHERE id=$1', [existing.thread_id])).rows[0]!;
          const currentMembers = (await db.query<{ agent_id: string }>(
            'SELECT agent_id FROM thread_members WHERE thread_id=$1 AND agent_id<>$2',
            [existing.thread_id, existing.lead_agent_id]
          )).rows.map(r => r.agent_id);
          const badges = await this.computeBadgesForBots(this.pool, p, [existing]);
          return {
            bot: botView(existing, currentMembers, badges.get(existing.id)),
            thread: threadView(thread),
            replayed: true
          };
        }
      }

      await requireFreeBotName(db, p.tenantId, scope, name);

      // Validate crew agents: must exist, be live (not archived), and in scope
      const crewIds = Array.from(new Set([leadAgentId, ...memberAgentIds]));
      const liveAgents = (await db.query<{ id: string; scope: string; archived: boolean }>(
        'SELECT id, scope, archived FROM agents WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
        [p.tenantId, crewIds]
      )).rows;

      const liveMap = new Map(liveAgents.map(a => [a.id, a]));
      for (const id of crewIds) {
        const ag = liveMap.get(id);
        requireCondition(
          Boolean(ag && !ag.archived && ag.scope === scope),
          400,
          'agent_not_found',
          `Agent ${id} not found, archived, or in different scope.`
        );
      }

      const threadId = newId();
      const botId = newId();

      await db.query(
        `INSERT INTO threads (id, tenant_id, scope, agent_id, kind, title, lead_agent_id)
         VALUES ($1, $2, $3, NULL, 'bot', $4, $5)`,
        [threadId, p.tenantId, scope, name, leadAgentId]
      );

      for (const agentId of crewIds) {
        await db.query(
          'INSERT INTO thread_members (tenant_id, thread_id, agent_id) VALUES ($1, $2, $3)',
          [p.tenantId, threadId, agentId]
        );
      }

      const botRes = await db.query<BotRow>(
        `INSERT INTO bots
           (id, tenant_id, scope, name, job, avatar, thread_id, lead_agent_id, routing, rules, schedule, next_run_at, archived, version, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, NULL, false, 1, $12, $13)
         RETURNING *`,
        [botId, p.tenantId, scope, name, job, avatar, threadId, leadAgentId, JSON.stringify(routing), JSON.stringify(rules), schedule, p.id, idempotency]
      );
      const bot = botRes.rows[0]!;

      const threadRes = await db.query<ThreadRow>('SELECT * FROM threads WHERE id=$1', [threadId]);
      const thread = threadRes.rows[0]!;

      await audit(db, p, scope, 'bot.create', botId, { name });
      await event(db, p, scope, 'bot.updated', botId, { bot_id: botId, reason: 'created' });

      return {
        bot: botView(bot, memberAgentIds, { unread: 0, needs_you: 0, latest: null }),
        thread: threadView(thread)
      };
    });
  }

  async botUpdate(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['bot_id', 'expected_version', 'name', 'job', 'avatar', 'lead_agent_id', 'member_agent_ids', 'routing', 'rules', 'schedule']);
    requirePermission(p, 'agent:manage');

    const botId = uuid(input.bot_id, 'bot_id');
    const expectedVersion = integer(input.expected_version, 'expected_version', 1, 2147483647);

    return transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);

      const existing = (await db.query<BotRow>('SELECT * FROM bots WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [botId, p.tenantId])).rows[0];
      requireFound(existing, 'Bot');
      requireScope(p, existing.scope);
      requireCondition(!existing.archived, 400, 'bot_archived', 'Cannot update an archived bot.');
      requireCondition(existing.version === expectedVersion, 409, 'conflict', 'Expected version does not match.');

      const nextName = input.name !== undefined ? string(input.name, 'name', 64) : existing.name;
      if (input.name !== undefined && nextName.toLowerCase() !== existing.name.toLowerCase()) {
        await requireFreeBotName(db, p.tenantId, existing.scope, nextName, botId);
      }

      let nextJob = existing.job;
      if (input.job !== undefined) {
        const rawJob = string(input.job, 'job', 8192);
        requireCondition(Buffer.byteLength(rawJob, 'utf8') <= 8192, 400, 'invalid_arguments', 'job exceeds maximum size of 8192 bytes.');
        nextJob = rawJob;
      }

      const nextAvatar = input.avatar !== undefined ? (input.avatar === null ? null : string(input.avatar, 'avatar', 200)) : existing.avatar;
      const nextLeadId = input.lead_agent_id !== undefined ? uuid(input.lead_agent_id, 'lead_agent_id') : existing.lead_agent_id;

      let nextMemberIds: string[];
      if (input.member_agent_ids !== undefined) {
        if (!Array.isArray(input.member_agent_ids)) throw new AppError(400, 'invalid_arguments', 'member_agent_ids must be an array of agent ids.');
        nextMemberIds = input.member_agent_ids.map(m => uuid(m, 'member_agent_ids'));
      } else {
        const cur = (await db.query<{ agent_id: string }>(
          'SELECT agent_id FROM thread_members WHERE thread_id=$1 AND agent_id<>$2',
          [existing.thread_id, existing.lead_agent_id]
        )).rows;
        nextMemberIds = cur.map(r => r.agent_id);
      }

      const crewChanged = input.lead_agent_id !== undefined || input.member_agent_ids !== undefined;
      if (crewChanged) {
        const allNewCrew = Array.from(new Set([nextLeadId, ...nextMemberIds]));
        const liveAgents = (await db.query<{ id: string; scope: string; archived: boolean }>(
          'SELECT id, scope, archived FROM agents WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
          [p.tenantId, allNewCrew]
        )).rows;
        const liveMap = new Map(liveAgents.map(a => [a.id, a]));
        for (const id of allNewCrew) {
          const ag = liveMap.get(id);
          requireCondition(
            Boolean(ag && !ag.archived && ag.scope === existing.scope),
            400,
            'agent_not_found',
            `Agent ${id} not found, archived, or in different scope.`
          );
        }

        await db.query('DELETE FROM thread_members WHERE thread_id=$1', [existing.thread_id]);
        for (const id of allNewCrew) {
          await db.query('INSERT INTO thread_members (tenant_id, thread_id, agent_id) VALUES ($1, $2, $3)', [p.tenantId, existing.thread_id, id]);
        }
        await db.query('UPDATE threads SET lead_agent_id=$1, updated_at=clock_timestamp() WHERE id=$2', [nextLeadId, existing.thread_id]);
      }

      const nextRouting = input.routing !== undefined ? validateRouting(input.routing) : existing.routing;
      const routingChanged = input.routing !== undefined && canonicalJson(nextRouting) !== canonicalJson(existing.routing);

      const nextRules = input.rules !== undefined ? validateRules(input.rules, existing.rules) : existing.rules;
      const nextSchedule = input.schedule !== undefined ? validateSchedule(input.schedule) : existing.schedule;

      if (input.name !== undefined) {
        await db.query('UPDATE threads SET title=$1, updated_at=clock_timestamp() WHERE id=$2', [nextName, existing.thread_id]);
      }

      // Post notice if routing or crew changed
      if (routingChanged || crewChanged) {
        const notices: string[] = [];
        if (routingChanged) {
          const patchRunner = nextRouting.patch as RunnerConfig | undefined;
          if (patchRunner?.provider) {
            const provName = patchRunner.provider.charAt(0).toUpperCase() + patchRunner.provider.slice(1);
            const details = [patchRunner.model, patchRunner.effort].filter(Boolean).join(' · ');
            notices.push(`Edits now run on ${provName}${details ? ` ${details}` : ''}`);
          } else if (patchRunner?.mode === 'auto') {
            notices.push('Edits now run on Auto');
          } else {
            notices.push('Routing updated');
          }
        }
        if (crewChanged) {
          notices.push('Crew updated');
        }
        const noticeBody = clipUtf8(notices.join('. ') + '.', 16384);
        const nextSeq = await assignThreadSeq(db, p.tenantId, existing.thread_id);
        const noticeMsgId = newId();
        await db.query(
          `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'notice', $7)`,
          [noticeMsgId, p.tenantId, existing.scope, existing.thread_id, nextSeq, JSON.stringify({ kind: 'system', id: 'service' }), noticeBody]
        );
        await event(db, p, existing.scope, 'message.created', noticeMsgId, {
          thread_id: existing.thread_id,
          message_id: noticeMsgId,
          seq: Number(nextSeq),
          kind: 'notice',
          author: { kind: 'system', id: 'service' }
        });
      }

      const updated = (await db.query<BotRow>(
        `UPDATE bots
         SET name=$1, job=$2, avatar=$3, lead_agent_id=$4, routing=$5::jsonb, rules=$6::jsonb, schedule=$7,
             version=version+1, updated_at=clock_timestamp()
         WHERE id=$8 RETURNING *`,
        [nextName, nextJob, nextAvatar, nextLeadId, JSON.stringify(nextRouting), JSON.stringify(nextRules), nextSchedule, botId]
      )).rows[0]!;

      await audit(db, p, existing.scope, 'bot.update', botId, { version: updated.version });
      await event(db, p, existing.scope, 'bot.updated', botId, { bot_id: botId, reason: 'updated' });

      const badges = await this.computeBadgesForBots(this.pool, p, [updated]);
      return { bot: botView(updated, nextMemberIds, badges.get(updated.id)) };
    });
  }

  async botGet(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['bot_id']);
    requirePermission(p, 'agent:read');

    const botId = uuid(input.bot_id, 'bot_id');
    const [all, grantedScopes] = scopeSql(p);

    const bot = (await this.pool.query<BotRow>(
      `SELECT * FROM bots WHERE id=$1 AND tenant_id=$2 AND ($3::boolean OR scope=ANY($4::text[]))`,
      [botId, p.tenantId, all, grantedScopes]
    )).rows[0];
    requireFound(bot, 'Bot');

    const crewRows = (await this.pool.query<AgentRow>(
      `SELECT a.* FROM thread_members tm
       JOIN agents a ON a.id = tm.agent_id
       WHERE tm.thread_id = $1 AND tm.tenant_id = $2`,
      [bot.thread_id, p.tenantId]
    )).rows;

    crewRows.sort((a, b) => {
      if (a.id === bot.lead_agent_id) return -1;
      if (b.id === bot.lead_agent_id) return 1;
      return a.name.localeCompare(b.name);
    });

    const crew = crewRows.map(a => agentView(a));
    const memberAgentIds = crewRows.filter(a => a.id !== bot.lead_agent_id).map(a => a.id);
    const badges = await this.computeBadgesForBots(this.pool, p, [bot]);
    const botBadge = badges.get(bot.id) ?? { unread: 0, needs_you: 0, latest: null };

    const view = {
      ...botView(bot, memberAgentIds, botBadge),
      crew,
      routing_now: null
    };

    return { bot: view, crew, routing_now: null };
  }

  async botList(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['scope', 'include_archived', 'after', 'limit']);
    requirePermission(p, 'agent:read');

    const [all, grantedScopes] = scopeSql(p);
    const scope = input.scope !== undefined ? scopeName(input.scope) : null;
    if (scope) {
      assertKnownScope(p, scope);
      requireScope(p, scope);
    }
    const includeArchived = input.include_archived !== undefined ? booleanOption(input.include_archived, 'include_archived') : false;
    const after = input.after !== undefined ? uuid(input.after, 'after') : null;
    const limit = input.limit !== undefined ? integer(input.limit, 'limit', 1, 100) : 50;

    // Use constant number of queries (CTE for initial ordering and page, then batch badges)
    const rows = (await this.pool.query<BotRow & { unread_count: number; needs_you_count: number; member_ids: string[]; thread_updated_at: Date }>(
      `WITH bot_badges AS (
         SELECT b.*,
           COALESCE((
             SELECT count(*)::int FROM messages m
             WHERE m.thread_id = b.thread_id
               AND m.seq > COALESCE((
                 SELECT r.last_read_seq FROM thread_reads r
                 WHERE r.tenant_id = b.tenant_id AND r.principal_id = $1 AND r.thread_id = b.thread_id
               ), 0)
           ), 0) AS unread_count,
           (
             COALESCE((
               SELECT count(*)::int FROM questions q
               WHERE q.tenant_id = b.tenant_id AND q.thread_id = b.thread_id AND q.status = 'open'
             ), 0)
             +
             COALESCE((
               SELECT count(*)::int FROM tasks tk
               WHERE tk.tenant_id = b.tenant_id AND tk.bot_id = b.id AND tk.resolved_at IS NULL
                 AND (tk.status = 'failed' OR (tk.status = 'completed' AND tk.result->>'head_commit' IS NOT NULL))
             ), 0)
           ) AS needs_you_count,
           COALESCE((
             SELECT array_agg(tm.agent_id::text)
             FROM thread_members tm
             WHERE tm.thread_id = b.thread_id AND tm.agent_id <> b.lead_agent_id
           ), ARRAY[]::text[]) AS member_ids,
           t.updated_at AS thread_updated_at
         FROM bots b
         JOIN threads t ON t.id = b.thread_id
         WHERE b.tenant_id = $2
           AND ($3::boolean OR b.scope = ANY($4::text[]))
           AND ($5::text IS NULL OR b.scope = $5)
           AND ($6::boolean OR NOT b.archived)
       )
       SELECT *
       FROM bot_badges
       WHERE ($7::uuid IS NULL OR (
         (CASE WHEN needs_you_count > 0 THEN 1 ELSE 0 END),
         (CASE WHEN unread_count > 0 THEN 1 ELSE 0 END),
         GREATEST(updated_at, thread_updated_at),
         id
       ) < (
         SELECT
           (CASE WHEN needs_you_count > 0 THEN 1 ELSE 0 END),
           (CASE WHEN unread_count > 0 THEN 1 ELSE 0 END),
           GREATEST(updated_at, thread_updated_at),
           id
         FROM bot_badges WHERE id = $7
       ))
       ORDER BY
         (CASE WHEN needs_you_count > 0 THEN 1 ELSE 0 END) DESC,
         (CASE WHEN unread_count > 0 THEN 1 ELSE 0 END) DESC,
         GREATEST(updated_at, thread_updated_at) DESC,
         id DESC
       LIMIT $8`,
      [p.id, p.tenantId, all, grantedScopes, scope, includeArchived, after, limit + 1]
    )).rows;

    const hasMore = rows.length > limit;
    const paged = rows.slice(0, limit);

    const badges = await this.computeBadgesForBots(this.pool, p, paged);

    const bots = paged.map(r => {
      const b = badges.get(r.id) ?? { unread: Number(r.unread_count), needs_you: Number(r.needs_you_count), latest: null };
      return botView(r, r.member_ids, b);
    });

    return {
      bots,
      has_more: hasMore,
      next_cursor: hasMore ? paged.at(-1)?.id ?? null : null
    };
  }

  async botArchive(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['bot_id']);
    requirePermission(p, 'agent:manage');

    const botId = uuid(input.bot_id, 'bot_id');

    return transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);

      const existing = (await db.query<BotRow>('SELECT * FROM bots WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [botId, p.tenantId])).rows[0];
      requireFound(existing, 'Bot');
      requireScope(p, existing.scope);

      // Cancel queued tasks for this bot
      const queuedTasks = (await db.query<TaskRow>(
        "SELECT * FROM tasks WHERE bot_id=$1 AND tenant_id=$2 AND status='queued' FOR UPDATE",
        [botId, p.tenantId]
      )).rows;

      for (const t of queuedTasks) {
        await cancelTask(db as any, p, t, false);
      }

      const updated = (await db.query<BotRow>(
        'UPDATE bots SET archived=true, version=version+1, updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
        [botId]
      )).rows[0]!;

      const memberIds = (await db.query<{ agent_id: string }>(
        'SELECT agent_id FROM thread_members WHERE thread_id=$1 AND agent_id<>$2',
        [existing.thread_id, existing.lead_agent_id]
      )).rows.map(r => r.agent_id);

      await audit(db, p, updated.scope, 'bot.archive', botId);
      await event(db, p, updated.scope, 'bot.updated', botId, { bot_id: botId, reason: 'archived' });

      return { bot: botView(updated, memberIds) };
    });
  }
}
