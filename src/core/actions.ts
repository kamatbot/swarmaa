import { AppError } from '../errors.js';
import { redactSecrets } from '../safety/redact.js';
import { validateStepGraph } from './swarms.js';
import { clipUtf8 } from './teams.js';
import type { Db } from './shared.js';
import type { AgentRow, ThreadRow } from './teams.js';

export interface TurnActionHandoff {
  type: 'handoff';
  to_agent: string;
  body: string;
  swarm_step_id?: string;
}

export interface SwarmStartStepInput {
  key?: string;
  title: string;
  assignee_agent_id: string;
  needs?: string[];
  instructions?: string;
  check?: string;
}

export interface TurnActionSwarmStart {
  type: 'swarm_start';
  title: string;
  goal: string;
  steps: SwarmStartStepInput[];
}

export interface TurnActionSwarmUpdate {
  type: 'swarm_update';
  swarm_id: string;
  ops: Array<Record<string, unknown>>;
}

export interface TurnActionQuestionAsk {
  type: 'question_ask';
  prompt: string;
  options: string[];
  multi?: boolean;
  free_text?: boolean;
  swarm_step_id?: string;
  expires_in?: number;
}

export interface TurnActionChannelPost {
  type: 'channel_post';
  channel_id: string;
  body: string;
}

export type TurnAction =
  | TurnActionHandoff
  | TurnActionSwarmStart
  | TurnActionSwarmUpdate
  | TurnActionQuestionAsk
  | TurnActionChannelPost;

export interface ExtractedActions {
  cleanText: string;
  rawBlock: string | null;
  actions?: TurnAction[];
  error?: string;
  rejectedAction?: unknown;
}

/**
 * Extracts and parses a fenced ```swarmaa-actions ... ``` block from an agent's answer.
 * Rules:
 * - Must be an unquoted code block (not inside markdown blockquote >).
 * - Must be the last element in the response (only whitespace allowed after the closing ```).
 * - At most one block allowed.
 * - Must be valid JSON array with at most 10 items.
 */
