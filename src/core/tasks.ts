import { botPolicy, botTaskFinished, taskBotPolicy } from './bot-routing.js';
import { firstReplyRunner, leadTurnProfile, postBotTaskCard } from './bots.js';
import { advanceFlow, validateFlowCompletion } from './flows.js';
import type { FlowTask } from './flow-definition.js';
import { bindSession, inboxSession, readTaskInbox, taskFinished, taskReroutedNotice } from './inbox.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '../db.js';
import { requireCondition } from '../errors.js';
import { hasPermission, requirePermission } from '../policy.js';
import { ARTIFACT_MAX_BYTES, type Principal } from '../types.js';
import { enumValue, integer, object, optionalString, scopeName, string, strings, uuid } from '../validation.js';
import { assertKnownScope, audit, canonicalJson, event, jsonObject, newId, noExtraKeys, requireFound, scopeLock, scopeSql, sha256, teamsLock, uuidArray, type Db } from './shared.js';
import { decide, decideAll, getPolicy, policyAllows, scopeUsage, type RoutingKind, type RoutingPolicy } from './routing.js';
import { AUTO_PATCH, AUTO_READ, touchWorker, workerProviders } from './swarm.js';
import { redactSecrets } from '../safety/redact.js';
import { clipUtf8, assignThreadSeq, getTurnWindow, type AgentRow } from './teams.js';
import { booleanOption } from './memory.js';
import { extractActionsBlock, validateTurnGrant, type TurnGrantContext } from './actions.js';
import { runOriginActions } from './voice.js';
import { MAX_HANDOFF_HOPS, SwarmsService, deriveSwarmStatus, type SwarmRow, type SwarmStepRow, type TurnBudget } from './swarms.js';
import { normalizeDispatchedFrom, resolveTurnRunner, validateModelAndEffort } from './model-catalog.js';

function effectiveRoutingKind(row: { kind: string; required_capability: string }): RoutingKind {
  return row.kind === 'turn'
    ? (row.required_capability.endsWith('.patch') ? 'patch' : 'review')
    : (row.kind as RoutingKind);
}

export const DELEGATE_MODEL = 'claude-opus-5-5';

export const TASK_KINDS = ['research','review','patch'] as const;
export const TASK_STATUSES = ['queued','running','blocked','completed','failed','cancelled'] as const;
type TaskKind = typeof TASK_KINDS[number] | 'check' | 'approve' | 'turn';
export interface TaskRow {
  id:string; tenant_id:string; scope:string; kind:TaskKind; objective:string;
  flow_id:string|null; flow:FlowTask|null;
  bot_id?:string|null; agent_id?:string|null; thread_id?:string|null; swarm_step_id?:string|null;
  initiator_kind?: 'person' | 'agent' | 'handoff' | 'swarm' | 'answer' | 'flow' | 'schedule' | 'bot_check' | 'source';
  initiator_id?: string | null;
  resolved_at?: Date | null;
  constraints:string[]; acceptance_criteria:string[]; permission_envelope:Record<string,unknown>;
  required_capability:string; resource_key:string|null; base_ref:string|null; context_refs:string[]; context_versions:Record<string,number>;
  status:typeof TASK_STATUSES[number]; version:number; created_by:string; idempotency_key:string; request_hash:string;
  attempt_count:number; max_attempts:number; continuation_count:number; lease_generation:number;
  lease_owner:string|null; lease_hash:string|null; lease_expires_at:Date|null;
  checkpoint:Record<string,unknown>|null; result:Record<string,unknown>|null; artifact_ids:string[];
  excluded_providers?:string[]; not_before?:Date|null; last_checkpoint_event_at?:Date|null;
  created_at:Date; updated_at:Date; completed_at:Date|null;
}
interface RunRow {
  id:string; task_id:string; generation:number; worker_id:string; lease_hash:string;
  status:string; completion_hash:string|null;
}
export interface LeaseInput { taskId:string; token:string; generation:number }
interface ArtifactRow {
  id:string; tenant_id:string; scope:string; task_id:string; run_generation:number;
  created_by:string; name:string; media_type:string; content:string; byte_length:number;
  sha256:string; created_at:Date;
}
/** Capabilities some worker can advertise; anything else would sit queued forever. */
// demo.read is reserved for scripts/demo.ts: no real worker advertises it.
/** The newest 40 messages (the turn window) hold a photo. ponytail: ignores the 24 KB window trim; over-approximates to claude. */
/** Task origins nobody is present for; Antigravity's consumer login never serves them (see bridge assertAntigravityCompliance). */
const UNATTENDED_INITIATORS: readonly string[] = ['schedule', 'source', 'bot_check'];
const UNATTENDED_SQL = UNATTENDED_INITIATORS.map(k => `'${k}'`).join(',');
/** Unattended itself, or spawned (directly or not) by unattended work: the migration 049 trigger marks those by excluding antigravity. */
const isUnattendedRow = (row: Pick<TaskRow,'initiator_kind'|'excluded_providers'>) =>
  Boolean(row.initiator_kind && UNATTENDED_INITIATORS.includes(row.initiator_kind)) || (row.excluded_providers ?? []).includes('antigravity');
export const VALID_CAPABILITIES = [AUTO_READ,AUTO_PATCH,'claude.read','claude.patch','codex.read','codex.patch','antigravity.read','antigravity.patch','demo.read'] as const;
const date = (value:Date|null):string|null => value?.toISOString() ?? null;
const expectedVersion = (value:unknown):number => integer(value, 'expected_version', 1, 2147483647);
const leaseSeconds = (value:unknown):number => value === undefined ? 120 : integer(value, 'lease_seconds', 30, 300);

export function leaseInput(input:Record<string,unknown>):LeaseInput {
  return { taskId:uuid(input.task_id,'task_id'), token:string(input.lease_token,'lease_token',128),
    generation:integer(input.lease_generation,'lease_generation',1,2147483647) };
}

function sameHash(a:string|null, b:string):boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function worker(p:Principal):void {
  requireCondition(p.role === 'worker', 403, 'worker_required', 'This operation requires a worker connection.');
}

export function taskView(row:TaskRow):Record<string,unknown> {
  const result = (row.result ?? {}) as Record<string, unknown>;
  return { id:row.id, scope:row.scope, kind:row.kind, objective:row.objective, constraints:row.constraints,
    acceptance_criteria:row.acceptance_criteria, permission_envelope:row.permission_envelope,
    required_capability:row.required_capability, resource_key:row.resource_key, base_ref:row.base_ref,
    context_refs:row.context_refs, context_versions:row.context_versions, status:row.status, version:row.version,
    created_by:row.created_by, attempt_count:row.attempt_count, max_attempts:row.max_attempts,
    continuation_count:row.continuation_count, lease_generation:row.lease_generation,
    lease_owner:row.lease_owner, lease_expires_at:date(row.lease_expires_at), checkpoint:row.checkpoint,
    result:row.result, artifact_ids:row.artifact_ids,
    failure: result.failure ?? null,
    served: result.served ?? null,
    excluded_providers: row.excluded_providers ?? [],
    not_before: date(row.not_before ?? null),
    created_at:date(row.created_at),
    updated_at:date(row.updated_at), completed_at:date(row.completed_at),
    ...(row.flow_id ? {flow_id:row.flow_id,flow:row.flow} : {}),
    ...(row.bot_id ? {bot_id:row.bot_id} : {}),
    ...(row.agent_id ? {agent_id:row.agent_id} : {}),
    ...(row.thread_id ? {thread_id:row.thread_id} : {}),
    ...(row.swarm_step_id ? {swarm_step_id:row.swarm_step_id} : {}),
    ...(row.initiator_kind ? {initiator_kind:row.initiator_kind} : {}),
    ...(row.initiator_id ? {initiator_id:row.initiator_id} : {}),
    ...(row.resolved_at ? {resolved_at:date(row.resolved_at)} : {}) };
}

/** List summaries deliberately exclude streamed output; detail/claim views stay full. */
export function taskListView(row:TaskRow):Record<string,unknown> {
  const view = taskView(row);
  const { partial_output, partial_text, activity, ...checkpoint } = row.checkpoint ?? {};
  const result = row.result === null ? null : Object.fromEntries(
    ['answer', 'branch', 'changed_files', 'served', 'failure', 'check', 'summary', 'review_required']
      .filter(key => row.result![key] !== undefined)
      .map(key => [key, key === 'answer' && typeof row.result![key] === 'string'
        ? (row.result![key] as string).slice(0, 500) : row.result![key]])
  );
  return { ...view, objective: row.objective.slice(0, 300), checkpoint: row.checkpoint === null ? null : checkpoint, result };
}

export async function taskWithInstructions(db:Db, row:TaskRow):Promise<Record<string,unknown>> {
  const instructions = await db.query(`SELECT id,instruction,actor_id,created_at FROM task_instructions
    WHERE task_id=$1 ORDER BY created_at,id`, [row.id]);
  const runs = await db.query(`SELECT generation,worker_id,status,artifact_ids,started_at,ended_at
    FROM task_runs WHERE task_id=$1 ORDER BY generation`, [row.id]);
  return { ...taskView(row), instructions:instructions.rows, runs:runs.rows };
}

export async function findTask(db:Db,p:Principal,id:string,lock=false):Promise<TaskRow> {
  const [all, scopes] = scopeSql(p);
  const result = await db.query<TaskRow>(`SELECT * FROM tasks WHERE id=$1 AND tenant_id=$2
    AND ($3::boolean OR scope=ANY($4::text[])) ${lock ? 'FOR UPDATE' : ''}`, [id,p.tenantId,all,scopes]);
  return requireFound(result.rows[0], 'Task');
}

/** All queue/resource mutations acquire scope then task locks, including retraction of context references.
 * Writes that can touch Teams state take teamsLock between the two when the task belongs to an agent or a swarm step.
 * ponytail: tenant-wide on purpose. finish() posts into other agents' threads (handoff), starts/updates swarms, advances steps of
 * other agents and queues bot checks; swarm/agent/bot/team writers elsewhere hold the same tenant key, so a per-thread key would not
 * exclude them. Narrow only with shared(tenant)+exclusive(thread) keys across every holder. */
async function lockedTask(db:PoolClient,p:Principal,id:string,teams=false):Promise<TaskRow> {
  const visible = await findTask(db,p,id);
  await scopeLock(db,'tasks',p,visible.scope);
  if (teams && (visible.agent_id || visible.swarm_step_id || visible.bot_id)) await teamsLock(db,p.tenantId);
  return findTask(db,p,id,true);
}

export async function taskChanged(db:PoolClient,p:Principal,row:TaskRow,action:string,advance=true,audited=true):Promise<void> {
  const failureCode = (row.result as any)?.failure?.code;
  const details = { task_id:row.id,kind:row.kind,required_capability:row.required_capability,
    ...(row.thread_id ? {thread_id:row.thread_id} : {}),version:row.version,status:row.status,action,
    attempt_count:row.attempt_count,lease_generation:row.lease_generation,
    ...(failureCode ? { failure_code: failureCode } : {}),
    ...(row.flow_id ? {flow_id:row.flow_id,step_id:row.flow!.step_id,
      ...(row.kind==='approve' && action==='flow_ready' ? {approval_required:true} : {})} : {}) };
  if (audited) await audit(db,p,row.scope,`task.${action}`,row.id,details);
  await event(db,p,row.scope,'task.updated',row.id,details);
  await taskFinished(db,p,row);
  if (advance && row.status==='completed') await advanceFlow(db,p,row);
}

async function releaseResource(db:PoolClient,row:TaskRow):Promise<void> {
  await db.query(`DELETE FROM task_resource_leases WHERE tenant_id=$1 AND scope=$2 AND task_id=$3
    AND generation=$4`, [row.tenant_id,row.scope,row.id,row.lease_generation]);
}

async function retireResource(db:PoolClient,row:TaskRow):Promise<void> {
  if (row.kind !== 'patch') return releaseResource(db,row);
  // A queued/failed/cancelled row can still reference an abandoned generation's cooldown.
  // Do not let a further continuation or cancellation erase that existing tombstone.
  if (row.status !== 'running') return;
  // Cancellation/expiry fences database writes immediately, but a cooperative local process needs
  // time to observe lease loss and stop. Keep the old generation as a temporary resource tombstone.
  await db.query(`UPDATE task_resource_leases SET expires_at=GREATEST(expires_at,clock_timestamp())+interval '30 seconds'
    WHERE tenant_id=$1 AND scope=$2 AND task_id=$3 AND generation=$4`,
  [row.tenant_id,row.scope,row.id,row.lease_generation]);
}

/** Checks the database clock after waiting for locks; application-host clocks cannot revive a lease. */
async function requireLease(db:PoolClient,p:Principal,row:TaskRow,lease:LeaseInput):Promise<void> {
  worker(p);
  requireCondition(row.status === 'running' && row.lease_owner === p.id && row.lease_generation === lease.generation
    && sameHash(row.lease_hash,sha256(lease.token)),409,'lease_lost','Worker no longer owns this task lease.');
  const time = await db.query<{live:boolean}>('SELECT $1::timestamptz>clock_timestamp() AS live',[row.lease_expires_at]);
  requireCondition(time.rows[0]?.live,409,'lease_lost','Task lease expired; claim again instead of reviving it.');
  const isPatchLike = row.kind === 'patch' || row.kind === 'check' || (row.kind === 'turn' && row.required_capability.endsWith('.patch'));
  if (isPatchLike) {
    requireCondition(hasPermission(p,'task:patch'),403,'forbidden','This worker no longer has task:patch permission.');
  }
  // Only these kinds take a resource lease at claim; a read task's resource_key is advisory.
  if (row.resource_key !== null && (row.kind === 'patch' || row.kind === 'check' || row.kind === 'turn')) {
    const resource = await db.query(`SELECT 1 FROM task_resource_leases WHERE tenant_id=$1 AND scope=$2
      AND resource_key=$3 AND task_id=$4 AND generation=$5 AND expires_at>clock_timestamp() FOR UPDATE`,
    [row.tenant_id,row.scope,row.resource_key,row.id,lease.generation]);
    requireCondition(resource.rowCount === 1,409,'lease_lost','Resource lease is no longer current.');
  }
}

