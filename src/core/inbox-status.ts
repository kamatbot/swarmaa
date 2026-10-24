import { hasPermission } from '../policy.js';
import type { Principal } from '../types.js';
import type { Db } from './shared.js';

/** Counts for dashboards/sinks; bounded per-item metadata is only for the recipient. Never selects bodies. */
export async function inboxStatus(db:Db,p:Principal,all:boolean,scopes:string[],taskId:string|null=null) {
  const empty={offered:0,accepted:0,unconfirmed:0,read:0,stuck:0};
  if (!hasPermission(p,'events:read')) return {counts:empty,items:[]};
  const access=`i.tenant_id=$1 AND i.recipient_principal=$2 AND ($3::boolean OR i.scope=ANY($4::text[]))
    AND ($5::uuid IS NULL OR i.task_id=$5) AND (i.task_id IS NULL OR $6::boolean)`;
  const args=[p.tenantId,p.id,all,scopes,taskId,hasPermission(p,'task:read')];
  const counts=(await db.query(`SELECT count(*) FILTER (WHERE r.state='offered')::int AS offered,
    count(*) FILTER (WHERE r.state='accepted')::int AS accepted,count(*) FILTER (WHERE r.state='unconfirmed')::int AS unconfirmed,
    count(*) FILTER (WHERE r.state='read')::int AS read,count(*) FILTER (WHERE r.stuck)::int AS stuck
    FROM inbox i JOIN inbox_receipt_status r USING(delivery_id) WHERE ${access}`,args)).rows[0];
  const items=taskId ? [] : (await db.query(`SELECT i.id,i.scope,i.task_id,r.* FROM inbox i JOIN inbox_receipt_status r USING(delivery_id)
    WHERE ${access} ORDER BY r.stuck DESC,i.created_at DESC,i.id,r.session LIMIT 50`,args)).rows;
  return {counts,items};
}
