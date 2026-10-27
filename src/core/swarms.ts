import type { Pool } from 'pg';
import { transaction } from '../db.js';
import { AppError, requireCondition } from '../errors.js';
import { canAccessScope, requirePermission, requireScope } from '../policy.js';
import { redactSecrets } from '../safety/redact.js';
import type { Principal } from '../types.js';
import { integer, object, optionalString, scopeName, string, uuid } from '../validation.js';
import { booleanOption } from './memory.js';
import { assertKnownScope, audit, canonicalJson, event, newId, noExtraKeys, requireFound, scopeLock, scopeSql, sha256, type Db } from './shared.js';
import { assignThreadSeq, clipUtf8, type AgentRow, type ThreadRow, type MessageRow } from './teams.js';
import { runnerCapability } from '../bridge/adapters.js';
import { cancelTask } from './tasks.js';
import type { TurnAction, TurnGrantContext } from './actions.js';

export interface SwarmRow {
  id: string;
  tenant_id: string;
  scope: string;
  title: string;
  goal: string;
  owner_agent_id: string | null;
  thread_id: string;
  status: 'planning' | 'running' | 'waiting_on_you' | 'blocked' | 'done' | 'cancelled';
  flow_id: string | null;
  version: number;
  created_by: string;
  idempotency_key: string | null;
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

    const rawSteps = input.steps as Array<Record<string, unknown>>;
    const validatedSteps: Array<{
      key: string;
      title: string;
      assignee_agent_id: string;
      needs: string[];
      instructions?: string;
      check?: string;
    }> = [];

    for (let i = 0; i < rawSteps.length; i++) {
      const s = rawSteps[i]!;
      const key = s.key ? String(s.key).trim() : `step_${i + 1}`;
      const stepTitle = string(s.title, `steps[${i}].title`, 200);
      const assignee = uuid(s.assignee_agent_id, `steps[${i}].assignee_agent_id`);
      const needs = Array.isArray(s.needs) ? s.needs.map(n => String(n).trim()) : [];
      const instructions = s.instructions !== undefined ? string(s.instructions, `steps[${i}].instructions`, 16384) : undefined;
      const check = s.check !== undefined ? string(s.check, `steps[${i}].check`, 64) : undefined;
      validatedSteps.push({ key, title: stepTitle, assignee_agent_id: assignee, needs, instructions, check });
    }

    validateStepGraph(validatedSteps);

