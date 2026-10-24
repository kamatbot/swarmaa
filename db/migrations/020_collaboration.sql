-- Durable collaboration is data associated with a task, never an execution grant.
-- A message is supplied only at a future invocation boundary; no live injection is implied.
CREATE TABLE task_messages (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks(id),
  actor_id uuid NOT NULL REFERENCES principals(id),
  source_task_id uuid REFERENCES tasks(id),
  source_generation integer,
  kind text NOT NULL CHECK (kind IN ('context','question','answer','steer')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000 AND octet_length(body) <= 8192),
  reply_to uuid REFERENCES task_messages(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL,
  available_from_generation integer NOT NULL CHECK (available_from_generation > 0),
  delivery_status text NOT NULL CHECK (delivery_status IN ('accepted','deferred','delivered','failed')),
  delivery_reason text,
  delivered_generation integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_id,actor_id,idempotency_key),
  CHECK ((source_task_id IS NULL) = (source_generation IS NULL)),
  CHECK (source_generation IS NULL OR source_generation > 0),
  CHECK ((delivery_status = 'delivered') = (delivered_generation IS NOT NULL))
);
CREATE INDEX task_messages_task_idx ON task_messages (tenant_id,scope,task_id,created_at,id);
CREATE INDEX task_messages_pending_idx ON task_messages (task_id,available_from_generation,created_at,id)
  WHERE delivery_status IN ('accepted','deferred');

-- One frozen selection per owned task run, including an empty selection. A retry
-- after a lost response receives the same batch, not newly arrived messages.
CREATE TABLE task_message_batches (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  generation integer NOT NULL CHECK (generation > 0),
  worker_id uuid NOT NULL REFERENCES principals(id),
  message_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(message_ids) <= 20),
  payload_bytes integer NOT NULL CHECK (payload_bytes BETWEEN 0 AND 16384),
  has_more boolean NOT NULL DEFAULT false,
  delivery_status text NOT NULL DEFAULT 'accepted' CHECK (delivery_status IN ('accepted','deferred','delivered','failed')),
  delivery_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  UNIQUE (task_id,generation),
  FOREIGN KEY (task_id,generation) REFERENCES task_runs(task_id,generation),
  CHECK ((delivery_status = 'accepted') = (acknowledged_at IS NULL))
);
