CREATE TABLE push_devices (
  token text PRIMARY KEY CHECK (token ~ '^[0-9a-f]{64,200}$'),
  tenant_id text NOT NULL,
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX push_devices_tenant_idx ON push_devices (tenant_id);

-- Transaction ordering avoids losing events from transactions that commit out of seq order.
CREATE TABLE push_cursor (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_xid xid8 NOT NULL DEFAULT '0',
  last_seq bigint NOT NULL DEFAULT 0
);
INSERT INTO push_cursor (id) VALUES (1);
CREATE TABLE push_cooldowns (
  bot_id uuid PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL
);

CREATE INDEX events_push_xid_seq_idx ON events (xid,seq);
