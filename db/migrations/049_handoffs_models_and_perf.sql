-- Handoffs, dynamic model catalog, multi-bot fan-in dispatch groups, and hot-path indexes.

CREATE INDEX IF NOT EXISTS tasks_unresolved_bot_idx
  ON tasks (tenant_id, bot_id)
  WHERE resolved_at IS NULL;

ALTER TABLE principals
  ADD COLUMN IF NOT EXISTS model_catalog JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE swarms
  ADD COLUMN IF NOT EXISTS dispatched_from JSONB;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_initiator_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_initiator_kind_check
  CHECK (initiator_kind IN ('person','agent','handoff','swarm','answer','flow','schedule','bot_check','source'));

CREATE TABLE IF NOT EXISTS dispatch_groups (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  coordinator_scope TEXT NOT NULL,
  coordinator_thread_id UUID NOT NULL,
  coordinator_agent_id UUID NOT NULL,
  coordinator_bot_id UUID,
  total INT NOT NULL,
  completed INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  synthesized BOOLEAN NOT NULL DEFAULT FALSE,
  counted UUID[] NOT NULL DEFAULT '{}', -- task ids already counted, so a continued or retried task counts once
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS dispatch_groups_tenant_thread_idx
  ON dispatch_groups (tenant_id, coordinator_thread_id)
  WHERE NOT synthesized;

-- Antigravity never runs unattended work (schedules, webhooks, scheduled checks), including the turns that work spawns:
-- handoffs, project dispatches, channel posts, swarm steps and fan-in syntheses. Finishing an unattended task sets
-- swarmaa.unattended for its transaction, and every task inserted in that transaction excludes Antigravity. The
-- exclusion is itself inherited, because the finish of an excluded task sets the same flag.
CREATE OR REPLACE FUNCTION tasks_inherit_unattended() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('swarmaa.unattended', true) = 'on' AND NOT ('antigravity' = ANY(NEW.excluded_providers)) THEN
    NEW.excluded_providers := array_append(NEW.excluded_providers, 'antigravity');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tasks_inherit_unattended ON tasks;
CREATE TRIGGER tasks_inherit_unattended BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION tasks_inherit_unattended();