/** Patch results from the bridge: a local branch, commits and a diffstat. Typed when present; other keys stay free-form. */
function patchResult(r:Record<string,unknown>):void {
  const bad = (k:string,why:string):never => requireCondition(false,400,'invalid_arguments',`result.${k} ${why}.`) as never;
  for (const k of ['branch','base_ref'] as const) if (r[k] !== undefined && (typeof r[k] !== 'string' || (r[k] as string).length>200)) bad(k,'must be a string of at most 200 characters');
  for (const k of ['base_commit','head_commit'] as const) if (r[k] !== undefined && r[k] !== null && (typeof r[k] !== 'string' || (r[k] as string).length>200)) bad(k,'must be a string or null');
  if (r.changed_files !== undefined && (!Number.isInteger(r.changed_files) || (r.changed_files as number)<0)) bad('changed_files','must be a non-negative integer');
  if (r.diffstat !== undefined && (typeof r.diffstat !== 'string' || Buffer.byteLength(r.diffstat)>4096)) bad('diffstat','must be a string of at most 4 KiB');
  if (r.commands_allowed !== undefined && typeof r.commands_allowed !== 'boolean') bad('commands_allowed','must be a boolean');
}

function artifactView(row:ArtifactRow):Record<string,unknown> {
  return { id:row.id,task_id:row.task_id,scope:row.scope,run_generation:row.run_generation,created_by:row.created_by,
    name:row.name,media_type:row.media_type,byte_length:row.byte_length,sha256:row.sha256,created_at:date(row.created_at) };
}

export async function cancelTask(db:PoolClient,p:Principal,row:TaskRow,advance=true):Promise<TaskRow> {
  const id = row.id;
  await db.query(`UPDATE task_runs SET status='cancelled',ended_at=clock_timestamp()
    WHERE task_id=$1 AND generation=$2 AND status='running'`,[id,row.lease_generation]);
  await retireResource(db,row);
  const updated = await db.query<TaskRow>(`UPDATE tasks SET status='cancelled',version=version+1,
    lease_generation=lease_generation+1,lease_owner=NULL,lease_hash=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=$1 RETURNING *`,[id]);
  const next = updated.rows[0]!;
  // A cancelled dispatched turn still reports back, so the coordinator's fan-in group can finish instead of waiting forever.
  await copyReplyToCoordinator(db, p, next, 'Cancelled before it finished.', 'failed');
  if (row.swarm_step_id) {
    await db.query("UPDATE swarm_steps SET status='cancelled', updated_at=clock_timestamp() WHERE id=$1", [row.swarm_step_id]);
    const stepRow = (await db.query<{ swarm_id: string }>('SELECT swarm_id FROM swarm_steps WHERE id=$1', [row.swarm_step_id])).rows[0];
    if (stepRow) {
      const swSteps = (await db.query<SwarmStepRow>('SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY id ASC', [stepRow.swarm_id])).rows;
      const swRow = (await db.query<SwarmRow>('SELECT * FROM swarms WHERE id=$1', [stepRow.swarm_id])).rows[0];
      if (swRow) {
        const derived = deriveSwarmStatus(swSteps, Boolean(swRow.closed_at), swRow.status === 'cancelled');
        await db.query('UPDATE swarms SET status=$1, version=version+1, updated_at=clock_timestamp() WHERE id=$2', [derived, swRow.id]);
        await event(db, p, swRow.scope, 'swarm.updated', swRow.id, { swarm_id: swRow.id, status: derived });
        const cardMsg = (await db.query<{ id: string; seq: string }>(
          `SELECT id, seq FROM messages WHERE thread_id=$1 AND kind='swarm' AND (ref->>'swarm_id')=$2 ORDER BY seq DESC LIMIT 1`,
          [swRow.thread_id, swRow.id]
        )).rows[0];
        if (cardMsg) {
          await event(db, p, swRow.scope, 'message.updated', cardMsg.id, {
            thread_id: swRow.thread_id,
            message_id: cardMsg.id,
            seq: Number(cardMsg.seq),
            kind: 'swarm',
            ref: { swarm_id: swRow.id }
          });
        }
      }
    }
  }
  await taskChanged(db,p,next,'cancelled',advance);
  return next;
}

export class TaskService {
  private readonly swarms: SwarmsService;
  constructor(private readonly pool:Pool, swarms?: SwarmsService) {
    this.swarms = swarms ?? new SwarmsService(pool);
  }

  async submit(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['scope','kind','objective','idempotency_key','required_capability','resource_key','base_ref','constraints','acceptance_criteria','context_refs','max_attempts','model','effort','exclude_providers','watch_session']);
    const scope = scopeName(input.scope);
    assertKnownScope(p,scope);
    const kind = enumValue(input.kind,'kind',TASK_KINDS);
    const objective = string(input.objective,'objective',16000);
    requireCondition(Buffer.byteLength(objective)<=32768,400,'invalid_arguments','objective exceeds 32 KiB in UTF-8.');
    const idempotency = string(input.idempotency_key,'idempotency_key',200);
    const capability = string(input.required_capability,'required_capability',128);
    requireCondition((VALID_CAPABILITIES as readonly string[]).includes(capability),400,'unknown_capability',`Unknown required_capability. Valid: ${VALID_CAPABILITIES.join(', ')}.`);
    const resource = optionalString(input.resource_key,'resource_key',240) ?? null;
    requireCondition(capability !== AUTO_READ || kind !== 'patch',400,'invalid_arguments','auto.read routes review and research work; use auto.patch or <provider>.patch for patch tasks.');
    requireCondition(capability !== AUTO_PATCH || kind === 'patch',400,'invalid_arguments','auto.patch routes patch work; use auto.read for review and research tasks.');
    requireCondition(!capability.endsWith('.patch') || kind === 'patch',400,'invalid_arguments',`${capability} takes patch tasks only; use a .read capability for ${kind}.`);
    requireCondition(!capability.endsWith('.read') || kind !== 'patch',400,'invalid_arguments',`${capability} is read-only; use auto.patch or <provider>.patch for patch tasks.`);
    const baseRef = optionalString(input.base_ref,'base_ref',200) ?? null;
    requireCondition(baseRef === null || kind === 'patch',400,'invalid_arguments','base_ref applies to patch tasks only.');
    requireCondition(baseRef === null || (/^[A-Za-z0-9._\/-]+$/u.test(baseRef) && !baseRef.startsWith('-') && !baseRef.includes('..')),400,'invalid_arguments','base_ref must be a git ref using letters, digits, . _ / - with no leading - and no "..".');
    const constraints = input.constraints === undefined ? [] : strings(input.constraints,'constraints',30,1000);
    const acceptance = input.acceptance_criteria === undefined ? [] : strings(input.acceptance_criteria,'acceptance_criteria',30,1000);
    const refs = uuidArray(input.context_refs,'context_refs');
    const attempts = input.max_attempts === undefined ? 3 : integer(input.max_attempts,'max_attempts',1,10);
    const model = optionalString(input.model,'model',80) ?? null;
    requireCondition(model === null || /^[A-Za-z0-9._:\/-]+$/u.test(model),400,'invalid_arguments','model must be a model name such as gpt-6-astra.');
    const effort = input.effort === undefined ? null : enumValue(input.effort,'effort',['minimal','low','medium','high','xhigh','max'] as const);
    const namedProvider = capability === AUTO_READ || capability === AUTO_PATCH ? null : capability.slice(0, capability.lastIndexOf('.'));
    validateModelAndEffort(namedProvider, model, effort);
    const watchSession = input.watch_session === undefined ? null : inboxSession(input.watch_session);
    if (watchSession) requirePermission(p, 'events:read');
    const exclude = input.exclude_providers === undefined ? [] : [...new Set(strings(input.exclude_providers,'exclude_providers',8,40))].sort();
    requireCondition(exclude.every(x => /^[a-z][a-z0-9-]{0,39}$/u.test(x)),400,'invalid_arguments','exclude_providers holds provider names such as claude, codex or antigravity.');
    requireCondition(!exclude.length || capability === AUTO_READ || capability === AUTO_PATCH,400,'invalid_arguments','exclude_providers applies to auto.read and auto.patch only; a named provider already picks who runs it.');
    const runner = model || effort ? { runner:{ ...(model ? {model} : {}), ...(effort ? {effort} : {}) } } : {};
    const envelope = { read_project:true, local_patch:kind === 'patch', external_side_effects:false,
      deploy:false, publish:false, send_messages:false, purchase:false, permission_changes:false, ...runner };
    const requestHash = sha256(canonicalJson({scope,kind,objective,capability,resource,constraints,base_ref:baseRef,acceptance,refs,max_attempts:attempts,model,effort,...(exclude.length ? {exclude} : {})}));
    return transaction(this.pool,async db => {
      // The idempotency namespace spans scopes so moving a retry cannot duplicate work.
      await scopeLock(db,'submission',p,'',`${p.id}:${idempotency}`);
      const existing = await db.query<TaskRow>('SELECT * FROM tasks WHERE tenant_id=$1 AND created_by=$2 AND idempotency_key=$3',[p.tenantId,p.id,idempotency]);
      if (existing.rows[0]) {
        requireCondition(existing.rows[0].request_hash === requestHash,409,'idempotency_conflict','This idempotency key was used for different task inputs.');
        if (watchSession) {
          await bindSession(db, p, watchSession);
          const exists = await db.query('SELECT 1 FROM task_watchers WHERE task_id=$1 AND principal_id=$2 AND session=$3',[existing.rows[0].id,p.id,watchSession]);
          const wCount = await db.query('SELECT count(*)::int AS n FROM task_watchers WHERE task_id=$1',[existing.rows[0].id]);
          requireCondition(exists.rowCount || wCount.rows[0].n<128,429,'watch_limit','This task has reached its watcher limit.');
          await db.query('INSERT INTO task_watchers(task_id,principal_id,session) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[existing.rows[0].id,p.id,watchSession]);
          await taskFinished(db, p, existing.rows[0]);
        }
        return {task:await taskWithInstructions(db,existing.rows[0]),replayed:true,...(watchSession ? {watching:true} : {})};
      }
      if ((capability.endsWith('.read') && capability !== AUTO_READ) || (capability.endsWith('.patch') && capability !== AUTO_PATCH)) {
        const {policy} = await getPolicy(db,p.tenantId);
        const provider = capability.slice(0,capability.lastIndexOf('.'));
        const entry = policy.providers.find(x => x.provider === provider);
        requireCondition(!entry || entry.enabled,400,'provider_disabled',`${capability} is disabled by the owner's routing policy. Use ${kind === 'patch' ? 'auto.patch' : 'auto.read'} or another provider.`);
        requireCondition(policyAllows(policy,provider,kind),400,'kind_not_allowed',
          `${provider} does not take ${kind} tasks under the owner's routing policy. Use ${kind === 'patch' ? 'auto.patch' : 'auto.read'} or another provider.`);
      }
      if (exclude.length) {
        const {policy} = await getPolicy(db,p.tenantId);
        requireCondition(policy.providers.some(x => x.enabled && (x.kinds as string[]).includes(kind) && !exclude.includes(x.provider)),400,'no_provider',
          `Every provider that takes ${kind} tasks is excluded or disabled, so this task could never run.`);
      }
      await scopeLock(db,'tasks',p,scope);
      const count = await db.query<{count:string}>(`SELECT count(*)::text AS count FROM tasks
        WHERE tenant_id=$1 AND scope=$2 AND status IN ('queued','running','blocked')`,[p.tenantId,scope]);
      requireCondition(Number(count.rows[0]?.count ?? 0)<1000,429,'queue_full','Scope already has 1000 open tasks; finish or cancel existing work first.');
      // FOR SHARE prevents retraction between the validation and creation of structured references.
      const memories = await db.query<{id:string;version:number}>(`SELECT id,version FROM memories WHERE tenant_id=$1
        AND scope=$2 AND id=ANY($3::uuid[]) AND status<>'retracted' FOR SHARE`,[p.tenantId,scope,refs]);
      requireCondition(memories.rows.length === refs.length,400,'invalid_context_refs','All context_refs must identify non-retracted records in this task scope.');
      const versions = Object.fromEntries(memories.rows.map(m => [m.id,m.version]));
      const result = await db.query<TaskRow>(`INSERT INTO tasks
        (id,tenant_id,scope,kind,objective,constraints,acceptance_criteria,permission_envelope,required_capability,
         resource_key,base_ref,context_refs,context_versions,status,created_by,idempotency_key,request_hash,max_attempts,excluded_providers)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$17,$11::uuid[],$12::jsonb,'queued',$13,$14,$15,$16,$18::text[]) RETURNING *`,
      [newId(),p.tenantId,scope,kind,objective,JSON.stringify(constraints),JSON.stringify(acceptance),JSON.stringify(envelope),
        capability,resource,refs,JSON.stringify(versions),p.id,idempotency,requestHash,attempts,baseRef,exclude]);
      const row = result.rows[0]!;
      if (watchSession) {
        await bindSession(db, p, watchSession);
        await db.query('INSERT INTO task_watchers(task_id,principal_id,session) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[row.id,p.id,watchSession]);
      }
      await taskChanged(db,p,row,'submitted');
      // Say so now rather than let the task sit unclaimed: no live worker serves this project.
      const served = await db.query<{workers:number;free:number}>(`SELECT count(*)::int AS workers,
          coalesce(sum(greatest(coalesce(w.worker_slots,1)-(SELECT count(*) FROM tasks t WHERE t.lease_owner=w.id AND t.status='running'),0)),0)::int AS free
        FROM principals w WHERE w.tenant_id=$1 AND w.role='worker' AND NOT w.disabled
        AND $2=ANY(w.scopes) AND w.last_seen_at>clock_timestamp()-interval '60 seconds'`,[p.tenantId,scope]);
      const {workers,free} = served.rows[0] ?? {workers:0,free:0};
      if (!workers) return {task:await taskWithInstructions(db,row),replayed:false,...(watchSession ? {watching:true} : {}),
        warning:`No live worker serves ${scope}, so this task will wait in the queue. Start a worker for this project or submit it to a project a worker serves.`};
      // Acknowledge to the submitting agent, in words it can relay to the user.
      const message = `Swarm started: task ${row.id.slice(0,8)} is queued in ${scope}. ${workers} live worker${workers===1?'':'s'} with ${free} free slot${free===1?'':'s'} serve it, so it ${free ? 'should start within seconds' : 'will start when a slot frees up'}. Follow it with events_poll on ${scope} (claimed, then finished; start after 0.0 and pass next_cursor unchanged) or task_get.`;
      return {task:await taskWithInstructions(db,row),replayed:false,...(watchSession ? {watching:true} : {}),message};
    });
  }

  async get(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['task_id','session']);
    const id = uuid(input.task_id,'task_id');
    const session = input.session===undefined ? '' : inboxSession(input.session);
    return transaction(this.pool,async db => {
      const row = await findTask(db,p,id);
      await readTaskInbox(db,p,id,session);
      return {task:await taskWithInstructions(db,row)};
    });
  }

