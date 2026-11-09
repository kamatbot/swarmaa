-- Per-worker running counts (task submit, swarm_status) and the recent-tasks list.
CREATE INDEX tasks_running_lease_owner_idx ON tasks (lease_owner) WHERE status = 'running';
CREATE INDEX tasks_tenant_updated_idx ON tasks (tenant_id, updated_at DESC);