export function extractActionsBlock(text: string): ExtractedActions {
  if (!text) return { cleanText: '', rawBlock: null, actions: [] };

  const lines = text.split(/\r?\n/);
  const blockOpenIndices: number[] = [];
  const blockCloseIndices: number[] = [];

  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const isQuoted = /^\s*>/.test(line);

    if (!inBlock) {
      if (!isQuoted && /^```swarmaa-actions\s*$/.test(trimmed)) {
        blockOpenIndices.push(i);
        inBlock = true;
      }
    } else {
      if (!isQuoted && /^```\s*$/.test(trimmed)) {
        blockCloseIndices.push(i);
        inBlock = false;
      }
    }
  }

  if (blockOpenIndices.length === 0) {
    return { cleanText: text, rawBlock: null, actions: [] };
  }

  if (blockOpenIndices.length > 1) {
    return {
      cleanText: text,
      rawBlock: null,
      error: 'multiple actions blocks found; only one is allowed'
    };
  }

  const openIdx = blockOpenIndices[0]!;
  if (blockCloseIndices.length === 0 || blockCloseIndices[0]! < openIdx) {
    return {
      cleanText: text,
      rawBlock: null,
      error: 'unclosed actions code block'
    };
  }

  const closeIdx = blockCloseIndices[0]!;

  // Check if anything other than whitespace follows the closing fence
  for (let i = closeIdx + 1; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) {
      return {
        cleanText: text,
        rawBlock: null,
        error: 'actions block must be the last element in the response'
      };
    }
  }

  const cleanLines = lines.slice(0, openIdx);
  while (cleanLines.length > 0 && cleanLines[cleanLines.length - 1]!.trim().length === 0) {
    cleanLines.pop();
  }
  const cleanText = cleanLines.join('\n');
  const rawBlock = lines.slice(openIdx + 1, closeIdx).join('\n').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBlock);
  } catch (err) {
    return {
      cleanText,
      rawBlock,
      error: `malformed actions JSON: ${(err as Error).message}`
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      cleanText,
      rawBlock,
      error: 'actions block must contain a JSON array'
    };
  }

  if (parsed.length > 10) {
    return {
      cleanText,
      rawBlock,
      error: `too many actions: at most 10 allowed (got ${parsed.length})`
    };
  }

  // Schema validation for each action
  const actions: TurnAction[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { cleanText, rawBlock, error: 'action must be an object', rejectedAction: item };
    }
    const act = item as Record<string, unknown>;
    const type = act.type;
    if (typeof type !== 'string') {
      return { cleanText, rawBlock, error: 'action missing type field', rejectedAction: item };
    }

    if (type === 'handoff') {
      const allowed = new Set(['type', 'to_agent', 'body', 'swarm_step_id']);
      for (const k of Object.keys(act)) {
        if (!allowed.has(k)) {
          return { cleanText, rawBlock, error: `unknown field '${k}' in handoff action`, rejectedAction: item };
        }
      }
      if (typeof act.to_agent !== 'string' || !act.to_agent.trim()) {
        return { cleanText, rawBlock, error: 'handoff requires to_agent', rejectedAction: item };
      }
      if (typeof act.body !== 'string') {
        return { cleanText, rawBlock, error: 'handoff requires body string', rejectedAction: item };
      }
      if (act.swarm_step_id !== undefined && (typeof act.swarm_step_id !== 'string' || !act.swarm_step_id.trim())) {
        return { cleanText, rawBlock, error: 'invalid swarm_step_id in handoff', rejectedAction: item };
      }
      actions.push({
        type: 'handoff',
        to_agent: act.to_agent.trim(),
        body: clipUtf8(redactSecrets(act.body), 16384),
        swarm_step_id: act.swarm_step_id ? String(act.swarm_step_id).trim() : undefined
      });
    } else if (type === 'swarm_start') {
      const allowed = new Set(['type', 'title', 'goal', 'steps']);
      for (const k of Object.keys(act)) {
        if (!allowed.has(k)) {
          return { cleanText, rawBlock, error: `unknown field '${k}' in swarm_start action`, rejectedAction: item };
        }
      }
      if (typeof act.title !== 'string' || act.title.trim().length === 0 || act.title.length > 200) {
        return { cleanText, rawBlock, error: 'swarm_start requires title (1-200 chars)', rejectedAction: item };
      }
      if (typeof act.goal !== 'string' || act.goal.trim().length === 0) {
        return { cleanText, rawBlock, error: 'swarm_start requires goal string', rejectedAction: item };
      }
      if (!Array.isArray(act.steps) || act.steps.length === 0 || act.steps.length > 50) {
        return { cleanText, rawBlock, error: 'swarm_start requires steps array (1-50 steps)', rejectedAction: item };
      }
      const steps: SwarmStartStepInput[] = [];
      const stepAllowed = new Set(['key', 'title', 'assignee_agent_id', 'needs', 'instructions', 'check']);
      for (const s of act.steps) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) {
          return { cleanText, rawBlock, error: 'swarm_start step must be an object', rejectedAction: item };
        }
        const stepObj = s as Record<string, unknown>;
        for (const k of Object.keys(stepObj)) {
          if (!stepAllowed.has(k)) {
            return { cleanText, rawBlock, error: `unknown field '${k}' in swarm_start step`, rejectedAction: item };
          }
        }
        if (typeof stepObj.title !== 'string' || stepObj.title.trim().length === 0 || stepObj.title.length > 200) {
          return { cleanText, rawBlock, error: 'step requires title (1-200 chars)', rejectedAction: item };
        }
        if (typeof stepObj.assignee_agent_id !== 'string' || !stepObj.assignee_agent_id.trim()) {
          return { cleanText, rawBlock, error: 'step requires assignee_agent_id', rejectedAction: item };
        }
        const needs = stepObj.needs !== undefined ? stepObj.needs : [];
        if (!Array.isArray(needs)) {
          return { cleanText, rawBlock, error: 'step needs must be an array', rejectedAction: item };
        }
        steps.push({
          key: stepObj.key ? String(stepObj.key) : undefined,
          title: stepObj.title.trim(),
          assignee_agent_id: String(stepObj.assignee_agent_id).trim(),
          needs: needs.map(n => String(n).trim()),
          instructions: stepObj.instructions !== undefined ? clipUtf8(redactSecrets(String(stepObj.instructions)), 16384) : undefined,
          check: stepObj.check !== undefined ? String(stepObj.check).trim() : undefined
        });
      }
      actions.push({
        type: 'swarm_start',
        title: act.title.trim(),
        goal: clipUtf8(redactSecrets(act.goal), 16384),
        steps
      });
    } else if (type === 'swarm_update') {
      const allowed = new Set(['type', 'swarm_id', 'ops']);
      for (const k of Object.keys(act)) {
        if (!allowed.has(k)) {
          return { cleanText, rawBlock, error: `unknown field '${k}' in swarm_update action`, rejectedAction: item };
        }
      }
      if (typeof act.swarm_id !== 'string' || !act.swarm_id.trim()) {
        return { cleanText, rawBlock, error: 'swarm_update requires swarm_id', rejectedAction: item };
      }
      if (!Array.isArray(act.ops) || act.ops.length === 0 || act.ops.length > 20) {
        return { cleanText, rawBlock, error: 'swarm_update requires ops array (1-20 ops)', rejectedAction: item };
      }
      actions.push({
        type: 'swarm_update',
        swarm_id: act.swarm_id.trim(),
        ops: act.ops as Array<Record<string, unknown>>
      });
    } else if (type === 'question_ask') {
      const allowed = new Set(['type', 'prompt', 'options', 'multi', 'free_text', 'swarm_step_id', 'expires_in']);
      for (const k of Object.keys(act)) {
        if (!allowed.has(k)) {
          return { cleanText, rawBlock, error: `unknown field '${k}' in question_ask action`, rejectedAction: item };
        }
      }
      if (typeof act.prompt !== 'string' || act.prompt.trim().length === 0) {
        return { cleanText, rawBlock, error: 'question_ask requires prompt', rejectedAction: item };
      }
      const prompt = clipUtf8(redactSecrets(act.prompt.trim()), 500);
      if (Buffer.byteLength(prompt, 'utf8') > 500) {
        return { cleanText, rawBlock, error: 'question prompt exceeds 500 bytes', rejectedAction: item };
      }
      if (!Array.isArray(act.options) || act.options.length > 8) {
        return { cleanText, rawBlock, error: 'question_ask requires options array (at most 8 options)', rejectedAction: item };
      }
      const options: string[] = [];
      for (const opt of act.options) {
        if (typeof opt !== 'string' || opt.length > 80) {
          return { cleanText, rawBlock, error: 'each option must be a string up to 80 chars', rejectedAction: item };
        }
        options.push(clipUtf8(redactSecrets(opt), 80));
      }
      actions.push({
        type: 'question_ask',
        prompt,
        options,
        multi: Boolean(act.multi),
        free_text: Boolean(act.free_text),
        swarm_step_id: act.swarm_step_id ? String(act.swarm_step_id).trim() : undefined,
        expires_in: typeof act.expires_in === 'number' ? Math.max(1, Math.floor(act.expires_in)) : undefined
      });
    } else if (type === 'channel_post') {
      const allowed = new Set(['type', 'channel_id', 'body']);
      for (const k of Object.keys(act)) {
        if (!allowed.has(k)) {
          return { cleanText, rawBlock, error: `unknown field '${k}' in channel_post action`, rejectedAction: item };
        }
      }
      if (typeof act.channel_id !== 'string' || !act.channel_id.trim()) {
        return { cleanText, rawBlock, error: 'channel_post requires channel_id', rejectedAction: item };
      }
      if (typeof act.body !== 'string' || act.body.trim().length === 0) {
        return { cleanText, rawBlock, error: 'channel_post requires body', rejectedAction: item };
      }
      actions.push({
        type: 'channel_post',
        channel_id: act.channel_id.trim(),
        body: clipUtf8(redactSecrets(act.body), 16384)
      });
    } else {
      return { cleanText, rawBlock, error: `unknown action type '${String(type)}'`, rejectedAction: item };
    }
  }

  return { cleanText, rawBlock, actions };
}

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(val: unknown): val is string {
  return typeof val === 'string' && UUID_REGEX.test(val);
}