  async list(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['scope','status','limit','before_id','resolved','initiator_kind']);
    const scope = scopeName(input.scope);
    assertKnownScope(p,scope);
    const status = input.status === undefined ? null : enumValue(input.status,'status',TASK_STATUSES);
    const limit = input.limit === undefined ? 20 : integer(input.limit,'limit',1,100);
    const before = input.before_id === undefined ? null : uuid(input.before_id,'before_id');
    const resolved = input.resolved !== undefined ? booleanOption(input.resolved,'resolved') : null;
    const initiatorKind = input.initiator_kind !== undefined ? enumValue(input.initiator_kind,'initiator_kind',['person','agent','handoff','swarm','answer','flow','schedule','bot_check','source'] as const) : null;
    let beforeDate:Date|null = null;
    if (before) {
      const cursor = await this.pool.query<{created_at:Date}>('SELECT created_at FROM tasks WHERE id=$1 AND tenant_id=$2 AND scope=$3',[before,p.tenantId,scope]);
      beforeDate = requireFound(cursor.rows[0],'Task cursor').created_at;
    }
    // Project the list view in SQL. partial_output / partial_text and the full result stay out of the
    // driver; task_get and claim still read the whole row.
    const result = await this.pool.query<TaskRow>(`SELECT id, scope, kind, left(objective, 300) AS objective,
      constraints, acceptance_criteria, permission_envelope, required_capability, resource_key, base_ref,
      context_refs, context_versions, status, version, created_by, attempt_count, max_attempts,
      continuation_count, lease_generation, lease_owner, lease_expires_at,
      CASE WHEN checkpoint IS NULL THEN NULL ELSE (checkpoint - 'partial_output' - 'partial_text' - 'activity') END AS checkpoint,
      CASE WHEN result IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
        'answer', left(result->>'answer', 500),
        'branch', result->'branch',
        'changed_files', result->'changed_files',
        'served', result->'served',
        'failure', result->'failure',
        'check', result->'check',
        'summary', result->'summary',
        'review_required', result->'review_required')) END AS result,
      artifact_ids, excluded_providers, not_before, created_at, updated_at, completed_at,
      flow_id, flow, bot_id, agent_id, thread_id, swarm_step_id, initiator_kind, initiator_id, resolved_at
      FROM tasks WHERE tenant_id=$1 AND scope=$2
      AND ($3::text IS NULL OR status=$3)
      AND ($4::boolean IS NULL OR (CASE WHEN $4 THEN resolved_at IS NOT NULL ELSE resolved_at IS NULL END))
      AND ($5::text IS NULL OR initiator_kind=$5)
      AND ($6::timestamptz IS NULL OR (created_at,id)<($6::timestamptz,$7::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $8`,[p.tenantId,scope,status,resolved,initiatorKind,beforeDate,before,limit+1]);
    const rows = result.rows.slice(0,limit);
    return {tasks:rows.map(taskListView),next_before_id:result.rows.length>limit ? rows.at(-1)!.id : null};
  }

  async continue(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['task_id','expected_version','instruction','idempotency_key']);
    const id = uuid(input.task_id,'task_id');
    const expected = expectedVersion(input.expected_version);
    const instruction = string(input.instruction,'instruction',16000);
    requireCondition(Buffer.byteLength(instruction)<=32768,400,'invalid_arguments','instruction exceeds 32 KiB in UTF-8.');
    const key = string(input.idempotency_key,'idempotency_key',200);
    const requestHash = sha256(canonicalJson({instruction,expected_version:expected}));
    return transaction(this.pool,async db => {
      const row = await lockedTask(db,p,id,true);
      const existing = await db.query<{request_hash:string}>(`SELECT request_hash FROM task_instructions
        WHERE task_id=$1 AND actor_id=$2 AND idempotency_key=$3`,[id,p.id,key]);
      if (existing.rows[0]) {
        requireCondition(existing.rows[0].request_hash === requestHash,409,'idempotency_conflict','This key was used for a different continuation.');
        return {task:await taskWithInstructions(db,row),replayed:true};
      }
      requireCondition(!row.flow_id,409,'flow_managed_task','Flow steps are immutable; start a new flow to retry or change work.');
      requireCondition(row.version === expected,409,'version_conflict','Task changed; read it before appending a continuation.');
      return this.continueInternal(db,p,row,instruction,key,requestHash);
    });
  }

  async continueInternal(
    db: PoolClient,
    p: Principal,
    row: TaskRow,
    instruction: string,
    idempotencyKey: string,
    requestHash: string
  ): Promise<{ task: Record<string, unknown>; replayed: boolean }> {
    requireCondition(row.continuation_count<20,409,'continuation_limit','A task permits at most 20 continuations; create a new bounded task.');
    if (['completed','failed','cancelled'].includes(row.status)) {
      const count = await db.query<{count:string}>(`SELECT count(*)::text AS count FROM tasks
        WHERE tenant_id=$1 AND scope=$2 AND status IN ('queued','running','blocked')`,[p.tenantId,row.scope]);
      requireCondition(Number(count.rows[0]?.count ?? 0)<1000,429,'queue_full','Scope already has 1000 open tasks; finish or cancel existing work first.');
    }
    if (row.status === 'running') {
      const time = await db.query<{live:boolean}>('SELECT $1::timestamptz>clock_timestamp() AS live',[row.lease_expires_at]);
      requireCondition(!time.rows[0]?.live,409,'task_running','Wait for the current run or cancel it before continuing.');
      await db.query(`UPDATE task_runs SET status='abandoned',ended_at=clock_timestamp() WHERE task_id=$1 AND generation=$2 AND status='running'`,[row.id,row.lease_generation]);
    }
    await retireResource(db,row);
    await db.query(`INSERT INTO task_instructions (id,task_id,actor_id,idempotency_key,request_hash,instruction)
      VALUES ($1,$2,$3,$4,$5,$6)`,[newId(),row.id,p.id,idempotencyKey,requestHash,instruction]);
    const updated = await db.query<TaskRow>(`UPDATE tasks SET status='queued',version=version+1,
      continuation_count=continuation_count+1,attempt_count=0,lease_generation=lease_generation+1,
      lease_owner=NULL,lease_hash=NULL,lease_expires_at=NULL,completed_at=NULL,updated_at=clock_timestamp()
      WHERE id=$1 RETURNING *`,[row.id]);
    const next = updated.rows[0]!;
    await taskChanged(db,p,next,'continued');
    return {task:await taskWithInstructions(db,next),replayed:false};
  }

  async claim(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['scope','capabilities','kinds','projects','lease_seconds','limit']);
    worker(p);
    requireCondition((input.scope !== undefined) !== (input.projects !== undefined),400,'invalid_arguments','Give exactly one of scope or projects.');
    if (input.projects !== undefined) {
      requireCondition(input.capabilities === undefined && input.kinds === undefined,400,'invalid_arguments','Use per-project capabilities and kinds.');
      requireCondition(Array.isArray(input.projects) && input.projects.length>0 && input.projects.length<=64,400,'invalid_arguments','projects must contain one to 64 entries.');
    }
    const projects = (input.projects === undefined ? [{scope:input.scope,capabilities:input.capabilities,kinds:input.kinds}] : input.projects as unknown[]).map(value => {
      const entry = object(value);
      noExtraKeys(entry,['scope','capabilities','kinds']);
      const scope = scopeName(entry.scope);
      assertKnownScope(p,scope);
      const capabilities = strings(entry.capabilities,'capabilities',30,128);
      requireCondition(capabilities.length>0,400,'invalid_arguments','At least one capability is required.');
      let kinds:TaskKind[] = ['research','review'];
      if (entry.kinds !== undefined) {
        requireCondition(Array.isArray(entry.kinds) && entry.kinds.length>0 && entry.kinds.length<=5,400,'invalid_arguments','kinds must contain one to five supported task kinds.');
        kinds = [...new Set(entry.kinds.map(v => enumValue(v,'kinds',[...TASK_KINDS,'check','turn'] as const)))];
      }
      const wantsPatch = kinds.includes('patch') || kinds.includes('check') || capabilities.some(c => c.endsWith('.patch'));
      requireCondition(!wantsPatch || hasPermission(p,'task:patch'),403,'forbidden','Claiming patch/check work requires the task:patch permission.');
      return {scope,capabilities,kinds};
    });
    const seconds = leaseSeconds(input.lease_seconds);
    const batchMode = input.limit !== undefined;
    const maxClaims = batchMode ? integer(input.limit,'limit',1,16) : 1;
    // One liveness write per call, then one cheap query so idle scopes skip the locked per-scope transaction.
    await touchWorker(this.pool,p);
    const ready = new Set((await this.pool.query<{scope:string}>(`SELECT x.scope FROM jsonb_to_recordset($2::jsonb)
      AS x(scope text,capabilities text[],kinds text[]) WHERE
      EXISTS (SELECT 1 FROM tasks t WHERE t.tenant_id=$1 AND t.scope=x.scope AND t.status='queued'
        AND (t.not_before IS NULL OR t.not_before<=clock_timestamp()) AND t.attempt_count<t.max_attempts
        AND (t.required_capability=ANY(x.capabilities) OR t.required_capability LIKE 'antigravity.%') AND (
          (t.kind<>'turn' AND t.kind=ANY(x.kinds))
          OR (t.kind='turn' AND (
            (NOT t.required_capability LIKE '%.patch' AND ('turn'=ANY(x.kinds) OR x.kinds && ARRAY['research','review']::text[]))
            OR (t.required_capability LIKE '%.patch' AND 'patch'=ANY(x.kinds))))))
      OR EXISTS (SELECT 1 FROM tasks t WHERE t.tenant_id=$1 AND t.scope=x.scope AND t.status='running' AND t.lease_expires_at<=clock_timestamp())
      OR EXISTS (SELECT 1 FROM questions q WHERE q.tenant_id=$1 AND q.scope=x.scope AND q.status='open' AND q.expires_at<=clock_timestamp())`,
      [p.tenantId,JSON.stringify(projects)])).rows.map(r => r.scope));
    const claimed: Array<{ task: Record<string, unknown>; lease_token: string; lease_generation: number; route?: { provider: string | null; allowed: string[] } }> = [];
    for (const {scope,capabilities,kinds} of projects) {
      if (!ready.has(scope)) continue;
      const remaining = maxClaims - claimed.length;
      if (remaining <= 0) break;
      const batch = await this.claimScope(p,scope,capabilities,kinds,seconds,remaining);
      claimed.push(...batch);
      if (claimed.length >= maxClaims) break;
    }
    if (batchMode) {
      const first = claimed[0];
      return {
        tasks: claimed,
        task: first?.task ?? null,
        ...(first ? { lease_token: first.lease_token, lease_generation: first.lease_generation, ...(first.route ? { route: first.route } : {}) } : {}),
      };
    }
    return claimed[0] ?? {task:null};
  }

  private async claimScope(p:Principal,scope:string,capabilities:string[],kinds:TaskKind[],seconds:number,limit=1) {
    return transaction(this.pool,async db => {
      await scopeLock(db,'tasks',p,scope);
      // The owner's routing policy decides, per kind, which provider takes auto.read work; explicit
      // capabilities still obey the policy's enabled flag and allowed kinds.
      const served = workerProviders(capabilities);
      const servedPatch = capabilities.filter(c => c.endsWith('.patch') && c !== AUTO_PATCH).map(c => c.slice(0,-6));
      const {policy} = await getPolicy(db,p.tenantId);
      const usage = await scopeUsage(db,p.tenantId,scope);
      const eligible = (row:TaskRow, taskPolicy=policy):boolean => {
        if (row.kind === 'check') return true;
        const exclusions = row.excluded_providers ?? [];
        const policyForTask = {...taskPolicy, providers:taskPolicy.providers.filter(x => !exclusions.includes(x.provider))};
        if (row.bot_id && row.required_capability.startsWith('auto.') && !policyForTask.providers.some(x => x.enabled && x.kinds.includes(effectiveRoutingKind(row)))) return false;
        const effectiveKind: RoutingKind = effectiveRoutingKind(row);
        const allowsAuto = (provider:string,kind:RoutingKind) => row.bot_id
          ? policyForTask.providers.some(x => x.provider===provider && x.enabled && x.kinds.includes(kind))
          : policyAllows(policyForTask,provider,kind);
        if (row.required_capability === AUTO_PATCH) {
          const d = decide(policyForTask, 'patch', usage);
          if (d.anyone) return servedPatch.some(s => allowsAuto(s,'patch') && !exclusions.includes(s));
          return d.provider !== null && servedPatch.includes(d.provider) && !exclusions.includes(d.provider);
        }
        if (row.required_capability.endsWith('.patch')) {
          const prov = row.required_capability.slice(0, -6);
          return !exclusions.includes(prov) && policyAllows(policy, prov, 'patch');
        }
        if (row.kind === 'patch') return true;
        if (row.required_capability === AUTO_READ) {
          const d = decide(policyForTask, effectiveKind, usage);
          if (d.anyone) return !served.length || served.some(s => allowsAuto(s,effectiveKind) && !exclusions.includes(s));
          return d.provider !== null && served.includes(d.provider) && !exclusions.includes(d.provider);
        }
        const prov = row.required_capability.slice(0, -5);
        return !exclusions.includes(prov) && policyAllows(policy, prov, effectiveKind);
      };
      // Only acquire teamsLock when actually needed for an eligible queued bot/thread candidate,
      // an expired teams task, or a due question (preserving strict scopeLock -> teamsLock -> tasks lock order).
      const needsTeamsLock = await db.query<{ needs_lock: boolean }>(`SELECT (
        EXISTS (SELECT 1 FROM tasks WHERE tenant_id=$1 AND scope=$2 AND status='queued'
          AND (bot_id IS NOT NULL OR thread_id IS NOT NULL OR agent_id IS NOT NULL OR swarm_step_id IS NOT NULL)
          AND (required_capability=ANY($3::text[]) OR required_capability LIKE 'antigravity.%') LIMIT 1)
        OR EXISTS (SELECT 1 FROM tasks WHERE tenant_id=$1 AND scope=$2 AND status='running'
          AND lease_expires_at<=clock_timestamp()
          AND (bot_id IS NOT NULL OR agent_id IS NOT NULL OR swarm_step_id IS NOT NULL) LIMIT 1)
        OR EXISTS (SELECT 1 FROM questions WHERE tenant_id=$1 AND scope=$2 AND status='open'
          AND expires_at<=clock_timestamp() LIMIT 1)
      ) AS needs_lock`,[p.tenantId,scope,capabilities]);
      if (needsTeamsLock.rows[0]?.needs_lock) await teamsLock(db,p.tenantId);
      // Questions past their expiry are expired here and by question_answer, never by a read.
      const dueQuestion = await db.query(`SELECT 1 FROM questions WHERE tenant_id=$1 AND scope=$2 AND status='open'
        AND expires_at<=clock_timestamp() LIMIT 1`,[p.tenantId,scope]);
      if (dueQuestion.rowCount) {
        await this.swarms.expireDueQuestions(db,p,scope);
      }
      await this.sweepExpired(db,p,scope);
      // Skip unconditional UPDATE tasks ... antigravity.% unless a queued antigravity task exists in this scope.
      const hasAgyQueued = await db.query(
        `SELECT 1 FROM tasks WHERE tenant_id=$1 AND scope=$2 AND status='queued' AND required_capability LIKE 'antigravity.%' LIMIT 1`,
        [p.tenantId,scope]
      );
      if (hasAgyQueued.rowCount) {
        // Unattended Antigravity tasks (schedules, webhooks, bot checks) rewrite to auto.<mode> with antigravity
        // excluded (not hardcoded claude) so Codex-only installs keep working; always strip runner model/effort/provider.
        await db.query(`UPDATE tasks t SET
          required_capability='auto.'||split_part(required_capability,'.',2),
          excluded_providers=CASE WHEN 'antigravity'=ANY(excluded_providers) THEN excluded_providers ELSE array_append(excluded_providers,'antigravity') END,
          permission_envelope=permission_envelope #- '{runner,model}' #- '{runner,effort}' #- '{runner,provider}'
          WHERE tenant_id=$1 AND scope=$2 AND status='queued' AND required_capability LIKE 'antigravity.%'
            AND (initiator_kind IN (${UNATTENDED_SQL}) OR 'antigravity'=ANY(excluded_providers))`,[p.tenantId,scope]);
      }
      const candidates = await db.query<TaskRow>(`SELECT * FROM tasks WHERE tenant_id=$1 AND scope=$2 AND status='queued'
        AND (not_before IS NULL OR not_before<=clock_timestamp())
        AND attempt_count<max_attempts AND required_capability=ANY($3::text[])
        AND (
          (kind<>'turn' AND kind=ANY($4::text[]))
          OR (kind='turn' AND (
            (NOT required_capability LIKE '%.patch' AND ('turn'=ANY($4::text[]) OR $4::text[] && ARRAY['research','review']::text[]))
            OR (required_capability LIKE '%.patch' AND 'patch'=ANY($4::text[]))
          ))
        )
        AND kind<>'approve' AND (flow_id IS NULL OR ((flow->>'ready')::boolean
          AND NOT EXISTS (SELECT 1 FROM flow_runs f WHERE f.id=tasks.flow_id AND f.cancelled_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM tasks sibling WHERE sibling.flow_id=tasks.flow_id AND sibling.status IN ('blocked','failed','cancelled'))))
        AND (kind NOT IN ('patch', 'turn') OR NOT EXISTS (SELECT 1 FROM task_resource_leases r WHERE r.tenant_id=tasks.tenant_id
          AND r.scope=tasks.scope AND r.resource_key=tasks.resource_key AND r.expires_at>clock_timestamp()))
        ORDER BY created_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`,[p.tenantId,scope,capabilities,kinds]);
      const botPolicyCache = new Map<string, RoutingPolicy>();
      const claimedBatch: Array<{ task: Record<string, unknown>; lease_token: string; lease_generation: number; route?: { provider: string | null; allowed: string[] } }> = [];
      for (const row of candidates.rows) {
        if (claimedBatch.length >= limit) break;
        // Antigravity runs only work a person started: schedules, webhooks and scheduled checks go to the other providers.
        if (row.initiator_kind && UNATTENDED_INITIATORS.includes(row.initiator_kind) && !(row.excluded_providers ?? []).includes('antigravity'))
          row.excluded_providers = [...(row.excluded_providers ?? []),'antigravity'];
        // Cache taskBotPolicy() by bot_id within this claimScope call.
        let taskPolicy: RoutingPolicy;
        if (row.bot_id && row.required_capability.startsWith('auto.')) {
          const cached = botPolicyCache.get(row.bot_id);
          if (cached) taskPolicy = cached;
          else {
            taskPolicy = await taskBotPolicy(db,p.tenantId,row,policy,usage);
            botPolicyCache.set(row.bot_id, taskPolicy);
          }
        } else {
          taskPolicy = policy;
        }
        let flowProvider:string|undefined;
        if (row.flow && row.kind!=='check') {
          const other = row.flow.different_provider_than ? (await db.query<TaskRow>("SELECT * FROM tasks WHERE flow_id=$1 AND flow->>'step_id'=$2",[row.flow_id,row.flow.different_provider_than])).rows[0] : undefined;
          const otherServed = (other?.result as any)?.served?.provider ?? other?.flow?.provider;
          if (row.flow.different_provider_than && (!other || other.status!=='completed' || !otherServed)) continue;
          const excluded = otherServed;
          const candidates = taskPolicy.providers.filter(x => x.enabled && x.kinds.includes(row.kind as RoutingKind) && x.provider!==excluded && !(row.excluded_providers || []).includes(x.provider));
          const auto = row.required_capability===AUTO_READ || row.required_capability===AUTO_PATCH;
          const d = decideAll({...policy,providers:candidates},usage)[row.kind as RoutingKind];
          const suffix = row.kind==='patch' ? 'patch' : 'read';
          const providers = auto ? (d.anyone ? candidates.map(x => x.provider) : d.provider ? [d.provider] : []) : [row.required_capability.split('.')[0]!];
          flowProvider = providers.find(provider => candidates.some(x => x.provider===provider) && capabilities.includes(`${provider}.${suffix}`));
          if (!flowProvider) continue;
        } else if (!eligible(row,taskPolicy)) continue;
        const generation = row.lease_generation+1;
        if ((row.kind === 'patch' || row.kind === 'turn') && row.resource_key !== null) {
          const resource = await db.query(`INSERT INTO task_resource_leases
            (tenant_id,scope,resource_key,task_id,generation,expires_at)
            VALUES ($1,$2,$3,$4,$5,clock_timestamp()+$6::integer*interval '1 second')
            ON CONFLICT (tenant_id,scope,resource_key) DO UPDATE SET task_id=EXCLUDED.task_id,
              generation=EXCLUDED.generation,expires_at=EXCLUDED.expires_at
            WHERE task_resource_leases.expires_at<=clock_timestamp()
            RETURNING task_id`,[p.tenantId,scope,row.resource_key,row.id,generation,seconds]);
          if (!resource.rowCount) continue;
        }
        const token = randomBytes(32).toString('base64url');
        const hash = sha256(token);
        const updated = await db.query<TaskRow>(`UPDATE tasks SET status='running',version=version+1,
          attempt_count=attempt_count+1,lease_generation=$2,lease_owner=$3,lease_hash=$4,
          lease_expires_at=clock_timestamp()+$5::integer*interval '1 second',updated_at=clock_timestamp(),completed_at=NULL
          WHERE id=$1 RETURNING *`,[row.id,generation,p.id,hash,seconds]);
        const next = updated.rows[0]!;
        if (flowProvider) {
          next.flow = {...next.flow!,provider:flowProvider};
          await db.query('UPDATE tasks SET flow=$2::jsonb WHERE id=$1',[next.id,JSON.stringify(next.flow)]);
        }
        // Use exactly the task's expiry for the resource; the two clocks must not diverge.
        if ((row.kind === 'patch' || row.kind === 'turn') && row.resource_key !== null) {
          await db.query(`UPDATE task_resource_leases SET expires_at=$4
            WHERE tenant_id=$1 AND scope=$2 AND task_id=$3 AND generation=$5`,[p.tenantId,scope,row.id,next.lease_expires_at,generation]);
        }
        await db.query(`INSERT INTO task_runs (id,task_id,generation,worker_id,lease_hash,status)
          VALUES ($1,$2,$3,$4,$5,'running')`,[newId(),row.id,generation,p.id,hash]);
        await taskChanged(db,p,next,'claimed');
        // Bind the router's decision to execution: the bridge may only run what the policy allows for this kind.
        const auto = row.required_capability === AUTO_READ || row.required_capability === AUTO_PATCH;
        const exclusions = row.excluded_providers ?? [];
        const policyForTask = {...taskPolicy,providers:taskPolicy.providers.filter(x => !exclusions.includes(x.provider))};
        const effKind = effectiveRoutingKind(row);
        const d = auto ? decide(policyForTask, effKind, usage) : undefined;
        const allowed = policyForTask.providers.filter(x => x.enabled && (x.kinds as string[]).includes(effKind)).map(x => x.provider);
        const route = flowProvider ? {provider:flowProvider,allowed:[flowProvider]} : auto ? {provider:d?.provider ?? null,allowed} : undefined;
        const baseTask = await taskWithInstructions(db,next);
        let claimTask: Record<string, unknown> = baseTask;
        if (next.kind === 'turn' && next.agent_id && next.thread_id) {
          const aRes = await db.query('SELECT * FROM agents WHERE id=$1', [next.agent_id]);
          const agent = aRes.rows[0] ?? null;
          const window = await getTurnWindow(db, next.thread_id);
          const maxSeq = window.reduce((max, m) => Math.max(max, Number((m as any).seq ?? 0)), 0);
          // Populate live crew / scope agents so leads/routers always see their crew & edit capabilities.
          const memberAgents = (await db.query<{ id: string; name: string; role: string; edits: boolean }>(
            `SELECT a.id, a.name, a.role, a.edits
             FROM thread_members tm
             JOIN agents a ON a.id = tm.agent_id
             WHERE tm.thread_id=$1 AND a.tenant_id=$2 AND NOT a.archived
             ORDER BY a.name ASC`,
            [next.thread_id, p.tenantId]
          )).rows;
          const crewAgents = memberAgents.length > 0
            ? memberAgents
            : (await db.query<{ id: string; name: string; role: string; edits: boolean }>(
                `SELECT id, name, role, edits FROM agents
                 WHERE tenant_id=$1 AND scope=$2 AND NOT archived
                 ORDER BY name ASC`,
                [p.tenantId, next.scope]
              )).rows;
          // Populate native_session_id from agent_provider_sessions for the target provider.
          const sessionProvider = route?.provider
            ?? (next.required_capability.startsWith('auto.') ? null : next.required_capability.split('.')[0]);
          // Unknown provider (auto routing to anyone): send no session id; another provider's id must never be resumed.
          const sessionRow = sessionProvider
            ? (await db.query<{ session_data: unknown }>(
                'SELECT session_data FROM agent_provider_sessions WHERE tenant_id=$1 AND agent_id=$2 AND provider=$3',
                [p.tenantId, next.agent_id, sessionProvider]
              )).rows[0]
            : undefined;
          const rawSession = sessionRow?.session_data as Record<string, unknown> | string | undefined;
          const nativeSessionId = typeof rawSession === 'string'
            ? rawSession
            : (typeof rawSession?.session_id === 'string' ? rawSession.session_id
              : typeof rawSession?.id === 'string' ? rawSession.id
              : typeof rawSession?.thread_id === 'string' ? rawSession.thread_id
              : null);
          const turnExtras = {
            ...(agent ? { agent } : {}),
            agents: crewAgents.map(a => ({ id: a.id, name: a.name, role: a.role, edits: a.edits })),
            ...(nativeSessionId ? { native_session_id: nativeSessionId } : {}),
            thread_messages: window,
          };
          if (maxSeq > 0) {
            const nextVersions = { ...(next.context_versions ?? {}), message_seq: maxSeq };
            await db.query('UPDATE tasks SET context_versions=$2::jsonb WHERE id=$1', [next.id, JSON.stringify(nextVersions)]);
            next.context_versions = nextVersions;
            claimTask = { ...baseTask, ...turnExtras, context_versions: nextVersions };
          } else {
            claimTask = { ...baseTask, ...turnExtras };
          }
        }
        if (next.kind === 'turn' && next.bot_id) {
          // A coordinator bot sees other project bots within the worker's permitted scopes so it can dispatch by name.
          const own = (await db.query<{rules:Record<string,unknown>}>('SELECT rules FROM bots WHERE id=$1',[next.bot_id])).rows[0];
          if (own?.rules?.dispatch_all_projects === true) {
            const [allScopes, grantedScopes] = scopeSql(p);
            const bots = (await db.query<{name:string;scope:string;job:string}>(
              'SELECT name, scope, job FROM bots WHERE tenant_id=$1 AND id<>$2 AND NOT archived AND ($3::boolean OR scope=ANY($4::text[])) ORDER BY name',
              [p.tenantId, next.bot_id, allScopes, grantedScopes]
            )).rows;
            claimTask = {...claimTask, project_bots: bots.map(b => ({name:b.name.trim(),scope:b.scope,job:clipUtf8(b.job ?? '',200)}))};
          }
          if (own?.rules?.local_actions === true) claimTask = {...claimTask, local_actions: true};
        }
        claimedBatch.push({task:claimTask,lease_token:token,lease_generation:generation,...(route ? {route} : {})});
      }
      return claimedBatch;
    });
  }

  /** Server timer entry: reaps expired leases in scopes no worker polls. Same locks and effects as the sweep inside claim. */
  async sweepLeases():Promise<number> {
    const pairs = (await this.pool.query<{tenant_id:string;scope:string;owner:string}>(`SELECT tenant_id,scope,(array_agg(lease_owner))[1] AS owner
      FROM tasks WHERE status='running' AND lease_expires_at<=clock_timestamp()
      GROUP BY tenant_id,scope LIMIT 50`)).rows;
    for (const pair of pairs) {
      // The audit actor is the worker that lost the lease; audit_log.actor_id must reference a principal.
      const p:Principal = {id:pair.owner,tenantId:pair.tenant_id,name:'lease-sweeper',role:'admin',scopes:[pair.scope],permissions:[]};
      await transaction(this.pool,async db => {
        await scopeLock(db,'tasks',p,pair.scope);
        if ((await db.query(`SELECT 1 FROM tasks WHERE tenant_id=$1 AND scope=$2 AND bot_id IS NOT NULL AND status IN ('queued','running') LIMIT 1`,[p.tenantId,pair.scope])).rowCount) await teamsLock(db,p.tenantId);
        await this.sweepExpired(db,p,pair.scope);
      });
    }
    return pairs.length;
  }

  /** Requeues or fails running tasks whose lease expired. The caller holds the scope advisory lock (and teamsLock when bot tasks exist). */
  private async sweepExpired(db:PoolClient,p:Principal,scope:string):Promise<void> {
    // Sweep expired attempts before selection. No process-local retry state is needed after a restart.
    // Agent and step tasks take teamsLock before their row lock, one task at a time.
    const expired = await db.query<{id:string;teams:boolean}>(`SELECT id,(agent_id IS NOT NULL OR swarm_step_id IS NOT NULL) AS teams
      FROM tasks WHERE tenant_id=$1 AND scope=$2 AND status='running'
      AND lease_expires_at<=clock_timestamp() ORDER BY created_at,id`,[p.tenantId,scope]);
    for (const candidate of expired.rows) {
      if (candidate.teams) await teamsLock(db,p.tenantId);
      const row = (await db.query<TaskRow>(`SELECT * FROM tasks WHERE id=$1 AND status='running'
        AND lease_expires_at<=clock_timestamp() FOR UPDATE`,[candidate.id])).rows[0];
      if (!row) continue;
      await db.query(`UPDATE task_runs SET status='abandoned',ended_at=clock_timestamp()
        WHERE task_id=$1 AND generation=$2 AND status='running'`,[row.id,row.lease_generation]);
      await retireResource(db,row);
      const exhausted = row.attempt_count>=row.max_attempts;
      const result = await db.query<TaskRow>(`UPDATE tasks SET status=$2,version=version+1,lease_owner=NULL,
        lease_hash=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),
        result=CASE WHEN $3::boolean THEN $4::jsonb ELSE result END,
        completed_at=CASE WHEN $3::boolean THEN clock_timestamp() ELSE NULL END
        WHERE id=$1 RETURNING *`,[row.id,exhausted ? 'failed':'queued',exhausted,
        JSON.stringify({error:'attempts_exhausted',message:'Worker lease expired after the configured attempt limit.',checkpoint_available:row.checkpoint !== null})]);
      await taskChanged(db,p,result.rows[0]!,exhausted ? 'attempts_exhausted':'lease_expired');
      if (exhausted) {
        await copyReplyToCoordinator(db, p, result.rows[0]!, 'Failed: worker lease expired after attempts exhausted.', 'failed');
      }
      if (exhausted && row.swarm_step_id) {
        await db.query(
          `UPDATE swarm_steps SET status='failed', failure_code='attempts_exhausted', failure_detail='Worker lease expired after the configured attempt limit.', updated_at=clock_timestamp() WHERE id=$1`,
          [row.swarm_step_id]
        );
        const stepRow = (await db.query<{ swarm_id: string }>('SELECT swarm_id FROM swarm_steps WHERE id=$1', [row.swarm_step_id])).rows[0];
        if (stepRow) {
          const swSteps = (await db.query<SwarmStepRow>('SELECT * FROM swarm_steps WHERE swarm_id=$1 ORDER BY id ASC', [stepRow.swarm_id])).rows;
          const swRow = (await db.query<SwarmRow>('SELECT * FROM swarms WHERE id=$1', [stepRow.swarm_id])).rows[0];
          if (swRow) {
            const derived = deriveSwarmStatus(swSteps, Boolean(swRow.closed_at), swRow.status === 'cancelled');
            await db.query('UPDATE swarms SET status=$1, version=version+1, updated_at=clock_timestamp() WHERE id=$2', [derived, swRow.id]);
            await event(db, p, swRow.scope, 'swarm.updated', swRow.id, { swarm_id: swRow.id, status: derived });
            const cardMsg = (await db.query<{ id: string; seq: string }>(
              `SELECT id, seq FROM messages WHERE thread_id=$1 AND kind='swarm' AND (ref->>'swarm_id')=$2 ORDER BY seq DESC LIMIT 1`,
              [swRow.thread_id, swRow.id]
            )).rows[0];
            if (cardMsg) {
              await event(db, p, swRow.scope, 'message.updated', cardMsg.id, {
                thread_id: swRow.thread_id,
                message_id: cardMsg.id,
                seq: Number(cardMsg.seq),
                kind: 'swarm',
                ref: { swarm_id: swRow.id }
              });
            }
          }
        }
      }
    }
  }

  async heartbeat(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['task_id','lease_token','lease_generation','lease_seconds']);
    const lease = leaseInput(input);
    const seconds = leaseSeconds(input.lease_seconds);
    return transaction(this.pool,async db => {
      const row = await findTask(db,p,lease.taskId,true);
      await requireLease(db,p,row,lease);
      await touchWorker(db,p);
      const updated = await db.query<TaskRow>(`UPDATE tasks SET
        lease_expires_at=clock_timestamp()+$2::integer*interval '1 second'
        WHERE id=$1 AND lease_expires_at>clock_timestamp() RETURNING *`,[row.id,seconds]);
      requireCondition(updated.rows[0],409,'lease_lost','Lease expired before renewal.');
      const next = updated.rows[0];
      if ((next.kind === 'patch' || next.kind === 'turn') && next.resource_key !== null) await db.query(`UPDATE task_resource_leases SET expires_at=$4
        WHERE tenant_id=$1 AND scope=$2 AND task_id=$3 AND generation=$5`,[p.tenantId,next.scope,next.id,next.lease_expires_at,next.lease_generation]);
      // Heartbeats do not change semantic versions or emit an event. The bridge only needs the lease
      // fields, so skip the instruction and run history that task_get returns.
      return {task:taskView(next)};
    });
  }

  async checkpoint(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['task_id','lease_token','lease_generation','checkpoint']);
    const lease = leaseInput(input);
    const checkpoint = jsonObject(input.checkpoint,'checkpoint',32768);
    return transaction(this.pool,async db => {
      const row = await findTask(db,p,lease.taskId,true);
      await requireLease(db,p,row,lease);
      // Streaming text is not a new task version: bumping it on every partial would invalidate the
      // caller's expected_version for the whole turn. Other phases still bump.
      const streamingPhase = checkpoint.phase === 'running';
      const updated = await db.query<TaskRow & { should_emit: boolean }>(`UPDATE tasks SET checkpoint=$2::jsonb,
        version=CASE WHEN $3::boolean THEN version ELSE version+1 END,
        updated_at=clock_timestamp(),
        last_checkpoint_event_at=CASE WHEN NOT $3::boolean OR last_checkpoint_event_at IS NULL OR last_checkpoint_event_at<=clock_timestamp()-interval '3 seconds'
          THEN clock_timestamp() ELSE last_checkpoint_event_at END
        WHERE id=$1 AND lease_expires_at>clock_timestamp()
        RETURNING *, (NOT $3::boolean OR $4::timestamptz IS NULL OR $4::timestamptz<=clock_timestamp()-interval '3 seconds') AS should_emit`,
        [row.id,JSON.stringify(checkpoint),streamingPhase,row.last_checkpoint_event_at ?? null]);
      requireCondition(updated.rows[0],409,'lease_lost','Lease expired before checkpoint.');
      const next = updated.rows[0];
      // Chat UIs refetch the thread (typing text is read from the checkpoint column) on task.updated events, so the
      // event stays; it is throttled to one per 3 s per task for streaming 'running' checkpoints. Other phases
      // (starting, provider_finished, or any client-defined one) always emit. Checkpoints are never audited.
      if (next.should_emit) await taskChanged(db,p,next,'checkpointed',true,false);
      // Steering: a bridge running a turn with an open stdin asks for owner messages posted since it started
      // (or since the last one it took). Text only, oldest first; a photo stops the batch so order is kept
      // and the photo waits for the follow-up turn.
      let steer: Array<{seq:number;body:string}> | undefined;
      if (next.kind === 'turn' && next.thread_id && typeof checkpoint.steer_after_seq === 'number' && Number.isSafeInteger(checkpoint.steer_after_seq)) {
        const after = Math.max(checkpoint.steer_after_seq, Number((next.context_versions as {message_seq?:unknown})?.message_seq) || 0);
        const rows = (await db.query<{seq:string;kind:string;body:string;has_photos:boolean}>(`SELECT seq, kind, body,
            has_attachments AS has_photos
          FROM messages WHERE tenant_id=$1 AND thread_id=$2 AND (author->>'kind')='human' AND seq>$3
          ORDER BY seq LIMIT 5`,[p.tenantId,next.thread_id,after])).rows;
        steer = [];
        for (const m of rows) {
          if (m.kind !== 'text' || m.has_photos) break;
          steer.push({seq:Number(m.seq),body:clipUtf8(redactSecrets(m.body),16384)});
        }
      }
      return {task:taskView(next),...(steer?.length ? {steer} : {})};
    });
  }

  /** finish(): validate lease/idempotency -> requeue on provider failure -> record run -> side effects, one transaction. */
  async finish(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['task_id','lease_token','lease_generation','outcome','result','artifact_ids','inline_artifacts']);
    worker(p);
    const lease = leaseInput(input);
    const outcome = enumValue(input.outcome,'outcome',['completed','failed','blocked'] as const);
    const result = jsonObject(input.result,'result',65536);
    const artifactIds = uuidArray(input.artifact_ids,'artifact_ids');
    const inlineArtifacts = parseInlineArtifacts(input.inline_artifacts);
    patchResult(result);
    const out = await transaction(this.pool,async db => {
      const v = await finishValidate(db,p,lease,outcome,result,artifactIds,inlineArtifacts);
      if ('replay' in v) return v.replay;
      const c = v.ctx;
      // Turns this finish spawns inherit "unattended" (migration 049 trigger), so Antigravity never picks them up.
      if (isUnattendedRow(c.row)) await db.query("SELECT set_config('swarmaa.unattended','on',true)");
      const requeued = await finishRequeue(db,p,c);
      if (requeued) return requeued;
      const next = await finishRecord(db,p,c);
      const { replyMsgId, budget } = await this.finishTurnReply(db,p,c);
      if (c.row.kind === 'turn' && c.row.agent_id && c.row.thread_id) await finishFollowUpTurn(db,p,c);
      if (c.row.swarm_step_id) {
        const failureObj = c.result.failure as { code?: string; detail?: string } | undefined;
        await this.swarms.onStepTaskFinished(db, p, c.row.swarm_step_id, c.row.id, c.row.scope, c.outcome, replyMsgId, failureObj, budget);
      }
      // B2 bot hook: follow-ups and check outcomes commit with the fenced result.
      await botTaskFinished(db,p,next);
      // Bots B1: post task card into bot thread on review-ready or failed
      if (c.row.bot_id) await postBotTaskCard(db, p, c.row, c.outcome, c.result);
      await taskChanged(db,p,next,'finished');
      return {task:await taskWithInstructions(db,next),replayed:false};
    });
    // Turn local_action rows run after commit (docs/RING-AGENT.md §5.3); the sweep retries any that do not start.
    if (outcome === 'completed') runOriginActions(this.pool,p.tenantId,'turn',lease.taskId.toLowerCase());
    return out;
  }

  /** Thread reply, native session, turn actions or failure notice for an agent turn. */
  private async finishTurnReply(db:PoolClient,p:Principal,c:FinishCtx):Promise<{replyMsgId?:string;budget?:TurnBudget}> {
    const { row, result, outcome, routerLead, servedProvider } = c;
    if (!(row.kind === 'turn' && row.agent_id && row.thread_id)) return {};
    let replyMsgId: string | undefined;
    const targetThreadId = (result.thread_id as string | undefined) ?? row.thread_id;
    const hop = (row.context_versions as any)?.hop_depth;
    const budget: TurnBudget = { hop: typeof hop === 'number' ? hop : 0, queued: 0, threadId: targetThreadId, scope: row.scope,
      summary: (row.context_versions as any)?.summary === true };
    const threadRow = (await db.query('SELECT * FROM threads WHERE id=$1 AND tenant_id=$2', [targetThreadId, p.tenantId])).rows[0];
    requireCondition(threadRow && (threadRow.agent_id === row.agent_id || ['channel','bot'].includes(threadRow.kind)) && threadRow.scope === row.scope, 403, 'turn_grant_forbidden', 'Turn grant refuses posting to another agent\'s thread.');
    if (['channel','bot'].includes(threadRow.kind)) {
      const isMember = (await db.query<{ count: string }>(
        'SELECT count(*)::int AS count FROM thread_members WHERE thread_id=$1 AND agent_id=$2',
        [targetThreadId, row.agent_id]
      )).rows[0]?.count ?? 0;
      requireCondition(Number(isMember) > 0, 403, 'turn_grant_forbidden', 'Turn grant refuses posting to a channel or bot thread the agent is not a member of.');
    }

    const dispatchedEntries = normalizeDispatchedFrom((row.context_versions as any)?.dispatched_from);
    if (outcome === 'completed') {
      const rawAnswer = [result.answer, result.summary, result.reason].find(v => typeof v === 'string') ?? '';
      const extracted = extractActionsBlock(String(rawAnswer));
      const answer = clipUtf8(redactSecrets(extracted.cleanText), 16384);
      const scheduled = row.bot_id && row.initiator_kind === 'schedule';
      // Models wrap JSON in fences or spaces; any {"quiet": true} as the whole answer counts.
      const quiet = scheduled && /^\s*(?:```(?:json)?\s*)?\{\s*"quiet"\s*:\s*true\s*\}\s*(?:```)?\s*$/u.test(String(rawAnswer));
      const replyText = (Boolean(row.bot_id) && !answer.trim()) ? 'Finished without a summary' : answer;
      if (!quiet) {
        // Defer the schedule notice until there is a reply; quiet runs never touch the thread.
        if (scheduled) await serviceNotice(db, p, row.scope, targetThreadId, 'Scheduled run', false);
        const emptyBotAnswer = Boolean(row.bot_id) && !answer.trim();
        const replyKind = emptyBotAnswer ? 'notice' : 'text';
        const replyAuthor = emptyBotAnswer ? { kind: 'system', id: 'service' } : { kind: 'agent', id: row.agent_id };
        const nextSeq = await assignThreadSeq(db, p.tenantId, targetThreadId);
        replyMsgId = newId();
        await db.query(
          `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $8, $7)`,
          [replyMsgId, p.tenantId, row.scope, targetThreadId, nextSeq, JSON.stringify(replyAuthor),
           replyText, replyKind]
        );
        await event(db, p, row.scope, 'message.created', replyMsgId, {
          thread_id: targetThreadId,
          message_id: replyMsgId,
          seq: Number(nextSeq),
          kind: replyKind,
          author: replyAuthor
        });
      }
      if (result.native_session) {
        await db.query(
          `INSERT INTO agent_provider_sessions (tenant_id, agent_id, provider, session_data, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, clock_timestamp())
           ON CONFLICT (tenant_id, agent_id, provider)
           DO UPDATE SET session_data=EXCLUDED.session_data, updated_at=clock_timestamp()`,
          [p.tenantId, row.agent_id, servedProvider, JSON.stringify(result.native_session)]
        );
      }

      // Process turn actions under turn grant
      let startedSwarm = false;
      const agentRow = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [row.agent_id])).rows[0];
      if (agentRow && threadRow) {
        const currentHop = (row.context_versions as any)?.hop_depth ?? 0;
        const turnCtx: TurnGrantContext = {
          agent: agentRow,
          thread: threadRow as any,
          tenantId: p.tenantId,
          scope: row.scope,
          hopDepth: typeof currentHop === 'number' ? currentHop : 0,
          botId: row.bot_id ?? null,
          leadMode: routerLead ? 'router' : 'default',
          taskId: row.id,
          ...(dispatchedEntries.length > 0 ? { dispatchedFrom: dispatchedEntries } : {}),
        };

        if (extracted.error) {
          await serviceNotice(db, p, row.scope, targetThreadId, clipUtf8(`Turn action rejected: ${extracted.error}`, 16384));
        } else if (extracted.actions && extracted.actions.length > 0) {
          const grant = await validateTurnGrant(db, turnCtx, extracted.actions);
          if (!grant.valid) {
            await serviceNotice(db, p, row.scope, targetThreadId, clipUtf8(`Turn action rejected: ${grant.action.type}: ${grant.reason}`, 16384));
          } else {
            // Summary turns remain reply-only. Appearance targets are locked by validateTurnGrant.
            const actionRes = await this.swarms.applyTurnActions(db, p, turnCtx,
              budget.summary ? extracted.actions : extracted.actions.filter(a => a.type !== 'bot_appearance'), budget);
            startedSwarm = actionRes.startedSwarm;
            // The dispatched bots answer and the fan-in synthesis reports them; a delegated follow-up could only say "no results yet".
            if (extracted.actions.some(a => a.type === 'project_dispatch')) delete result.delegate;
            if (!budget.summary) for (const act of extracted.actions) {
              if (act.type !== 'bot_appearance') continue;
              const updated = (await db.query<{ version: number }>(
                `UPDATE bots SET avatar=CASE WHEN $4 THEN $5 ELSE avatar END,
                   color=CASE WHEN $6 THEN $7 ELSE color END,
                   version=version+1, updated_at=clock_timestamp()
                 WHERE id=$1 AND tenant_id=$2 AND scope=$3 RETURNING version`,
                [row.bot_id, p.tenantId, row.scope, act.avatar !== undefined, act.avatar ?? null,
                 act.color !== undefined, act.color ?? null]
              )).rows[0]!;
              await audit(db, p, row.scope, 'bot.update', row.bot_id!, { reason: 'appearance', version: updated.version });
              await event(db, p, row.scope, 'bot.updated', row.bot_id!, { bot_id: row.bot_id, reason: 'appearance' });
            }
          }
        }
      }

      // Only copy reply back to coordinator(s) when the turn is terminal (not delegating and not just starting a swarm).
      const runnerObj = row.permission_envelope.runner as { delegated?: unknown } | undefined;
      const delegateObj = result.delegate as { objective?: unknown } | undefined;
      const willDelegate = Boolean(
        runnerObj?.delegated !== true && !row.swarm_step_id && !routerLead
        && typeof delegateObj?.objective === 'string' && redactSecrets(delegateObj.objective).trim().length > 0
      );
      if (!quiet && !willDelegate && !startedSwarm && dispatchedEntries.length > 0) {
        await copyReplyToCoordinator(db, p, row, replyText, 'completed');
      }
    } else {
      const failureObj = result.failure as { code?: string; detail?: string } | undefined;
      const failCode = failureObj?.code || 'harness_error';
      const detail = failureObj?.detail || result.summary || failCode;
      const failText = clipUtf8(redactSecrets(`Turn failed: ${failCode} - ${detail}`), 16384);
      await serviceNotice(db, p, row.scope, targetThreadId, failText);
      if (dispatchedEntries.length > 0) {
        await copyReplyToCoordinator(db, p, row, failText, 'failed');
      }
    }
    return { replyMsgId, budget };
  }

  async cancel(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['task_id','expected_version']);
    const id = uuid(input.task_id,'task_id');
    const expected = expectedVersion(input.expected_version);
    return transaction(this.pool,async db => {
      const row = await lockedTask(db,p,id,true);
      requireCondition(row.version === expected,409,'version_conflict','Task changed; read it before cancelling.');
      if (row.status === 'cancelled') return {task:await taskWithInstructions(db,row)};
      const next = await cancelTask(db,p,row);
      return {task:await taskWithInstructions(db,next)};
    });
  }

  async artifactPut(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['task_id','lease_token','lease_generation','name','content','media_type']);
    const lease = leaseInput(input);
    const name = string(input.name,'name',120);
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name) && !name.includes('..'),400,'invalid_arguments','name must be a plain filename beginning with a letter or digit.');
    requireCondition(typeof input.content === 'string' && !input.content.includes('\u0000'),400,'invalid_arguments','content must be a UTF-8 text string without NUL.');
    const content = input.content;
    const bytes = Buffer.byteLength(content,'utf8');
    requireCondition(bytes<=ARTIFACT_MAX_BYTES,400,'artifact_too_large','Artifact exceeds 256 KiB in UTF-8.');
    const mediaType = input.media_type === undefined ? 'text/plain' : enumValue(input.media_type,'media_type',['text/plain','text/markdown','application/json','text/x-diff','application/x-patch'] as const);
    const hash = sha256(content);
    return transaction(this.pool,async db => {
      const row = await lockedTask(db,p,lease.taskId);
      await requireLease(db,p,row,lease);
      const existing = await db.query<ArtifactRow>(`SELECT * FROM artifacts WHERE task_id=$1 AND run_generation=$2 AND name=$3`,[row.id,lease.generation,name]);
      if (existing.rows[0]) {
        requireCondition(existing.rows[0].sha256 === hash && existing.rows[0].media_type === mediaType,409,'artifact_conflict','An artifact with this name already exists with different content.');
        return {artifact:artifactView(existing.rows[0]),replayed:true};
      }
      const count = await db.query<{count:string}>('SELECT count(*)::text AS count FROM artifacts WHERE task_id=$1',[row.id]);
      requireCondition(Number(count.rows[0]?.count ?? 0)<128,409,'artifact_limit','A task permits at most 128 text artifacts across attempts.');
      const inserted = await db.query<ArtifactRow>(`INSERT INTO artifacts
        (id,tenant_id,scope,task_id,run_generation,created_by,name,media_type,content,byte_length,sha256)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11 FROM tasks
        WHERE id=$4 AND lease_expires_at>clock_timestamp() RETURNING *`,
      [newId(),p.tenantId,row.scope,row.id,lease.generation,p.id,name,mediaType,content,bytes,hash]);
      requireCondition(inserted.rows[0],409,'lease_lost','Lease expired before artifact commit.');
      await audit(db,p,row.scope,'artifact.created',inserted.rows[0].id,{task_id:row.id,run_generation:lease.generation,byte_length:bytes,sha256:hash});
      return {artifact:artifactView(inserted.rows[0]),replayed:false};
    });
  }

  async artifactGet(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['artifact_id']);
    const id = uuid(input.artifact_id,'artifact_id');
    const [all,scopes] = scopeSql(p);
    const result = await this.pool.query<ArtifactRow>(`SELECT * FROM artifacts WHERE id=$1 AND tenant_id=$2
      AND ($3::boolean OR scope=ANY($4::text[]))`,[id,p.tenantId,all,scopes]);
    const row = requireFound(result.rows[0],'Artifact');
    return {artifact:{...artifactView(row),content:row.content}};
  }
}

