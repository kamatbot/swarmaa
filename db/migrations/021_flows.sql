CREATE TABLE flow_definitions (
  tenant_id text NOT NULL,
  id text NOT NULL,
  definition jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,id)
);
CREATE TABLE flow_runs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  definition jsonb NOT NULL,
  inputs jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES principals(id),
  owner_id uuid REFERENCES principals(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,created_by,idempotency_key)
);
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (kind IN ('research','review','patch','check','approve'));
ALTER TABLE tasks ADD COLUMN flow_id uuid REFERENCES flow_runs(id);
ALTER TABLE tasks ADD COLUMN flow jsonb;
ALTER TABLE tasks ADD CONSTRAINT tasks_flow_check CHECK ((flow_id IS NULL) = (flow IS NULL));
ALTER TABLE tasks ADD CONSTRAINT tasks_gate_check CHECK (kind NOT IN ('check','approve') OR flow_id IS NOT NULL);
CREATE UNIQUE INDEX tasks_flow_step ON tasks(flow_id,(flow->>'step_id')) WHERE flow_id IS NOT NULL;
ALTER TABLE inbox DROP CONSTRAINT inbox_kind_check;
ALTER TABLE inbox ADD CONSTRAINT inbox_kind_check CHECK (kind IN ('task_finished','message','flow_approval'));
CREATE UNIQUE INDEX inbox_flow_approval ON inbox(task_id,recipient_principal) WHERE kind='flow_approval';
