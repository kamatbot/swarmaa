-- Owner-configurable routing policy: provider priority, quota ceilings and allowed task kinds. No row means the built-in default.
CREATE TABLE routing_policies (
  tenant_id text PRIMARY KEY,
  policy jsonb NOT NULL,
  updated_by uuid NOT NULL REFERENCES principals(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
