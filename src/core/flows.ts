import type { Pool, PoolClient } from 'pg';
import { transaction } from '../db.js';
import { requireCondition } from '../errors.js';
import { requirePermission } from '../policy.js';
import type { Principal } from '../types.js';
import { object, scopeName, string, uuid } from '../validation.js';
import { BUILTIN_FLOWS, COMMIT, flowObjective, validateFlow, type FlowDefinition, type FlowTask } from './flow-definition.js';
import { flowApprovalNotice } from './inbox.js';
import { assertKnownScope, audit, canonicalJson, jsonObject, newId, noExtraKeys, requireFound, scopeLock, scopeSql, sha256, type Db } from './shared.js';
import { cancelTask, taskChanged, taskView, type TaskRow } from './tasks.js';

interface FlowRun {
  id:string; tenant_id:string; scope:string; definition:FlowDefinition; inputs:Record<string,string>;
  created_by:string; owner_id:string|null; cancelled_at:Date|null; created_at:Date; request_hash:string;
}
const stopped = (t:TaskRow) => ['blocked','failed','cancelled'].includes(t.status);
const tasksFor = async(db:Db,id:string):Promise<TaskRow[]> => (await db.query<TaskRow>('SELECT * FROM tasks WHERE flow_id=$1 ORDER BY created_at,id',[id])).rows;
async function findFlow(db:Db,p:Principal,id:string):Promise<FlowRun> {
  const [all,scopes] = scopeSql(p);
  return requireFound((await db.query<FlowRun>(`SELECT * FROM flow_runs WHERE id=$1 AND tenant_id=$2
    AND ($3::boolean OR scope=ANY($4::text[]))`,[id,p.tenantId,all,scopes])).rows[0],'Flow');
}
function view(run:FlowRun,tasks:TaskRow[]) {
  const status = run.cancelled_at ? 'cancelled' : tasks.some(stopped) ? 'blocked' :
    tasks.every(t => t.status==='completed') ? 'completed' : tasks.some(t => t.kind==='approve' && t.flow?.ready && t.status==='queued') ? 'awaiting_approval' :
    tasks.some(t => t.status==='running' || t.status==='completed') ? 'running' : 'queued';
  const byStep = new Map(tasks.map(t => [t.flow!.step_id,t]));
  return {id:run.id,scope:run.scope,definition:run.definition,inputs:run.inputs,status,created_by:run.created_by,
    owner_id:run.owner_id,created_at:run.created_at,cancelled_at:run.cancelled_at,
    steps:run.definition.steps.map(s => taskView(byStep.get(s.id)!))};
}

