import pg, { type Pool } from 'pg';
import { transaction } from '../db.js';
import { AppError, requireCondition } from '../errors.js';
import { canAccessScope, hasPermission, requirePermission, requireScope } from '../policy.js';
import { redactSecrets } from '../safety/redact.js';
import type { Principal } from '../types.js';
import { integer, object, optionalString, scopeName, string, uuid } from '../validation.js';
import { booleanOption } from './memory.js';
import { assertKnownScope, audit, canonicalJson, event, newId, noExtraKeys, requireFound, scopeLock, scopeSql, sha256, teamsLock, type Db } from './shared.js';
import { assignThreadSeq, clipUtf8, type AgentRow, type ThreadRow, type MessageRow } from './teams.js';
import { runnerCapability } from '../bridge/adapters.js';
import { cancelTask, taskView, type TaskRow } from './tasks.js';
import { botCapability } from './bots.js';
import type { TurnAction, TurnGrantContext, SwarmStartStepInput } from './actions.js';

// Teams writes take teamsLock first.

export const MAX_TURNS_PER_FINISH = 20;
export const MAX_HANDOFF_HOPS = 3;

/** Turns one task_finish may still queue, the hop depth they inherit, and where refusals are noticed. */
export interface TurnBudget {
  hop: number;
  queued: number;
  threadId: string;
  scope: string;
  /** A swarm's summary turn: it may only reply, so it can never start the work it summarises again. */
  summary?: boolean;
}

/** A list row's title: the first line of an objective, at most 120 characters. */
const oneLine = (text: string): string => { const line = text.split('\n')[0]!.trim(); return line.length > 120 ? `${line.slice(0, 119)}…` : line; };

/** Model output that should become a notice rather than roll back the finish: 4xx, or Postgres data (22) and constraint (23) errors. */
function isActionError(err: unknown): boolean {
  if (err instanceof AppError) return err.status >= 400 && err.status < 500;
  return err instanceof pg.DatabaseError && /^2[23]/.test(err.code ?? '');
}

export interface SwarmRow {
  id: string;
  tenant_id: string;
  scope: string;
  title: string;
  goal: string;
  owner_agent_id: string | null;
  thread_id: string | null;
  status: 'planning' | 'running' | 'waiting_on_you' | 'blocked' | 'done' | 'cancelled';
  flow_id: string | null;
  summary_task_id: string | null;
  version: number;
  created_by: string;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

export interface SwarmStepRow {
  id: string;
  tenant_id: string;
  swarm_id: string;
  step_key: string | null;
  title: string;
  assignee_agent_id: string;
  needs: string[];
  instructions: string | null;
  check: string | null;
  status: 'pending' | 'running' | 'waiting_on_you' | 'blocked' | 'done' | 'failed' | 'cancelled';
  task_id: string | null;
  result_message_id: string | null;
  failure_code: string | null;
  failure_detail: string | null;
  order_index: number;
  created_at: Date;
  updated_at: Date;
}

export interface QuestionRow {
  id: string;
  tenant_id: string;
  scope: string;
  thread_id: string;
  agent_id: string;
  swarm_step_id: string | null;
  prompt: string;
  options: string[];
  multi: boolean;
  free_text: boolean;
  status: 'open' | 'answered' | 'expired';
  choices: string[] | null;
  answer_text: string | null;
  answered_by: string | null;
  answered_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SectionRow {
  id: string;
  tenant_id: string;
  principal_id: string;
  name: string;
  order_index: number;
  items: string[];
  collapsed: boolean;
  created_at: Date;
  updated_at: Date;
}

export function validateStepGraph(steps: Array<{ key?: string; id?: string; needs?: string[] }>): void {
  const keys = new Set<string>();
  const allKeys = steps.map((s, idx) => s.key ?? s.id ?? String(idx));

  for (const k of allKeys) {
    if (keys.has(k)) {
      throw new AppError(400, 'invalid_steps', `Duplicate step key: ${k}`);
    }
    keys.add(k);
  }

  // Check valid references and no self-dependency
  const graph = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const k of allKeys) {
    graph.set(k, []);
    inDegree.set(k, 0);
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const stepKey = allKeys[i]!;
    const needs = s.needs ?? [];
    for (const dep of needs) {
      if (!keys.has(dep)) {
        throw new AppError(400, 'invalid_steps', `Step '${stepKey}' depends on unknown step '${dep}'`);
      }
      if (dep === stepKey) {
        throw new AppError(400, 'invalid_steps', `Step '${stepKey}' depends on itself`);
      }
      graph.get(dep)!.push(stepKey);
      inDegree.set(stepKey, (inDegree.get(stepKey) ?? 0) + 1);
    }
  }

  // Kahn's algorithm for cycle detection
  const queue: string[] = [];
  for (const [k, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(k);
  }

  let visitedCount = 0;
  while (queue.length > 0) {
    const curr = queue.shift()!;
    visitedCount++;
    for (const neighbor of graph.get(curr) ?? []) {
      const nextDeg = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, nextDeg);
      if (nextDeg === 0) queue.push(neighbor);
    }
  }

  if (visitedCount !== allKeys.length) {
    throw new AppError(400, 'cycle_detected', 'Step dependency graph contains a cycle.');
  }
}

export function deriveSwarmStatus(
  steps: Array<{ status: string }>,
  isClosed = false,
  isCancelled = false
): 'planning' | 'running' | 'waiting_on_you' | 'blocked' | 'done' | 'cancelled' {
  if (isCancelled || (steps.length > 0 && steps.every(s => s.status === 'cancelled'))) {
    return 'cancelled';
  }
  if (steps.some(s => s.status === 'waiting_on_you')) {
    return 'waiting_on_you';
  }
  if (steps.some(s => s.status === 'blocked' || s.status === 'failed')) {
    return 'blocked';
  }
  if (steps.length > 0 && steps.every(s => s.status === 'done')) {
    return 'done';
  }
  if (isClosed) {
    return 'done';
  }
  if (steps.some(s => s.status === 'running' || s.status === 'pending')) {
    return 'running';
  }
  return 'planning';
}

export function swarmView(swarm: SwarmRow, steps: SwarmStepRow[] = []): Record<string, unknown> {
  const doneCount = steps.filter(s => s.status === 'done').length;
  return {
    id: swarm.id,
    scope: swarm.scope,
    title: swarm.title,
    goal: swarm.goal,
    owner_agent_id: swarm.owner_agent_id,
    thread_id: swarm.thread_id,
    status: swarm.status,
    flow_id: swarm.flow_id,
    version: swarm.version,
    created_at: swarm.created_at.toISOString(),
    updated_at: swarm.updated_at.toISOString(),
    closed_at: swarm.closed_at ? swarm.closed_at.toISOString() : null,
    steps: steps.map(s => ({
      id: s.id,
      step_key: s.step_key,
      title: s.title,
      assignee_agent_id: s.assignee_agent_id,
      needs: s.needs,
      instructions: s.instructions,
      check: s.check,
      status: s.status,
      task_id: s.task_id,
      result_message_id: s.result_message_id,
      failure_code: s.failure_code,
      failure_detail: s.failure_detail,
      order_index: s.order_index,
      created_at: s.created_at.toISOString(),
      updated_at: s.updated_at.toISOString()
    })),
    progress: {
      done: doneCount,
      total: steps.length
    }
  };
}

export function questionView(q: QuestionRow): Record<string, unknown> {
  return {
    id: q.id,
    scope: q.scope,
    thread_id: q.thread_id,
    agent_id: q.agent_id,
    swarm_step_id: q.swarm_step_id,
    prompt: q.prompt,
    options: q.options,
    multi: q.multi,
    free_text: q.free_text,
    status: q.status,
    choices: q.choices,
    answer_text: q.answer_text,
    answered_by: q.answered_by,
    answered_at: q.answered_at ? q.answered_at.toISOString() : null,
    expires_at: q.expires_at ? q.expires_at.toISOString() : null,
    created_at: q.created_at.toISOString(),
    updated_at: q.updated_at.toISOString()
  };
}

export function sectionView(s: SectionRow): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    order: s.order_index,
    items: s.items,
    collapsed: s.collapsed,
    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at.toISOString()
  };
}

export class SwarmsService {
  constructor(private readonly pool: Pool) {}

