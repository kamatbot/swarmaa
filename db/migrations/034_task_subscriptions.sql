CREATE TABLE task_subscriptions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  external_thread_ref text NOT NULL CHECK (length(external_thread_ref) <= 300),
  created_via text NOT NULL CHECK (created_via IN ('tool','branch_match')),
  created_by uuid NOT NULL REFERENCES principals(id),
  budget_remaining integer NOT NULL DEFAULT 5 CHECK (budget_remaining BETWEEN 0 AND 20),
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '14 days',
  last_delivery_at timestamptz,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_id, external_thread_ref)
);
CREATE INDEX task_subscriptions_ref_idx ON task_subscriptions (tenant_id, source_id, external_thread_ref) WHERE active;
CREATE UNIQUE INDEX task_subscriptions_idem_uidx ON task_subscriptions (tenant_id, created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
