-- Teams Phase 1: persistent agents, threads, messages, turn tasks, read cursors and provider sessions.

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  role text NOT NULL CHECK (length(role) BETWEEN 1 AND 64),
  instructions text NOT NULL CHECK (octet_length(instructions) <= 8192),
  runner jsonb NOT NULL,
  edits boolean NOT NULL DEFAULT false,
  avatar text,
  main_thread_id uuid,
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES principals(id),
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, scope, name),
  UNIQUE (tenant_id, created_by, idempotency_key)
);
CREATE INDEX agents_scope_idx ON agents (tenant_id, scope, archived, created_at DESC);

CREATE TABLE threads (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  agent_id uuid REFERENCES agents(id),
  kind text NOT NULL CHECK (kind IN ('agent_main','agent_side','channel')),
  title text,
  archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX threads_scope_idx ON threads (tenant_id, scope, archived, updated_at DESC);
CREATE INDEX threads_agent_idx ON threads (tenant_id, agent_id);

ALTER TABLE agents ADD CONSTRAINT agents_main_thread_fk FOREIGN KEY (main_thread_id) REFERENCES threads(id) ON DELETE SET NULL;

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq bigint NOT NULL CHECK (seq > 0),
  author jsonb NOT NULL,
  kind text NOT NULL CHECK (kind IN ('text','handoff','swarm','run','question','answer','notice')),
  body text NOT NULL CHECK (octet_length(body) <= 16384),
  ref jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  edited_at timestamptz,
  UNIQUE (thread_id, seq),
  UNIQUE (tenant_id, thread_id, author, idempotency_key)
);
CREATE INDEX messages_thread_seq_idx ON messages (thread_id, seq DESC);
CREATE INDEX messages_scope_idx ON messages (tenant_id, scope, created_at DESC);

CREATE TABLE thread_reads (
  tenant_id text NOT NULL,
  principal_id uuid NOT NULL REFERENCES principals(id),
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  last_read_seq bigint NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, principal_id, thread_id)
);
CREATE INDEX thread_reads_thread_idx ON thread_reads (thread_id, principal_id);

CREATE TABLE agent_provider_sessions (
  tenant_id text NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider text NOT NULL,
  session_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, agent_id, provider)
);

ALTER TABLE tasks ADD COLUMN agent_id uuid REFERENCES agents(id);
ALTER TABLE tasks ADD COLUMN thread_id uuid REFERENCES threads(id);
ALTER TABLE tasks ADD COLUMN swarm_step_id text;

ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (kind IN ('research','review','patch','check','approve','turn'));

CREATE INDEX tasks_agent_idx ON tasks (tenant_id, agent_id, status);

ALTER TABLE events DROP CONSTRAINT events_name_check;
ALTER TABLE events ADD CONSTRAINT events_name_check CHECK (name IN ('task.updated','memory.changed','message.created','message.updated','swarm.updated','agent.updated','question.created','question.answered','thread.read'));

DO $$
BEGIN
  IF to_regclass('event_subscriptions') IS NOT NULL THEN
    ALTER TABLE event_subscriptions DROP CONSTRAINT IF EXISTS event_subscriptions_name_check;
    ALTER TABLE event_subscriptions ADD CONSTRAINT event_subscriptions_name_check CHECK (name IN ('task.updated','memory.changed','message.created','message.updated','swarm.updated','agent.updated','question.created','question.answered','thread.read'));
  END IF;
END $$;
