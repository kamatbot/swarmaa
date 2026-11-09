import type { Pool } from 'pg';

const BATCH = 5000;
const MAX_BATCHES = 20; // per table per sweep; an hourly timer drains any larger backlog

/** Deletes in bounded batches so no single statement holds locks or bloats WAL for long. */
async function drain(pool: Pool, sql: string, params: unknown[]): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = (await pool.query(sql, [...params, BATCH])).rowCount ?? 0;
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

/**
 * Prunes append-only logs older than `days`. Events are read by (xid,seq) cursors, so removing old rows never changes
 * what a client with an older cursor receives next (it only skips events that no longer exist). Events not yet passed
 * by the push cursor, or still referenced by a webhook delivery, are kept.
 * Deliberately not pruned (deliverables): task_runs, artifacts, inbox, chat_sessions.
 */
export async function sweepRetention(pool: Pool, days: number): Promise<{ event_deliveries: number; events: number; audit_log: number }> {
  const event_deliveries = await drain(pool, `DELETE FROM event_deliveries WHERE (subscription_id,event_id) IN (
      SELECT subscription_id,event_id FROM event_deliveries
      WHERE state IN ('delivered','failed','skipped') AND updated_at<clock_timestamp()-interval '7 days' LIMIT $1)`, []);
  const events = await drain(pool, `DELETE FROM events WHERE id IN (
      SELECT e.id FROM events e
      WHERE e.created_at<clock_timestamp()-make_interval(days=>$1::int)
        AND (e.xid,e.seq)<=(SELECT last_xid,last_seq FROM push_cursor WHERE id=1)
        AND NOT EXISTS (SELECT 1 FROM event_deliveries d WHERE d.event_id=e.id) LIMIT $2)`, [days]);
  const audit_log = await drain(pool, `DELETE FROM audit_log WHERE id IN (
      SELECT id FROM audit_log WHERE created_at<clock_timestamp()-make_interval(days=>$1::int) LIMIT $2)`, [days]);
  return { event_deliveries, events, audit_log };
}
