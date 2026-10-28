ALTER TABLE bots ADD COLUMN starred boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX bots_one_star_per_tenant
  ON bots (tenant_id) WHERE starred AND NOT archived;
