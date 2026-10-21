-- Provider quota readings reported by workers, and worker liveness, for swarm status and auto routing.
CREATE TABLE provider_usage (
  tenant_id text NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{0,49}$'),
  reporter_id uuid NOT NULL REFERENCES principals(id),
  ok boolean NOT NULL,
  headroom numeric(5,2) NOT NULL CHECK (headroom >= 0 AND headroom <= 100),
  windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);

ALTER TABLE principals ADD COLUMN last_seen_at timestamptz;