  async internalSwarmStart(
    db: Db,
    p: Principal,
    input: {
      title: string;
      goal: string;
      scope: string;
      thread_id: string;
      steps: SwarmStartStepInput[];
      owner_agent_id: string | null;
      flow_id?: string | null;
      idempotency_key?: string | null;
    },
    budget?: TurnBudget
  ): Promise<Record<string, unknown>> {
    const title = input.title;
    const goal = input.goal;
    const scope = input.scope;
    const threadId = input.thread_id;
    const ownerAgentId = input.owner_agent_id;
    const flowId = input.flow_id ?? null;
    const idempotency = input.idempotency_key ?? null;

    const validatedSteps: Array<{
      key: string;
      title: string;
      assignee_agent_id: string;
      needs: string[];
      instructions?: string;
      check?: string;
    }> = [];

    for (let i = 0; i < input.steps.length; i++) {
      const s = input.steps[i]!;
      const key = s.key ? String(s.key).trim() : `step_${i + 1}`;
      const stepTitle = string(s.title, `steps[${i}].title`, 200);
      const assignee = uuid(s.assignee_agent_id, `steps[${i}].assignee_agent_id`);
      const needs = Array.isArray(s.needs) ? s.needs.map(n => String(n).trim()) : [];
      const instructions = s.instructions !== undefined ? string(s.instructions, `steps[${i}].instructions`, 16384) : undefined;
      const check = s.check !== undefined ? string(s.check, `steps[${i}].check`, 64) : undefined;
      validatedSteps.push({
        key,
        title: stepTitle,
        assignee_agent_id: assignee,
        needs,
        ...(instructions !== undefined ? { instructions } : {}),
        ...(check !== undefined ? { check } : {})
      });
    }

    validateStepGraph(validatedSteps);

    // Verify thread exists in scope
    const thread = (await db.query<ThreadRow>(
      'SELECT * FROM threads WHERE id=$1 AND tenant_id=$2 AND scope=$3 FOR UPDATE',
      [threadId, p.tenantId, scope]
    )).rows[0];
    requireFound(thread, 'Thread');

    // Verify owner_agent_id if provided (Finding 5)
    if (ownerAgentId) {
      const ownerAgent = (await db.query<AgentRow>(
        'SELECT * FROM agents WHERE id=$1 AND tenant_id=$2 AND scope=$3 AND NOT archived',
        [ownerAgentId, p.tenantId, scope]
      )).rows[0];
      requireCondition(Boolean(ownerAgent), 400, 'agent_not_found', `Owner agent '${ownerAgentId}' not found or archived in scope '${scope}'.`);
    }

    // Verify all assignee agents exist and are not archived in same scope
    for (const st of validatedSteps) {
      const agent = (await db.query<AgentRow>(
        'SELECT * FROM agents WHERE id=$1 AND tenant_id=$2 AND scope=$3 AND NOT archived',
        [st.assignee_agent_id, p.tenantId, scope]
      )).rows[0];
      requireCondition(Boolean(agent), 400, 'agent_not_found', `Assignee agent '${st.assignee_agent_id}' not found or archived in scope '${scope}'.`);
    }

    const swarmOwner = ownerAgentId ?? thread.agent_id ?? thread.lead_agent_id ?? null;
    const reqHash = sha256(canonicalJson({
      title, goal, scope, thread_id: threadId, steps: validatedSteps, owner_agent_id: swarmOwner
    }));

    if (idempotency) {
      const existing = (await db.query<SwarmRow>(
        'SELECT * FROM swarms WHERE tenant_id=$1 AND created_by=$2 AND idempotency_key=$3',
        [p.tenantId, p.id, idempotency]
      )).rows[0];
      if (existing) {
        requireCondition(existing.request_hash === reqHash, 409, 'idempotency_conflict', 'This key was used for another swarm start.');
        const steps = (await db.query<SwarmStepRow>(
          'SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY order_index ASC',
          [existing.id]
        )).rows;
        return { swarm: swarmView(existing, steps), replayed: true };
      }
    }

    const swarmId = newId();

    await db.query(
      `INSERT INTO swarms (id, tenant_id, scope, title, goal, owner_agent_id, thread_id, status, flow_id, created_by, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8, $9, $10, $11)`,
      [swarmId, p.tenantId, scope, title, goal, swarmOwner, threadId, flowId, p.id, idempotency, reqHash]
    );

    // Create step UUID mapping
    const keyToId = new Map<string, string>();
    for (const st of validatedSteps) {
      keyToId.set(st.key, newId());
    }

    const stepRows: SwarmStepRow[] = [];
    for (let i = 0; i < validatedSteps.length; i++) {
      const st = validatedSteps[i]!;
      const stepId = keyToId.get(st.key)!;
      const depIds = st.needs.map(depKey => keyToId.get(depKey) ?? depKey);

      const row = (await db.query<SwarmStepRow>(
        `INSERT INTO swarm_steps (id, tenant_id, swarm_id, step_key, title, assignee_agent_id, needs, instructions, "check", order_index, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9, $10, 'pending') RETURNING *`,
        [stepId, p.tenantId, swarmId, st.key, st.title, st.assignee_agent_id, depIds, st.instructions ?? null, st.check ?? null, i]
      )).rows[0]!;
      stepRows.push(row);
    }

    // Post swarm card message to thread
    const nextSeq = await assignThreadSeq(db, p.tenantId, threadId);
    const cardMsgId = newId();
    await db.query(
      `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body, ref)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'swarm', '', $7::jsonb)`,
      [cardMsgId, p.tenantId, scope, threadId, nextSeq, JSON.stringify({ kind: 'system', id: 'service' }), JSON.stringify({ swarm_id: swarmId })]
    );

    await audit(db, p, scope, 'swarm.started', swarmId, { title });
    await event(db, p, scope, 'message.created', cardMsgId, {
      thread_id: threadId,
      message_id: cardMsgId,
      seq: Number(nextSeq),
      kind: 'swarm',
      author: { kind: 'system', id: 'service' }
    });
    await event(db, p, scope, 'swarm.updated', swarmId, { swarm_id: swarmId, status: 'running' });

    // Start ready steps (those with empty needs)
    const ownerName = swarmOwner
      ? ((await db.query<{ name: string }>('SELECT name FROM agents WHERE id=$1', [swarmOwner])).rows[0]?.name ?? 'Lead')
      : 'Team lead';

    for (const step of stepRows) {
      if (!step.needs || step.needs.length === 0) {
        await this.queueStepTurn(db, p, scope, swarmId, step, ownerName, budget);
      }
    }

    const finalSwarm = (await db.query<SwarmRow>('SELECT * FROM swarms WHERE id=$1', [swarmId])).rows[0]!;
    const finalSteps = (await db.query<SwarmStepRow>('SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY order_index ASC', [swarmId])).rows;

    return { swarm: swarmView(finalSwarm, finalSteps), replayed: false };
  }

  async swarmStart(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['title', 'goal', 'scope', 'thread_id', 'steps', 'owner_agent_id', 'flow_id', 'idempotency_key']);
    requirePermission(p, 'task:submit');
    const title = string(input.title, 'title', 200);
    const goal = string(input.goal, 'goal', 16384);
    const scope = scopeName(input.scope);
    assertKnownScope(p, scope);
    requireScope(p, scope);
    const threadId = uuid(input.thread_id, 'thread_id');
    const ownerAgentId = input.owner_agent_id !== undefined ? uuid(input.owner_agent_id, 'owner_agent_id') : null;
    const flowId = input.flow_id !== undefined ? uuid(input.flow_id, 'flow_id') : null;
    const idempotency = input.idempotency_key !== undefined ? string(input.idempotency_key, 'idempotency_key', 200) : null;