    return transaction(this.pool, async db => {
      if (idempotency) {
        const existing = (await db.query<SwarmRow>(
          'SELECT * FROM swarms WHERE tenant_id=$1 AND created_by=$2 AND idempotency_key=$3',
          [p.tenantId, p.id, idempotency]
        )).rows[0];
        if (existing) {
          const steps = (await db.query<SwarmStepRow>(
            'SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY order_index ASC',
            [existing.id]
          )).rows;
          return { swarm: swarmView(existing, steps), replayed: true };
        }
      }

      // Verify thread exists in scope
      const thread = (await db.query<ThreadRow>(
        'SELECT * FROM threads WHERE id=$1 AND tenant_id=$2 AND scope=$3 FOR UPDATE',
        [threadId, p.tenantId, scope]
      )).rows[0];
      requireFound(thread, 'Thread');

      // Verify all assignee agents exist and are not archived in same scope
      for (const st of validatedSteps) {
        const agent = (await db.query<AgentRow>(
          'SELECT * FROM agents WHERE id=$1 AND tenant_id=$2 AND scope=$3 AND NOT archived',
          [st.assignee_agent_id, p.tenantId, scope]
        )).rows[0];
        requireCondition(Boolean(agent), 400, 'agent_not_found', `Assignee agent '${st.assignee_agent_id}' not found or archived in scope '${scope}'.`);
      }

      const swarmId = newId();
      const swarmOwner = ownerAgentId ?? thread.agent_id;

      await db.query(
        `INSERT INTO swarms (id, tenant_id, scope, title, goal, owner_agent_id, thread_id, status, flow_id, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8, $9, $10)`,
        [swarmId, p.tenantId, scope, title, goal, swarmOwner, threadId, flowId, p.id, idempotency]
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
          await this.queueStepTurn(db, p, scope, swarmId, step, ownerName);
        }
      }

      // Re-read swarm and steps
      const finalSwarm = (await db.query<SwarmRow>('SELECT * FROM swarms WHERE id=$1', [swarmId])).rows[0]!;
      const finalSteps = (await db.query<SwarmStepRow>('SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY order_index ASC', [swarmId])).rows;

      return { swarm: swarmView(finalSwarm, finalSteps), replayed: false };
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

  async swarmUpdate(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['swarm_id', 'expected_version', 'ops']);
    requirePermission(p, 'task:submit');
    const swarmId = uuid(input.swarm_id, 'swarm_id');
    const expected = input.expected_version !== undefined ? integer(input.expected_version, 'expected_version', 1, 2147483647) : null;
    if (!Array.isArray(input.ops) || input.ops.length === 0 || input.ops.length > 20) {
      throw new AppError(400, 'invalid_arguments', 'ops must be an array of 1-20 ops.');
    }

    return transaction(this.pool, async db => {
      const swarm = (await db.query<SwarmRow>(
        'SELECT * FROM swarms WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [swarmId, p.tenantId]
      )).rows[0];
      requireFound(swarm, 'Swarm');
      requireScope(p, swarm.scope);
      if (expected !== null) {
        requireCondition(swarm.version === expected, 409, 'version_conflict', 'Swarm has changed; reload before updating.');
      }

      let allSteps = (await db.query<SwarmStepRow>(
        'SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY order_index ASC FOR UPDATE',
        [swarmId]
      )).rows;

      const ownerName = swarm.owner_agent_id
        ? ((await db.query<{ name: string }>('SELECT name FROM agents WHERE id=$1', [swarm.owner_agent_id])).rows[0]?.name ?? 'Lead')
        : 'Team lead';

      for (const op of input.ops as Array<Record<string, unknown>>) {
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

          const needs = Array.isArray(stepObj.needs) ? stepObj.needs.map(n => String(n).trim()) : [];
          const stepId = newId();
          const nextIndex = allSteps.length;

          // Test cycle with the new step added
          validateStepGraph([...allSteps.map(s => ({ id: s.id, needs: s.needs })), { id: stepId, needs }]);

          const inserted = (await db.query<SwarmStepRow>(
            `INSERT INTO swarm_steps (id, tenant_id, swarm_id, step_key, title, assignee_agent_id, needs, instructions, "check", order_index, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9, $10, 'pending') RETURNING *`,
            [stepId, p.tenantId, swarmId, stepObj.key ? String(stepObj.key) : null, stepTitle, assignee,
             needs, stepObj.instructions ? String(stepObj.instructions) : null, stepObj.check ? String(stepObj.check) : null, nextIndex]
          )).rows[0]!;

          allSteps.push(inserted);

          await this.postNotice(db, p, swarm.scope, swarm.thread_id, `Added step: ${stepTitle}`);

          // Check if ready
          const ready = needs.length === 0 || needs.every(nid => allSteps.some(s => s.id === nid && s.status === 'done'));
          if (ready) {
            await this.queueStepTurn(db, p, swarm.scope, swarmId, inserted, ownerName);
          }
        } else if (opName === 'reassign') {
          const stepId = uuid(op.step_id, 'op.step_id');
          const newAssigneeId = uuid(op.assignee_agent_id, 'op.assignee_agent_id');
          const step = requireFound(allSteps.find(s => s.id === stepId), 'Swarm step');

          const newAgent = (await db.query<AgentRow>(
            'SELECT * FROM agents WHERE id=$1 AND tenant_id=$2 AND scope=$3 AND NOT archived',
            [newAssigneeId, p.tenantId, swarm.scope]
          )).rows[0];
          requireFound(newAgent, 'Assignee agent');

          // Cancel running task if any
          if (step.task_id && step.status === 'running') {
            const task = (await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [step.task_id])).rows[0];
            if (task && !['completed', 'cancelled', 'failed'].includes(task.status)) {
              await cancelTask(db, p, task as any, false);
            }
          }

          step.assignee_agent_id = newAssigneeId;
          await db.query('UPDATE swarm_steps SET assignee_agent_id=$1, updated_at=clock_timestamp() WHERE id=$2', [newAssigneeId, stepId]);

          await this.postNotice(db, p, swarm.scope, swarm.thread_id, `Reassigned step "${step.title}" to ${newAgent.name}`);

          // Queue turn for new agent
          await this.queueStepTurn(db, p, swarm.scope, swarmId, step, ownerName);
        } else if (opName === 'retry') {
          const stepId = uuid(op.step_id, 'op.step_id');
          const step = requireFound(allSteps.find(s => s.id === stepId), 'Swarm step');
          requireCondition(['failed', 'cancelled'].includes(step.status), 400, 'invalid_state', 'Only failed or cancelled steps can be retried.');

          step.status = 'running';
          step.failure_code = null;
          step.failure_detail = null;
          await db.query('UPDATE swarm_steps SET status=\'running\', failure_code=null, failure_detail=null, updated_at=clock_timestamp() WHERE id=$1', [stepId]);

          await this.postNotice(db, p, swarm.scope, swarm.thread_id, `Retrying step "${step.title}"`);
          await this.queueStepTurn(db, p, swarm.scope, swarmId, step, ownerName);
        } else if (opName === 'cancel_step') {
          const stepId = uuid(op.step_id, 'op.step_id');
          const step = requireFound(allSteps.find(s => s.id === stepId), 'Swarm step');

          if (step.task_id && step.status === 'running') {
            const task = (await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [step.task_id])).rows[0];
            if (task && !['completed', 'cancelled', 'failed'].includes(task.status)) {
              await cancelTask(db, p, task as any, false);
            }
          }

          step.status = 'cancelled';
          await db.query("UPDATE swarm_steps SET status='cancelled', updated_at=clock_timestamp() WHERE id=$1", [stepId]);
          await this.postNotice(db, p, swarm.scope, swarm.thread_id, `Cancelled step "${step.title}"`);
        } else if (opName === 'edit') {
          const nextTitle = op.title !== undefined ? string(op.title, 'op.title', 200) : swarm.title;
          const nextGoal = op.goal !== undefined ? string(op.goal, 'op.goal', 16384) : swarm.goal;
          swarm.title = nextTitle;
          swarm.goal = nextGoal;
          await db.query('UPDATE swarms SET title=$1, goal=$2 WHERE id=$3', [nextTitle, nextGoal, swarmId]);
          await this.postNotice(db, p, swarm.scope, swarm.thread_id, 'Updated swarm details');
        } else if (opName === 'close') {
          for (const s of allSteps) {
            if (s.status === 'running' || s.status === 'pending') {
              if (s.task_id) {
                const task = (await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [s.task_id])).rows[0];
                if (task && !['completed', 'cancelled', 'failed'].includes(task.status)) {
                  await cancelTask(db, p, task as any, false);
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
        } else {
          throw new AppError(400, 'invalid_op', `Unknown swarm_update op: ${opName}`);
        }
      }

      // Re-read steps & update derived status
      allSteps = (await db.query<SwarmStepRow>('SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY order_index ASC', [swarmId])).rows;
      const derived = deriveSwarmStatus(allSteps, swarm.closed_at !== null, swarm.status === 'cancelled');

      const updatedSwarm = (await db.query<SwarmRow>(
        `UPDATE swarms SET status=$1, version=version+1, updated_at=clock_timestamp() WHERE id=$2 RETURNING *`,
        [derived, swarmId]
      )).rows[0]!;

      await event(db, p, swarm.scope, 'swarm.updated', swarmId, { swarm_id: swarmId, status: derived, version: updatedSwarm.version });
      await this.notifyCard(db, p, swarm.scope, swarm.thread_id, swarmId);

      return { swarm: swarmView(updatedSwarm, allSteps) };
    });
  }

