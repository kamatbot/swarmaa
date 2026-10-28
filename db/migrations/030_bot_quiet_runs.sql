-- Only actual scheduled turns advance this watermark; idle/busy ticks leave it unchanged.
ALTER TABLE bots ADD COLUMN last_scheduled_run_at timestamptz;
CREATE INDEX events_scope_created_idx ON events(tenant_id, scope, created_at);