    if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 50) {
      throw new AppError(400, 'invalid_arguments', 'steps must be an array of 1-50 steps.');
    }

    return transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);
      return this.internalSwarmStart(db, p, {
        title,
        goal,
        scope,
        thread_id: threadId,
        steps: input.steps as SwarmStartStepInput[],
        owner_agent_id: ownerAgentId,
        flow_id: flowId,
        idempotency_key: idempotency
      });
    });
  }

  async swarmGet(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['swarm_id']);
    requirePermission(p, 'task:read');
    const swarmId = uuid(input.swarm_id, 'swarm_id');
    const [all, grantedScopes] = scopeSql(p);

    const swarm = (await this.pool.query<SwarmRow>(
      `SELECT * FROM swarms WHERE id=$1 AND tenant_id=$2 AND ($3::boolean OR scope=ANY($4::text[]))`,
      [swarmId, p.tenantId, all, grantedScopes]
    )).rows[0];
    requireFound(swarm, 'Swarm');

    const steps = (await this.pool.query<SwarmStepRow>(
      'SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY order_index ASC',
      [swarmId]
    )).rows;

    return { swarm: swarmView(swarm, steps) };
  }

  async swarmList(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['scope', 'status', 'after', 'limit']);
    requirePermission(p, 'task:read');
    const [all, grantedScopes] = scopeSql(p);
    const scope = input.scope !== undefined ? scopeName(input.scope) : null;
    if (scope) {
      assertKnownScope(p, scope);
      requireScope(p, scope);
    }
    const statusParam = input.status !== undefined ? string(input.status, 'status', 32) : 'open';
    const after = input.after !== undefined ? uuid(input.after, 'after') : null;
    const limit = input.limit !== undefined ? integer(input.limit, 'limit', 1, 100) : 50;

    let statusCondition = '';
    const params: unknown[] = [p.tenantId, all, grantedScopes, scope, after, limit + 1];

    if (statusParam === 'open') {
      statusCondition = "AND s.status IN ('planning','running','waiting_on_you','blocked')";
    } else if (statusParam !== 'all') {
      params.push(statusParam);
      statusCondition = `AND s.status = $${params.length}`;
    }

    const rows = (await this.pool.query<SwarmRow>(
      `SELECT s.*
       FROM swarms s
       WHERE s.tenant_id = $1
         AND ($2::boolean OR s.scope = ANY($3::text[]))
         AND ($4::text IS NULL OR s.scope = $4)
         ${statusCondition}
         AND ($5::uuid IS NULL OR s.updated_at < (SELECT updated_at FROM swarms WHERE id = $5))
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT $6`,
      params
    )).rows;

    const hasMore = rows.length > limit;
    const paged = rows.slice(0, limit);

    const swarms = await Promise.all(
      paged.map(async sw => {
        const steps = (await this.pool.query<SwarmStepRow>(
          'SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY order_index ASC',
          [sw.id]
        )).rows;
        return swarmView(sw, steps);
      })
    );

    return {
      swarms,
      has_more: hasMore,
      next_cursor: hasMore ? paged.at(-1)?.id ?? null : null
    };
  }

  async internalSwarmUpdate(
    db: Db,
    p: Principal,
    input: {
      swarm_id: string;
      expected_version?: number | null;
      ops: Array<Record<string, unknown>>;
    },
    budget?: TurnBudget
  ): Promise<Record<string, unknown>> {
    const swarmId = input.swarm_id;
    const expected = input.expected_version ?? null;

    await db.query(
      `SELECT id FROM tasks WHERE id IN (SELECT task_id FROM swarm_steps WHERE swarm_id=$1 AND task_id IS NOT NULL) ORDER BY id ASC FOR UPDATE`,
      [swarmId]
    );

    await db.query(
      'SELECT 1 FROM threads WHERE id = (SELECT thread_id FROM swarms WHERE id=$1) FOR UPDATE',
      [swarmId]
    );

    const swarm = (await db.query<SwarmRow>(
      'SELECT * FROM swarms WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
      [swarmId, p.tenantId]
    )).rows[0];
    requireFound(swarm, 'Swarm');
    requireScope(p, swarm.scope);
    if (expected !== null) {
      requireCondition(swarm.version === expected, 409, 'version_conflict', 'Swarm has changed; reload before updating.');
    }
    requireCondition(swarm.status !== 'cancelled' && swarm.closed_at === null, 400, 'swarm_closed', 'Cannot update a closed or cancelled swarm.');

    let allSteps = (await db.query<SwarmStepRow>(
      'SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY id ASC FOR UPDATE',
      [swarmId]
    )).rows;

    const ownerName = swarm.owner_agent_id
      ? ((await db.query<{ name: string }>('SELECT name FROM agents WHERE id=$1', [swarm.owner_agent_id])).rows[0]?.name ?? 'Lead')
      : 'Team lead';

    for (const op of input.ops) {
      const opName = string(op.op, 'op.op', 32);

      if (opName === 'add_step') {
        const stepObj = object(op.step);
        const stepTitle = string(stepObj.title, 'step.title', 200);
        const assignee = uuid(stepObj.assignee_agent_id, 'step.assignee_agent_id');
        const agent = (await db.query<AgentRow>(
          'SELECT * FROM agents WHERE id=$1 AND tenant_id=$2 AND scope=$3 AND NOT archived',
          [assignee, p.tenantId, swarm.scope]
        )).rows[0];
        requireCondition(Boolean(agent), 400, 'agent_not_found', 'Assignee agent not found or archived.');

        // A new step can only need existing steps, by id or key, so it cannot close a cycle.
        const needs = (Array.isArray(stepObj.needs) ? stepObj.needs : []).map(n => {
          const ref = String(n).trim();
          const dep = allSteps.find(s => s.id === ref || s.step_key === ref);
          requireCondition(dep, 400, 'invalid_steps', `add_step needs '${ref}', which is not a step of this swarm.`);
          return dep.id;
        });
        const stepId = newId();
        const nextIndex = allSteps.length;

        const inserted = (await db.query<SwarmStepRow>(
          `INSERT INTO swarm_steps (id, tenant_id, swarm_id, step_key, title, assignee_agent_id, needs, instructions, "check", order_index, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9, $10, 'pending') RETURNING *`,
          [stepId, p.tenantId, swarmId, stepObj.key ? String(stepObj.key) : null, stepTitle, assignee,
           needs, stepObj.instructions ? String(stepObj.instructions) : null, stepObj.check ? String(stepObj.check) : null, nextIndex]
        )).rows[0]!;

        allSteps.push(inserted);

        await this.postNotice(db, p, swarm.scope, swarm.thread_id, `Added step: ${stepTitle}`);

        const ready = needs.length === 0 || needs.every(nid => allSteps.some(s => s.id === nid && s.status === 'done'));
        if (ready) {
          await this.queueStepTurn(db, p, swarm.scope, swarmId, inserted, ownerName, budget);
        }
      } else if (opName === 'reassign') {
        const stepId = uuid(op.step_id, 'op.step_id');
        const newAssigneeId = uuid(op.assignee_agent_id, 'op.assignee_agent_id');
        const step = requireFound(allSteps.find(s => s.id === stepId), 'Swarm step');
        requireCondition(step.status !== 'done', 400, 'invalid_state', 'Cannot reassign a completed step.');

        const newAgent = (await db.query<AgentRow>(
          'SELECT * FROM agents WHERE id=$1 AND tenant_id=$2 AND scope=$3 AND NOT archived',
          [newAssigneeId, p.tenantId, swarm.scope]
        )).rows[0];
        requireFound(newAgent, 'Assignee agent');

        // Expire open question if waiting_on_you
        if (step.status === 'waiting_on_you') {
          await db.query(
            "UPDATE questions SET status='expired', updated_at=clock_timestamp() WHERE swarm_step_id=$1 AND status='open'",
            [stepId]
          );
        }

        // Cancel running task if any
        if (step.task_id && step.status === 'running') {
          const task = (await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [step.task_id])).rows[0];
          if (task && !['completed', 'cancelled', 'failed'].includes(task.status)) {
            await cancelTask(db as any, p, task as any, false);
          }
        }

        step.assignee_agent_id = newAssigneeId;
        const ready = step.needs.length === 0 || step.needs.every(nid => allSteps.some(s => s.id === nid && s.status === 'done'));

        if (ready) {
          step.status = 'running';
          await db.query(
            "UPDATE swarm_steps SET assignee_agent_id=$1, status='running', updated_at=clock_timestamp() WHERE id=$2",
            [newAssigneeId, stepId]
          );
          await this.postNotice(db, p, swarm.scope, swarm.thread_id, `Reassigned step "${step.title}" to ${newAgent.name}`);
          await this.queueStepTurn(db, p, swarm.scope, swarmId, step, ownerName, budget);
        } else {
          step.status = 'pending';
          step.task_id = null;
          await db.query(
            "UPDATE swarm_steps SET assignee_agent_id=$1, status='pending', task_id=NULL, updated_at=clock_timestamp() WHERE id=$2",
            [newAssigneeId, stepId]
          );
          await this.postNotice(db, p, swarm.scope, swarm.thread_id, `Reassigned step "${step.title}" to ${newAgent.name}`);
        }
      } else if (opName === 'retry') {
        const stepId = uuid(op.step_id, 'op.step_id');
        const step = requireFound(allSteps.find(s => s.id === stepId), 'Swarm step');
        requireCondition(['failed', 'cancelled'].includes(step.status), 400, 'invalid_state', 'Only failed or cancelled steps can be retried.');

        const ready = step.needs.length === 0 || step.needs.every(nid => allSteps.some(s => s.id === nid && s.status === 'done'));

        if (ready) {
          step.status = 'running';
          step.failure_code = null;
          step.failure_detail = null;
          await db.query(
            "UPDATE swarm_steps SET status='running', failure_code=null, failure_detail=null, updated_at=clock_timestamp() WHERE id=$1",
            [stepId]
          );
          await this.postNotice(db, p, swarm.scope, swarm.thread_id, `Retrying step "${step.title}"`);
          await this.queueStepTurn(db, p, swarm.scope, swarmId, step, ownerName, budget);
        } else {
          step.status = 'pending';
          step.task_id = null;
          step.failure_code = null;
          step.failure_detail = null;
          await db.query(
            "UPDATE swarm_steps SET status='pending', task_id=NULL, failure_code=null, failure_detail=null, updated_at=clock_timestamp() WHERE id=$1",
            [stepId]
          );
          await this.postNotice(db, p, swarm.scope, swarm.thread_id, `Retrying step "${step.title}"`);
        }
      } else if (opName === 'cancel_step') {
        const stepId = uuid(op.step_id, 'op.step_id');
        const step = requireFound(allSteps.find(s => s.id === stepId), 'Swarm step');

        if (step.task_id && step.status === 'running') {
          const task = (await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [step.task_id])).rows[0];
          if (task && !['completed', 'cancelled', 'failed'].includes(task.status)) {
            await cancelTask(db as any, p, task as any, false);
          }
        }

        step.status = 'cancelled';
        await db.query("UPDATE swarm_steps SET status='cancelled', updated_at=clock_timestamp() WHERE id=$1", [stepId]);
        await this.postNotice(db, p, swarm.scope, swarm.thread_id, `Cancelled step "${step.title}"`);
        await this.expireStepQuestions(db, p, [stepId]);
      } else if (opName === 'edit') {
        const nextTitle = op.title !== undefined ? string(op.title, 'op.title', 200) : swarm.title;
        const nextGoal = op.goal !== undefined ? string(op.goal, 'op.goal', 16384) : swarm.goal;
        swarm.title = nextTitle;
        swarm.goal = nextGoal;
        await db.query('UPDATE swarms SET title=$1, goal=$2 WHERE id=$3', [nextTitle, nextGoal, swarmId]);
        await this.postNotice(db, p, swarm.scope, swarm.thread_id, 'Updated swarm details');
      } else if (opName === 'close') {
        for (const s of allSteps) {
          if (s.status === 'running' || s.status === 'pending' || s.status === 'waiting_on_you') {
            if (s.task_id) {
              const task = (await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [s.task_id])).rows[0];
              if (task && !['completed', 'cancelled', 'failed'].includes(task.status)) {
                await cancelTask(db as any, p, task as any, false);
              }
            }
            s.status = 'cancelled';
            await db.query("UPDATE swarm_steps SET status='cancelled', updated_at=clock_timestamp() WHERE id=$1", [s.id]);
          }
        }
        swarm.status = 'cancelled';
        swarm.closed_at = new Date();
        await db.query("UPDATE swarms SET status='cancelled', closed_at=clock_timestamp() WHERE id=$1", [swarmId]);
        await this.postNotice(db, p, swarm.scope, swarm.thread_id, 'Swarm closed');
        await this.expireStepQuestions(db, p, allSteps.map(s => s.id));
      } else {
        throw new AppError(400, 'invalid_op', `Unknown swarm_update op: ${opName}`);
      }
    }

    // Re-read steps & update derived status
    allSteps = (await db.query<SwarmStepRow>('SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY id ASC', [swarmId])).rows;
    const derived = deriveSwarmStatus(allSteps, swarm.closed_at !== null, swarm.status === 'cancelled');

    const updatedSwarm = (await db.query<SwarmRow>(
      `UPDATE swarms SET status=$1, version=version+1, updated_at=clock_timestamp() WHERE id=$2 RETURNING *`,
      [derived, swarmId]
    )).rows[0]!;

    await event(db, p, swarm.scope, 'swarm.updated', swarmId, { swarm_id: swarmId, status: derived, version: updatedSwarm.version });
    await this.notifyCard(db, p, swarm.scope, swarm.thread_id, swarmId);

    return { swarm: swarmView(updatedSwarm, allSteps) };
  }

  async swarmUpdate(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['swarm_id', 'expected_version', 'ops']);
    requirePermission(p, 'task:submit');
    const swarmId = uuid(input.swarm_id, 'swarm_id');
    const expected = input.expected_version !== undefined ? integer(input.expected_version, 'expected_version', 1, 2147483647) : null;
    if (!Array.isArray(input.ops) || input.ops.length === 0 || input.ops.length > 20) {
      throw new AppError(400, 'invalid_arguments', 'ops must be an array of 1-20 ops.');
    }

    return transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);
      return this.internalSwarmUpdate(db, p, {
        swarm_id: swarmId,
        expected_version: expected,
        ops: input.ops as Array<Record<string, unknown>>
      });
    });
  }

  async swarmCancel(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['swarm_id', 'expected_version']);
    requirePermission(p, 'task:submit');
    const swarmId = uuid(input.swarm_id, 'swarm_id');
    const expected = input.expected_version !== undefined ? integer(input.expected_version, 'expected_version', 1, 2147483647) : null;

    return transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);
      await db.query(
        `SELECT id FROM tasks WHERE id IN (SELECT task_id FROM swarm_steps WHERE swarm_id=$1 AND task_id IS NOT NULL) ORDER BY id ASC FOR UPDATE`,
        [swarmId]
      );
      await db.query(
        'SELECT 1 FROM threads WHERE id = (SELECT thread_id FROM swarms WHERE id=$1) FOR UPDATE',
        [swarmId]
      );
      const swarm = (await db.query<SwarmRow>(
        'SELECT * FROM swarms WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [swarmId, p.tenantId]
      )).rows[0];
      requireFound(swarm, 'Swarm');
      requireScope(p, swarm.scope);
      if (expected !== null) {
        requireCondition(swarm.version === expected, 409, 'version_conflict', 'Swarm has changed; reload before cancelling.');
      }

      const allSteps = (await db.query<SwarmStepRow>(
        'SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY id ASC FOR UPDATE',
        [swarmId]
      )).rows;

      for (const s of allSteps) {
        if (['running', 'pending', 'waiting_on_you'].includes(s.status)) {
          if (s.task_id) {
            const task = (await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [s.task_id])).rows[0];
            if (task && !['completed', 'cancelled', 'failed'].includes(task.status)) {
              await cancelTask(db, p, task as any, false);
            }
          }
          await db.query("UPDATE swarm_steps SET status='cancelled', updated_at=clock_timestamp() WHERE id=$1", [s.id]);
        }
      }

      const updated = (await db.query<SwarmRow>(
        `UPDATE swarms SET status='cancelled', closed_at=clock_timestamp(), version=version+1, updated_at=clock_timestamp()
         WHERE id=$1 RETURNING *`,
        [swarmId]
      )).rows[0]!;

      await this.postNotice(db, p, swarm.scope, swarm.thread_id, 'Swarm cancelled');
      await this.expireStepQuestions(db, p, allSteps.map(s => s.id));
      await audit(db, p, swarm.scope, 'swarm.cancelled', swarmId);
      await event(db, p, swarm.scope, 'swarm.updated', swarmId, { swarm_id: swarmId, status: 'cancelled' });
      await this.notifyCard(db, p, swarm.scope, swarm.thread_id, swarmId);

      const finalSteps = (await db.query<SwarmStepRow>('SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY order_index ASC', [swarmId])).rows;
      return { swarm: swarmView(updated, finalSteps) };
    });
  }

  async questionAnswer(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['question_id', 'choices', 'text', 'idempotency_key']);
    requirePermission(p, 'thread:write');
    // The owner answers: admin, or a frontend identity the owner granted answer_questions. Never the Dot or Grok entrypoints.
    requireCondition(!['grok', 'dot'].includes(p.name.toLowerCase()) && hasPermission(p, 'answer_questions'), 403, 'owner_required', 'Only the owner can answer questions.');
    const questionId = uuid(input.question_id, 'question_id');
    const rawChoices = input.choices !== undefined ? input.choices : [];
    if (!Array.isArray(rawChoices)) throw new AppError(400, 'invalid_arguments', 'choices must be an array of strings.');
    const choices = rawChoices.map(c => string(c, 'choice', 80));
    // A blank note is no note: older phone builds send "" when the field is left empty.
    const text = input.text === undefined || (typeof input.text === 'string' && input.text.trim() === '') ? null : string(input.text, 'text', 16384);
    const idempotency = input.idempotency_key !== undefined ? string(input.idempotency_key, 'idempotency_key', 200) : null;

    // Expire due questions in their own transaction, so the expiry persists when this answer is refused.
    const expired = await transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);
      const q = (await db.query<QuestionRow>('SELECT * FROM questions WHERE id=$1 AND tenant_id=$2', [questionId, p.tenantId])).rows[0];
      if (!q) return false;
      requireScope(p, q.scope);
      return (await this.expireDueQuestions(db, p, q.scope)).includes(questionId);
    });
    if (expired) throw new AppError(400, 'question_expired', 'Question has expired.');

    return transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);
      const q = (await db.query<QuestionRow>(
        'SELECT * FROM questions WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [questionId, p.tenantId]
      )).rows[0];
      requireFound(q, 'Question');
      requireScope(p, q.scope);

      if (q.status === 'answered') {
        return { question: questionView(q), replayed: true };
      }

      if (q.swarm_step_id) {
        const step = (await db.query<SwarmStepRow>('SELECT * FROM swarm_steps WHERE id=$1', [q.swarm_step_id])).rows[0];
        requireCondition(step?.status === 'waiting_on_you', 409, 'step_not_waiting', `This question's step is ${step?.status ?? 'gone'}, not waiting on you.`);
      }
      requireCondition(q.status === 'open', 400, q.status === 'expired' ? 'question_expired' : 'invalid_state', `Cannot answer question with status '${q.status}'.`);

      // Validate choices against options
      for (const ch of choices) {
        requireCondition(q.options.includes(ch), 400, 'invalid_choice', `Choice '${ch}' is not one of the available options.`);
      }
      if (!q.multi && choices.length > 1) {
        throw new AppError(400, 'invalid_choice', 'Multiple choices not permitted for this question.');
      }
      if (!q.free_text && text !== null && text.trim().length > 0) {
        throw new AppError(400, 'invalid_choice', 'Free text is not permitted for this question.');
      }
      if (choices.length === 0 && (!text || text.trim().length === 0)) {
        throw new AppError(400, 'invalid_choice', 'An answer must provide choices or text.');
      }

      const updated = (await db.query<QuestionRow>(
        `UPDATE questions SET status='answered', choices=$1::jsonb, answer_text=$2, answered_by=$3,
           answered_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE id=$4 RETURNING *`,
        [JSON.stringify(choices), text ? clipUtf8(redactSecrets(text), 16384) : null, p.id, questionId]
      )).rows[0]!;

      const nextSeq = await assignThreadSeq(db, p.tenantId, q.thread_id);
      const agent = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [q.agent_id])).rows[0]!;

      if (q.swarm_step_id) {
        const step = (await db.query<{ swarm_id: string }>(
          "UPDATE swarm_steps SET status='running', updated_at=clock_timestamp() WHERE id=$1 RETURNING swarm_id",
          [q.swarm_step_id]
        )).rows[0]!;
        await this.refreshSwarmStatus(db, p, step.swarm_id);
      }

      // Post answer message to thread
      const answerParts: string[] = [];
      if (choices.length > 0) answerParts.push(choices.join(', '));
      if (text && text.trim().length > 0) answerParts.push(text.trim());
      const answerBody = clipUtf8(redactSecrets(answerParts.join('\n\n')), 16384);

      const answerMsgId = newId();
      await db.query(
        `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body, ref, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'answer', $7, $8::jsonb, $9)`,
        [answerMsgId, p.tenantId, q.scope, q.thread_id, nextSeq, JSON.stringify({ kind: 'human', id: p.id }),
         answerBody, JSON.stringify({ question_id: questionId }), idempotency]
      );

      await audit(db, p, q.scope, 'question.answered', questionId);
      await event(db, p, q.scope, 'question.answered', questionId, {
        question_id: questionId,
        thread_id: q.thread_id,
        agent_id: q.agent_id
      });
      await event(db, p, q.scope, 'message.created', answerMsgId, {
        thread_id: q.thread_id,
        message_id: answerMsgId,
        seq: Number(nextSeq),
        kind: 'answer',
        author: { kind: 'human', id: p.id }
      });

      // Queue the agent's next turn with initiator answer
      let botId: string | null = null;
      let requiredCap = runnerCapability(agent.runner, agent.edits);
      if (q.thread_id) {
        const bot = (await db.query<{ id: string; routing: Record<string, unknown> }>(
          'SELECT id, routing FROM bots WHERE thread_id=$1', [q.thread_id]
        )).rows[0];
        if (bot) {
          botId = bot.id;
          requiredCap = botCapability(bot, agent.edits ? 'patch' : 'summary', agent.edits);
        }
      }
      const taskId = newId();
      const envelope = {
        deploy: false, publish: false, purchase: false, local_patch: agent.edits,
        read_project: true, send_messages: false, permission_changes: false, external_side_effects: false
      };
      const contextVersions = { message_seq: Number(nextSeq), hop_depth: 0 };
      const reqHash = sha256(canonicalJson({
        kind: 'turn', scope: agent.scope, agent_id: agent.id, thread_id: q.thread_id, seq: Number(nextSeq)
      }));

      await db.query(
        `INSERT INTO tasks
           (id, tenant_id, scope, kind, agent_id, thread_id, bot_id, swarm_step_id, objective, constraints, acceptance_criteria,
            permission_envelope, required_capability, resource_key, context_versions, status, created_by,
            idempotency_key, request_hash, max_attempts, initiator_kind, initiator_id)
         VALUES ($1, $2, $3, 'turn', $4, $5, $6, $7, $8, '[]'::jsonb, '[]'::jsonb, $9::jsonb, $10, $11, $12::jsonb, 'queued', $13, $14, $15, 3, 'answer', $16)`,
        [taskId, p.tenantId, agent.scope, agent.id, q.thread_id, botId, q.swarm_step_id, `Answer to: ${q.prompt}`,
         JSON.stringify(envelope), requiredCap, `agent:${agent.id}`, JSON.stringify(contextVersions), p.id, newId(), reqHash, questionId]
      );

      await audit(db, p, agent.scope, 'task.submitted', taskId, { kind: 'turn', agent_id: agent.id, initiator_kind: 'answer' });
      await event(db, p, agent.scope, 'task.updated', taskId, { task_id: taskId, status: 'queued', action: 'submitted' });

      if (q.swarm_step_id) {
        await db.query('UPDATE swarm_steps SET task_id=$1, updated_at=clock_timestamp() WHERE id=$2', [taskId, q.swarm_step_id]);
      }

      return { question: questionView(updated), replayed: false };
    });
  }

  /** Expires open questions in a scope that are past expires_at by the database clock, blocking their steps. The caller holds teamsLock. */
  async expireDueQuestions(db: Db, p: Principal, scope: string): Promise<string[]> {
    const expired = (await db.query<QuestionRow>(
      `UPDATE questions SET status='expired', updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND scope=$2 AND status='open' AND expires_at <= clock_timestamp() RETURNING *`,
      [p.tenantId, scope]
    )).rows;
    for (const q of expired) {
      await this.postNotice(db, p, q.scope, q.thread_id, `Question "${q.prompt}" has expired`);
      if (!q.swarm_step_id) continue;
      const step = (await db.query<{ swarm_id: string }>(
        `UPDATE swarm_steps SET status='blocked', failure_code='question_expired', failure_detail='Question expired without an answer', updated_at=clock_timestamp()
         WHERE id=$1 AND status IN ('waiting_on_you','running') RETURNING swarm_id`,
        [q.swarm_step_id]
      )).rows[0];
      if (step) await this.refreshSwarmStatus(db, p, step.swarm_id);
    }
    return expired.map(q => q.id);
  }

  /** Cancelled steps cannot be answered: expire their open questions. */
  private async expireStepQuestions(db: Db, p: Principal, stepIds: string[]): Promise<void> {
    const expired = (await db.query<QuestionRow>(
      `UPDATE questions SET status='expired', updated_at=clock_timestamp()
       WHERE swarm_step_id = ANY($1::uuid[]) AND status='open' RETURNING *`,
      [stepIds]
    )).rows;
    for (const q of expired) {
      await this.postNotice(db, p, q.scope, q.thread_id, `Question "${q.prompt}" has expired: its step was cancelled`);
    }
  }

  private async refreshSwarmStatus(db: Db, p: Principal, swarmId: string): Promise<void> {
    const swarm = (await db.query<SwarmRow>('SELECT * FROM swarms WHERE id=$1 FOR UPDATE', [swarmId])).rows[0];
    if (!swarm) return;
    const steps = (await db.query<SwarmStepRow>('SELECT * FROM swarm_steps WHERE swarm_id=$1', [swarmId])).rows;
    const derived = deriveSwarmStatus(steps, Boolean(swarm.closed_at), swarm.status === 'cancelled');
    await db.query('UPDATE swarms SET status=$1, version=version+1, updated_at=clock_timestamp() WHERE id=$2', [derived, swarmId]);
    await event(db, p, swarm.scope, 'swarm.updated', swarmId, { swarm_id: swarmId, status: derived });
    await this.notifyCard(db, p, swarm.scope, swarm.thread_id, swarmId);
  }

  async questionList(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['status', 'after', 'limit']);
    requirePermission(p, 'thread:read');
    const [all, grantedScopes] = scopeSql(p);
    const statusParam = input.status !== undefined ? string(input.status, 'status', 32) : 'open';
    const after = input.after !== undefined ? uuid(input.after, 'after') : null;
    const limit = input.limit !== undefined ? integer(input.limit, 'limit', 1, 100) : 50;

    let statusCondition = '';
    const params: unknown[] = [p.tenantId, all, grantedScopes, after, limit + 1];

    if (statusParam !== 'all') {
      params.push(statusParam);
      statusCondition = `AND q.status = $${params.length}`;
    }

    const rows = (await this.pool.query<QuestionRow>(
      `SELECT q.*
       FROM questions q
       WHERE q.tenant_id = $1
         AND ($2::boolean OR q.scope = ANY($3::text[]))
         ${statusCondition}
         AND ($4::uuid IS NULL OR q.created_at < (SELECT created_at FROM questions WHERE id = $4))
       ORDER BY q.created_at DESC, q.id DESC
       LIMIT $5`,
      params
    )).rows;

    const hasMore = rows.length > limit;
    const paged = rows.slice(0, limit);

    return {
      questions: paged.map(questionView),
      has_more: hasMore,
      next_cursor: hasMore ? paged.at(-1)?.id ?? null : null
    };
  }

  async attentionList(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['scope', 'after', 'limit']);
    requirePermission(p, 'task:read');
    requirePermission(p, 'thread:read');
    const [all, grantedScopes] = scopeSql(p);
    const scope = input.scope !== undefined ? scopeName(input.scope) : null;
    if (scope) {
      assertKnownScope(p, scope);
      requireScope(p, scope);
    }
    const limit = input.limit !== undefined ? integer(input.limit, 'limit', 1, 100) : 50;
    const after = input.after !== undefined ? string(input.after, 'after', 100) : null;

    // 1. Open questions
    const qRows = (await this.pool.query<QuestionRow>(
      `SELECT * FROM questions
       WHERE tenant_id=$1 AND status='open'
         AND ($2::boolean OR scope = ANY($3::text[]))
         AND ($4::text IS NULL OR scope = $4)
       ORDER BY created_at DESC LIMIT $5`,
      [p.tenantId, all, grantedScopes, scope, limit + 1]
    )).rows;

    // 2. Completed patch and turn tasks with review_required, not yet resolved
    const reviewTasks = (await this.pool.query<{
      id: string; objective: string; scope: string; kind: string; updated_at: Date; result: Record<string, unknown> | null;
    }>(
      `SELECT id, objective, scope, kind, updated_at, result
       FROM tasks
       WHERE tenant_id=$1 AND status='completed' AND resolved_at IS NULL
         AND kind IN ('patch', 'turn')
         AND (result->>'review_required')::boolean IS TRUE
         AND result->>'head_commit' IS NOT NULL
         AND ($2::boolean OR scope = ANY($3::text[]))
         AND ($4::text IS NULL OR scope = $4)
       ORDER BY updated_at DESC LIMIT $5`,
      [p.tenantId, all, grantedScopes, scope, limit + 1]
    )).rows;

    // 3. Failed tasks not resolved
    const failedTasks = (await this.pool.query<{
      id: string; objective: string; scope: string; updated_at: Date; result: Record<string, unknown> | null;
    }>(
      `SELECT id, objective, scope, updated_at, result
       FROM tasks
       WHERE tenant_id=$1 AND status='failed' AND resolved_at IS NULL
         AND ($2::boolean OR scope = ANY($3::text[]))
         AND ($4::text IS NULL OR scope = $4)
       ORDER BY updated_at DESC LIMIT $5`,
      [p.tenantId, all, grantedScopes, scope, limit + 1]
    )).rows;

    // 4. Swarms waiting_on_you or blocked
    const swarms = (await this.pool.query<SwarmRow>(
      `SELECT * FROM swarms
       WHERE tenant_id=$1 AND status IN ('waiting_on_you', 'blocked')
         AND ($2::boolean OR scope = ANY($3::text[]))
         AND ($4::text IS NULL OR scope = $4)
       ORDER BY updated_at DESC LIMIT $5`,
      [p.tenantId, all, grantedScopes, scope, limit + 1]
    )).rows;

    interface AttentionItem {
      kind: 'question' | 'task' | 'swarm';
      id: string;
      title: string;
      state: string;
      next_step: string;
      at: string;
      thread_id?: string;
    }

    const items: AttentionItem[] = [];

    for (const q of qRows) {
      items.push({
        kind: 'question',
        id: q.id,
        title: q.prompt,
        state: 'open',
        next_step: 'Needs input · answer the question',
        at: q.created_at.toISOString(),
        thread_id: q.thread_id
      });
    }

    for (const t of reviewTasks) {
      const res = t.result ?? {};
      const branch = (res as any).branch ?? '';
      const files = Number((res as any).changed_files) || 0;
      const diffstat = files ? `${files} file${files === 1 ? '' : 's'}` : '';
      const parts = ['Ready for review'];
      if (branch) parts.push(`branch ${branch}`);
      if (diffstat) parts.push(diffstat);

      items.push({
        kind: 'task',
        id: t.id,
        title: oneLine(t.objective),
        state: 'completed',
        next_step: parts.join(' · '),
        at: t.updated_at.toISOString()
      });
    }

    for (const f of failedTasks) {
      const fail = (f.result as any)?.failure ?? {};
      const code = fail.code || 'failure';
      items.push({
        kind: 'task',
        id: f.id,
        title: oneLine(f.objective),
        state: 'failed',
        next_step: `Failed · ${code} · retry`,
        at: f.updated_at.toISOString()
      });
    }

    for (const sw of swarms) {
      items.push({
        kind: 'swarm',
        id: sw.id,
        title: sw.title,
        state: sw.status,
        next_step: sw.status === 'waiting_on_you' ? 'Needs input · answer the question' : 'Blocked · inspect step failures',
        at: sw.updated_at.toISOString(),
        ...(sw.thread_id ? { thread_id: sw.thread_id } : {})
      });
    }

    // Sort newest first
    items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    let filtered = items;
    if (after) {
      const idx = items.findIndex(it => it.id === after);
      if (idx !== -1) {
        filtered = items.slice(idx + 1);
      }
    }

    const anyExceeded = qRows.length > limit || reviewTasks.length > limit || failedTasks.length > limit || swarms.length > limit;
    const hasMore = filtered.length > limit || anyExceeded;
    const paged = filtered.slice(0, limit);

    return {
      items: paged,
      has_more: hasMore,
      next_cursor: hasMore ? paged.at(-1)?.id ?? null : null
    };
  }

  async taskResolve(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['task_id', 'resolved', 'expected_version']);
    requireCondition(!['grok', 'dot'].includes(p.name.toLowerCase()) && hasPermission(p, 'answer_questions'), 403, 'owner_required', 'Only an owner or an identity granted answer_questions may resolve tasks.');
    const taskId = uuid(input.task_id, 'task_id');
    const resolved = booleanOption(input.resolved, 'resolved');
    const expected = integer(input.expected_version, 'expected_version', 1, 2147483647);

    return transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);
      const task = (await db.query<TaskRow>(
        'SELECT * FROM tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [taskId, p.tenantId]
      )).rows[0];
      requireFound(task, 'Task');
      requireScope(p, task.scope);
      requireCondition(!['running', 'queued'].includes(task.status), 409, 'task_active', 'Wait for the active task to finish or cancel it before resolving.');
      if (expected !== null) {
        requireCondition(task.version === expected, 409, 'version_conflict', 'Task has changed; reload before resolving.');
      }
      requireCondition(['completed', 'failed', 'cancelled'].includes(task.status), 400, 'invalid_state', `Cannot resolve task with status '${task.status}'.`);

      await db.query(
        `UPDATE tasks
         SET resolved_at = ${resolved ? 'clock_timestamp()' : 'NULL'},
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id=$1`,
        [taskId]
      );

      await audit(db, p, task.scope, 'task.resolved', taskId, { resolved });
      await event(db, p, task.scope, 'task.updated', taskId, { task_id: taskId, resolved });

      const updated = (await db.query<TaskRow>('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0]!;
      return { task: taskView(updated) };
    });
  }

  async onStepTaskFinished(
    db: Db,
    p: Principal,
    stepId: string,
    taskId: string,
    taskScope: string,
    outcome: string,
    resultMsgId?: string,
    failure?: { code?: string; detail?: string },
    budget?: TurnBudget
  ): Promise<void> {
    const stepLookup = (await db.query<{ id: string; swarm_id: string; task_id: string | null; status: string }>(
      'SELECT id, swarm_id, task_id, status FROM swarm_steps WHERE id=$1',
      [stepId]
    )).rows[0];
    if (!stepLookup) return;

    // Only the step's current task may move it.
    if (stepLookup.task_id !== taskId) {
      return;
    }

    const swarm = (await db.query<SwarmRow>(
      'SELECT * FROM swarms WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
      [stepLookup.swarm_id, p.tenantId]
    )).rows[0];
    if (!swarm) return;

    if (swarm.scope !== taskScope) {
      return;
    }

    const allSteps = (await db.query<SwarmStepRow>(
      'SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY id ASC FOR UPDATE',
      [swarm.id]
    )).rows;

    const step = allSteps.find(s => s.id === stepId);
    if (!step) return;

    // A step waiting on a question, or already cancelled, does not move on its task's finish.
    if (step.status === 'waiting_on_you' || step.status === 'cancelled') {
      return;
    }

    if (outcome === 'completed') {
      step.status = 'done';
      step.result_message_id = resultMsgId ?? null;
      await db.query(
        `UPDATE swarm_steps
         SET status='done', result_message_id=$1, updated_at=clock_timestamp()
         WHERE id=$2`,
        [resultMsgId ?? null, stepId]
      );
    } else {
      const failStatus = outcome === 'cancelled' ? 'cancelled' : 'failed';
      step.status = failStatus;
      step.failure_code = failure?.code ?? 'failed';
      step.failure_detail = failure?.detail ?? 'Task failed';
      await db.query(
        `UPDATE swarm_steps
         SET status=$1, failure_code=$2, failure_detail=$3, updated_at=clock_timestamp()
         WHERE id=$4`,
        [failStatus, failure?.code ?? 'failed', failure?.detail ?? 'Task failed', stepId]
      );
    }

    // Flow swarms are driven by flows.ts advanceFlow: no agent or summary turns. They close when every step is done.
    if (swarm.flow_id !== null) {
      const derived = deriveSwarmStatus(allSteps, Boolean(swarm.closed_at), swarm.status === 'cancelled');
      if (swarm.status !== derived && swarm.status !== 'cancelled' && swarm.closed_at === null) {
        await db.query(
          `UPDATE swarms SET status=$1, closed_at=CASE WHEN $1='done' THEN clock_timestamp() END, version=version+1, updated_at=clock_timestamp() WHERE id=$2`,
          [derived, swarm.id]
        );
        await event(db, p, swarm.scope, 'swarm.updated', swarm.id, { swarm_id: swarm.id, status: derived });
      }
      await this.notifyCard(db, p, swarm.scope, swarm.thread_id, swarm.id);
      return;
    }

    const ownerName = swarm.owner_agent_id
      ? ((await db.query<{ name: string }>('SELECT name FROM agents WHERE id=$1', [swarm.owner_agent_id])).rows[0]?.name ?? 'Lead')
      : 'Team lead';

    // Start newly unblocked steps
    for (const s of allSteps) {
      if (s.status === 'pending') {
        const needsDone = s.needs.length === 0 || s.needs.every(depId => allSteps.some(other => other.id === depId && other.status === 'done'));
        if (needsDone) {
          await this.queueStepTurn(db, p, swarm.scope, swarm.id, s, ownerName, budget);
        }
      }
    }

    const allDone = allSteps.length > 0 && allSteps.every(s => s.status === 'done');
    let derived = deriveSwarmStatus(allSteps, Boolean(swarm.closed_at), swarm.status === 'cancelled');

    if (allDone) {
      derived = 'done';
      if (swarm.status !== 'done') {
        await db.query(
          `UPDATE swarms SET status='done', closed_at=clock_timestamp(), version=version+1, updated_at=clock_timestamp()
           WHERE id=$1`,
          [swarm.id]
        );
      }

      // One summarising turn per swarm, however often its last step finishes.
      let ownerAgentId = swarm.owner_agent_id;
      if (!ownerAgentId && swarm.thread_id) {
        const tr = (await db.query<{ lead_agent_id: string | null; agent_id: string | null }>(
          'SELECT lead_agent_id, agent_id FROM threads WHERE id=$1',
          [swarm.thread_id]
        )).rows[0];
        ownerAgentId = tr?.lead_agent_id ?? tr?.agent_id ?? null;
      }
      const ownerAgent = ownerAgentId
        ? (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1', [ownerAgentId])).rows[0]
        : undefined;
      if (ownerAgent && swarm.summary_task_id === null) {
        if (budget && budget.queued >= MAX_TURNS_PER_FINISH) {
          await this.refuseTurn(db, p, budget, `the summary of "${swarm.title}"`, `one finish may queue at most the cap of ${MAX_TURNS_PER_FINISH} turns`);
        } else {
          const followUpId = newId();
          const claimed = await db.query(
            'UPDATE swarms SET summary_task_id=$1 WHERE id=$2 AND summary_task_id IS NULL RETURNING id',
            [followUpId, swarm.id]
          );
          if (claimed.rowCount) {
            if (budget) budget.queued++;
            // The step results live in the assignees' threads; put them in the owner's so the summary turn sees them.
            const results = (await db.query<{ title: string; name: string | null; body: string | null }>(
              `SELECT s.title, a.name, m.body FROM swarm_steps s
                 LEFT JOIN agents a ON a.id=s.assignee_agent_id LEFT JOIN messages m ON m.id=s.result_message_id
               WHERE s.swarm_id=$1 ORDER BY s.order_index`, [swarm.id])).rows;
            await this.postNotice(db, p, swarm.scope, swarm.thread_id, `"${swarm.title}" is done. Step results:\n\n`
              + results.map((r, n) => `${n + 1}. ${r.title} (${r.name ?? 'unassigned'}): ${(r.body ?? '(no reply)').slice(0, 2000)}`).join('\n\n'));
            let botId: string | null = null;
            let requiredCap = runnerCapability(ownerAgent.runner, ownerAgent.edits);
            if (swarm.thread_id) {
              const bot = (await db.query<{ id: string; routing: Record<string, unknown> }>(
                'SELECT id, routing FROM bots WHERE thread_id=$1', [swarm.thread_id]
              )).rows[0];
              if (bot) {
                botId = bot.id;
                requiredCap = botCapability(bot, ownerAgent.edits ? 'patch' : 'summary', ownerAgent.edits);
              }
            }
            const envelope = {
              deploy: false, publish: false, purchase: false, local_patch: ownerAgent.edits,
              read_project: true, send_messages: false, permission_changes: false, external_side_effects: false
            };
            const reqHash = sha256(canonicalJson({
              kind: 'turn', scope: ownerAgent.scope, agent_id: ownerAgent.id, swarm_id: swarm.id, summary: true
            }));

            await db.query(
              `INSERT INTO tasks
                 (id, tenant_id, scope, kind, agent_id, thread_id, bot_id, objective, constraints, acceptance_criteria,
                  permission_envelope, required_capability, resource_key, context_versions, status, created_by,
                  idempotency_key, request_hash, max_attempts, initiator_kind, initiator_id)
               VALUES ($1, $2, $3, 'turn', $4, $5, $6, $7, '[]'::jsonb, '[]'::jsonb, $8::jsonb, $9, $10, $11::jsonb, 'queued', $12, $13, $14, 3, 'swarm', $15)`,
              [followUpId, p.tenantId, ownerAgent.scope, ownerAgent.id, swarm.thread_id, botId,
               `Summarise the results of "${swarm.title}" for the user. Reply only; start no new work.`, JSON.stringify(envelope),
               requiredCap, `agent:${ownerAgent.id}`, JSON.stringify({ hop_depth: budget ? budget.hop + 1 : 0, summary: true }),
               p.id, `swarm:summary:${swarm.id}`, reqHash, swarm.id]
            );

            await audit(db, p, ownerAgent.scope, 'task.submitted', followUpId, { kind: 'turn', agent_id: ownerAgent.id, initiator_kind: 'swarm' });
            await event(db, p, ownerAgent.scope, 'task.updated', followUpId, { task_id: followUpId, status: 'queued', action: 'submitted' });
          }
        }
      }
    } else {
      if (swarm.status !== 'cancelled' && swarm.closed_at === null) {
        await db.query(
          `UPDATE swarms SET status=$1, version=version+1, updated_at=clock_timestamp() WHERE id=$2`,
          [derived, swarm.id]
        );
      }
    }

    await event(db, p, swarm.scope, 'swarm.updated', swarm.id, { swarm_id: swarm.id, status: derived });
    await this.notifyCard(db, p, swarm.scope, swarm.thread_id, swarm.id);
  }

  /** Runs each action in its own savepoint: bad model output becomes a notice, the reply and the other actions stand. */
  async applyTurnActions(
    db: Db,
    p: Principal,
    ctx: TurnGrantContext,
    actions: TurnAction[],
    budget: TurnBudget
  ): Promise<void> {
    if (budget.summary) {
      await this.postNotice(db, p, ctx.scope, ctx.thread.id, `A summary turn can only reply; its ${actions.length} action(s) were ignored.`);
      return;
    }
    for (const [i, act] of actions.entries()) {
      const queued = budget.queued;
      await db.query(`SAVEPOINT act_${i}`);
      try {
        await this.applyTurnAction(db, p, ctx, act, budget);
        await db.query(`RELEASE SAVEPOINT act_${i}`);
      } catch (err) {
        if (!isActionError(err)) throw err;
        await db.query(`ROLLBACK TO SAVEPOINT act_${i}`);
        budget.queued = queued;
        await this.postNotice(db, p, ctx.scope, ctx.thread.id, `Action ${i + 1} (${act.type}) failed: ${(err as Error).message}`);
      }
    }
  }

  private async applyTurnAction(db: Db, p: Principal, ctx: TurnGrantContext, act: TurnAction, budget: TurnBudget): Promise<void> {
    if (act.type === 'handoff') {
      const targetAgent = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1', [act.to_agent])).rows[0]!;

      // 1. Post handoff line into sending agent's thread (Low 4: author is sending agent)
      const senderSeq = await assignThreadSeq(db, ctx.tenantId, ctx.thread.id);
      const senderHandoffMsgId = newId();
      const handoffText = `${ctx.agent.name} handed off to ${targetAgent.name}: ${act.body}`;
      await db.query(
        `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body, ref)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'handoff', $7, $8::jsonb)`,
        [senderHandoffMsgId, ctx.tenantId, ctx.scope, ctx.thread.id, senderSeq,
         JSON.stringify({ kind: 'agent', id: ctx.agent.id }), handoffText,
         JSON.stringify({ from_agent_id: ctx.agent.id, to_agent_id: targetAgent.id, ...(act.swarm_step_id ? { swarm_step_id: act.swarm_step_id } : {}) })]
      );
      await event(db, p, ctx.scope, 'message.created', senderHandoffMsgId, {
        thread_id: ctx.thread.id,
        message_id: senderHandoffMsgId,
        seq: Number(senderSeq),
        kind: 'handoff',
        author: { kind: 'agent', id: ctx.agent.id }
      });

      // 2. Post handoff line into target agent's main thread (Low 4: author is sending agent)
      const targetThreadId = targetAgent.main_thread_id!;
      const targetSeq = await assignThreadSeq(db, ctx.tenantId, targetThreadId);
      const targetHandoffMsgId = newId();
      const targetHandoffText = `${ctx.agent.name} gave you: ${act.body}`;
      await db.query(
        `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body, ref)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'handoff', $7, $8::jsonb)`,
        [targetHandoffMsgId, ctx.tenantId, ctx.scope, targetThreadId, targetSeq,
         JSON.stringify({ kind: 'agent', id: ctx.agent.id }), targetHandoffText,
         JSON.stringify({ from_agent_id: ctx.agent.id, to_agent_id: targetAgent.id, ...(act.swarm_step_id ? { swarm_step_id: act.swarm_step_id } : {}) })]
      );
      await event(db, p, ctx.scope, 'message.created', targetHandoffMsgId, {
        thread_id: targetThreadId,
        message_id: targetHandoffMsgId,
        seq: Number(targetSeq),
        kind: 'handoff',
        author: { kind: 'agent', id: ctx.agent.id }
      });

      // 3. Queue turn task for target agent with initiator handoff, within the hop limit and fan-out cap
      if (!(await this.takeTurn(db, p, budget, targetAgent.name))) return;
      let botId: string | null = ctx.botId ?? null;
      let requiredCap = runnerCapability(targetAgent.runner, targetAgent.edits);
      if (botId) {
        const bot = (await db.query<{ id: string; routing: Record<string, unknown> }>(
          'SELECT id, routing FROM bots WHERE id=$1', [botId]
        )).rows[0];
        if (bot) {
          requiredCap = botCapability(bot, targetAgent.edits ? 'patch' : 'summary', targetAgent.edits);
        }
      }
      const taskId = newId();
      const envelope = {
        deploy: false, publish: false, purchase: false, local_patch: targetAgent.edits,
        read_project: true, send_messages: false, permission_changes: false, external_side_effects: false
      };
      const ctxVersions = { message_seq: Number(targetSeq), hop_depth: budget.hop + 1 };
      const reqHash = sha256(canonicalJson({
        kind: 'turn', scope: targetAgent.scope, agent_id: targetAgent.id, thread_id: targetThreadId, seq: Number(targetSeq)
      }));

      await db.query(
        `INSERT INTO tasks
           (id, tenant_id, scope, kind, agent_id, thread_id, bot_id, swarm_step_id, objective, constraints, acceptance_criteria,
            permission_envelope, required_capability, resource_key, context_versions, status, created_by,
            idempotency_key, request_hash, max_attempts, initiator_kind, initiator_id)
         VALUES ($1, $2, $3, 'turn', $4, $5, $6, $7, $8, '[]'::jsonb, '[]'::jsonb, $9::jsonb, $10, $11, $12::jsonb, 'queued', $13, $14, $15, 3, 'handoff', $16)`,
        [taskId, ctx.tenantId, targetAgent.scope, targetAgent.id, targetThreadId, botId, act.swarm_step_id ?? null,
         `Handoff from ${ctx.agent.name}: ${act.body}`, JSON.stringify(envelope),
         requiredCap, `agent:${targetAgent.id}`, JSON.stringify(ctxVersions), p.id, newId(), reqHash, ctx.agent.id]
      );

      if (act.swarm_step_id) {
        await db.query(
          'UPDATE swarm_steps SET task_id=$1, assignee_agent_id=$2, updated_at=clock_timestamp() WHERE id=$3',
          [taskId, targetAgent.id, act.swarm_step_id]
        );
      }

      await audit(db, p, targetAgent.scope, 'task.submitted', taskId, { kind: 'turn', agent_id: targetAgent.id, initiator_kind: 'handoff' });
      await event(db, p, targetAgent.scope, 'task.updated', taskId, { task_id: taskId, status: 'queued', action: 'submitted' });
    } else if (act.type === 'swarm_start') {
      requireCondition(budget.hop < MAX_HANDOFF_HOPS, 409, 'hop_limit', `the hop depth limit of ${MAX_HANDOFF_HOPS} is reached`);
      await this.internalSwarmStart(db, p, {
        title: act.title,
        goal: act.goal,
        scope: ctx.scope,
        thread_id: ctx.thread.id,
        steps: act.steps,
        owner_agent_id: ctx.agent.id
      }, budget);
    } else if (act.type === 'swarm_update') {
      await this.internalSwarmUpdate(db, p, {
        swarm_id: act.swarm_id,
        ops: act.ops
      }, budget);
    } else if (act.type === 'question_ask') {
      const questionId = newId();

      await db.query(
        `INSERT INTO questions
           (id, tenant_id, scope, thread_id, agent_id, swarm_step_id, prompt, options, multi, free_text, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, 'open',
           CASE WHEN $11::integer IS NULL THEN NULL ELSE clock_timestamp() + $11::integer * interval '1 second' END)`,
        [questionId, ctx.tenantId, ctx.scope, ctx.thread.id, ctx.agent.id, act.swarm_step_id ?? null,
         act.prompt, JSON.stringify(act.options), act.multi ?? false, act.free_text ?? false, act.expires_in ?? null]
      );

      const cardSeq = await assignThreadSeq(db, ctx.tenantId, ctx.thread.id);
      const cardMsgId = newId();
      await db.query(
        `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body, ref)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'question', $7, $8::jsonb)`,
        [cardMsgId, ctx.tenantId, ctx.scope, ctx.thread.id, cardSeq,
         JSON.stringify({ kind: 'agent', id: ctx.agent.id }), act.prompt,
         JSON.stringify({ question_id: questionId })]
      );

      await event(db, p, ctx.scope, 'question.created', questionId, {
        question_id: questionId,
        thread_id: ctx.thread.id,
        agent_id: ctx.agent.id,
        prompt: act.prompt
      });
      await event(db, p, ctx.scope, 'message.created', cardMsgId, {
        thread_id: ctx.thread.id,
        message_id: cardMsgId,
        seq: Number(cardSeq),
        kind: 'question',
        author: { kind: 'agent', id: ctx.agent.id }
      });

      if (act.swarm_step_id) {
        const step = (await db.query<{ swarm_id: string }>(
          "UPDATE swarm_steps SET status='waiting_on_you', updated_at=clock_timestamp() WHERE id=$1 RETURNING swarm_id",
          [act.swarm_step_id]
        )).rows[0];
        if (step) await this.refreshSwarmStatus(db, p, step.swarm_id);
      }
    } else if (act.type === 'channel_post') {
      const chanSeq = await assignThreadSeq(db, ctx.tenantId, act.channel_id);
      const chanMsgId = newId();
      await db.query(
        `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'text', $7)`,
        [chanMsgId, ctx.tenantId, ctx.scope, act.channel_id, chanSeq,
         JSON.stringify({ kind: 'agent', id: ctx.agent.id }), act.body]
      );

      await event(db, p, ctx.scope, 'message.created', chanMsgId, {
        thread_id: act.channel_id,
        message_id: chanMsgId,
        seq: Number(chanSeq),
        kind: 'text',
        author: { kind: 'agent', id: ctx.agent.id }
      });

      await this.routeChannelPost(db, p, ctx, act.channel_id, act.body, Number(chanSeq), budget);
    }
  }

  async routeChannelPost(
    db: Db,
    p: Principal,
    ctx: TurnGrantContext,
    channelId: string,
    body: string,
    msgSeq: number,
    budget: TurnBudget
  ): Promise<void> {
    const channel = (await db.query<ThreadRow & { lead_agent_id: string | null }>(
      'SELECT * FROM threads WHERE id=$1 FOR UPDATE',
      [channelId]
    )).rows[0];
    if (!channel) return;

    const members = (await db.query<{ agent_id: string; name: string }>(
      `SELECT m.agent_id, a.name
       FROM thread_members m
       JOIN agents a ON a.id = m.agent_id
       WHERE m.thread_id=$1 AND NOT a.archived`,
      [channelId]
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
        if (mentionedNames.has(m.name.toLowerCase()) && m.agent_id !== ctx.agent.id) {
          targetAgents.push(m.agent_id);
        }
      }
    } else if (channel.lead_agent_id && channel.lead_agent_id !== ctx.agent.id) {
      targetAgents.push(channel.lead_agent_id);
    }

    for (const agentId of targetAgents) {
      // Join the agent's existing queued turn in this channel instead of queueing another.
      const queuedTurn = (await db.query<{ id: string; context_versions: Record<string, unknown> }>(
        "SELECT id, context_versions FROM tasks WHERE tenant_id=$1 AND agent_id=$2 AND thread_id=$3 AND kind='turn' AND status='queued' ORDER BY id ASC LIMIT 1 FOR UPDATE",
        [p.tenantId, agentId, channelId]
      )).rows[0];

      if (queuedTurn) {
        const updatedVersions = { ...(queuedTurn.context_versions ?? {}), message_seq: msgSeq };
        await db.query(
          'UPDATE tasks SET context_versions=$1::jsonb, updated_at=clock_timestamp() WHERE id=$2',
          [JSON.stringify(updatedVersions), queuedTurn.id]
        );
      } else {
        const agent = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1', [agentId])).rows[0];
        if (!agent) continue;
        if (!(await this.takeTurn(db, p, budget, agent.name))) continue;

        const requiredCap = runnerCapability(agent.runner, agent.edits);
        const taskId = newId();
        const envelope = {
          deploy: false, publish: false, purchase: false, local_patch: agent.edits,
          read_project: true, send_messages: false, permission_changes: false, external_side_effects: false
        };
        const ctxVersions = { message_seq: msgSeq, hop_depth: budget.hop + 1 };
        const reqHash = sha256(canonicalJson({
          kind: 'turn', scope: ctx.scope, agent_id: agent.id, thread_id: channelId, seq: msgSeq
        }));

        await db.query(
          `INSERT INTO tasks
             (id, tenant_id, scope, kind, agent_id, thread_id, objective, constraints, acceptance_criteria,
              permission_envelope, required_capability, resource_key, context_versions, status, created_by,
              idempotency_key, request_hash, max_attempts, initiator_kind, initiator_id)
           VALUES ($1, $2, $3, 'turn', $4, $5, $6, '[]'::jsonb, '[]'::jsonb, $7::jsonb, $8, $9, $10::jsonb, 'queued', $11, $12, $13, 3, 'person', $14)`,
          [taskId, p.tenantId, ctx.scope, agent.id, channelId, `Turn in channel #${channel.title ?? 'channel'}`,
           JSON.stringify(envelope), requiredCap, `agent:${agent.id}`, JSON.stringify(ctxVersions), p.id, newId(), reqHash, p.id]
        );

        await audit(db, p, ctx.scope, 'task.submitted', taskId, { kind: 'turn', agent_id: agent.id });
        await event(db, p, ctx.scope, 'task.updated', taskId, { task_id: taskId, status: 'queued', action: 'submitted' });
      }
    }
  }

  /** Handoff and channel turns: refused past the hop limit or the per-finish cap, with a notice. */
  private async takeTurn(db: Db, p: Principal, budget: TurnBudget, agentName: string): Promise<boolean> {
    if (budget.hop >= MAX_HANDOFF_HOPS) {
      await this.refuseTurn(db, p, budget, agentName, `the hop depth limit of ${MAX_HANDOFF_HOPS} is reached`);
      return false;
    }
    if (budget.queued >= MAX_TURNS_PER_FINISH) {
      await this.refuseTurn(db, p, budget, agentName, `one finish may queue at most the cap of ${MAX_TURNS_PER_FINISH} turns`);
      return false;
    }
    budget.queued++;
    return true;
  }

  private async refuseTurn(db: Db, p: Principal, budget: TurnBudget, what: string, why: string): Promise<void> {
    await this.postNotice(db, p, budget.scope, budget.threadId, `Turn for ${what} refused: ${why}.`);
  }

  private async queueStepTurn(
    db: Db,
    p: Principal,
    scope: string,
    swarmId: string,
    step: SwarmStepRow,
    ownerName: string,
    budget?: TurnBudget
  ): Promise<void> {
    const agent = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1', [step.assignee_agent_id])).rows[0];
    if (!agent) return;

    if (budget && budget.queued >= MAX_TURNS_PER_FINISH) {
      const why = `one finish may queue at most the cap of ${MAX_TURNS_PER_FINISH} turns`;
      step.status = 'failed';
      await db.query(
        "UPDATE swarm_steps SET status='failed', failure_code='turn_cap', failure_detail=$2, updated_at=clock_timestamp() WHERE id=$1",
        [step.id, `Not started: ${why}. Retry the step.`]
      );
      await this.refuseTurn(db, p, budget, `step "${step.title}"`, why);
      return;
    }
    if (budget) budget.queued++;

    const targetThreadId = agent.main_thread_id!;

    // Post handoff message into assignee's main thread
    const seq = await assignThreadSeq(db, p.tenantId, targetThreadId);
    const handoffMsgId = newId();
    const handoffBody = `${ownerName} gave you: ${step.title}`;
    await db.query(
      `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body, ref)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'handoff', $7, $8::jsonb)`,
      [handoffMsgId, p.tenantId, scope, targetThreadId, seq,
       JSON.stringify({ kind: 'system', id: 'service' }), handoffBody,
       JSON.stringify({ swarm_id: swarmId, step_id: step.id })]
    );

    await event(db, p, scope, 'message.created', handoffMsgId, {
      thread_id: targetThreadId,
      message_id: handoffMsgId,
      seq: Number(seq),
      kind: 'handoff',
      author: { kind: 'system', id: 'service' }
    });

    // Queue turn task
    const sw = (await db.query<{ thread_id: string }>('SELECT thread_id FROM swarms WHERE id=$1', [swarmId])).rows[0];
    let botId: string | null = null;
    let requiredCap = runnerCapability(agent.runner, agent.edits);
    if (sw?.thread_id) {
      const bot = (await db.query<{ id: string; routing: Record<string, unknown> }>(
        'SELECT id, routing FROM bots WHERE thread_id=$1', [sw.thread_id]
      )).rows[0];
      if (bot) {
        botId = bot.id;
        const routingKind = agent.edits ? 'patch' : 'research';
        requiredCap = botCapability(bot, routingKind, agent.edits);
      }
    }
    const taskId = newId();
    const envelope = {
      deploy: false, publish: false, purchase: false, local_patch: agent.edits,
      read_project: true, send_messages: false, permission_changes: false, external_side_effects: false
    };
    const ctxVersions = { message_seq: Number(seq), hop_depth: budget ? budget.hop + 1 : 0 };
    const reqHash = sha256(canonicalJson({
      kind: 'turn', scope, agent_id: agent.id, thread_id: targetThreadId, seq: Number(seq)
    }));

    await db.query(
      `INSERT INTO tasks
         (id, tenant_id, scope, kind, agent_id, thread_id, bot_id, swarm_step_id, objective, constraints, acceptance_criteria,
          permission_envelope, required_capability, resource_key, context_versions, status, created_by,
          idempotency_key, request_hash, max_attempts, initiator_kind, initiator_id)
       VALUES ($1, $2, $3, 'turn', $4, $5, $6, $7, $8, '[]'::jsonb, '[]'::jsonb, $9::jsonb, $10, $11, $12::jsonb, 'queued', $13, $14, $15, 3, 'swarm', $16)`,
      [taskId, p.tenantId, scope, agent.id, targetThreadId, botId, step.id,
       step.instructions ?? step.title, JSON.stringify(envelope),
       requiredCap, `agent:${agent.id}`, JSON.stringify(ctxVersions), p.id, newId(), reqHash, swarmId]
    );

    step.task_id = taskId;
    step.status = 'running';
    await db.query(
      "UPDATE swarm_steps SET task_id=$1, status='running', updated_at=clock_timestamp() WHERE id=$2",
      [taskId, step.id]
    );

    await audit(db, p, scope, 'task.submitted', taskId, { kind: 'turn', agent_id: agent.id, swarm_step_id: step.id });
    await event(db, p, scope, 'task.updated', taskId, { task_id: taskId, status: 'queued', action: 'submitted' });
  }

  private async postNotice(db: Db, p: Principal, scope: string, threadId: string | null, body: string): Promise<void> {
    if (!threadId) return;
    const seq = await assignThreadSeq(db, p.tenantId, threadId);
    const msgId = newId();
    await db.query(
      `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'notice', $7)`,
      [msgId, p.tenantId, scope, threadId, seq, JSON.stringify({ kind: 'system', id: 'service' }), clipUtf8(body, 16384)]
    );
    await event(db, p, scope, 'message.created', msgId, {
      thread_id: threadId,
      message_id: msgId,
      seq: Number(seq),
      kind: 'notice',
      author: { kind: 'system', id: 'service' }
    });
  }

  private async notifyCard(db: Db, p: Principal, scope: string, threadId: string | null, swarmId: string): Promise<void> {
    if (!threadId) return;
    const cardMsg = (await db.query<{ id: string; seq: string }>(
      "SELECT id, seq FROM messages WHERE thread_id=$1 AND kind='swarm' AND (ref->>'swarm_id')=$2 ORDER BY seq DESC LIMIT 1",
      [threadId, swarmId]
    )).rows[0];
    if (cardMsg) {
      await event(db, p, scope, 'message.updated', cardMsg.id, {
        thread_id: threadId,
        message_id: cardMsg.id,
        seq: Number(cardMsg.seq),
        kind: 'swarm'
      });
    }
  }
}
