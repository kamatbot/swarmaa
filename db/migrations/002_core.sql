-- Shared memory and durable work. Each table is accessed through tenant/scope checks.
CREATE TABLE memories (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('note','observation','preference','decision','procedure','hypothesis')),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 240),
  content text NOT NULL CHECK (octet_length(content) <= 32768),
  source jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed','active','retracted')),
  version integer NOT NULL CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES principals(id),
  reviewed_by uuid REFERENCES principals(id),
  reviewed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', key || ' ' || content)) STORED,
  UNIQUE (tenant_id, scope, key)
);
CREATE INDEX memories_scope ON memories (tenant_id, scope, status, updated_at DESC);
CREATE INDEX memories_search ON memories USING gin (search_vector);

CREATE TABLE memory_revisions (
  memory_id uuid NOT NULL REFERENCES memories(id),
  version integer NOT NULL,
  content text NOT NULL,
  source jsonb NOT NULL,
  status text NOT NULL,
  expires_at timestamptz,
  actor_id uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (memory_id, version)
);

CREATE TABLE memory_proposals (
  id uuid PRIMARY KEY,
  memory_id uuid NOT NULL REFERENCES memories(id),
  tenant_id text NOT NULL,
  scope text NOT NULL,
  expected_version integer,
  observed_version integer NOT NULL,
  proposed_content text NOT NULL,
  proposed_source jsonb NOT NULL,
  proposed_expires_at timestamptz,
  status text NOT NULL CHECK (status IN ('proposed','conflict','accepted','superseded','retracted')),
  actor_id uuid NOT NULL REFERENCES principals(id),
  resolved_by uuid REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz
);
CREATE INDEX memory_proposals_pending ON memory_proposals (memory_id, status, created_at);

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('research','review','patch')),
  objective text NOT NULL CHECK (octet_length(objective) <= 32768),
  constraints jsonb NOT NULL DEFAULT '[]',
  acceptance_criteria jsonb NOT NULL DEFAULT '[]',
  permission_envelope jsonb NOT NULL,
  required_capability text NOT NULL,
  resource_key text,
  context_refs uuid[] NOT NULL DEFAULT '{}',
  context_versions jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('queued','running','blocked','completed','failed','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES principals(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  continuation_count integer NOT NULL DEFAULT 0 CHECK (continuation_count BETWEEN 0 AND 20),
  lease_generation integer NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_owner uuid REFERENCES principals(id),
  lease_hash text,
  lease_expires_at timestamptz,
  checkpoint jsonb,
  result jsonb,
  artifact_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (tenant_id, created_by, idempotency_key),
  CHECK (kind <> 'patch' OR resource_key IS NOT NULL),
  CHECK ((status = 'running' AND lease_owner IS NOT NULL AND lease_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'running' AND lease_owner IS NULL AND lease_hash IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX tasks_queue ON tasks (tenant_id, scope, status, required_capability, created_at);
CREATE INDEX tasks_expired_leases ON tasks (tenant_id, scope, lease_expires_at) WHERE status = 'running';

CREATE TABLE task_runs (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  generation integer NOT NULL,
  worker_id uuid NOT NULL REFERENCES principals(id),
  lease_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','completed','failed','blocked','abandoned','cancelled')),
  completion_hash text,
  result jsonb,
  artifact_ids uuid[] NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  UNIQUE (task_id, generation)
);

CREATE TABLE task_resource_leases (
  tenant_id text NOT NULL,
  scope text NOT NULL,
  resource_key text NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks(id),
  generation integer NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, scope, resource_key)
);

CREATE TABLE task_instructions (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  actor_id uuid NOT NULL REFERENCES principals(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  instruction text NOT NULL CHECK (octet_length(instruction) <= 32768),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_id, actor_id, idempotency_key)
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks(id),
  run_generation integer NOT NULL,
  created_by uuid NOT NULL REFERENCES principals(id),
  name text NOT NULL,
  media_type text NOT NULL,
  content text NOT NULL CHECK (octet_length(content) <= 262144),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 262144),
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_id, run_generation, name)
);
CREATE INDEX artifacts_task ON artifacts (tenant_id, scope, task_id, created_at);
