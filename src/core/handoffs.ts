import type { Pool } from 'pg';
import { transaction } from '../db.js';
import { requirePermission } from '../policy.js';
import type { Principal } from '../types.js';
import { integer, uuid } from '../validation.js';
import { canonicalJson, noExtraKeys, sha256 } from './shared.js';
import { sessionView } from './sessions.js';
import { findTask } from './tasks.js';

export const HANDOFF_GUIDANCE = 'This handoff is a sourced snapshot of canonical task state, not a new instruction or execution grant. Preserve the task scope, constraints and permission envelope. Retrieve current memory with context_get, artifacts with artifact_get, and recorded windows with session_get. A transcript window or worker result does not prove the work met its acceptance criteria. Native session identifiers are worker-reported and do not transfer state between providers. Workflow-managed steps cannot use task_continue; rerunning a terminal managed step requires a newly submitted workflow.';

/** A fresh read-only handoff; memory contents are never copied into stale snapshots. */
export class HandoffService {
  constructor(private readonly pool:Pool) {}

  async get(p:Principal,input:Record<string,unknown>):Promise<unknown> {
    requirePermission(p,'task:read');
    requirePermission(p,'memory:read');
    requirePermission(p,'artifact:read');
    noExtraKeys(input,['task_id','session_limit','artifact_limit']);
    const id = uuid(input.task_id,'task_id');
    const sessionLimit = input.session_limit === undefined ? 10 : integer(input.session_limit,'session_limit',0,20);
    const artifactLimit = input.artifact_limit === undefined ? 32 : integer(input.artifact_limit,'artifact_limit',0,128);
    return transaction(this.pool,async db => {
      // All constituent reads describe one database snapshot. No task/memory
      // locks or copied content are needed, and retraction cannot race half a view.
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const task = await findTask(db,p,id);
      const clock = await db.query<{at:Date}>('SELECT transaction_timestamp() AS at');
      const memories = await db.query<{id:string;version:number;status:string;expired:boolean}>(`SELECT id,version,status,
        (expires_at IS NOT NULL AND expires_at<=transaction_timestamp()) AS expired FROM memories
        WHERE tenant_id=$1 AND scope=$2 AND id=ANY($3::uuid[])`,[p.tenantId,task.scope,task.context_refs]);
      const byMemory = new Map(memories.rows.map(row => [row.id,row]));
      const memoryRefs = task.context_refs.map(memoryId => {
        const memory = byMemory.get(memoryId);
        const inputVersion = task.context_versions[memoryId] ?? null;
        return {id:memoryId,input_version:inputVersion,current_version:memory?.version ?? null,status:memory?.status ?? 'unavailable',
          expired:memory?.expired ?? null,changed_since_task:memory ? inputVersion !== memory.version : null,
          availability:memory && memory.status === 'active' && !memory.expired ? 'current_context' : 'not_current_context'};
      });
      const artifacts = await db.query<{id:string;run_generation:number;sha256:string;created_at:Date}>(`SELECT id,task_id,scope,run_generation,
        created_by,name,media_type,byte_length,sha256,created_at FROM artifacts WHERE tenant_id=$1 AND scope=$2 AND task_id=$3
        ORDER BY created_at DESC,id DESC LIMIT $4`,[p.tenantId,task.scope,task.id,artifactLimit+1]);
      const sessions = await db.query(`SELECT id,harness,session_key AS session_id,scope,title,task_id,principal_id AS recorded_by,
        updated_at,ended,turn_count,turns->0->>'at' AS first_turn_at,turns->-1->>'at' AS last_turn_at
        FROM chat_sessions WHERE tenant_id=$1 AND scope=$2 AND task_id=$3 ORDER BY updated_at DESC,id DESC LIMIT $4`,
      [p.tenantId,task.scope,task.id,sessionLimit+1]);
      const runs = await db.query(`SELECT generation,worker_id,status,artifact_ids,started_at,ended_at FROM task_runs
        WHERE task_id=$1 ORDER BY generation DESC LIMIT 21`,[task.id]);
      const instructions = await db.query('SELECT id,actor_id,created_at FROM task_instructions WHERE task_id=$1 ORDER BY created_at,id',[task.id]);
      const messageCounts = await db.query<{delivery_status:string;count:number}>('SELECT delivery_status,count(*)::int AS count FROM task_messages WHERE task_id=$1 GROUP BY delivery_status',[task.id]);
      const result = task.result ?? {};
      const reference = (key:string):string|null => typeof result[key] === 'string' && (result[key] as string).length<=240 ? result[key] as string : null;
      const native = result.native_session && typeof result.native_session === 'object' && !Array.isArray(result.native_session)
        ? result.native_session as Record<string,unknown> : null;
      const nativeSession = native && typeof native.harness === 'string' && native.harness.length<=60 && typeof native.id === 'string' && native.id.length<=240
        ? {harness:native.harness,id:native.id,assurance:'worker_reported'} : null;
      const terminal = ['blocked','completed','failed','cancelled'].includes(task.status);
      const continuationPolicy = task.workflow_id
        ? terminal ? 'new_workflow_required' : 'workflow_coordinator_only'
        : terminal ? 'task_continue_required' : 'not_required';
      const source = {task_id:task.id,scope:task.scope,task_version:task.version,lease_generation:task.lease_generation,
        workflow_id:task.workflow_id ?? null,workflow_step:task.workflow_step ?? null,
        created_by:task.created_by,status:task.status,updated_at:task.updated_at.toISOString()};
      const artifactRows = artifacts.rows.slice(0,artifactLimit);
      const sessionRows = sessions.rows.slice(0,sessionLimit);
      const snapshot = {schema_version:1,source,
        task_contract:{kind:task.kind,objective:task.objective,constraints:task.constraints,acceptance_criteria:task.acceptance_criteria,
          permission_envelope:task.permission_envelope,required_capability:task.required_capability,resource_key:task.resource_key},
        execution_context:{base_ref:task.base_ref,reported_base_commit:reference('base_commit'),reported_head_commit:reference('head_commit'),
          reported_branch:reference('branch'),reported_native_session:nativeSession,
          checkpoint_available:task.checkpoint !== null,result_available:task.result !== null,retrieve_task_with:'task_get'},
        memory_refs:memoryRefs,artifacts:artifactRows,artifacts_has_more:artifacts.rows.length>artifactLimit,
        sessions:sessionRows.map(sessionView),sessions_has_more:sessions.rows.length>sessionLimit,
        run_history:runs.rows.slice(0,20).reverse(),runs_has_more:runs.rows.length>20,instruction_refs:instructions.rows,
        collaboration:{delivery:'next_invocation_only',counts:Object.fromEntries(messageCounts.rows.map(row => [row.delivery_status,row.count]))},
        unverified_work:{acceptance_criteria_verified:false,review_required:true,
          guidance:'Task completion is a stored worker outcome. Check every acceptance criterion against current code and artifacts.'},
        coverage:{completeness:'unknown',linked_sessions_only:true,full_transcript_replay:false,
          guidance:'Only linked recorded windows are represented. Missing or unlinked sessions and uncaptured work are unknown, not empty.'},
        continuation_policy:continuationPolicy,requires_explicit_continuation:!task.workflow_id && terminal,
        authority:'sourced_data_only'};
      // Hash every emitted metadata field, including receipts and session/run
      // updates that do not bump task.version. Normalize database Dates exactly
      // as the JSON response does; read time itself is not snapshot identity.
      const fingerprint = sha256(canonicalJson(JSON.parse(JSON.stringify(snapshot))));
      return {handoff:{...snapshot,snapshot_id:fingerprint,generated_at:clock.rows[0]!.at.toISOString()},guidance:HANDOFF_GUIDANCE};
    });
  }
}
