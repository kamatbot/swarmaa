import { advanceFlow, validateFlowCompletion } from './flows.js';
import type { FlowTask } from './flow-definition.js';
import { inboxSession, readTaskInbox, taskFinished, taskReroutedNotice } from './inbox.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '../db.js';
import { requireCondition } from '../errors.js';
import { hasPermission } from '../policy.js';
import { ARTIFACT_MAX_BYTES, type Principal } from '../types.js';
import { enumValue, integer, object, optionalString, scopeName, string, strings, uuid } from '../validation.js';
import { assertKnownScope, audit, canonicalJson, event, jsonObject, newId, noExtraKeys, requireFound, scopeLock, scopeSql, sha256, uuidArray, type Db } from './shared.js';
import { decide, decideAll, getPolicy, policyAllows, scopeUsage, type RoutingKind } from './routing.js';
import { AUTO_PATCH, AUTO_READ, touchWorker, workerProviders } from './swarm.js';
import { runnerCapability } from '../bridge/adapters.js';
import { redactSecrets } from '../safety/redact.js';
import { clipUtf8, assignThreadSeq, getTurnWindow, type AgentRow } from './teams.js';

function effectiveRoutingKind(row: { kind: string; required_capability: string }): RoutingKind {
  return row.kind === 'turn'
    ? (row.required_capability.endsWith('.patch') ? 'patch' : 'review')
    : (row.kind as RoutingKind);
}

export const TASK_KINDS = ['research','review','patch'] as const;
export const TASK_STATUSES = ['queued','running','blocked','completed','failed','cancelled'] as const;
type TaskKind = typeof TASK_KINDS[number] | 'check' | 'approve' | 'turn';
export interface TaskRow {
  id:string; tenant_id:string; scope:string; kind:TaskKind; objective:string;
  flow_id:string|null; flow:FlowTask|null;
  agent_id?:string|null; thread_id?:string|null; swarm_step_id?:string|null;
  constraints:string[]; acceptance_criteria:string[]; permission_envelope:Record<string,unknown>;
  required_capability:string; resource_key:string|null; base_ref:string|null; context_refs:string[]; context_versions:Record<string,number>;
  status:typeof TASK_STATUSES[number]; version:number; created_by:string; idempotency_key:string; request_hash:string;
  attempt_count:number; max_attempts:number; continuation_count:number; lease_generation:number;
  lease_owner:string|null; lease_hash:string|null; lease_expires_at:Date|null;
  checkpoint:Record<string,unknown>|null; result:Record<string,unknown>|null; artifact_ids:string[];
  excluded_providers?:string[]; not_before?:Date|null;
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
    ...(row.agent_id ? {agent_id:row.agent_id} : {}),
    ...(row.thread_id ? {thread_id:row.thread_id} : {}),
    ...(row.swarm_step_id ? {swarm_step_id:row.swarm_step_id} : {}) };
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

/** All queue/resource mutations acquire scope then task locks, including retraction of context references. */
async function lockedTask(db:PoolClient,p:Principal,id:string):Promise<TaskRow> {
  const visible = await findTask(db,p,id);
  await scopeLock(db,'tasks',p,visible.scope);
  return findTask(db,p,id,true);
}

export async function taskChanged(db:PoolClient,p:Principal,row:TaskRow,action:string,advance=true):Promise<void> {
  const failureCode = (row.result as any)?.failure?.code;
  const details = { task_id:row.id,version:row.version,status:row.status,action,
    attempt_count:row.attempt_count,lease_generation:row.lease_generation,
    ...(failureCode ? { failure_code: failureCode } : {}),
    ...(row.flow_id ? {flow_id:row.flow_id,step_id:row.flow!.step_id,kind:row.kind,
      ...(row.kind==='approve' && action==='flow_ready' ? {approval_required:true} : {})} : {}) };
  await audit(db,p,row.scope,`task.${action}`,row.id,details);
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
  await taskChanged(db,p,next,'cancelled',advance);
  return next;
}

export class TaskService {
  constructor(private readonly pool:Pool) {}

