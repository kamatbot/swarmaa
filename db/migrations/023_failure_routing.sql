ALTER TABLE tasks ADD COLUMN IF NOT EXISTS excluded_providers text[] NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS not_before timestamptz;
CREATE INDEX IF NOT EXISTS tasks_queue_not_before ON tasks (tenant_id, scope, status, not_before) WHERE status = 'queued';
