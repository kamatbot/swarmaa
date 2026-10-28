-- Archived agents no longer hold their name: only live agents in a scope must be unique, case-insensitively.
ALTER TABLE agents DROP CONSTRAINT agents_tenant_id_scope_name_key;
CREATE UNIQUE INDEX agents_live_name_key ON agents (tenant_id, scope, lower(name)) WHERE NOT archived;
