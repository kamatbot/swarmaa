CREATE TABLE principals (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','frontend','worker')),
  scopes text[] NOT NULL,
  permissions text[] NOT NULL,
  token_hash text NOT NULL UNIQUE,
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  CHECK (cardinality(scopes) BETWEEN 1 AND 64),
  CHECK (role = 'admin' OR NOT ('*' = ANY(scopes)))
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  actor_id uuid NOT NULL REFERENCES principals(id),
  scope text,
  operation text NOT NULL,
  subject_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_created_idx ON audit_log(tenant_id, created_at DESC);

CREATE TABLE events (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  name text NOT NULL CHECK (name IN ('task.updated','memory.changed')),
  subject_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX events_scope_seq_idx ON events(tenant_id, scope, seq);