  async swarmCancel(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['swarm_id', 'expected_version']);
    requirePermission(p, 'task:submit');
    const swarmId = uuid(input.swarm_id, 'swarm_id');
    const expected = input.expected_version !== undefined ? integer(input.expected_version, 'expected_version', 1, 2147483647) : null;

    return transaction(this.pool, async db => {
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
        'SELECT * FROM swarm_steps WHERE swarm_id=$1 FOR UPDATE',
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
    const questionId = uuid(input.question_id, 'question_id');
    const rawChoices = input.choices !== undefined ? input.choices : [];
    if (!Array.isArray(rawChoices)) throw new AppError(400, 'invalid_arguments', 'choices must be an array of strings.');
    const choices = rawChoices.map(c => string(c, 'choice', 80));
    const text = input.text !== undefined ? string(input.text, 'text', 16384) : null;
    const idempotency = input.idempotency_key !== undefined ? string(input.idempotency_key, 'idempotency_key', 200) : null;

    return transaction(this.pool, async db => {
      const q = (await db.query<QuestionRow>(
        'SELECT * FROM questions WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [questionId, p.tenantId]
      )).rows[0];
      requireFound(q, 'Question');
      requireScope(p, q.scope);

      if (q.status === 'answered') {
        return { question: questionView(q), replayed: true };
      }
      requireCondition(q.status === 'open', 400, 'invalid_state', `Cannot answer question with status '${q.status}'.`);

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

      // Post answer message to thread
      const answerParts: string[] = [];
      if (choices.length > 0) answerParts.push(choices.join(', '));
      if (text && text.trim().length > 0) answerParts.push(text.trim());
      const answerBody = clipUtf8(redactSecrets(answerParts.join('\n\n')), 16384);

      const nextSeq = await assignThreadSeq(db, p.tenantId, q.thread_id);
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

      // If tied to a swarm step, revert step to running
      if (q.swarm_step_id) {
        await db.query(
          "UPDATE swarm_steps SET status='running', updated_at=clock_timestamp() WHERE id=$1",
          [q.swarm_step_id]
        );
        const stepRow = (await db.query<{ swarm_id: string }>('SELECT swarm_id FROM swarm_steps WHERE id=$1', [q.swarm_step_id])).rows[0];
        if (stepRow) {
          const swSteps = (await db.query<SwarmStepRow>('SELECT * FROM swarm_steps WHERE swarm_id=$1', [stepRow.swarm_id])).rows;
          const derived = deriveSwarmStatus(swSteps);
          await db.query('UPDATE swarms SET status=$1, updated_at=clock_timestamp() WHERE id=$2', [derived, stepRow.swarm_id]);
          await event(db, p, q.scope, 'swarm.updated', stepRow.swarm_id, { swarm_id: stepRow.swarm_id, status: derived });
        }
      }

      // Queue the agent's next turn with initiator answer
      const agent = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [q.agent_id])).rows[0]!;
      const requiredCap = runnerCapability(agent.runner, agent.edits);
      const taskId = newId();
      const envelope = {
        deploy: false, publish: false, purchase: false, local_patch: agent.edits,
        read_project: true, send_messages: false, permission_changes: false, external_side_effects: false
      };
      const contextVersions = { message_seq: Number(nextSeq) };
      const reqHash = sha256(canonicalJson({
        kind: 'turn', scope: agent.scope, agent_id: agent.id, thread_id: q.thread_id, seq: Number(nextSeq)
      }));

      await db.query(
        `INSERT INTO tasks
           (id, tenant_id, scope, kind, agent_id, thread_id, swarm_step_id, objective, constraints, acceptance_criteria,
            permission_envelope, required_capability, resource_key, context_versions, status, created_by,
            idempotency_key, request_hash, max_attempts, initiator_kind, initiator_id)
         VALUES ($1, $2, $3, 'turn', $4, $5, $6, $7, '[]'::jsonb, '[]'::jsonb, $8::jsonb, $9, $10, $11::jsonb, 'queued', $12, $13, $14, 3, 'answer', $15)`,
        [taskId, p.tenantId, agent.scope, agent.id, q.thread_id, q.swarm_step_id, `Answer to: ${q.prompt}`,
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

  async questionList(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['status', 'after', 'limit']);
    requirePermission(p, 'thread:read');
    const [all, grantedScopes] = scopeSql(p);
    const statusParam = input.status !== undefined ? string(input.status, 'status', 32) : 'open';
    const after = input.after !== undefined ? uuid(input.after, 'after') : null;
    const limit = input.limit !== undefined ? integer(input.limit, 'limit', 1, 100) : 50;

    // Check expiry
    await this.pool.query(
      `UPDATE questions SET status='expired', updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND status='open' AND expires_at < clock_timestamp()`,
      [p.tenantId]
    );

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
       ORDER BY created_at DESC LIMIT 50`,
      [p.tenantId, all, grantedScopes, scope]
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
         AND ($2::boolean OR scope = ANY($3::text[]))
         AND ($4::text IS NULL OR scope = $4)
       ORDER BY updated_at DESC LIMIT 50`,
      [p.tenantId, all, grantedScopes, scope]
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
       ORDER BY updated_at DESC LIMIT 50`,
      [p.tenantId, all, grantedScopes, scope]
    )).rows;

    // 4. Swarms waiting_on_you or blocked
    const swarms = (await this.pool.query<SwarmRow>(
      `SELECT * FROM swarms
       WHERE tenant_id=$1 AND status IN ('waiting_on_you', 'blocked')
         AND ($2::boolean OR scope = ANY($3::text[]))
         AND ($4::text IS NULL OR scope = $4)
       ORDER BY updated_at DESC LIMIT 50`,
      [p.tenantId, all, grantedScopes, scope]
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
      const diffstat = (res as any).diffstat ?? (res as any).changed_files ? `${(res as any).changed_files} files` : '';
      const parts = ['Ready for review'];
      if (branch) parts.push(`branch ${branch}`);
      if (diffstat) parts.push(diffstat);

      items.push({
        kind: 'task',
        id: t.id,
        title: t.objective,
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
        title: f.objective,
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
        thread_id: sw.thread_id
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

    const hasMore = filtered.length > limit;
    const paged = filtered.slice(0, limit);

    return {
      items: paged,
      has_more: hasMore,
      next_cursor: hasMore ? paged.at(-1)?.id ?? null : null
    };
  }

  async taskResolve(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['task_id', 'resolved', 'expected_version']);
    requireCondition(p.role === 'admin', 403, 'owner_required', 'Only an owner may resolve tasks.');
    const taskId = uuid(input.task_id, 'task_id');
    const resolved = booleanOption(input.resolved, 'resolved');
    const expected = integer(input.expected_version, 'expected_version', 1, 2147483647);

    return transaction(this.pool, async db => {
      const task = (await db.query<{ id: string; tenant_id: string; scope: string; version: number }>(
        'SELECT id, tenant_id, scope, version FROM tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [taskId, p.tenantId]
      )).rows[0];
      requireFound(task, 'Task');
      requireScope(p, task.scope);
      requireCondition(task.version === expected, 409, 'version_conflict', 'Task has changed; reload before resolving.');

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

      const updated = (await db.query('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0];
      return { task: updated };
    });
  }

  async onStepTaskFinished(
    db: Db,
    p: Principal,
    stepId: string,
    outcome: string,
    resultMsgId?: string,
    failure?: { code?: string; detail?: string }
  ): Promise<void> {
    const step = (await db.query<SwarmStepRow>(
      'SELECT * FROM swarm_steps WHERE id=$1 FOR UPDATE',
      [stepId]
    )).rows[0];
    if (!step) return;

    if (step.status === 'waiting_on_you') {
      return;
    }

    const swarm = (await db.query<SwarmRow>(
      'SELECT * FROM swarms WHERE id=$1 FOR UPDATE',
      [step.swarm_id]
    )).rows[0];
    if (!swarm) return;

    if (outcome === 'completed') {
      await db.query(
        `UPDATE swarm_steps
         SET status='done', result_message_id=$1, updated_at=clock_timestamp()
         WHERE id=$2`,
        [resultMsgId ?? null, stepId]
      );
    } else {
      const failStatus = outcome === 'cancelled' ? 'cancelled' : 'failed';
      await db.query(
        `UPDATE swarm_steps
         SET status=$1, failure_code=$2, failure_detail=$3, updated_at=clock_timestamp()
         WHERE id=$4`,
        [failStatus, failure?.code ?? 'failed', failure?.detail ?? 'Task failed', stepId]
      );
    }

    const allSteps = (await db.query<SwarmStepRow>(
      'SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY order_index ASC FOR UPDATE',
      [swarm.id]
    )).rows;

    const ownerName = swarm.owner_agent_id
      ? ((await db.query<{ name: string }>('SELECT name FROM agents WHERE id=$1', [swarm.owner_agent_id])).rows[0]?.name ?? 'Lead')
      : 'Team lead';

    // Start newly unblocked steps
    for (const s of allSteps) {
      if (s.status === 'pending') {
        const needsDone = s.needs.length === 0 || s.needs.every(depId => allSteps.some(other => other.id === depId && other.status === 'done'));
        if (needsDone) {
          await this.queueStepTurn(db, p, swarm.scope, swarm.id, s, ownerName);
        }
      }
    }

    // Re-check all steps
    const refreshedSteps = (await db.query<SwarmStepRow>(
      'SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY order_index ASC',
      [swarm.id]
    )).rows;

    const allDone = refreshedSteps.length > 0 && refreshedSteps.every(s => s.status === 'done');
    let derived = deriveSwarmStatus(refreshedSteps);

    if (allDone) {
      derived = 'done';
      await db.query(
        `UPDATE swarms SET status='done', closed_at=clock_timestamp(), version=version+1, updated_at=clock_timestamp()
         WHERE id=$1`,
        [swarm.id]
      );

      // Final summarising turn for owner agent
      if (swarm.owner_agent_id) {
        const ownerAgent = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [swarm.owner_agent_id])).rows[0];
        if (ownerAgent) {
          const requiredCap = runnerCapability(ownerAgent.runner, ownerAgent.edits);
          const followUpId = newId();
          const envelope = {
            deploy: false, publish: false, purchase: false, local_patch: ownerAgent.edits,
            read_project: true, send_messages: false, permission_changes: false, external_side_effects: false
          };
          const reqHash = sha256(canonicalJson({
            kind: 'turn', scope: ownerAgent.scope, agent_id: ownerAgent.id, swarm_id: swarm.id, summary: true
          }));

          await db.query(
            `INSERT INTO tasks
               (id, tenant_id, scope, kind, agent_id, thread_id, objective, constraints, acceptance_criteria,
                permission_envelope, required_capability, resource_key, context_versions, status, created_by,
                idempotency_key, request_hash, max_attempts, initiator_kind, initiator_id)
             VALUES ($1, $2, $3, 'turn', $4, $5, $6, '[]'::jsonb, '[]'::jsonb, $7::jsonb, $8, $9, '{}'::jsonb, 'queued', $10, $11, $12, 3, 'swarm', $13)`,
            [followUpId, p.tenantId, ownerAgent.scope, ownerAgent.id, swarm.thread_id,
             `Summarise swarm results: ${swarm.title}`, JSON.stringify(envelope),
             requiredCap, `agent:${ownerAgent.id}`, p.id, newId(), reqHash, swarm.id]
          );

          await audit(db, p, ownerAgent.scope, 'task.submitted', followUpId, { kind: 'turn', agent_id: ownerAgent.id, initiator_kind: 'swarm' });
          await event(db, p, ownerAgent.scope, 'task.updated', followUpId, { task_id: followUpId, status: 'queued', action: 'submitted' });
        }
      }
    } else {
      await db.query(
        `UPDATE swarms SET status=$1, version=version+1, updated_at=clock_timestamp() WHERE id=$2`,
        [derived, swarm.id]
      );
    }

    await event(db, p, swarm.scope, 'swarm.updated', swarm.id, { swarm_id: swarm.id, status: derived });
    await this.notifyCard(db, p, swarm.scope, swarm.thread_id, swarm.id);
  }

  async applyTurnActions(
    db: Db,
    p: Principal,
    ctx: TurnGrantContext,
    actions: TurnAction[],
    cleanReplyMsgId: string
  ): Promise<void> {
    for (const act of actions) {
      if (act.type === 'handoff') {
        const targetAgent = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [act.to_agent])).rows[0]!;

        // 1. Post handoff line into sending agent's thread
        const senderSeq = await assignThreadSeq(db, ctx.tenantId, ctx.thread.id);
        const senderHandoffMsgId = newId();
        const handoffText = `${ctx.agent.name} handed off to ${targetAgent.name}: ${act.body}`;
        await db.query(
          `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body, ref)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'handoff', $7, $8::jsonb)`,
          [senderHandoffMsgId, ctx.tenantId, ctx.scope, ctx.thread.id, senderSeq,
           JSON.stringify({ kind: 'system', id: 'service' }), handoffText,
           JSON.stringify({ from_agent_id: ctx.agent.id, to_agent_id: targetAgent.id, ...(act.swarm_step_id ? { swarm_step_id: act.swarm_step_id } : {}) })]
        );
        await event(db, p, ctx.scope, 'message.created', senderHandoffMsgId, {
          thread_id: ctx.thread.id,
          message_id: senderHandoffMsgId,
          seq: Number(senderSeq),
          kind: 'handoff',
          author: { kind: 'system', id: 'service' }
        });

        // 2. Post handoff line into target agent's main thread
        const targetThreadId = targetAgent.main_thread_id!;
        const targetSeq = await assignThreadSeq(db, ctx.tenantId, targetThreadId);
        const targetHandoffMsgId = newId();
        const targetHandoffText = `${ctx.agent.name} gave you: ${act.body}`;
        await db.query(
          `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body, ref)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'handoff', $7, $8::jsonb)`,
          [targetHandoffMsgId, ctx.tenantId, ctx.scope, targetThreadId, targetSeq,
           JSON.stringify({ kind: 'system', id: 'service' }), targetHandoffText,
           JSON.stringify({ from_agent_id: ctx.agent.id, to_agent_id: targetAgent.id, ...(act.swarm_step_id ? { swarm_step_id: act.swarm_step_id } : {}) })]
        );
        await event(db, p, ctx.scope, 'message.created', targetHandoffMsgId, {
          thread_id: targetThreadId,
          message_id: targetHandoffMsgId,
          seq: Number(targetSeq),
          kind: 'handoff',
          author: { kind: 'system', id: 'service' }
        });

        // 3. Queue turn task for target agent with initiator handoff
        const requiredCap = runnerCapability(targetAgent.runner, targetAgent.edits);
        const taskId = newId();
        const envelope = {
          deploy: false, publish: false, purchase: false, local_patch: targetAgent.edits,
          read_project: true, send_messages: false, permission_changes: false, external_side_effects: false
        };
        const ctxVersions = { message_seq: Number(targetSeq) };
        const reqHash = sha256(canonicalJson({
          kind: 'turn', scope: targetAgent.scope, agent_id: targetAgent.id, thread_id: targetThreadId, seq: Number(targetSeq)
        }));

        await db.query(
          `INSERT INTO tasks
             (id, tenant_id, scope, kind, agent_id, thread_id, swarm_step_id, objective, constraints, acceptance_criteria,
              permission_envelope, required_capability, resource_key, context_versions, status, created_by,
              idempotency_key, request_hash, max_attempts, initiator_kind, initiator_id)
           VALUES ($1, $2, $3, 'turn', $4, $5, $6, $7, '[]'::jsonb, '[]'::jsonb, $8::jsonb, $9, $10, $11::jsonb, 'queued', $12, $13, $14, 3, 'handoff', $15)`,
          [taskId, ctx.tenantId, targetAgent.scope, targetAgent.id, targetThreadId, act.swarm_step_id ?? null,
           `Handoff from ${ctx.agent.name}: ${act.body}`, JSON.stringify(envelope),
           requiredCap, `agent:${targetAgent.id}`, JSON.stringify(ctxVersions), p.id, newId(), reqHash, ctx.agent.id]
        );

        await audit(db, p, targetAgent.scope, 'task.submitted', taskId, { kind: 'turn', agent_id: targetAgent.id, initiator_kind: 'handoff' });
        await event(db, p, targetAgent.scope, 'task.updated', taskId, { task_id: taskId, status: 'queued', action: 'submitted' });
      } else if (act.type === 'swarm_start') {
        await this.swarmStart(p, {
          title: act.title,
          goal: act.goal,
          scope: ctx.scope,
          thread_id: ctx.thread.id,
          steps: act.steps,
          owner_agent_id: ctx.agent.id
        });
      } else if (act.type === 'swarm_update') {
        await this.swarmUpdate(p, {
          swarm_id: act.swarm_id,
          ops: act.ops
        });
      } else if (act.type === 'question_ask') {
        const questionId = newId();
        const expiresAt = act.expires_in ? new Date(Date.now() + act.expires_in * 1000) : null;

        await db.query(
          `INSERT INTO questions
             (id, tenant_id, scope, thread_id, agent_id, swarm_step_id, prompt, options, multi, free_text, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, 'open', $11)`,
          [questionId, ctx.tenantId, ctx.scope, ctx.thread.id, ctx.agent.id, act.swarm_step_id ?? null,
           act.prompt, JSON.stringify(act.options), act.multi ?? false, act.free_text ?? false, expiresAt]
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
          await db.query(
            "UPDATE swarm_steps SET status='waiting_on_you', updated_at=clock_timestamp() WHERE id=$1",
            [act.swarm_step_id]
          );
          const stepRow = (await db.query<{ swarm_id: string }>('SELECT swarm_id FROM swarm_steps WHERE id=$1', [act.swarm_step_id])).rows[0];
          if (stepRow) {
            const swSteps = (await db.query<SwarmStepRow>('SELECT * FROM swarm_steps WHERE swarm_id=$1', [stepRow.swarm_id])).rows;
            const derived = deriveSwarmStatus(swSteps);
            await db.query('UPDATE swarms SET status=$1, updated_at=clock_timestamp() WHERE id=$2', [derived, stepRow.swarm_id]);
            await event(db, p, ctx.scope, 'swarm.updated', stepRow.swarm_id, { swarm_id: stepRow.swarm_id, status: derived });
            await this.notifyCard(db, p, ctx.scope, ctx.thread.id, stepRow.swarm_id);
          }
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

        // Mentions or lead routing in channel
        await this.routeChannelPost(db, p, ctx.scope, act.channel_id, act.body, ctx.agent.id, Number(chanSeq));
      }
    }
  }

  async routeChannelPost(
    db: Db,
    p: Principal,
    scope: string,
    channelId: string,
    body: string,
    authorAgentId: string | null,
    msgSeq: number
  ): Promise<void> {
    const channel = (await db.query<ThreadRow & { lead_agent_id: string | null }>(
      'SELECT * FROM threads WHERE id=$1',
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
        if (mentionedNames.has(m.name.toLowerCase()) && m.agent_id !== authorAgentId) {
          targetAgents.push(m.agent_id);
        }
      }
    } else if (channel.lead_agent_id && channel.lead_agent_id !== authorAgentId) {
      targetAgents.push(channel.lead_agent_id);
    }

    for (const agentId of targetAgents) {
      const active = (await db.query(
        "SELECT id FROM tasks WHERE tenant_id=$1 AND agent_id=$2 AND status IN ('queued', 'running') LIMIT 1",
        [p.tenantId, agentId]
      )).rows[0];

      if (!active) {
        const agent = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1', [agentId])).rows[0];
        if (!agent) continue;

        const requiredCap = runnerCapability(agent.runner, agent.edits);
        const taskId = newId();
        const envelope = {
          deploy: false, publish: false, purchase: false, local_patch: agent.edits,
          read_project: true, send_messages: false, permission_changes: false, external_side_effects: false
        };
        const ctxVersions = { message_seq: msgSeq };
        const reqHash = sha256(canonicalJson({
          kind: 'turn', scope, agent_id: agent.id, thread_id: channelId, seq: msgSeq
        }));

        await db.query(
          `INSERT INTO tasks
             (id, tenant_id, scope, kind, agent_id, thread_id, objective, constraints, acceptance_criteria,
              permission_envelope, required_capability, resource_key, context_versions, status, created_by,
              idempotency_key, request_hash, max_attempts, initiator_kind, initiator_id)
           VALUES ($1, $2, $3, 'turn', $4, $5, $6, '[]'::jsonb, '[]'::jsonb, $7::jsonb, $8, $9, $10::jsonb, 'queued', $11, $12, $13, 3, 'person', $14)`,
          [taskId, p.tenantId, scope, agent.id, channelId, `Turn in channel #${channel.title ?? 'channel'}`,
           JSON.stringify(envelope), requiredCap, `agent:${agent.id}`, JSON.stringify(ctxVersions), p.id, newId(), reqHash, p.id]
        );

        await audit(db, p, scope, 'task.submitted', taskId, { kind: 'turn', agent_id: agent.id });
        await event(db, p, scope, 'task.updated', taskId, { task_id: taskId, status: 'queued', action: 'submitted' });
      }
    }
  }

  private async queueStepTurn(
    db: Db,
    p: Principal,
    scope: string,
    swarmId: string,
    step: SwarmStepRow,
    ownerName: string
  ): Promise<void> {
    const agent = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [step.assignee_agent_id])).rows[0];
    if (!agent) return;

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
    const requiredCap = runnerCapability(agent.runner, agent.edits);
    const taskId = newId();
    const envelope = {
      deploy: false, publish: false, purchase: false, local_patch: agent.edits,
      read_project: true, send_messages: false, permission_changes: false, external_side_effects: false
    };
    const ctxVersions = { message_seq: Number(seq) };
    const reqHash = sha256(canonicalJson({
      kind: 'turn', scope, agent_id: agent.id, thread_id: targetThreadId, seq: Number(seq)
    }));

    await db.query(
      `INSERT INTO tasks
         (id, tenant_id, scope, kind, agent_id, thread_id, swarm_step_id, objective, constraints, acceptance_criteria,
          permission_envelope, required_capability, resource_key, context_versions, status, created_by,
          idempotency_key, request_hash, max_attempts, initiator_kind, initiator_id)
       VALUES ($1, $2, $3, 'turn', $4, $5, $6, $7, '[]'::jsonb, '[]'::jsonb, $8::jsonb, $9, $10, $11::jsonb, 'queued', $12, $13, $14, 3, 'swarm', $15)`,
      [taskId, p.tenantId, scope, agent.id, targetThreadId, step.id,
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

  private async postNotice(db: Db, p: Principal, scope: string, threadId: string, body: string): Promise<void> {
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

  private async notifyCard(db: Db, p: Principal, scope: string, threadId: string, swarmId: string): Promise<void> {
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