export interface TurnGrantContext {
  agent: AgentRow;
  thread: ThreadRow;
  tenantId: string;
  scope: string;
  hopDepth?: number;
  botId?: string | null;
}

/**
 * Validates parsed actions against the turn grant in the database.
 * Turn grant rules:
 * - post only to its own agent's threads and the channels that agent is a member of;
 * - hand off only to agents in the same tenant and scope;
 * - start swarms only in its own scope, owned by itself;
 * - update only swarms it owns or holds a step in;
 * - ask questions only as itself on running steps.
 * All model-supplied IDs are validated as UUIDs and scope-checked.
 */
export async function validateTurnGrant(
  db: Db,
  ctx: TurnGrantContext,
  actions: TurnAction[]
): Promise<{ valid: true } | { valid: false; reason: string; action: TurnAction }> {
  for (const act of actions) {
    if (act.type === 'handoff') {
      // Find target agent in same tenant and scope
      const res = await db.query<AgentRow>(
        'SELECT * FROM agents WHERE tenant_id=$1 AND scope=$2 AND (id::text=$3 OR name=$3) AND NOT archived',
        [ctx.tenantId, ctx.scope, act.to_agent]
      );
      if (!res.rows[0]) {
        return {
          valid: false,
          reason: `handoff target agent '${act.to_agent}' not found or not active in this scope`,
          action: act
        };
      }
      // Re-map to exact UUID if name was provided
      act.to_agent = res.rows[0].id;

      if (act.swarm_step_id) {
        if (!isUuid(act.swarm_step_id)) {
          return {
            valid: false,
            reason: `swarm_step_id '${act.swarm_step_id}' is not a valid uuid`,
            action: act
          };
        }
        const stepRes = await db.query<{ id: string; assignee_agent_id: string; scope: string; owner_agent_id: string | null; status: string; swarm_status: string; closed_at: Date | null }>(
          `SELECT s.id, s.assignee_agent_id, sw.scope, sw.owner_agent_id, s.status, sw.status AS swarm_status, sw.closed_at
           FROM swarm_steps s
           JOIN swarms sw ON sw.id = s.swarm_id
           WHERE s.id = $1 AND s.tenant_id = $2`,
          [act.swarm_step_id, ctx.tenantId]
        );
        if (!stepRes.rows[0] || stepRes.rows[0].scope !== ctx.scope) {
          return {
            valid: false,
            reason: `swarm_step_id '${act.swarm_step_id}' not found in this scope`,
            action: act
          };
        }
        const stepRow = stepRes.rows[0];
        if (stepRow.assignee_agent_id !== ctx.agent.id && stepRow.owner_agent_id !== ctx.agent.id) {
          return {
            valid: false,
            reason: `agent does not hold or own swarm step '${act.swarm_step_id}'`,
            action: act
          };
        }
        if (['done', 'cancelled', 'failed'].includes(stepRow.status) || stepRow.closed_at !== null || ['done', 'cancelled'].includes(stepRow.swarm_status)) {
          return {
            valid: false,
            reason: `swarm step '${act.swarm_step_id}' is ${stepRow.status} in a ${stepRow.closed_at !== null ? 'closed' : stepRow.swarm_status} swarm; it cannot be handed off`,
            action: act
          };
        }
      }
    } else if (act.type === 'swarm_start') {
      // Swarms are started in agent's scope, owned by itself
      // All assignees must be in same tenant and scope and active
      for (const step of act.steps) {
        const res = await db.query<AgentRow>(
          'SELECT * FROM agents WHERE tenant_id=$1 AND scope=$2 AND (id::text=$3 OR name=$3) AND NOT archived',
          [ctx.tenantId, ctx.scope, step.assignee_agent_id]
        );
        if (!res.rows[0]) {
          return {
            valid: false,
            reason: `swarm step assignee '${step.assignee_agent_id}' not found or not active in this scope`,
            action: act
          };
        }
        step.assignee_agent_id = res.rows[0].id;
      }
      try {
        validateStepGraph(act.steps.map((st, i) => ({ key: st.key ? String(st.key).trim() : `step_${i + 1}`, needs: st.needs ?? [] })));
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        return { valid: false, reason: err.message, action: act };
      }
    } else if (act.type === 'swarm_update') {
      if (!isUuid(act.swarm_id)) {
        return {
          valid: false,
          reason: `swarm_id '${act.swarm_id}' is not a valid uuid`,
          action: act
        };
      }
      const swarmRes = await db.query<{ id: string; owner_agent_id: string | null; scope: string; status: string; closed_at: Date | null }>(
        'SELECT id, owner_agent_id, scope, status, closed_at FROM swarms WHERE tenant_id=$1 AND id=$2',
        [ctx.tenantId, act.swarm_id]
      );
      if (!swarmRes.rows[0]) {
        return {
          valid: false,
          reason: `swarm '${act.swarm_id}' not found`,
          action: act
        };
      }
      const swarm = swarmRes.rows[0];
      if (swarm.scope !== ctx.scope) {
        return {
          valid: false,
          reason: `cannot update swarm in different scope '${swarm.scope}'`,
          action: act
        };
      }
      if (swarm.status === 'cancelled' || swarm.closed_at !== null) {
        return {
          valid: false,
          reason: 'cannot update a closed or cancelled swarm',
          action: act
        };
      }
      const owns = swarm.owner_agent_id === ctx.agent.id;
      if (!owns) {
        const stepRes = await db.query<{ count: string }>(
          'SELECT count(*)::int AS count FROM swarm_steps WHERE swarm_id=$1 AND assignee_agent_id=$2',
          [act.swarm_id, ctx.agent.id]
        );
        const holdsStep = Number(stepRes.rows[0]?.count ?? 0) > 0;
        if (!holdsStep) {
          return {
            valid: false,
            reason: `agent is neither the owner nor holds a step in swarm '${act.swarm_id}'`,
            action: act
          };
        }
      }

      const steps = (await db.query<{ id: string; step_key: string | null }>(
        'SELECT id, step_key FROM swarm_steps WHERE swarm_id=$1',
        [act.swarm_id]
      )).rows;
      for (const op of act.ops) {
        const opError = await validateOp(db, ctx, op, steps);
        if (opError) return { valid: false, reason: opError, action: act };
        if (op.step_id !== undefined) {
          if (!isUuid(op.step_id)) {
            return {
              valid: false,
              reason: `step_id '${op.step_id}' is not a valid uuid`,
              action: act
            };
          }
          const st = (await db.query<{ id: string; status: string }>(
            'SELECT id, status FROM swarm_steps WHERE id=$1 AND swarm_id=$2',
            [op.step_id, act.swarm_id]
          )).rows[0];
          if (!st) {
            return {
              valid: false,
              reason: `step '${op.step_id}' not found in swarm`,
              action: act
            };
          }
          if (op.op === 'reassign' && st.status === 'done') {
            return {
              valid: false,
              reason: 'cannot reassign a completed step',
              action: act
            };
          }
        }
        if (op.assignee_agent_id !== undefined) {
          const ag = (await db.query<{ id: string }>(
            'SELECT id FROM agents WHERE tenant_id=$1 AND scope=$2 AND (id::text=$3 OR name=$3) AND NOT archived',
            [ctx.tenantId, ctx.scope, op.assignee_agent_id]
          )).rows[0];
          if (!ag) {
            return {
              valid: false,
              reason: `assignee agent '${op.assignee_agent_id}' not found or not active in this scope`,
              action: act
            };
          }
          op.assignee_agent_id = ag.id;
        }
      }
    } else if (act.type === 'question_ask') {
      if (act.swarm_step_id) {
        if (!isUuid(act.swarm_step_id)) {
          return {
            valid: false,
            reason: `swarm_step_id '${act.swarm_step_id}' is not a valid uuid`,
            action: act
          };
        }
        const stepRes = await db.query<{ id: string; assignee_agent_id: string; status: string }>(
          'SELECT id, assignee_agent_id, status FROM swarm_steps WHERE id=$1 AND tenant_id=$2',
          [act.swarm_step_id, ctx.tenantId]
        );
        if (!stepRes.rows[0] || stepRes.rows[0].assignee_agent_id !== ctx.agent.id) {
          return {
            valid: false,
            reason: `swarm_step_id '${act.swarm_step_id}' does not belong to this agent`,
            action: act
          };
        }
        if (stepRes.rows[0].status !== 'running') {
          return {
            valid: false,
            reason: `cannot ask question on swarm step with status '${stepRes.rows[0].status}'`,
            action: act
          };
        }
      }
    } else if (act.type === 'channel_post') {
      if (!isUuid(act.channel_id)) {
        return {
          valid: false,
          reason: `channel_id '${act.channel_id}' is not a valid uuid`,
          action: act
        };
      }
      const channelRes = await db.query<ThreadRow>(
        "SELECT * FROM threads WHERE id=$1 AND tenant_id=$2 AND scope=$3 AND kind='channel'",
        [act.channel_id, ctx.tenantId, ctx.scope]
      );
      if (!channelRes.rows[0]) {
        return {
          valid: false,
          reason: `channel '${act.channel_id}' not found in this scope`,
          action: act
        };
      }
      const memberRes = await db.query<{ count: string }>(
        'SELECT count(*)::int AS count FROM thread_members WHERE thread_id=$1 AND agent_id=$2',
        [act.channel_id, ctx.agent.id]
      );
      if (Number(memberRes.rows[0]?.count ?? 0) === 0) {
        return {
          valid: false,
          reason: `agent is not a member of channel '${act.channel_id}'`,
          action: act
        };
      }
    }
  }

  return { valid: true };
}