// ---- finish() phases -------------------------------------------------------------------------------------------

interface InlineArtifactInput {
  name: string;
  content: string;
  media_type: 'text/plain' | 'text/markdown' | 'application/json' | 'text/x-diff' | 'application/x-patch';
  bytes: number;
  sha256: string;
}

function parseInlineArtifacts(raw: unknown): InlineArtifactInput[] {
  if (raw === undefined) return [];
  requireCondition(Array.isArray(raw) && raw.length <= 16, 400, 'invalid_arguments', 'inline_artifacts must be an array of at most 16 items.');
  const seenNames = new Set<string>();
  return raw.map(item => {
    const obj = object(item);
    noExtraKeys(obj, ['name', 'content', 'media_type']);
    const name = string(obj.name, 'inline_artifacts[].name', 120);
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name) && !name.includes('..'), 400, 'invalid_arguments', 'inline_artifacts[].name must be a plain filename beginning with a letter or digit.');
    requireCondition(!seenNames.has(name), 400, 'invalid_arguments', `Duplicate inline artifact name: ${name}.`);
    seenNames.add(name);
    requireCondition(typeof obj.content === 'string' && !obj.content.includes('\u0000'), 400, 'invalid_arguments', 'inline_artifacts[].content must be a UTF-8 text string without NUL.');
    const content = obj.content;
    const bytes = Buffer.byteLength(content, 'utf8');
    requireCondition(bytes <= ARTIFACT_MAX_BYTES, 400, 'artifact_too_large', 'Inline artifact exceeds 256 KiB in UTF-8.');
    const media_type = obj.media_type === undefined ? 'text/plain' : enumValue(obj.media_type, 'media_type', ['text/plain', 'text/markdown', 'application/json', 'text/x-diff', 'application/x-patch'] as const);
    return { name, content, media_type, bytes, sha256: sha256(content) };
  });
}