  async submit(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['scope','kind','objective','idempotency_key','required_capability','resource_key','base_ref','constraints','acceptance_criteria','context_refs','max_attempts']);
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
    const envelope = { read_project:true, local_patch:kind === 'patch', external_side_effects:false,
      deploy:false, publish:false, send_messages:false, purchase:false, permission_changes:false };
    const requestHash = sha256(canonicalJson({scope,kind,objective,capability,resource,constraints,base_ref:baseRef,acceptance,refs,max_attempts:attempts}));
    return transaction(this.pool,async db => {
      // The idempotency namespace spans scopes so moving a retry cannot duplicate work.
      await scopeLock(db,'submission',p,'',`${p.id}:${idempotency}`);
      const existing = await db.query<TaskRow>('SELECT * FROM tasks WHERE tenant_id=$1 AND created_by=$2 AND idempotency_key=$3',[p.tenantId,p.id,idempotency]);
      if (existing.rows[0]) {
        requireCondition(existing.rows[0].request_hash === requestHash,409,'idempotency_conflict','This idempotency key was used for different task inputs.');
        return {task:await taskWithInstructions(db,existing.rows[0]),replayed:true};
      }
      if ((capability.endsWith('.read') && capability !== AUTO_READ) || (capability.endsWith('.patch') && capability !== AUTO_PATCH)) {
        const {policy} = await getPolicy(db,p.tenantId);
        const provider = capability.slice(0,capability.lastIndexOf('.'));
        const entry = policy.providers.find(x => x.provider === provider);
        requireCondition(!entry || entry.enabled,400,'provider_disabled',`${capability} is disabled by the owner's routing policy. Use ${kind === 'patch' ? 'auto.patch' : 'auto.read'} or another provider.`);
        requireCondition(policyAllows(policy,provider,kind),400,'kind_not_allowed',provider === 'antigravity'
          ? 'Antigravity takes review and in-project edit tasks, not research (it cannot reach outside the project). Use auto.read or codex.read for research.'
          : `${provider} does not take ${kind} tasks under the owner's routing policy. Use ${kind === 'patch' ? 'auto.patch' : 'auto.read'} or another provider.`);
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
         resource_key,base_ref,context_refs,context_versions,status,created_by,idempotency_key,request_hash,max_attempts)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$17,$11::uuid[],$12::jsonb,'queued',$13,$14,$15,$16) RETURNING *`,
      [newId(),p.tenantId,scope,kind,objective,JSON.stringify(constraints),JSON.stringify(acceptance),JSON.stringify(envelope),
        capability,resource,refs,JSON.stringify(versions),p.id,idempotency,requestHash,attempts,baseRef]);
      const row = result.rows[0]!;
      await taskChanged(db,p,row,'submitted');
      // Say so now rather than let the task sit unclaimed: no live worker serves this project.
      const served = await db.query<{workers:number;free:number}>(`SELECT count(*)::int AS workers,
          coalesce(sum(greatest(coalesce(w.worker_slots,1)-(SELECT count(*) FROM tasks t WHERE t.lease_owner=w.id AND t.status='running'),0)),0)::int AS free
        FROM principals w WHERE w.tenant_id=$1 AND w.role='worker' AND NOT w.disabled
        AND $2=ANY(w.scopes) AND w.last_seen_at>clock_timestamp()-interval '60 seconds'`,[p.tenantId,scope]);
      const {workers,free} = served.rows[0] ?? {workers:0,free:0};
      if (!workers) return {task:await taskWithInstructions(db,row),replayed:false,
        warning:`No live worker serves ${scope}, so this task will wait in the queue. Start a worker for this project or submit it to a project a worker serves.`};
      // Acknowledge to the submitting agent, in words it can relay to the user.
      const message = `Swarm started: task ${row.id.slice(0,8)} is queued in ${scope}. ${workers} live worker${workers===1?'':'s'} with ${free} free slot${free===1?'':'s'} serve it, so it ${free ? 'should start within seconds' : 'will start when a slot frees up'}. Follow it with events_poll on ${scope} (claimed, then finished; start after 0.0 and pass next_cursor unchanged) or task_get.`;
      return {task:await taskWithInstructions(db,row),replayed:false,message};
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
    noExtraKeys(input,['scope','status','limit','before_id']);
    const scope = scopeName(input.scope);
    assertKnownScope(p,scope);
    const status = input.status === undefined ? null : enumValue(input.status,'status',TASK_STATUSES);
    const limit = input.limit === undefined ? 20 : integer(input.limit,'limit',1,100);
    const before = input.before_id === undefined ? null : uuid(input.before_id,'before_id');
    let beforeDate:Date|null = null;
    if (before) {
      const cursor = await this.pool.query<{created_at:Date}>('SELECT created_at FROM tasks WHERE id=$1 AND tenant_id=$2 AND scope=$3',[before,p.tenantId,scope]);
      beforeDate = requireFound(cursor.rows[0],'Task cursor').created_at;
    }
    const result = await this.pool.query<TaskRow>(`SELECT * FROM tasks WHERE tenant_id=$1 AND scope=$2
      AND ($3::text IS NULL OR status=$3) AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $6`,[p.tenantId,scope,status,beforeDate,before,limit+1]);
    const rows = result.rows.slice(0,limit);
    return {tasks:rows.map(taskView),next_before_id:result.rows.length>limit ? rows.at(-1)!.id : null};
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
      const row = await lockedTask(db,p,id);
      const existing = await db.query<{request_hash:string}>(`SELECT request_hash FROM task_instructions
        WHERE task_id=$1 AND actor_id=$2 AND idempotency_key=$3`,[id,p.id,key]);
      if (existing.rows[0]) {
        requireCondition(existing.rows[0].request_hash === requestHash,409,'idempotency_conflict','This key was used for a different continuation.');
        return {task:await taskWithInstructions(db,row),replayed:true};
      }
      requireCondition(!row.flow_id,409,'flow_managed_task','Flow steps are immutable; start a new flow to retry or change work.');
      requireCondition(row.version === expected,409,'version_conflict','Task changed; read it before appending a continuation.');
      requireCondition(row.continuation_count<20,409,'continuation_limit','A task permits at most 20 continuations; create a new bounded task.');
      if (['completed','failed','cancelled'].includes(row.status)) {
        const count = await db.query<{count:string}>(`SELECT count(*)::text AS count FROM tasks
          WHERE tenant_id=$1 AND scope=$2 AND status IN ('queued','running','blocked')`,[p.tenantId,row.scope]);
        requireCondition(Number(count.rows[0]?.count ?? 0)<1000,429,'queue_full','Scope already has 1000 open tasks; finish or cancel existing work first.');
      }
      if (row.status === 'running') {
        const time = await db.query<{live:boolean}>('SELECT $1::timestamptz>clock_timestamp() AS live',[row.lease_expires_at]);
        requireCondition(!time.rows[0]?.live,409,'task_running','Wait for the current run or cancel it before continuing.');
        await db.query(`UPDATE task_runs SET status='abandoned',ended_at=clock_timestamp() WHERE task_id=$1 AND generation=$2 AND status='running'`,[id,row.lease_generation]);
      }
      await retireResource(db,row);
      await db.query(`INSERT INTO task_instructions (id,task_id,actor_id,idempotency_key,request_hash,instruction)
        VALUES ($1,$2,$3,$4,$5,$6)`,[newId(),id,p.id,key,requestHash,instruction]);
      const updated = await db.query<TaskRow>(`UPDATE tasks SET status='queued',version=version+1,
        continuation_count=continuation_count+1,attempt_count=0,lease_generation=lease_generation+1,
        lease_owner=NULL,lease_hash=NULL,lease_expires_at=NULL,completed_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`,[id]);
      const next = updated.rows[0]!;
      await taskChanged(db,p,next,'continued');
      return {task:await taskWithInstructions(db,next),replayed:false};
    });
  }

  async claim(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['scope','capabilities','kinds','projects','lease_seconds']);
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
    for (const {scope,capabilities,kinds} of projects) {
      const claim = await this.claimScope(p,scope,capabilities,kinds,seconds);
      if (claim.task) return claim;
    }
    return {task:null};
  }

  private async claimScope(p:Principal,scope:string,capabilities:string[],kinds:TaskKind[],seconds:number) {
    return transaction(this.pool,async db => {
      await scopeLock(db,'tasks',p,scope);
      await touchWorker(db,p);
      // The owner's routing policy decides, per kind, which provider takes auto.read work; explicit
      // capabilities still obey the policy's enabled flag and allowed kinds.
      const served = workerProviders(capabilities);
      const servedPatch = capabilities.filter(c => c.endsWith('.patch') && c !== AUTO_PATCH).map(c => c.slice(0,-6));
      const {policy} = await getPolicy(db,p.tenantId);
      const usage = await scopeUsage(db,p.tenantId,scope);
      const decisions = capabilities.includes(AUTO_READ) || capabilities.includes(AUTO_PATCH) ? decideAll(policy,usage) : null;
      const eligible = (row:TaskRow):boolean => {
        if (row.kind === 'check') return true;
        const exclusions = row.excluded_providers ?? [];
        const policyForTask = exclusions.length ? { ...policy, providers: policy.providers.filter(x => !exclusions.includes(x.provider)) } : policy;
        const effectiveKind: RoutingKind = effectiveRoutingKind(row);
        if (row.required_capability === AUTO_PATCH) {
          const d = decide(policyForTask, 'patch', usage);
          if (d.anyone) return servedPatch.some(s => policyAllows(policyForTask, s, 'patch') && !exclusions.includes(s));
          return d.provider !== null && servedPatch.includes(d.provider) && !exclusions.includes(d.provider);
        }
        if (row.required_capability.endsWith('.patch')) {
          const prov = row.required_capability.slice(0, -6);
          return !exclusions.includes(prov) && policyAllows(policy, prov, 'patch');
        }
        if (row.kind === 'patch') return true;
        if (row.required_capability === AUTO_READ) {
          const d = decide(policyForTask, effectiveKind, usage);
          if (d.anyone) return !served.length || served.some(s => policyAllows(policyForTask, s, effectiveKind) && !exclusions.includes(s));
          return d.provider !== null && served.includes(d.provider) && !exclusions.includes(d.provider);
        }
        const prov = row.required_capability.slice(0, -5);
        return !exclusions.includes(prov) && policyAllows(policy, prov, effectiveKind);
      };
      // Sweep expired attempts before selection. No process-local retry state is needed after a restart.
      const expired = await db.query<TaskRow>(`SELECT * FROM tasks WHERE tenant_id=$1 AND scope=$2 AND status='running'
        AND lease_expires_at<=clock_timestamp() ORDER BY created_at,id FOR UPDATE`,[p.tenantId,scope]);
      for (const row of expired.rows) {
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
      for (const row of candidates.rows) {
        let flowProvider:string|undefined;
        if (row.flow && row.kind!=='check') {
          const other = row.flow.different_provider_than ? (await db.query<TaskRow>("SELECT * FROM tasks WHERE flow_id=$1 AND flow->>'step_id'=$2",[row.flow_id,row.flow.different_provider_than])).rows[0] : undefined;
          const otherServed = (other?.result as any)?.served?.provider ?? other?.flow?.provider;
          if (row.flow.different_provider_than && (!other || other.status!=='completed' || !otherServed)) continue;
          const excluded = otherServed;
          const candidates = policy.providers.filter(x => x.enabled && x.kinds.includes(row.kind as RoutingKind) && x.provider!==excluded && !(row.excluded_providers || []).includes(x.provider));
          const auto = row.required_capability===AUTO_READ || row.required_capability===AUTO_PATCH;
          const d = decideAll({...policy,providers:candidates},usage)[row.kind as RoutingKind];
          const suffix = row.kind==='patch' ? 'patch' : 'read';
          const providers = auto ? (d.anyone ? candidates.map(x => x.provider) : d.provider ? [d.provider] : []) : [row.required_capability.split('.')[0]!];
          flowProvider = providers.find(provider => candidates.some(x => x.provider===provider) && capabilities.includes(`${provider}.${suffix}`));
          if (!flowProvider) continue;
        } else if (!eligible(row)) continue;
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
        const policyForTask = exclusions.length ? { ...policy, providers: policy.providers.filter(x => !exclusions.includes(x.provider)) } : policy;
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
          if (maxSeq > 0) {
            const nextVersions = { ...(next.context_versions ?? {}), message_seq: maxSeq };
            await db.query('UPDATE tasks SET context_versions=$2::jsonb WHERE id=$1', [next.id, JSON.stringify(nextVersions)]);
            next.context_versions = nextVersions;
            claimTask = { ...baseTask, ...(agent ? { agent } : {}), context_versions: nextVersions, thread_messages: window };
          } else {
            claimTask = { ...baseTask, ...(agent ? { agent } : {}), thread_messages: window };
          }
        }
        return {task:claimTask,lease_token:token,lease_generation:generation,...(route ? {route} : {})};
      }
      return {task:null};
    });
  }

  async heartbeat(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['task_id','lease_token','lease_generation','lease_seconds']);
    const lease = leaseInput(input);
    const seconds = leaseSeconds(input.lease_seconds);
    return transaction(this.pool,async db => {
      const row = await lockedTask(db,p,lease.taskId);
      await requireLease(db,p,row,lease);
      await touchWorker(db,p);
      const updated = await db.query<TaskRow>(`UPDATE tasks SET
        lease_expires_at=clock_timestamp()+$2::integer*interval '1 second'
        WHERE id=$1 AND lease_expires_at>clock_timestamp() RETURNING *`,[row.id,seconds]);
      requireCondition(updated.rows[0],409,'lease_lost','Lease expired before renewal.');
      const next = updated.rows[0];
      if ((next.kind === 'patch' || next.kind === 'turn') && next.resource_key !== null) await db.query(`UPDATE task_resource_leases SET expires_at=$4
        WHERE tenant_id=$1 AND scope=$2 AND task_id=$3 AND generation=$5`,[p.tenantId,next.scope,next.id,next.lease_expires_at,next.lease_generation]);
      // Heartbeats do not change semantic versions or emit an event for every timer tick.
      return {task:await taskWithInstructions(db,next)};
    });
  }

  async checkpoint(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['task_id','lease_token','lease_generation','checkpoint']);
    const lease = leaseInput(input);
    const checkpoint = jsonObject(input.checkpoint,'checkpoint',32768);
    return transaction(this.pool,async db => {
      const row = await lockedTask(db,p,lease.taskId);
      await requireLease(db,p,row,lease);
      const updated = await db.query<TaskRow>(`UPDATE tasks SET checkpoint=$2::jsonb,version=version+1,
        updated_at=clock_timestamp() WHERE id=$1 AND lease_expires_at>clock_timestamp() RETURNING *`,[row.id,JSON.stringify(checkpoint)]);
      requireCondition(updated.rows[0],409,'lease_lost','Lease expired before checkpoint.');
      const next = updated.rows[0];
      await taskChanged(db,p,next,'checkpointed');
      return {task:await taskWithInstructions(db,next)};
    });
  }

  async finish(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['task_id','lease_token','lease_generation','outcome','result','artifact_ids']);
    worker(p);
    const lease = leaseInput(input);
    const outcome = enumValue(input.outcome,'outcome',['completed','failed','blocked'] as const);
    const result = jsonObject(input.result,'result',65536);
    const artifactIds = uuidArray(input.artifact_ids,'artifact_ids');
    patchResult(result);
    const completionHash = sha256(canonicalJson({outcome,result_json:canonicalJson(result),artifact_ids:[...artifactIds].sort()}));
    return transaction(this.pool,async db => {
      const row = await lockedTask(db,p,lease.taskId);
      const runResult = await db.query<RunRow>('SELECT * FROM task_runs WHERE task_id=$1 AND generation=$2 FOR UPDATE',[row.id,lease.generation]);
      const run = runResult.rows[0];
      requireCondition(run && run.worker_id === p.id && sameHash(run.lease_hash,sha256(lease.token)),409,'lease_lost','This connection does not own that execution attempt.');
      if (run.completion_hash !== null) {
        requireCondition(run.completion_hash === completionHash,409,'completion_conflict','This run already finished with different result content.');
        return {task:await taskWithInstructions(db,row),replayed:true};
      }
      await requireLease(db,p,row,lease);
      validateFlowCompletion(row,outcome,result);
      if (row.flow?.different_provider_than) {
        const other = (await db.query<TaskRow>("SELECT * FROM tasks WHERE flow_id=$1 AND flow->>'step_id'=$2",[row.flow_id,row.flow.different_provider_than])).rows[0];
        const otherServed = (other?.result as any)?.served?.provider ?? other?.flow?.provider;
        const currentServed = (result.served as any)?.provider ?? result.provider;
        requireCondition(!otherServed || currentServed !== otherServed, 409, 'flow_provider_mismatch', 'Step ran on the same provider as the step it must differ from.');
      }
      const artifacts = await db.query<{id:string}>(`SELECT id FROM artifacts WHERE tenant_id=$1 AND scope=$2
        AND task_id=$3 AND run_generation=$4 AND id=ANY($5::uuid[])`,[p.tenantId,row.scope,row.id,lease.generation,artifactIds]);
      requireCondition(artifacts.rows.length === artifactIds.length,400,'invalid_artifacts','Each artifact must belong to this task execution attempt.');

      const isAuto = row.required_capability === AUTO_READ || row.required_capability === AUTO_PATCH;
      const failure = result.failure as { code?: string; retry?: boolean; detail?: string; retry_after_ms?: number } | undefined;
      const failureCode = failure?.code;
      const servedProvider = (result.served as any)?.provider || (result.provider as string) || row.required_capability.split('.')[0]!;

      if (outcome === 'failed' && isAuto && failureCode === 'quota_exhausted') {
        await db.query(`UPDATE provider_usage SET fetched_at=clock_timestamp()-interval '16 minutes', headroom=0
          WHERE tenant_id=$1 AND provider=$2`, [p.tenantId, servedProvider]);
        const nextExclusions = Array.from(new Set([...(row.excluded_providers || []), servedProvider]));
        const { policy } = await getPolicy(db, p.tenantId);
        const candidates = policy.providers.filter(pr => pr.enabled && (pr.kinds as string[]).includes(row.kind));
        const usageRows = await db.query<{ provider: string; ok: boolean; headroom: number; windows: any }>(
          `SELECT provider, ok, headroom::float AS headroom, windows FROM provider_usage WHERE tenant_id=$1`, [p.tenantId]
        );
        const usageMap = new Map(usageRows.rows.map(u => [u.provider, u]));

        const allExhausted = candidates.every(c => {
          if (nextExclusions.includes(c.provider)) return true;
          const u = usageMap.get(c.provider);
          return !u || !u.ok || u.headroom <= 0;
        });

        if (allExhausted) {
          const resetDescriptions = candidates.map(c => {
            const u = usageMap.get(c.provider);
            const winList: any[] = u?.windows?.windows ?? u?.windows ?? [];
            const resetWin = Array.isArray(winList) ? winList.find(w => w.resets_at) : undefined;
            const resetTime = resetWin?.resets_at ? new Date(resetWin.resets_at).toISOString() : 'unknown';
            return `${c.provider} resets at ${resetTime}`;
          });
          const exhaustedMessage = `quota_exhausted: all providers exhausted (${resetDescriptions.join(', ')})`;
          result.failure = { code: 'quota_exhausted', retry: false, detail: exhaustedMessage };
          result.summary = exhaustedMessage;
          result.answer = exhaustedMessage;
        } else {
          const updated = await db.query<TaskRow>(`UPDATE tasks SET status='queued',result=$2::jsonb,
            excluded_providers=$3::text[],artifact_ids=$4::uuid[],version=version+1,lease_owner=NULL,
            lease_hash=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),completed_at=NULL
            WHERE id=$1 AND lease_expires_at>clock_timestamp() RETURNING *`,
          [row.id, JSON.stringify(result), nextExclusions, artifactIds]);
          requireCondition(updated.rows[0], 409, 'lease_lost', 'Lease expired before result commit.');
          await db.query(`UPDATE task_runs SET status='failed',completion_hash=$3,result=$4::jsonb,artifact_ids=$5::uuid[],ended_at=clock_timestamp()
            WHERE task_id=$1 AND generation=$2`, [row.id, lease.generation, completionHash, JSON.stringify(result), artifactIds]);
          await releaseResource(db, row);
          const next = updated.rows[0]!;

          const remainingUsage = await scopeUsage(db, p.tenantId, row.scope);
          const policyForRequeue = { ...policy, providers: policy.providers.filter(pr => !nextExclusions.includes(pr.provider)) };
          const nextDecision = decide(policyForRequeue, effectiveRoutingKind(row), remainingUsage);
          const reroutedTo = nextDecision.provider ?? 'another provider';

          await taskChanged(db, p, next, 'requeued');
          await taskReroutedNotice(db, p, next, servedProvider, reroutedTo, 'quota_exhausted');
          return { task: await taskWithInstructions(db, next), replayed: false };
        }
      } else if (outcome === 'failed' && isAuto && failureCode === 'provider_error') {
        const priorRuns = await db.query<RunRow>(
          `SELECT * FROM task_runs WHERE task_id=$1 AND status='failed'
           AND result->'failure'->>'code'='provider_error'
           AND coalesce(result->'served'->>'provider', result->>'provider')=$2`,
          [row.id, servedProvider]
        );
        if (priorRuns.rows.length === 0) {
          const backoffSec = failure?.retry_after_ms ? Math.ceil(failure.retry_after_ms / 1000) : 5;
          const updated = await db.query<TaskRow>(`UPDATE tasks SET status='queued',result=$2::jsonb,
            not_before=clock_timestamp()+$3::integer*interval '1 second',artifact_ids=$4::uuid[],
            version=version+1,lease_owner=NULL,lease_hash=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),completed_at=NULL
            WHERE id=$1 AND lease_expires_at>clock_timestamp() RETURNING *`,
          [row.id, JSON.stringify(result), backoffSec, artifactIds]);
          requireCondition(updated.rows[0], 409, 'lease_lost', 'Lease expired before result commit.');
          await db.query(`UPDATE task_runs SET status='failed',completion_hash=$3,result=$4::jsonb,artifact_ids=$5::uuid[],ended_at=clock_timestamp()
            WHERE task_id=$1 AND generation=$2`, [row.id, lease.generation, completionHash, JSON.stringify(result), artifactIds]);
          await releaseResource(db, row);
          const next = updated.rows[0]!;
          await taskChanged(db, p, next, 'requeued');
          return { task: await taskWithInstructions(db, next), replayed: false };
        } else {
          const nextExclusions = Array.from(new Set([...(row.excluded_providers || []), servedProvider]));
          const { policy } = await getPolicy(db, p.tenantId);
          const candidates = policy.providers.filter(pr => pr.enabled && (pr.kinds as string[]).includes(effectiveRoutingKind(row)));
          const usageRows = await db.query<{ provider: string; ok: boolean; headroom: number; windows: any }>(
            `SELECT provider, ok, headroom::float AS headroom, windows FROM provider_usage WHERE tenant_id=$1`, [p.tenantId]
          );
          const usageMap = new Map(usageRows.rows.map(u => [u.provider, u]));

          const allExhausted = candidates.every(c => {
            if (nextExclusions.includes(c.provider)) return true;
            const u = usageMap.get(c.provider);
            return !u || !u.ok || u.headroom <= 0;
          });

          if (allExhausted) {
            const resetDescriptions = candidates.map(c => {
              const u = usageMap.get(c.provider);
              const winList: any[] = u?.windows?.windows ?? u?.windows ?? [];
              const resetWin = Array.isArray(winList) ? winList.find(w => w.resets_at) : undefined;
              const resetTime = resetWin?.resets_at ? new Date(resetWin.resets_at).toISOString() : 'unknown';
              return `${c.provider} resets at ${resetTime}`;
            });
            const exhaustedMessage = `quota_exhausted: all providers exhausted (${resetDescriptions.join(', ')})`;
            result.failure = { code: 'quota_exhausted', retry: false, detail: exhaustedMessage };
            result.summary = exhaustedMessage;
            result.answer = exhaustedMessage;
          } else {
            const updated = await db.query<TaskRow>(`UPDATE tasks SET status='queued',result=$2::jsonb,
              excluded_providers=$3::text[],artifact_ids=$4::uuid[],version=version+1,lease_owner=NULL,
              lease_hash=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),completed_at=NULL
              WHERE id=$1 AND lease_expires_at>clock_timestamp() RETURNING *`,
            [row.id, JSON.stringify(result), nextExclusions, artifactIds]);
            requireCondition(updated.rows[0], 409, 'lease_lost', 'Lease expired before result commit.');
            await db.query(`UPDATE task_runs SET status='failed',completion_hash=$3,result=$4::jsonb,artifact_ids=$5::uuid[],ended_at=clock_timestamp()
              WHERE task_id=$1 AND generation=$2`, [row.id, lease.generation, completionHash, JSON.stringify(result), artifactIds]);
            await releaseResource(db, row);
            const next = updated.rows[0]!;

            const remainingUsage = await scopeUsage(db, p.tenantId, row.scope);
            const policyForRequeue = { ...policy, providers: policy.providers.filter(pr => !nextExclusions.includes(pr.provider)) };
            const nextDecision = decide(policyForRequeue, effectiveRoutingKind(row), remainingUsage);
            const reroutedTo = nextDecision.provider ?? 'another provider';

            await taskChanged(db, p, next, 'requeued');
            await taskReroutedNotice(db, p, next, servedProvider, reroutedTo, 'provider_error');
            return { task: await taskWithInstructions(db, next), replayed: false };
          }
        }
      } else if (outcome === 'failed' && isAuto && failureCode === 'rate_limited') {
        const backoffSec = failure?.retry_after_ms ? Math.ceil(failure.retry_after_ms / 1000) : 60;
        const updated = await db.query<TaskRow>(`UPDATE tasks SET status='queued',result=$2::jsonb,
          not_before=clock_timestamp()+$3::integer*interval '1 second',artifact_ids=$4::uuid[],
          version=version+1,lease_owner=NULL,lease_hash=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),completed_at=NULL
          WHERE id=$1 AND lease_expires_at>clock_timestamp() RETURNING *`,
        [row.id, JSON.stringify(result), backoffSec, artifactIds]);
        requireCondition(updated.rows[0], 409, 'lease_lost', 'Lease expired before result commit.');
        await db.query(`UPDATE task_runs SET status='failed',completion_hash=$3,result=$4::jsonb,artifact_ids=$5::uuid[],ended_at=clock_timestamp()
          WHERE task_id=$1 AND generation=$2`, [row.id, lease.generation, completionHash, JSON.stringify(result), artifactIds]);
        await releaseResource(db, row);
        const next = updated.rows[0]!;
        await taskChanged(db, p, next, 'requeued');
        return { task: await taskWithInstructions(db, next), replayed: false };
      }
      const updated = await db.query<TaskRow>(`UPDATE tasks SET status=$2,result=$3::jsonb,artifact_ids=$4::uuid[],
        version=version+1,lease_owner=NULL,lease_hash=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),
        completed_at=CASE WHEN $2='blocked' THEN NULL ELSE clock_timestamp() END
        WHERE id=$1 AND lease_expires_at>clock_timestamp() RETURNING *`,[row.id,outcome,JSON.stringify(result),artifactIds]);
      requireCondition(updated.rows[0],409,'lease_lost','Lease expired before result commit.');
      await db.query(`UPDATE task_runs SET status=$3,completion_hash=$4,result=$5::jsonb,artifact_ids=$6::uuid[],ended_at=clock_timestamp()
        WHERE task_id=$1 AND generation=$2`,[row.id,lease.generation,outcome,completionHash,JSON.stringify(result),artifactIds]);
      await releaseResource(db,row);
      const next = updated.rows[0];

      if (row.kind === 'turn' && row.agent_id && row.thread_id) {
        const targetThreadId = (result.thread_id as string | undefined) ?? row.thread_id;
        const threadRow = (await db.query('SELECT * FROM threads WHERE id=$1 AND tenant_id=$2', [targetThreadId, p.tenantId])).rows[0];
        requireCondition(threadRow && threadRow.agent_id === row.agent_id && threadRow.scope === row.scope, 403, 'turn_grant_forbidden', 'Turn grant refuses posting to another agent\'s thread.');

        if (outcome === 'completed') {
          const rawAnswer = [result.answer, result.summary, result.reason].find(v => typeof v === 'string') ?? '';
          const answer = clipUtf8(redactSecrets(String(rawAnswer)), 16384);
          const nextSeq = await assignThreadSeq(db, p.tenantId, targetThreadId);
          const msgId = newId();
          await db.query(
            `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'text', $7)`,
            [msgId, p.tenantId, row.scope, targetThreadId, nextSeq, JSON.stringify({ kind: 'agent', id: row.agent_id }), answer]
          );
          await event(db, p, row.scope, 'message.created', msgId, {
            thread_id: targetThreadId,
            message_id: msgId,
            seq: Number(nextSeq),
            kind: 'text',
            author: { kind: 'agent', id: row.agent_id }
          });
          if (result.native_session) {
            await db.query(
              `INSERT INTO agent_provider_sessions (tenant_id, agent_id, provider, session_data, updated_at)
               VALUES ($1, $2, $3, $4::jsonb, clock_timestamp())
               ON CONFLICT (tenant_id, agent_id, provider)
               DO UPDATE SET session_data=EXCLUDED.session_data, updated_at=clock_timestamp()`,
              [p.tenantId, row.agent_id, servedProvider, JSON.stringify(result.native_session)]
            );
          }
        } else {
          const failureObj = result.failure as { code?: string; detail?: string } | undefined;
          const failCode = failureObj?.code || 'harness_error';
          const detail = failureObj?.detail || result.summary || failCode;
          const noticeBody = clipUtf8(redactSecrets(`Turn failed: ${failCode} - ${detail}`), 16384);
          const nextSeq = await assignThreadSeq(db, p.tenantId, targetThreadId);
          const msgId = newId();
          await db.query(
            `INSERT INTO messages (id, tenant_id, scope, thread_id, seq, author, kind, body)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'notice', $7)`,
            [msgId, p.tenantId, row.scope, targetThreadId, nextSeq, JSON.stringify({ kind: 'system', id: 'service' }), noticeBody]
          );
          await event(db, p, row.scope, 'message.created', msgId, {
            thread_id: targetThreadId,
            message_id: msgId,
            seq: Number(nextSeq),
            kind: 'notice',
            author: { kind: 'system', id: 'service' }
          });
        }

        const agentRow = (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [row.agent_id])).rows[0];

        const processedSeq = (row.context_versions as any)?.message_seq ?? 0;
        const pendingHuman = (await db.query<{ seq: string }>(
          `SELECT seq FROM messages
           WHERE thread_id=$1 AND (author->>'kind')='human' AND seq > $2
           ORDER BY seq DESC LIMIT 1`,
          [row.thread_id, processedSeq]
        )).rows[0];

        if (pendingHuman && agentRow) {
          const active = (await db.query(
            `SELECT id FROM tasks
             WHERE tenant_id=$1 AND agent_id=$2 AND status IN ('queued', 'running') AND id <> $3
             LIMIT 1`,
            [p.tenantId, row.agent_id, row.id]
          )).rows[0];

          if (!active) {
            const nextCap = runnerCapability(agentRow.runner, agentRow.edits);
            const followUpId = newId();
            const envelope = {
              deploy: false, publish: false, purchase: false, local_patch: agentRow.edits,
              read_project: true, send_messages: false, permission_changes: false, external_side_effects: false
            };
            const ctxVersions = { message_seq: Number(pendingHuman.seq) };
            const reqHash = sha256(canonicalJson({
              kind: 'turn', scope: agentRow.scope, agent_id: agentRow.id, thread_id: row.thread_id, seq: Number(pendingHuman.seq)
            }));
            await db.query(
              `INSERT INTO tasks
                 (id, tenant_id, scope, kind, agent_id, thread_id, objective, constraints, acceptance_criteria,
                  permission_envelope, required_capability, resource_key, context_versions, status, created_by,
                  idempotency_key, request_hash, max_attempts)
               VALUES ($1, $2, $3, 'turn', $4, $5, $6, '[]'::jsonb, '[]'::jsonb, $7::jsonb, $8, $9, $10::jsonb, 'queued', $11, $12, $13, 3)`,
              [followUpId, p.tenantId, agentRow.scope, agentRow.id, row.thread_id, `Turn for agent ${agentRow.name}`,
               JSON.stringify(envelope), nextCap, `agent:${agentRow.id}`, JSON.stringify(ctxVersions), row.created_by, newId(), reqHash]
            );
            await audit(db, p, agentRow.scope, 'task.submitted', followUpId, { kind: 'turn', agent_id: agentRow.id });
            await event(db, p, agentRow.scope, 'task.updated', followUpId, { task_id: followUpId, status: 'queued', action: 'submitted' });
          }
        }
      }

      await taskChanged(db,p,next,'finished');
      return {task:await taskWithInstructions(db,next),replayed:false};
    });
  }

  async cancel(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['task_id','expected_version']);
    const id = uuid(input.task_id,'task_id');
    const expected = expectedVersion(input.expected_version);
    return transaction(this.pool,async db => {
      const row = await lockedTask(db,p,id);
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
