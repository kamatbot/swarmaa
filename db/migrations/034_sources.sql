CREATE TABLE sources (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('github')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  repo_full_name text NOT NULL CHECK (repo_full_name ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$'),
  secret_ciphertext text NOT NULL,              -- SecretBox(EVENT_ENCRYPTION_KEY), context `source:<id>`
  previous_secret_ciphertext text,              -- rotation overlap
  previous_secret_until timestamptz,
  accept_mode text NOT NULL DEFAULT 'observe' CHECK (accept_mode IN ('off','observe','auto')),
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,     -- see §4.2; validated in code, closed keys
  bot_id uuid REFERENCES bots(id),              -- where explicit/candidate events land (optional)
  created_by uuid NOT NULL REFERENCES principals(id),
  version integer NOT NULL DEFAULT 1,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX sources_repo_uidx ON sources (tenant_id, kind, lower(repo_full_name)) WHERE NOT archived;

CREATE TABLE source_deliveries (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  source_id uuid NOT NULL REFERENCES sources(id),
  delivery_id text NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 100),   -- X-GitHub-Delivery
  event_type text NOT NULL CHECK (length(event_type) <= 64),                 -- X-GitHub-Event
  action text CHECK (length(action) <= 64),
  body_sha256 text NOT NULL,
  digest jsonb NOT NULL,                       -- normalized, bounded, redacted fields (§4.3); never the raw body
  thread_ref text,                             -- canonical external ref (§3.3), null if none
  classification text CHECK (classification IN ('explicit','candidate','ignore')),
  reason text,                                 -- machine reason code, e.g. 'author_not_allowed'
  mode_at_receipt text NOT NULL CHECK (mode_at_receipt IN ('off','observe','auto')),
  status text NOT NULL DEFAULT 'received' CHECK (status IN
    ('received','ignored','observed','deferred','dispatched','continued','failed')),
  would_do jsonb,                              -- observe mode: {"continue_task": "<id>"} / {"post_bot": "<id>"}
  task_id uuid REFERENCES tasks(id),           -- task continued (auto)
  message_id uuid,                             -- bot-thread message posted (auto)
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  UNIQUE (source_id, delivery_id)
);
CREATE INDEX source_deliveries_pending_idx ON source_deliveries (next_attempt_at) WHERE status IN ('received','deferred');
CREATE INDEX source_deliveries_source_idx ON source_deliveries (source_id, received_at DESC);

ALTER TABLE tasks DROP CONSTRAINT tasks_initiator_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_initiator_kind_check CHECK (initiator_kind IN ('person','handoff','swarm','answer','flow','schedule','bot_check','source'));

ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text','handoff','swarm','run','question','answer','notice','task','schedule','source_event'));

ALTER TABLE events DROP CONSTRAINT events_name_check;
ALTER TABLE events ADD CONSTRAINT events_name_check CHECK (name IN ('task.updated','memory.changed','message.created','message.updated','swarm.updated','agent.updated','question.created','question.answered','thread.read','bot.updated','source.delivery'));

DO $$
BEGIN
  IF to_regclass('event_subscriptions') IS NOT NULL THEN
    ALTER TABLE event_subscriptions DROP CONSTRAINT IF EXISTS event_subscriptions_name_check;
    ALTER TABLE event_subscriptions ADD CONSTRAINT event_subscriptions_name_check CHECK (name IN ('task.updated','memory.changed','message.created','message.updated','swarm.updated','agent.updated','question.created','question.answered','thread.read','bot.updated','source.delivery'));
  END IF;
END $$;