type FinishOutcome = 'completed'|'failed'|'blocked';
interface FinishBot { id: string; routing: Record<string, unknown>; rules: Record<string, unknown>; lead_agent_id: string }
interface FinishCtx {
  row:TaskRow; lease:LeaseInput; outcome:FinishOutcome; result:Record<string,unknown>; artifactIds:string[];
  completionHash:string; bot?:FinishBot; routerLead:boolean; servedProvider:string;
}

/** Phase 1: lock, fence the lease, replay by completion_hash, validate flow/artifacts (including inline_artifacts). */
async function finishValidate(
  db:PoolClient,
  p:Principal,
  lease:LeaseInput,
  outcomeIn:FinishOutcome,
  result:Record<string,unknown>,
  artifactIds:string[],
  inlineArtifacts:InlineArtifactInput[] = []
): Promise<{replay:unknown}|{ctx:FinishCtx}> {
  let outcome = outcomeIn;
  const row = await lockedTask(db,p,lease.taskId,true);
  const runResult = await db.query<RunRow>('SELECT * FROM task_runs WHERE task_id=$1 AND generation=$2 FOR UPDATE',[row.id,lease.generation]);
  const run = runResult.rows[0];
  requireCondition(run && run.worker_id === p.id && sameHash(run.lease_hash,sha256(lease.token)),409,'lease_lost','This connection does not own that execution attempt.');
  const bot = row.bot_id
    ? (await db.query<FinishBot>('SELECT id, routing, rules, lead_agent_id FROM bots WHERE id=$1 AND tenant_id=$2 AND NOT archived',
        [row.bot_id, p.tenantId])).rows[0]
    : undefined;
  const routerLead = Boolean(bot && bot.rules.lead_mode === 'router' && bot.lead_agent_id === row.agent_id);
  const isRouterTurn = (row.permission_envelope?.runner as any)?.router === true || routerLead;
  if (isRouterTurn && (result.changed_files !== undefined || result.branch !== undefined)) {
    outcome = 'failed';
    result.failure = { code: 'router_edit_forbidden', retry: false, detail: 'Router lead turns cannot edit files or create branches.' };
  }

  // Handle idempotent replay before requireLease (a completed run no longer holds a live lease).
  if (run.completion_hash !== null) {
    const replayArtifactIds = [...artifactIds];
    if (inlineArtifacts.length > 0) {
      const existingRows = (await db.query<ArtifactRow>(
        'SELECT * FROM artifacts WHERE task_id=$1 AND run_generation=$2 AND name=ANY($3::text[])',
        [row.id, lease.generation, inlineArtifacts.map(a => a.name)]
      )).rows;
      const byName = new Map(existingRows.map(a => [a.name, a]));
      for (const art of inlineArtifacts) {
        const ex = byName.get(art.name);
        requireCondition(ex && ex.sha256 === art.sha256 && ex.media_type === art.media_type, 409, 'completion_conflict', 'This run already finished with different result content.');
        replayArtifactIds.push(ex.id);
      }
    }
    const replayHash = sha256(canonicalJson({outcome,result_json:canonicalJson(result),artifact_ids:[...new Set(replayArtifactIds)].sort()}));
    requireCondition(run.completion_hash === replayHash,409,'completion_conflict','This run already finished with different result content.');
    return {replay:{task:await taskWithInstructions(db,row),replayed:true}};
  }

  await requireLease(db,p,row,lease);
  validateFlowCompletion(row,outcome,result);
  if (row.flow?.different_provider_than) {
    const other = (await db.query<TaskRow>("SELECT * FROM tasks WHERE flow_id=$1 AND flow->>'step_id'=$2",[row.flow_id,row.flow.different_provider_than])).rows[0];
    const otherServed = (other?.result as any)?.served?.provider ?? other?.flow?.provider;
    const currentServed = (result.served as any)?.provider ?? result.provider;
    requireCondition(!otherServed || currentServed !== otherServed, 409, 'flow_provider_mismatch', 'Step ran on the same provider as the step it must differ from.');
  }
  if (artifactIds.length > 0) {
    const artifacts = await db.query<{id:string}>(`SELECT id FROM artifacts WHERE tenant_id=$1 AND scope=$2
      AND task_id=$3 AND run_generation=$4 AND id=ANY($5::uuid[])`,[p.tenantId,row.scope,row.id,lease.generation,artifactIds]);
    requireCondition(artifacts.rows.length === artifactIds.length,400,'invalid_artifacts','Each artifact must belong to this task execution attempt.');
  }
  const mergedArtifactIds = [...artifactIds];
  if (inlineArtifacts.length > 0) {
    requireCondition(hasPermission(p, 'artifact:write'), 403, 'forbidden', 'Saving inline_artifacts requires artifact:write permission.');
    const countRes = await db.query<{count:string}>('SELECT count(*)::text AS count FROM artifacts WHERE task_id=$1',[row.id]);
    let currentCount = Number(countRes.rows[0]?.count ?? 0);
    for (const art of inlineArtifacts) {
      const existing = await db.query<ArtifactRow>(
        'SELECT * FROM artifacts WHERE task_id=$1 AND run_generation=$2 AND name=$3',
        [row.id, lease.generation, art.name]
      );
      if (existing.rows[0]) {
        requireCondition(existing.rows[0].sha256 === art.sha256 && existing.rows[0].media_type === art.media_type, 409, 'artifact_conflict', 'An artifact with this name already exists with different content.');
        mergedArtifactIds.push(existing.rows[0].id);
      } else {
        requireCondition(currentCount < 128, 409, 'artifact_limit', 'A task permits at most 128 text artifacts across attempts.');
        const inserted = await db.query<ArtifactRow>(`INSERT INTO artifacts
          (id,tenant_id,scope,task_id,run_generation,created_by,name,media_type,content,byte_length,sha256)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11 FROM tasks
          WHERE id=$4 AND lease_expires_at>clock_timestamp() RETURNING *`,
        [newId(),p.tenantId,row.scope,row.id,lease.generation,p.id,art.name,art.media_type,art.content,art.bytes,art.sha256]);
        requireCondition(inserted.rows[0],409,'lease_lost','Lease expired before artifact commit.');
        currentCount++;
        await audit(db,p,row.scope,'artifact.created',inserted.rows[0].id,{task_id:row.id,run_generation:lease.generation,byte_length:art.bytes,sha256:art.sha256});
        mergedArtifactIds.push(inserted.rows[0].id);
      }
    }
  }
  const finalArtifactIds = [...new Set(mergedArtifactIds)];
  const completionHash = sha256(canonicalJson({outcome,result_json:canonicalJson(result),artifact_ids:[...finalArtifactIds].sort()}));
  const servedProvider = (result.served as any)?.provider || (result.provider as string) || row.required_capability.split('.')[0]!;
  return {ctx:{row,lease,outcome,result,artifactIds:finalArtifactIds,completionHash,bot,routerLead,servedProvider}};
}

