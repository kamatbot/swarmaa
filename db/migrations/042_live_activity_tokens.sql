ALTER TABLE push_devices ADD COLUMN activity_start_token text
  CHECK (activity_start_token IS NULL OR activity_start_token ~ '^[0-9a-f]{1,512}$');

CREATE TABLE bot_activity_tokens (
  tenant_id text NOT NULL,
  device_id text NOT NULL REFERENCES push_devices(token) ON DELETE CASCADE,
  device_token text GENERATED ALWAYS AS (device_id) STORED,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  token text NOT NULL CHECK (token ~ '^[0-9a-f]{1,512}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (device_id, bot_id)
);

CREATE INDEX bot_activity_tokens_tenant_idx ON bot_activity_tokens (tenant_id);
CREATE INDEX bot_activity_tokens_bot_idx ON bot_activity_tokens (bot_id);

CREATE VIEW push_activity_tokens AS SELECT * FROM bot_activity_tokens;
CREATE VIEW live_activity_tokens AS SELECT * FROM bot_activity_tokens;
