-- Bots: a persistent, configured swarm. A bot owns one thread (kind 'bot') whose members are its crew and whose
-- lead answers it; its routing and rules apply to every task it starts. See docs/BOTS.md.

ALTER TABLE threads DROP CONSTRAINT threads_kind_check;
ALTER TABLE threads ADD CONSTRAINT threads_kind_check CHECK (kind IN ('agent_main','agent_side','channel','bot'));

CREATE TABLE bots (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  job text NOT NULL CHECK (octet_length(job) <= 8192),
  avatar text,
  thread_id uuid NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
  lead_agent_id uuid NOT NULL REFERENCES agents(id),
  -- {"research"|"patch"|"review"|"summary": runner}; runner = {"mode":"auto"} | {"provider","model"?,"effort"?},
  -- and review may also be {"mode":"different_from_author"}. A missing kind means auto.
  routing jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(routing) = 'object'),
  -- {"quota_floor_pct": 0-50, "approve_public": bool, "review_edits": bool, "require_tests": bool}
  rules jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rules) = 'object'),
  schedule text CHECK (schedule IS NULL OR length(schedule) BETWEEN 9 AND 120),
  next_run_at timestamptz,
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES principals(id),
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, created_by, idempotency_key)
);
CREATE UNIQUE INDEX bots_live_name_key ON bots (tenant_id, scope, lower(name)) WHERE NOT archived;
CREATE INDEX bots_scope_idx ON bots (tenant_id, scope, archived, updated_at DESC);
CREATE INDEX bots_schedule_idx ON bots (next_run_at) WHERE schedule IS NOT NULL AND NOT archived;

-- Every task a bot starts (its turns, swarm steps, handoffs, reviews, checks) carries the bot.
ALTER TABLE tasks ADD COLUMN bot_id uuid REFERENCES bots(id) ON DELETE SET NULL;
CREATE INDEX tasks_bot_idx ON tasks (tenant_id, bot_id, status, updated_at DESC) WHERE bot_id IS NOT NULL;

ALTER TABLE tasks DROP CONSTRAINT tasks_initiator_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_initiator_kind_check CHECK (initiator_kind IN ('person','handoff','swarm','answer','flow','schedule','bot_check'));

-- A task card in a bot thread: ref {"task_id"}; body is a one-line, service-written summary.
ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text','handoff','swarm','run','question','answer','notice','task'));

ALTER TABLE events DROP CONSTRAINT events_name_check;
ALTER TABLE events ADD CONSTRAINT events_name_check CHECK (name IN ('task.updated','memory.changed','message.created','message.updated','swarm.updated','agent.updated','question.created','question.answered','thread.read','bot.updated'));

DO $$
BEGIN
  IF to_regclass('event_subscriptions') IS NOT NULL THEN
    ALTER TABLE event_subscriptions DROP CONSTRAINT IF EXISTS event_subscriptions_name_check;
    ALTER TABLE event_subscriptions ADD CONSTRAINT event_subscriptions_name_check CHECK (name IN ('task.updated','memory.changed','message.created','message.updated','swarm.updated','agent.updated','question.created','question.answered','thread.read','bot.updated'));
  END IF;
END $$;