/** Requeue the task with the failed run recorded. Differences between callers: `exclusions` replaces
 * excluded_providers (no delay); `backoffSec` delays not_before (providers untouched). Fenced on the live lease. */
async function requeue(db:PoolClient,p:Principal,c:FinishCtx,change:{exclusions:string[]}|{backoffSec:number}):Promise<TaskRow> {
  const set = 'exclusions' in change
    ? 'excluded_providers=$3::text[]'
    : "not_before=clock_timestamp()+$3::integer*interval '1 second'";
  const updated = await db.query<TaskRow>(`UPDATE tasks SET status='queued',result=$2::jsonb,${set},artifact_ids=$4::uuid[],
    version=version+1,lease_owner=NULL,lease_hash=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),completed_at=NULL
    WHERE id=$1 AND lease_expires_at>clock_timestamp() RETURNING *`,
  [c.row.id, JSON.stringify(c.result), 'exclusions' in change ? change.exclusions : change.backoffSec, c.artifactIds]);
  requireCondition(updated.rows[0], 409, 'lease_lost', 'Lease expired before result commit.');
  await db.query(`UPDATE task_runs SET status='failed',completion_hash=$3,result=$4::jsonb,artifact_ids=$5::uuid[],ended_at=clock_timestamp()
    WHERE task_id=$1 AND generation=$2`, [c.row.id, c.lease.generation, c.completionHash, JSON.stringify(c.result), c.artifactIds]);
  await releaseResource(db, c.row);
  const next = updated.rows[0]!;
  await taskChanged(db, p, next, 'requeued');
  return next;
}

