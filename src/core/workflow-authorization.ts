import type { PoolClient } from 'pg';
import { principalFromRow } from '../auth.js';
import { requireCondition } from '../errors.js';
import { narrowGrant } from '../oauth.js';
import { canAccessScope, hasPermission } from '../policy.js';
import type { Principal } from '../types.js';

export interface WorkflowAuthorization {
  tenant_id: string;
  scope: string;
  created_by: string;
  authorization_snapshot: Principal;
  oauth_grant_id: string | null;
  credential_version: number;
}

/**
 * Recheck the initiating authority before any deferred work starts or a managed lease writes.
 * The stored snapshot is a ceiling: later grants never expand the original authorization.
 * Call under the task scope advisory lock, before taking unrelated scope/identity locks.
 */
export async function workflowCreator(db: PoolClient, run: WorkflowAuthorization): Promise<Principal | null> {
  const rows = await db.query('SELECT * FROM principals WHERE id=$1 AND tenant_id=$2 AND NOT disabled FOR SHARE', [run.created_by, run.tenant_id]);
  if (!rows.rows[0]) return null;
  const current = principalFromRow(rows.rows[0]);
  const snapshot = run.authorization_snapshot;
  if (snapshot.id !== current.id || snapshot.tenantId !== current.tenantId || snapshot.role !== current.role ||
      run.credential_version !== current.credentialVersion || snapshot.credentialVersion !== current.credentialVersion ||
      !canAccessScope(snapshot, run.scope) || !canAccessScope(current, run.scope) ||
      !hasPermission(snapshot, 'task:submit') || !hasPermission(current, 'task:submit') ||
      !hasPermission(snapshot, 'task:read') || !hasPermission(current, 'task:read')) return null;
  if (run.oauth_grant_id !== null) {
    const grants = await db.query<{ grant_snapshot: Principal }>(`SELECT grant_snapshot FROM oauth_grants
      WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`, [run.oauth_grant_id, run.created_by]);
    if (!grants.rows[0]) return null;
    const grant = narrowGrant(grants.rows[0].grant_snapshot, current);
    if (!grant || !canAccessScope(grant, run.scope) || !hasPermission(grant, 'task:submit') || !hasPermission(grant, 'task:read')) return null;
    // A row lock can wait across the expiry instant; evaluate the database clock after the wait.
    const live = await db.query<{ live: boolean }>('SELECT revoked_at IS NULL AND expires_at>clock_timestamp() AS live FROM oauth_grants WHERE id=$1', [run.oauth_grant_id]);
    if (!live.rows[0]?.live) return null;
  }
  // This identity is used only for this run's scoped database writes/audit, never to call a provider.
  return { ...snapshot, scopes: [run.scope], permissions: snapshot.permissions.filter(permission => hasPermission(current, permission)) };
}

export interface ManagedWorkflowTask {
  workflow_id?: string | null;
  workflow_step?: string | null;
  tenant_id: string;
  scope: string;
  base_ref: string | null;
}

/** Called by task claim and lease checks, closing the interval before the periodic reconciler. */
export async function workflowTaskEligible(db: PoolClient, worker: Principal, task: ManagedWorkflowTask): Promise<boolean> {
  if (!task.workflow_id) return true;
  if (worker.tenantId !== task.tenant_id || !canAccessScope(worker, task.scope)) return false;
  const rows = await db.query<WorkflowAuthorization & { base_commit: string; live: boolean }>(`SELECT w.*,
      (w.status='running' AND w.deadline_at>clock_timestamp() AND s.activated_at IS NOT NULL) AS live
    FROM workflow_runs w JOIN workflow_steps s ON s.workflow_id=w.id AND s.step_key=$4
    WHERE w.id=$1 AND w.tenant_id=$2 AND w.scope=$3 FOR SHARE OF w, s`,
  [task.workflow_id, task.tenant_id, task.scope, task.workflow_step]);
  const run = rows.rows[0];
  if (!run || !run.live || task.base_ref !== run.base_commit || (await workflowCreator(db, run)) === null) return false;
  const live = await db.query<{ live: boolean }>("SELECT status='running' AND deadline_at>clock_timestamp() AS live FROM workflow_runs WHERE id=$1", [task.workflow_id]);
  return live.rows[0]?.live === true;
}

/**
 * Clamp managed leases to both durable budgets. Call after workflowTaskEligible under its locks.
 * Missing managed state fails closed; ordinary tasks neither need nor query workflow tables.
 */
export async function workflowTaskDeadline(db: PoolClient, task: ManagedWorkflowTask): Promise<Date | null> {
  if (!task.workflow_id) return null;
  const rows = await db.query<{ deadline_at: Date; oauth_grant_id: string | null; grant_expires_at: Date | null; revoked_at: Date | null; active: boolean }>(`SELECT w.deadline_at,w.oauth_grant_id,
      g.expires_at AS grant_expires_at,g.revoked_at,w.status='running' AS active
    FROM workflow_runs w LEFT JOIN oauth_grants g ON g.id=w.oauth_grant_id AND g.principal_id=w.created_by
    WHERE w.id=$1 AND w.tenant_id=$2 AND w.scope=$3`, [task.workflow_id, task.tenant_id, task.scope]);
  const run = rows.rows[0];
  requireCondition(!!run && run.active, 409, 'lease_lost', 'The managed workflow is no longer active.');
  requireCondition(run!.oauth_grant_id === null || (run!.grant_expires_at !== null && run!.revoked_at === null),
    409, 'lease_lost', 'The originating workflow authorization is unavailable.');
  return new Date(Math.min(run!.deadline_at.getTime(), run!.grant_expires_at?.getTime() ?? Infinity));
}