/** The caller holds the task scope lock. Activation and completion commit atomically. */
export async function advanceFlow(db:PoolClient,p:Principal,row:TaskRow):Promise<void> {
  if (!row.flow_id) return;
  const run = await findFlow(db,p,row.flow_id);
  const tasks = await tasksFor(db,run.id);
  if (run.cancelled_at || tasks.some(stopped)) return;
  const byStep = new Map(tasks.map(t => [t.flow!.step_id,t]));
  const results = new Map(tasks.map(t => [t.flow!.step_id,t.result]));
  for (const step of run.definition.steps) {
    const task = byStep.get(step.id)!;
    if (task.flow!.ready || task.status!=='queued' || !step.needs.every(n => byStep.get(n)!.status==='completed')) continue;
    const source = step.pin ? byStep.get(step.pin)! : undefined;
    const commit = source ? source.kind==='patch' ? (source.result!.head_commit ?? source.result!.base_commit) as string : source.result!.observed_commit as string : run.inputs.commit ?? null;
    const diffBase = source ? source.kind==='patch' ? source.result!.base_commit as string : source.flow!.diff_base : null;
    const flow:FlowTask = {...task.flow!,ready:true,commit,diff_base:diffBase};
    const updated = (await db.query<TaskRow>(`UPDATE tasks SET flow=$2::jsonb,base_ref=$3,objective=$4,
      version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
    [task.id,JSON.stringify(flow),commit,flowObjective(step,run.inputs,results,step.kind==='approve' ? `Flow ${run.definition.title} needs your approval: ` : '')])).rows[0]!;
    await taskChanged(db,p,updated,'flow_ready',false);
    if (step.kind==='approve') await flowApprovalNotice(db,p,updated,run.owner_id!,run.definition.title,run.id);
  }
}

/** Results are bridge observations, never a boolean copied out of the model answer. */
export function validateFlowCompletion(row:TaskRow,outcome:string,result:Record<string,unknown>):void {
  if (!row.flow_id) return;
  requireCondition(row.kind!=='approve',403,'owner_required','Approval tasks can only finish through flow_approve.');
  if (outcome!=='completed') return;
  const flow = row.flow!;
  requireCondition(typeof result.observed_commit==='string' && COMMIT.test(result.observed_commit),400,'flow_evidence_required','Flow completion needs the bridge-observed commit.');
  if (row.kind==='patch') {
    requireCondition(typeof result.base_commit==='string' && COMMIT.test(result.base_commit) &&
      (result.head_commit===null || typeof result.head_commit==='string' && COMMIT.test(result.head_commit)) &&
      result.observed_commit===(result.head_commit ?? result.base_commit),400,'flow_evidence_required','Patch completion needs matching base/head commit evidence.');
    requireCondition(!flow.commit || result.base_commit===flow.commit,409,'flow_commit_mismatch','Patch did not start from the pinned commit.');
  } else requireCondition(result.observed_commit===flow.commit,409,'flow_commit_mismatch','Step did not run against its pinned commit.');
  if (row.kind==='check') {
    const fact = object(result.check);
    requireCondition(result.tests_run_by_bridge===true && fact.type===flow.check!.type && fact.commit===flow.commit &&
      fact.base_commit===flow.diff_base && fact.passed===true && fact.exit_code===0 && fact.stop_reason===null &&
      typeof fact.output_tail==='string' && Buffer.byteLength(fact.output_tail)<=16384 &&
      typeof fact.duration_ms==='number' && Number.isFinite(fact.duration_ms) && fact.duration_ms>=0,
    409,'flow_check_failed','Only a passing deterministic bridge check can complete this step.');
    const servedProvider = (result.served as any)?.provider ?? result.provider;
    requireCondition(servedProvider===flow.provider,409,'flow_provider_mismatch','Completion provider differs from the service-bound provider.');
  }
}

export function validateFlowStepProvider(actualProvider: string, otherServedProvider?: string | null): void {
  if (otherServedProvider) {
    requireCondition(actualProvider !== otherServedProvider, 409, 'flow_provider_mismatch', 'Step ran on the same provider as the step it must differ from.');
  }
}

export class FlowService {
  constructor(private readonly pool:Pool) {}
  async list(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,[]);
    const stored = (await this.pool.query<{definition:FlowDefinition}>('SELECT definition FROM flow_definitions WHERE tenant_id=$1 ORDER BY id',[p.tenantId])).rows;
    const definitions = new Map(BUILTIN_FLOWS.map(d => [d.id,d]));
    for (const row of stored) definitions.set(row.definition.id,row.definition);
    return {flows:[...definitions.values()]};
  }
  async start(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['flow','scope','inputs','idempotency_key']);
    const scope = scopeName(input.scope); assertKnownScope(p,scope);
    const rawInputs = jsonObject(input.inputs ?? {},'inputs',16000);
    const inputs:Record<string,string> = {};
    for (const [key,value] of Object.entries(rawInputs)) {
      requireCondition(/^[a-z][a-z0-9_]*$/.test(key),400,'invalid_flow_inputs','Input keys use lowercase letters, digits and underscores.');
      inputs[key] = string(value,`inputs.${key}`,8000);
    }
    requireCondition(inputs.commit===undefined || COMMIT.test(inputs.commit),400,'invalid_flow_inputs','commit must be a full hexadecimal Git commit, never a moving ref.');
    const inline = typeof input.flow!=='string';
    if (inline) requireCondition(p.role==='admin',403,'owner_required','Only an owner may register a flow definition.');
    const requested = inline ? validateFlow(input.flow) : string(input.flow,'flow',80);
    const key = input.idempotency_key===undefined ? newId() : string(input.idempotency_key,'idempotency_key',200);
    const hash = sha256(canonicalJson({flow:requested,scope,inputs}));
    return transaction(this.pool,async db => {
      await scopeLock(db,'flow-submission',p,'',`${p.id}:${key}`);
      const existing = (await db.query<FlowRun>('SELECT * FROM flow_runs WHERE tenant_id=$1 AND created_by=$2 AND idempotency_key=$3',[p.tenantId,p.id,key])).rows[0];
      if (existing) {
        requireCondition(existing.request_hash===hash,409,'idempotency_conflict','This key was used for another flow start.');
        const existingSwarm = (await db.query<{ id: string }>('SELECT id FROM swarms WHERE flow_id=$1', [existing.id])).rows[0];
        return {flow:view(existing,await tasksFor(db,existing.id)),swarm_id:existingSwarm?.id ?? null,replayed:true,idempotency_key:key};
      }
      const id = typeof requested==='string' ? requested : requested.id;
      const saved = (await db.query<{definition:FlowDefinition}>('SELECT definition FROM flow_definitions WHERE tenant_id=$1 AND id=$2',[p.tenantId,id])).rows[0];
      const builtin = BUILTIN_FLOWS.find(d => d.id===id);
      const definition = typeof requested==='string' ? requireFound(saved?.definition ?? builtin,'Flow definition') : requested;
      requireCondition(!builtin || canonicalJson(builtin)===canonicalJson(definition),409,'flow_definition_conflict','Built-in definitions cannot be replaced.');
      requireCondition(!saved || canonicalJson(saved.definition)===canonicalJson(definition),409,'flow_definition_conflict','Definitions are immutable; use a new ID for a changed definition.');
      for (const step of definition.steps) {
        flowObjective(step,inputs,new Map(),step.kind==='approve' ? `Flow ${definition.title} needs your approval: ` : '');
        requireCondition(step.kind==='patch' || step.kind==='approve' || step.pin || inputs.commit,400,'invalid_flow_inputs','Unpinned read steps require inputs.commit.');
      }
      let ownerId:string|null = null;
      if (definition.steps.some(s => s.kind==='approve')) {
        const owners = (await db.query<{id:string;name:string}>(`SELECT id,name FROM principals WHERE tenant_id=$1 AND role='admin' AND NOT disabled
          AND ($2=ANY(scopes) OR '*'=ANY(scopes)) AND ('admin'=ANY(permissions) OR ('task:read'=ANY(permissions) AND 'task:cancel'=ANY(permissions) AND 'events:read'=ANY(permissions)))`,[p.tenantId,scope])).rows;
        ownerId = owners.find(o => o.name==='owner')?.id ?? (owners.length===1 ? owners[0]!.id : null);
        requireCondition(ownerId,409,'flow_owner_required','Approval flows need an unambiguous scoped owner identity (name owner, or the sole admin).');
      }
      await scopeLock(db,'tasks',p,scope);
      const count = (await db.query(`SELECT count(*)::int AS n FROM tasks WHERE tenant_id=$1 AND scope=$2 AND status IN ('queued','running','blocked')`,[p.tenantId,scope])).rows[0].n;
      requireCondition(count+definition.steps.length<=1000,429,'queue_full','Flow would exceed 1000 open tasks in this scope.');
      await db.query(`INSERT INTO flow_definitions(tenant_id,id,definition,created_by) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING`,[p.tenantId,id,JSON.stringify(definition),p.id]);
      // Serialize concurrent registration of the same tenant ID without allowing a different definition to win silently.
      const registered = (await db.query('SELECT definition FROM flow_definitions WHERE tenant_id=$1 AND id=$2',[p.tenantId,id])).rows[0].definition;
      requireCondition(canonicalJson(registered)===canonicalJson(definition),409,'flow_definition_conflict','Definition ID already exists with different content.');
      const run = (await db.query<FlowRun>(`INSERT INTO flow_runs(id,tenant_id,scope,definition,inputs,created_by,owner_id,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9) RETURNING *`,[newId(),p.tenantId,scope,JSON.stringify(definition),JSON.stringify(inputs),p.id,ownerId,key,hash])).rows[0]!;

      const flowThreadId = newId();
      await db.query(
        `INSERT INTO threads (id, tenant_id, scope, kind, title)
         VALUES ($1, $2, $3, 'channel', $4)`,
        [flowThreadId, p.tenantId, scope, `Flow: ${definition.title}`]
      );

      const swarmId = newId();
      await db.query(
        `INSERT INTO swarms (id, tenant_id, scope, title, goal, thread_id, status, flow_id, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $8, $9)`,
        [swarmId, p.tenantId, scope, definition.title, definition.title, flowThreadId, run.id, p.id, key]
      );

      const defaultAgent = (await db.query<{ id: string }>(
        'SELECT id FROM agents WHERE tenant_id=$1 AND scope=$2 AND NOT archived LIMIT 1',
        [p.tenantId, scope]
      )).rows[0];

      const stepKeyToId = new Map<string, string>();
      for (const step of definition.steps) {
        stepKeyToId.set(step.id, newId());
      }

      let first!:TaskRow;
      for (let i = 0; i < definition.steps.length; i++) {
        const step = definition.steps[i]!;
        const stepId = stepKeyToId.get(step.id)!;
        const depIds = (step.needs ?? []).map(d => stepKeyToId.get(d) ?? d);
        const flow:FlowTask = {step_id:step.id,needs:step.needs,ready:false,commit:null,diff_base:null,provider:null,
          ...(step.pin ? {pin:step.pin} : {}),...(step.check ? {check:step.check} : {}),
          ...(typeof step.capability==='object' ? {different_provider_than:step.capability.different_provider_than} : {})};
        const capability = typeof step.capability==='string' ? step.capability : step.kind==='patch' ? 'auto.patch' : 'auto.read';
        const envelope = {read_project:true,local_patch:step.kind==='patch' || step.kind==='check',external_side_effects:false,
          deploy:false,publish:false,send_messages:false,purchase:false,permission_changes:false};
        const taskId = newId();

        const task = (await db.query<TaskRow>(`INSERT INTO tasks(id,tenant_id,scope,kind,objective,permission_envelope,required_capability,status,
          created_by,idempotency_key,request_hash,flow_id,flow,max_attempts,initiator_kind,initiator_id,swarm_step_id)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'queued',$8,$9,$10,$11,$12::jsonb,3,'flow',$13,$14) RETURNING *`,
        [taskId,p.tenantId,scope,step.kind,flowObjective(step,inputs,new Map(),step.kind==='approve' ? `Flow ${definition.title} needs your approval: ` : ''),JSON.stringify(envelope),capability,p.id,`flow:${run.id}:${step.id}`,hash,run.id,JSON.stringify(flow),run.id,stepId])).rows[0]!;

        await db.query(
          `INSERT INTO swarm_steps (id, tenant_id, swarm_id, step_key, title, assignee_agent_id, needs, order_index, status, task_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, 'pending', $9)`,
          [stepId, p.tenantId, swarmId, step.id, step.id, defaultAgent?.id ?? null, depIds, i, taskId]
        );
        first ??= task;
        await taskChanged(db,p,task,'submitted',false);
      }
      await advanceFlow(db,p,first);
      await audit(db,p,scope,'flow.started',run.id,{definition:id});
      return {flow:view(run,await tasksFor(db,run.id)),swarm_id:swarmId,replayed:false,idempotency_key:key};
    });
  }
  async get(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['flow_id']);
    return transaction(this.pool,async db => {
      const run = await findFlow(db,p,uuid(input.flow_id,'flow_id'));
      await scopeLock(db,'tasks',p,run.scope);
      return {flow:view(await findFlow(db,p,run.id),await tasksFor(db,run.id))};
    });
  }
  async cancel(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['flow_id']);
    return transaction(this.pool,async db => {
      const run = await findFlow(db,p,uuid(input.flow_id,'flow_id'));
      await scopeLock(db,'tasks',p,run.scope);
      await db.query('UPDATE flow_runs SET cancelled_at=coalesce(cancelled_at,clock_timestamp()) WHERE id=$1',[run.id]);
      for (const task of await tasksFor(db,run.id)) if (!['completed','cancelled'].includes(task.status)) await cancelTask(db,p,task,false);
      await db.query(`UPDATE inbox SET read_at=coalesce(read_at,clock_timestamp()) WHERE kind='flow_approval' AND task_id IN (SELECT id FROM tasks WHERE flow_id=$1)`,[run.id]);
      await audit(db,p,run.scope,'flow.cancelled',run.id);
      return {flow:view(await findFlow(db,p,run.id),await tasksFor(db,run.id))};
    });
  }
  async approve(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    noExtraKeys(input,['flow_id','step_id','approve']);
    requireCondition(p.role==='admin',403,'owner_required','Only the owner can approve a flow.');
    requirePermission(p,'task:cancel');
    const step = string(input.step_id,'step_id',80);
    requireCondition(typeof input.approve==='boolean',400,'invalid_arguments','approve must be a boolean.');
    return transaction(this.pool,async db => {
      const run = await findFlow(db,p,uuid(input.flow_id,'flow_id'));
      requireCondition(run.owner_id===p.id,403,'owner_required','Only this flow’s owner identity can approve it.');
      await scopeLock(db,'tasks',p,run.scope);
      const current = await findFlow(db,p,run.id), tasks = await tasksFor(db,run.id);
      const task = requireFound(tasks.find(t => t.flow!.step_id===step && t.kind==='approve'),'Approval step');
      if (task.result?.approved===input.approve && task.result?.approved_by===p.id) return {flow:view(current,tasks),replayed:true};
      requireCondition(!current.cancelled_at && !tasks.some(stopped) && task.status==='queued' && task.flow!.ready,409,'flow_not_approvable','This approval is not pending or its dependencies have stopped.');
      const next = (await db.query<TaskRow>(`UPDATE tasks SET status=$2,result=$3::jsonb,version=version+1,
        updated_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=$1 RETURNING *`,
      [task.id,input.approve ? 'completed' : 'blocked',JSON.stringify({approved:input.approve,approved_by:p.id,reason:input.approve ? 'Owner approved.' : 'Owner rejected.'})])).rows[0]!;
      await db.query("UPDATE inbox SET read_at=coalesce(read_at,clock_timestamp()) WHERE kind='flow_approval' AND task_id=$1",[task.id]);
      await taskChanged(db,p,next,input.approve ? 'approved' : 'rejected');
      return {flow:view(current,await tasksFor(db,run.id)),replayed:false};
    });
  }
}
