-- Audit remediation: event subscription xid cursor, task checkpoint throttle column,
-- message attachment flag, and hot-path / retention indexes.

ALTER TABLE event_subscriptions ADD COLUMN IF NOT EXISTS last_xid xid8 NOT NULL DEFAULT '0'::xid8;

UPDATE event_subscriptions s
SET last_xid = COALESCE((
  SELECT e.xid
  FROM events e
  WHERE e.tenant_id = s.tenant_id
    AND e.scope = s.scope
    AND e.name = s.name
    AND e.seq <= s.last_seq
  ORDER BY e.xid DESC, e.seq DESC
  LIMIT 1
), '0'::xid8)
WHERE s.last_xid = '0'::xid8 AND s.last_seq > 0;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_checkpoint_event_at TIMESTAMPTZ;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS has_attachments BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE messages
SET has_attachments = TRUE
WHERE ref IS NOT NULL
  AND jsonb_typeof(ref->'attachments') = 'array'
  AND jsonb_array_length(ref->'attachments') > 0
  AND NOT has_attachments;

CREATE INDEX IF NOT EXISTS events_checkpoint_throttle_idx
  ON events (tenant_id, scope, subject_id, created_at DESC)
  WHERE name = 'task.updated';

CREATE INDEX IF NOT EXISTS events_tenant_xid_seq_idx
  ON events (tenant_id, xid, seq);

CREATE INDEX IF NOT EXISTS events_created_at_idx
  ON events (created_at);

CREATE INDEX IF NOT EXISTS event_deliveries_event_id_idx
  ON event_deliveries (event_id);

CREATE INDEX IF NOT EXISTS event_deliveries_retention_idx
  ON event_deliveries (updated_at)
  WHERE state IN ('delivered', 'failed', 'skipped');

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx
  ON audit_log (created_at);

CREATE INDEX IF NOT EXISTS source_deliveries_received_at_idx
  ON source_deliveries (received_at);

CREATE INDEX IF NOT EXISTS tasks_scope_created_idx
  ON tasks (tenant_id, scope, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS tasks_running_turn_thread_idx
  ON tasks (tenant_id, thread_id)
  WHERE kind = 'turn' AND status = 'running';