/** Exclude the served provider and requeue on another one. Returns undefined (after rewriting `result` as a terminal
 * quota_exhausted failure) when no enabled provider with headroom remains. `candidateKind` is the kind used to list
 * candidate providers (quota_exhausted historically used row.kind, provider_error the routing kind). */
async function requeueOnOtherProvider(db:PoolClient,p:Principal,c:FinishCtx,reason:'quota_exhausted'|'provider_error',candidateKind:string):Promise<unknown|undefined> {
  const { row, result, servedProvider } = c;
  const nextExclusions = Array.from(new Set([...(row.excluded_providers || []), servedProvider]));
  const { policy } = await getPolicy(db, p.tenantId);
  const candidates = policy.providers.filter(pr => pr.enabled && (pr.kinds as string[]).includes(candidateKind));
  const usageRows = await db.query<{ provider: string; ok: boolean; headroom: number; windows: any }>(
    `SELECT provider, ok, headroom::float AS headroom, windows FROM provider_usage WHERE tenant_id=$1`, [p.tenantId]
  );
  const usageMap = new Map(usageRows.rows.map(u => [u.provider, u]));
  const allExhausted = candidates.every(cand => {
    if (nextExclusions.includes(cand.provider)) return true;
    const u = usageMap.get(cand.provider);
    return !u || !u.ok || u.headroom <= 0;
  });
  if (allExhausted) {
    const resetDescriptions = candidates.map(cand => {
      const u = usageMap.get(cand.provider);
      const winList: any[] = u?.windows?.windows ?? u?.windows ?? [];
      const resetWin = Array.isArray(winList) ? winList.find(w => w.resets_at) : undefined;
      const resetTime = resetWin?.resets_at ? new Date(resetWin.resets_at).toISOString() : 'unknown';
      return `${cand.provider} resets at ${resetTime}`;
    });
    const exhaustedMessage = `quota_exhausted: all providers exhausted (${resetDescriptions.join(', ')})`;
    result.failure = { code: 'quota_exhausted', retry: false, detail: exhaustedMessage };
    result.summary = exhaustedMessage;
    result.answer = exhaustedMessage;
    return undefined;
  }
  const next = await requeue(db, p, c, { exclusions: nextExclusions });
  const remainingUsage = await scopeUsage(db, p.tenantId, row.scope);
  const policyForRequeue = { ...policy, providers: policy.providers.filter(pr => !nextExclusions.includes(pr.provider)) };
  const reroutedTo = decide(policyForRequeue, effectiveRoutingKind(row), remainingUsage).provider ?? 'another provider';
  await taskReroutedNotice(db, p, next, servedProvider, reroutedTo, reason);
  return { task: await taskWithInstructions(db, next), replayed: false };
}

/** Phase 2: auto-routed tasks that failed on quota / provider error / rate limit are requeued instead of finished. */
async function finishRequeue(db:PoolClient,p:Principal,c:FinishCtx):Promise<unknown|undefined> {
  const { row, outcome, result, servedProvider } = c;
  if (outcome !== 'failed') return undefined;
  const failure = result.failure as { code?: string; retry_after_ms?: number } | undefined;
  const backoff = (defaultSec:number) => ({ backoffSec: failure?.retry_after_ms ? Math.ceil(failure.retry_after_ms / 1000) : defaultSec });
  const requeued = async (change:{backoffSec:number}) =>
    ({ task: await taskWithInstructions(db, await requeue(db, p, c, change)), replayed: false });
  // Owner-configured checks failed on a patch: retry while attempts remain; the next attempt resumes with the check output.
  if (failure?.code === 'swarmaa_checks_failed' && row.attempt_count < row.max_attempts) return requeued({ backoffSec: 0 });
  if (!(row.required_capability === AUTO_READ || row.required_capability === AUTO_PATCH)) return undefined;
  switch (failure?.code) {
    case 'quota_exhausted':
      await db.query(`UPDATE provider_usage SET fetched_at=clock_timestamp()-interval '16 minutes', headroom=0
        WHERE tenant_id=$1 AND provider=$2`, [p.tenantId, servedProvider]);
      return requeueOnOtherProvider(db, p, c, 'quota_exhausted', effectiveRoutingKind(row));
    case 'provider_error': {
      // One delayed retry per provider; a repeat failure there moves to another provider.
      const priorRuns = await db.query<RunRow>(
        `SELECT * FROM task_runs WHERE task_id=$1 AND status='failed'
         AND result->'failure'->>'code'='provider_error'
         AND coalesce(result->'served'->>'provider', result->>'provider')=$2`,
        [row.id, servedProvider]
      );
      return priorRuns.rows.length === 0
        ? requeued(backoff(5))
        : requeueOnOtherProvider(db, p, c, 'provider_error', effectiveRoutingKind(row));
    }
    case 'rate_limited':
      return requeued(backoff(60));
    default:
      return undefined;
  }
}

/** Phase 3: fenced task state transition and run record. */
async function finishRecord(db:PoolClient,p:Principal,c:FinishCtx):Promise<TaskRow> {
  const { row, lease, outcome, result, artifactIds, completionHash } = c;
  const updated = await db.query<TaskRow>(`UPDATE tasks SET status=$2,result=$3::jsonb,artifact_ids=$4::uuid[],
    version=version+1,lease_owner=NULL,lease_hash=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),
    completed_at=CASE WHEN $2='blocked' THEN NULL ELSE clock_timestamp() END
    WHERE id=$1 AND lease_expires_at>clock_timestamp() RETURNING *`,[row.id,outcome,JSON.stringify(result),artifactIds]);
  requireCondition(updated.rows[0],409,'lease_lost','Lease expired before result commit.');
  await db.query(`UPDATE task_runs SET status=$3,completion_hash=$4,result=$5::jsonb,artifact_ids=$6::uuid[],ended_at=clock_timestamp()
    WHERE task_id=$1 AND generation=$2`,[row.id,lease.generation,outcome,completionHash,JSON.stringify(result),artifactIds]);
  await releaseResource(db,row);
  return updated.rows[0]!;
}

/** System notice in a thread. The scheduled-run notice never carried an author in its event payload. */
async function serviceNotice(db:PoolClient,p:Principal,scope:string,threadId:string,body:string,withAuthor=true):Promise<void> {
  const author = { kind: 'system', id: 'service' };
  const seq = await assignThreadSeq(db, p.tenantId, threadId), id = newId();
  await db.query(
    `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'notice', $7)`,
    [id, p.tenantId, scope, threadId, seq, JSON.stringify(author), body]
  );
  await event(db, p, scope, 'message.created', id, {
    thread_id: threadId, message_id: id, seq: Number(seq), kind: 'notice', ...(withAuthor ? { author } : {})
  });
}