const OP_FIELDS: Record<string, { allowed: string[]; required: string[] }> = {
  add_step: { allowed: ['op', 'step'], required: ['step'] },
  reassign: { allowed: ['op', 'step_id', 'assignee_agent_id'], required: ['step_id', 'assignee_agent_id'] },
  retry: { allowed: ['op', 'step_id'], required: ['step_id'] },
  cancel_step: { allowed: ['op', 'step_id'], required: ['step_id'] },
  edit: { allowed: ['op', 'title', 'goal'], required: [] },
  close: { allowed: ['op'], required: [] }
};
const ADD_STEP_FIELDS = new Set(['key', 'title', 'assignee_agent_id', 'needs', 'instructions', 'check']);

/** Checks one swarm_update op's shape, and rewrites an add_step's assignee name and needs keys to ids. Returns the refusal, if any. */
async function validateOp(
  db: Db,
  ctx: TurnGrantContext,
  op: Record<string, unknown>,
  steps: Array<{ id: string; step_key: string | null }>
): Promise<string | null> {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return 'each op must be an object';
  const spec = OP_FIELDS[String(op.op)];
  if (!spec) return `unknown op '${String(op.op)}'`;
  const extra = Object.keys(op).find(k => !spec.allowed.includes(k));
  if (extra) return `unknown field '${extra}' in ${String(op.op)} op`;
  const missing = spec.required.find(k => op[k] === undefined);
  if (missing) return `${String(op.op)} op requires ${missing}`;
  for (const k of ['step_id', 'assignee_agent_id', 'title', 'goal']) {
    if (op[k] !== undefined && (typeof op[k] !== 'string' || !(op[k] as string).trim())) return `${String(op.op)} op ${k} must be a non-empty string`;
  }
  if (op.title !== undefined && (op.title as string).length > 200) return 'edit op title exceeds 200 characters';
  if (op.op !== 'add_step') return null;

  const step = op.step as Record<string, unknown>;
  if (!step || typeof step !== 'object' || Array.isArray(step)) return 'add_step op step must be an object';
  const extraStep = Object.keys(step).find(k => !ADD_STEP_FIELDS.has(k));
  if (extraStep) return `unknown field '${extraStep}' in add_step step`;
  if (typeof step.title !== 'string' || !step.title.trim() || step.title.length > 200) return 'add_step step requires title (1-200 chars)';
  for (const k of ['key', 'instructions', 'check']) {
    if (step[k] !== undefined && typeof step[k] !== 'string') return `add_step step ${k} must be a string`;
  }
  if (typeof step.assignee_agent_id !== 'string' || !step.assignee_agent_id.trim()) return 'add_step step requires assignee_agent_id';
  const assignee = (await db.query<{ id: string }>(
    'SELECT id FROM agents WHERE tenant_id=$1 AND scope=$2 AND (id::text=$3 OR name=$3) AND NOT archived',
    [ctx.tenantId, ctx.scope, step.assignee_agent_id.trim()]
  )).rows[0];
  if (!assignee) return `add_step assignee '${step.assignee_agent_id}' not found or not active in this scope`;
  step.assignee_agent_id = assignee.id;
  const needs = step.needs ?? [];
  if (!Array.isArray(needs)) return 'add_step step needs must be an array';
  const ids: string[] = [];
  for (const ref of needs) {
    const dep = steps.find(st => st.id === ref || (st.step_key !== null && st.step_key === ref));
    if (!dep) return `add_step needs '${String(ref)}', which is not a step of this swarm`;
    ids.push(dep.id);
  }
  step.needs = ids;
  return null;
}
