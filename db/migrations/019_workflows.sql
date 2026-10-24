-- A deliberately fixed workflow: two independent reviews of one commit, then synthesis.
-- Task leases, attempts and artifacts remain authoritative in the existing task tables.
CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  template text NOT NULL CHECK (template = 'independent_review_v1'),
  objective text NOT NULL CHECK (octet_length(objective) BETWEEN 1 AND 24000),
  base_commit text NOT NULL CHECK (base_commit ~ '^[0-9a-f]{40}$'),
  reviewers text[] NOT NULL CHECK (cardinality(reviewers) = 2 AND reviewers[1] <> reviewers[2]
    AND reviewers <@ ARRAY['claude','codex','antigravity']::text[]),
  synthesis_provider text NOT NULL CHECK (synthesis_provider IN ('auto','claude','codex','antigravity')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','blocked','failed','cancelled')),
  verification text NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified','approved','rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES principals(id),
  authorization_snapshot jsonb NOT NULL,
  -- Preserve the originating grant ID even if an expired grant is later deleted.
  -- A missing grant fails authorization; SET NULL would silently widen that authority.
  oauth_grant_id uuid,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 3),
  timeout_seconds integer NOT NULL CHECK (timeout_seconds BETWEEN 300 AND 86400),
  deadline_at timestamptz NOT NULL,
  reason text,
  reviewed_by uuid REFERENCES principals(id),
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, created_by, idempotency_key),
  CHECK (verification = 'unverified' OR (status = 'completed' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX workflow_runs_scope ON workflow_runs (tenant_id, scope, created_at DESC, id DESC);
CREATE INDEX workflow_runs_pending ON workflow_runs (reconciled_at, id) WHERE status = 'running';

ALTER TABLE tasks ADD COLUMN workflow_id uuid REFERENCES workflow_runs(id);
ALTER TABLE tasks ADD COLUMN workflow_step text;
ALTER TABLE tasks ADD CONSTRAINT tasks_workflow_shape CHECK (
  (workflow_id IS NULL AND workflow_step IS NULL) OR
  (workflow_id IS NOT NULL AND workflow_step IS NOT NULL AND workflow_step IN ('reviewer_a','reviewer_b','synthesis')
    AND kind = 'review' AND base_ref IS NOT NULL AND base_ref ~ '^[0-9a-f]{40}$')
);
ALTER TABLE tasks ADD CONSTRAINT tasks_workflow_step_unique UNIQUE (workflow_id, workflow_step);
ALTER TABLE tasks ADD CONSTRAINT tasks_workflow_identity_unique UNIQUE (id, workflow_id, workflow_step);

CREATE TABLE workflow_steps (
  id uuid PRIMARY KEY,
  workflow_id uuid NOT NULL REFERENCES workflow_runs(id),
  step_key text NOT NULL CHECK (step_key IN ('reviewer_a','reviewer_b','synthesis')),
  task_id uuid NOT NULL UNIQUE,
  depends_on text[] NOT NULL,
  activated_at timestamptz,
  UNIQUE (workflow_id, step_key),
  FOREIGN KEY (task_id, workflow_id, step_key) REFERENCES tasks (id, workflow_id, workflow_step),
  CHECK ((step_key IN ('reviewer_a','reviewer_b') AND cardinality(depends_on) = 0 AND activated_at IS NOT NULL)
    OR (step_key = 'synthesis' AND depends_on = ARRAY['reviewer_a','reviewer_b']::text[]))
);
