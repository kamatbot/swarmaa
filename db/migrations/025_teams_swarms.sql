-- Teams Phase 2: swarms, steps, handoffs, questions, channels, sections, and task resolution.

ALTER TABLE threads ADD COLUMN lead_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;

CREATE TABLE thread_members (
  tenant_id text NOT NULL,
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id, agent_id)
);
CREATE INDEX thread_members_agent_idx ON thread_members (tenant_id, agent_id);

CREATE TABLE sections (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  order_index integer NOT NULL DEFAULT 0,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  collapsed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sections_principal_idx ON sections (tenant_id, principal_id, order_index ASC);

CREATE TABLE swarms (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  goal text NOT NULL,
  owner_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  thread_id uuid REFERENCES threads(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('planning','running','waiting_on_you','blocked','done','cancelled')) DEFAULT 'running',
  flow_id uuid REFERENCES flow_runs(id) ON DELETE SET NULL,
  summary_task_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES principals(id),
  idempotency_key text,
  request_hash text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  UNIQUE (tenant_id, created_by, idempotency_key)
);
CREATE INDEX swarms_scope_idx ON swarms (tenant_id, scope, status, updated_at DESC);
CREATE INDEX swarms_thread_idx ON swarms (thread_id);

CREATE TABLE swarm_steps (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  swarm_id uuid NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
  step_key text,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  assignee_agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  needs uuid[] NOT NULL DEFAULT '{}',
  instructions text,
  "check" text,
  status text NOT NULL CHECK (status IN ('pending','running','waiting_on_you','blocked','done','failed','cancelled')) DEFAULT 'pending',
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  result_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  failure_code text,
  failure_detail text,
  order_index integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX swarm_steps_swarm_idx ON swarm_steps (swarm_id, order_index ASC);
CREATE INDEX swarm_steps_task_idx ON swarm_steps (task_id);
CREATE INDEX swarm_steps_assignee_idx ON swarm_steps (tenant_id, assignee_agent_id, status);

CREATE TABLE questions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  swarm_step_id uuid REFERENCES swarm_steps(id) ON DELETE SET NULL,
  prompt text NOT NULL CHECK (octet_length(prompt) <= 500),
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  multi boolean NOT NULL DEFAULT false,
  free_text boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('open','answered','expired')) DEFAULT 'open',
  choices jsonb,
  answer_text text,
  answered_by uuid REFERENCES principals(id),
  answered_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX questions_tenant_status_idx ON questions (tenant_id, status, created_at DESC);
CREATE INDEX questions_thread_idx ON questions (thread_id, status);
CREATE INDEX questions_step_idx ON questions (swarm_step_id);

ALTER TABLE tasks ALTER COLUMN swarm_step_id TYPE uuid USING (CASE WHEN swarm_step_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN swarm_step_id::uuid ELSE NULL END);
ALTER TABLE tasks ADD CONSTRAINT tasks_swarm_step_id_fkey FOREIGN KEY (swarm_step_id) REFERENCES swarm_steps(id) ON DELETE SET NULL;
CREATE INDEX tasks_swarm_step_idx ON tasks (swarm_step_id);

ALTER TABLE tasks ADD COLUMN initiator_kind text NOT NULL DEFAULT 'person' CHECK (initiator_kind IN ('person','handoff','swarm','answer','flow'));
ALTER TABLE tasks ADD COLUMN initiator_id text;
ALTER TABLE tasks ADD COLUMN resolved_at timestamptz;
CREATE INDEX tasks_resolved_idx ON tasks (tenant_id, scope, resolved_at);
CREATE INDEX tasks_initiator_idx ON tasks (tenant_id, initiator_kind);

ALTER TABLE events DROP CONSTRAINT events_name_check;
ALTER TABLE events ADD CONSTRAINT events_name_check CHECK (name IN ('task.updated','memory.changed','message.created','message.updated','swarm.updated','agent.updated','question.created','question.answered','thread.read'));

DO $$
BEGIN
  IF to_regclass('event_subscriptions') IS NOT NULL THEN
    ALTER TABLE event_subscriptions DROP CONSTRAINT IF EXISTS event_subscriptions_name_check;
    ALTER TABLE event_subscriptions ADD CONSTRAINT event_subscriptions_name_check CHECK (name IN ('task.updated','memory.changed','message.created','message.updated','swarm.updated','agent.updated','question.created','question.answered','thread.read'));
  END IF;
END $$;