/** Phase 4b: queue the next turn for a pending human message or a delegation. */
async function finishFollowUpTurn(db:PoolClient,p:Principal,c:FinishCtx):Promise<void> {
  const { row, result, outcome, bot, routerLead } = c;
  const threadId = row.thread_id!;
  const agentRow = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [row.agent_id])).rows[0];

  // Messages the bridge steered into the running turn (and Claude acknowledged) were already handled.
  const steeredSeq = Number((row.checkpoint as {steered_seq?:unknown}|null)?.steered_seq);
  const processedSeq = Math.max(Number((row.context_versions as any)?.message_seq ?? 0) || 0, Number.isSafeInteger(steeredSeq) ? steeredSeq : 0);
  const pendingHuman = (await db.query<{ seq: string }>(
    `SELECT seq FROM messages
     WHERE thread_id=$1 AND (author->>'kind')='human' AND seq > $2
     ORDER BY seq DESC LIMIT 1`,
    [threadId, processedSeq]
  )).rows[0];

  const runner = row.permission_envelope.runner as { delegated?: unknown } | undefined;
  const delegate = result.delegate as { objective?: unknown } | undefined;
  // A swarm step's turn never delegates: the step would complete with the placeholder reply.
  const delegateObjective = outcome === 'completed' && runner?.delegated !== true && !row.swarm_step_id && typeof delegate?.objective === 'string'
    ? redactSecrets(delegate.objective).trim().slice(0, 500) : '';
  const botId = row.bot_id ?? null;
  let effectiveDelegateObjective = delegateObjective;
  if (routerLead && delegateObjective) {
    effectiveDelegateObjective = '';
    await serviceNotice(db, p, row.scope, threadId, "Router lead can't self-delegate; use handoff or swarm_start.");
  }
  if (!((pendingHuman || effectiveDelegateObjective) && agentRow)) return;
  const active = (await db.query(
    `SELECT id FROM tasks
     WHERE tenant_id=$1 AND agent_id=$2 AND status IN ('queued', 'running') AND id <> $3
     LIMIT 1`,
    [p.tenantId, row.agent_id, row.id]
  )).rows[0];

  // A delegation is queued even behind a busy agent (resource_key runs it after); the user was told it is coming.
  if (active && !effectiveDelegateObjective) return;
  const profile = bot ? leadTurnProfile(bot, agentRow) : null;
  const edits = profile ? profile.edits : agentRow.edits;
  const suffix = edits ? 'patch' : 'read';
  let nextCap: string;
  let runnerObj: Record<string, unknown> | undefined;
  let noticeModelLabel: string | undefined;

  if (effectiveDelegateObjective) {
    // Respect bot routing.summary / routing.patch and global routing policy instead of blindly forcing
    // auto agents onto claude-opus-5-5 when Claude is disabled or over quota.
    const routeKind = edits ? 'patch' : 'summary';
    const policyKind: RoutingKind = edits ? 'patch' : 'review';
    const botRoute = (bot?.routing && typeof bot.routing === 'object')
      ? (bot.routing[routeKind] as { mode?: string; provider?: string; model?: string; effort?: string } | undefined)
      : undefined;
    const agentPinned = agentRow.runner.mode !== 'auto' ? agentRow.runner.provider : undefined;

    if (botRoute && botRoute.mode !== 'auto' && botRoute.mode !== 'different_from_author' && botRoute.provider) {
      const m = botRoute.model ?? (botRoute.provider === 'claude' ? DELEGATE_MODEL : undefined);
      nextCap = `${botRoute.provider}.${suffix}`;
      runnerObj = {
        provider: botRoute.provider,
        ...(m ? { model: m } : {}),
        ...(botRoute.effort ? { effort: botRoute.effort } : {}),
        delegated: true,
      };
      noticeModelLabel = m;
    } else if (agentPinned) {
      const m = agentRow.runner.model ?? (agentPinned === 'claude' ? DELEGATE_MODEL : undefined);
      nextCap = `${agentPinned}.${suffix}`;
      runnerObj = {
        provider: agentPinned,
        ...(m ? { model: m } : {}),
        ...(agentRow.runner.effort ? { effort: agentRow.runner.effort } : {}),
        delegated: true,
      };
      noticeModelLabel = m;
    } else {
      const [{ policy }, usage] = await Promise.all([
        getPolicy(db, p.tenantId),
        scopeUsage(db, p.tenantId, agentRow.scope),
      ]);
      const floor = typeof bot?.rules?.quota_floor_pct === 'number' ? bot.rules.quota_floor_pct : 0;
      const effectivePolicy = bot ? botPolicy(policy, usage, floor) : policy;
      const decision = decide(effectivePolicy, policyKind, usage);
      const claudeEntry = effectivePolicy.providers.find(pr => pr.provider === 'claude' && pr.enabled && pr.kinds.includes(policyKind));
      if (decision.provider === 'claude' || (decision.anyone && Boolean(claudeEntry))) {
        const m = agentRow.runner.model ?? DELEGATE_MODEL;
        nextCap = `claude.${suffix}`;
        runnerObj = { provider: 'claude', model: m, ...(agentRow.runner.effort ? { effort: agentRow.runner.effort } : {}), delegated: true };
        noticeModelLabel = m;
      } else if (decision.provider) {
        nextCap = `${decision.provider}.${suffix}`;
        runnerObj = { provider: decision.provider, delegated: true };
        noticeModelLabel = decision.provider;
      } else {
        nextCap = edits ? AUTO_PATCH : AUTO_READ;
        runnerObj = { mode: 'auto', delegated: true };
      }
    }
  } else {
    const firstFollowUp = (bot && !profile?.router) ? firstReplyRunner(bot.rules, agentRow.edits) : null;
    const resolved = resolveTurnRunner({ bot, agent: agentRow, firstReply: firstFollowUp });
    nextCap = resolved.capability;
    runnerObj = resolved.runner;
  }

  const followUpId = newId();
  const envelope = {
    deploy: false, publish: false, purchase: false, local_patch: edits,
    read_project: true, send_messages: false, permission_changes: false, external_side_effects: false,
    ...(runnerObj ? { runner: runnerObj } : {})
  };
  const dispatched = effectiveDelegateObjective ? normalizeDispatchedFrom((row.context_versions as any)?.dispatched_from) : [];
  // hop_depth and dispatched_from carry over across DELEGATE follow-ups.
  const ctxVersions = {
    message_seq: Number(pendingHuman?.seq ?? processedSeq),
    hop_depth: (row.context_versions as any)?.hop_depth ?? 0,
    ...(dispatched.length > 0 ? { dispatched_from: dispatched } : {}),
  };
  const reqHash = sha256(canonicalJson({
    kind: 'turn', scope: agentRow.scope, agent_id: agentRow.id, thread_id: threadId, seq: Number(pendingHuman?.seq ?? processedSeq)
  }));
  await db.query(
    `INSERT INTO tasks
       (id, tenant_id, scope, kind, agent_id, thread_id, bot_id, objective, constraints, acceptance_criteria,
        permission_envelope, required_capability, resource_key, context_versions, status, created_by,
        idempotency_key, request_hash, max_attempts)
     VALUES ($1, $2, $3, 'turn', $4, $5, $6, $7, '[]'::jsonb, '[]'::jsonb, $8::jsonb, $9, $10, $11::jsonb, 'queued', $12, $13, $14, 3)`,
    [followUpId, p.tenantId, agentRow.scope, agentRow.id, threadId, botId, effectiveDelegateObjective || `Turn for agent ${agentRow.name}`,
     JSON.stringify(envelope), nextCap, `agent:${agentRow.id}`, JSON.stringify(ctxVersions), row.created_by, newId(), reqHash]
  );
  await audit(db, p, agentRow.scope, 'task.submitted', followUpId, { kind: 'turn', agent_id: agentRow.id, thread_id: threadId, required_capability: nextCap });
  await event(db, p, agentRow.scope, 'task.updated', followUpId, { task_id: followUpId, kind: 'turn', thread_id: threadId, required_capability: nextCap, status: 'queued', action: 'submitted' });
  if (effectiveDelegateObjective) {
    await serviceNotice(db, p, row.scope, threadId, redactSecrets(`${agentRow.name} handed this to ${noticeModelLabel ?? 'its full model'} for a fuller answer`));
  }
}

/**
 * A turn a coordinator bot dispatched (project_dispatch): copy the reply into each coordinator's thread.
 * When a dispatch_group reaches completed + failed >= total, atomically mark it synthesized and queue
 * ONE batched read-only synthesis turn on the coordinator (bounded by MAX_HANDOFF_HOPS).
 */
async function copyReplyToCoordinator(
  db: PoolClient,
  p: Principal,
  row: TaskRow,
  answer: string,
  outcomeStatus: 'completed' | 'failed' = 'completed'
): Promise<void> {
  const entries = normalizeDispatchedFrom((row.context_versions as any)?.dispatched_from);
  if (!entries.length || !row.bot_id) return;
  const bot = (await db.query<{ name: string }>('SELECT name FROM bots WHERE id=$1', [row.bot_id])).rows[0];
  if (!bot) return;

  for (const from of entries) {
    const origin = (await db.query<{ id: string }>(
      "SELECT id FROM threads WHERE id=$1 AND tenant_id=$2 AND scope=$3 AND kind='bot' AND NOT archived",
      [from.thread_id, p.tenantId, from.scope]
    )).rows[0];
    if (!origin) continue;
    const seq = await assignThreadSeq(db, p.tenantId, origin.id);
    const id = newId(), author = { kind: 'agent', id: row.agent_id };
    await db.query(`INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body, ref)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'text', $7, $8::jsonb)`,
      [id, p.tenantId, from.scope, origin.id, seq, JSON.stringify(author), clipUtf8(`**${bot.name.trim()}:** ${answer}`, 16384),
       JSON.stringify({ dispatched_reply: { bot_id: row.bot_id, task_id: row.id, ...(from.dispatch_group_id ? { dispatch_group_id: from.dispatch_group_id } : {}) } })]);
    await db.query('UPDATE threads SET updated_at=clock_timestamp() WHERE id=$1', [origin.id]);
    await event(db, p, from.scope, 'message.created', id, { thread_id: origin.id, message_id: id, seq: Number(seq), kind: 'text', author });

    if (from.dispatch_group_id) {
      const updatedGroup = (await db.query<{
        id: string; coordinator_scope: string; coordinator_thread_id: string;
        coordinator_agent_id: string; coordinator_bot_id: string | null;
        total: number; completed: number; failed: number; synthesized: boolean;
      }>(
        `UPDATE dispatch_groups
         SET completed = completed + CASE WHEN $2 = 'completed' THEN 1 ELSE 0 END,
             failed = failed + CASE WHEN $2 = 'failed' THEN 1 ELSE 0 END,
             counted = array_append(counted, $4::uuid),
             updated_at = clock_timestamp()
         WHERE id = $1 AND tenant_id = $3 AND NOT synthesized AND NOT ($4::uuid = ANY(counted))
         RETURNING *`,
        // A continued or retried task finishes again with the same id: it counts once.
        [from.dispatch_group_id, outcomeStatus, p.tenantId, row.id]
      )).rows[0];

      if (updatedGroup && updatedGroup.completed + updatedGroup.failed >= updatedGroup.total) {
        const claimed = await db.query(
          'UPDATE dispatch_groups SET synthesized=TRUE, updated_at=clock_timestamp() WHERE id=$1 AND NOT synthesized RETURNING id',
          [updatedGroup.id]
        );
        if (claimed.rowCount) {
          const nextHop = (from.hop_depth ?? 0) + 1;
          if (nextHop <= MAX_HANDOFF_HOPS) {
            const coordAgent = (await db.query<AgentRow>(
              'SELECT * FROM agents WHERE id=$1 AND tenant_id=$2 AND NOT archived',
              [updatedGroup.coordinator_agent_id, p.tenantId]
            )).rows[0];
            const coordBot = updatedGroup.coordinator_bot_id
                ? (await db.query<{ id: string; routing: Record<string, unknown>; rules: Record<string, unknown>; lead_agent_id: string }>(
                    'SELECT id, routing, rules, lead_agent_id FROM bots WHERE id=$1 AND tenant_id=$2 AND NOT archived',
                    [updatedGroup.coordinator_bot_id, p.tenantId]
                  )).rows[0]
                : undefined;
            // An archived coordinator bot gets no synthesis turn (never fall back to its id).
            if (coordAgent && (!updatedGroup.coordinator_bot_id || coordBot)) {
              const resolved = resolveTurnRunner({
                bot: coordBot,
                agent: coordAgent,
                routeKind: 'summary',
                forceReadOnly: true,
                summary: true,
              });
              const synthId = newId();
              const synthEnvelope = {
                deploy: false, publish: false, purchase: false, local_patch: false,
                read_project: true, send_messages: false, permission_changes: false, external_side_effects: false,
                runner: { ...(resolved.runner ?? {}), summary: true, fast: false },
              };
              const synthCtxVersions = {
                message_seq: Number(seq),
                hop_depth: nextHop,
                summary: true,
                dispatch_group_id: updatedGroup.id,
              };
              const synthReqHash = sha256(canonicalJson({
                kind: 'turn', scope: updatedGroup.coordinator_scope, agent_id: coordAgent.id, dispatch_group_id: updatedGroup.id, summary: true
              }));
              await db.query(
                `INSERT INTO tasks
                   (id, tenant_id, scope, kind, agent_id, thread_id, bot_id, objective, constraints, acceptance_criteria,
                    permission_envelope, required_capability, resource_key, context_versions, status, created_by,
                    idempotency_key, request_hash, max_attempts, initiator_kind, initiator_id)
                 VALUES ($1, $2, $3, 'turn', $4, $5, $6, $7, '[]'::jsonb, '[]'::jsonb, $8::jsonb, $9, $10, $11::jsonb, 'queued', $12, $13, $14, 3, 'handoff', $15)`,
                [synthId, p.tenantId, updatedGroup.coordinator_scope, coordAgent.id, updatedGroup.coordinator_thread_id,
                 coordBot?.id ?? updatedGroup.coordinator_bot_id,
                 'Synthesize the replies from the dispatched bots for the user. Reply only; start no new dispatches.',
                 JSON.stringify(synthEnvelope), resolved.capability, `agent:${coordAgent.id}`,
                 JSON.stringify(synthCtxVersions), row.created_by, `dispatch-synth:${updatedGroup.id}`, synthReqHash, updatedGroup.id]
              );
              await audit(db, p, updatedGroup.coordinator_scope, 'task.submitted', synthId, { kind: 'turn', agent_id: coordAgent.id, thread_id: updatedGroup.coordinator_thread_id, required_capability: resolved.capability });
              await event(db, p, updatedGroup.coordinator_scope, 'task.updated', synthId, { task_id: synthId, kind: 'turn', thread_id: updatedGroup.coordinator_thread_id, required_capability: resolved.capability, status: 'queued', action: 'submitted' });
            }
          }
        }
      }
    }
  }
}
