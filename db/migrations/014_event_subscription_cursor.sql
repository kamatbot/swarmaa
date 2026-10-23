-- Per-subscription sequence cursor for bounded incremental event discovery.
ALTER TABLE event_subscriptions ADD COLUMN IF NOT EXISTS last_seq bigint NOT NULL DEFAULT 0;

UPDATE event_subscriptions s
SET last_seq = COALESCE((
  SELECT max(e.seq)
  FROM event_deliveries d
  JOIN events e ON e.id = d.event_id
  WHERE d.subscription_id = s.id
), COALESCE((
  SELECT max(e.seq)
  FROM events e
  WHERE e.tenant_id = s.tenant_id AND e.scope = s.scope AND e.name = s.name AND e.created_at < s.starts_at
), 0))
WHERE s.last_seq = 0;

CREATE INDEX IF NOT EXISTS events_scope_name_seq_idx ON events(tenant_id, scope, name, seq);
CREATE INDEX IF NOT EXISTS event_subscriptions_active_idx ON event_subscriptions(active, expires_at) WHERE active;
