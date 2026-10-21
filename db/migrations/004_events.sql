CREATE TABLE event_subscriptions (
  id text PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  oauth_grant_id uuid REFERENCES oauth_grants(id),
  credential_version integer NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  name text NOT NULL CHECK (name IN ('task.updated','memory.changed')),
  mode text NOT NULL CHECK (mode IN ('mcp','generic')),
  callback_url text NOT NULL,
  secret_ciphertext text NOT NULL,
  previous_secret_ciphertext text,
  previous_secret_until timestamptz,
  verified_until timestamptz NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX event_subscriptions_owner_idx ON event_subscriptions(principal_id, active);

CREATE TABLE event_deliveries (
  subscription_id text NOT NULL REFERENCES event_subscriptions(id),
  event_id uuid NOT NULL REFERENCES events(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','delivered','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lock_token uuid,
  locked_until timestamptz,
  last_status integer,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(subscription_id, event_id)
);
CREATE INDEX event_deliveries_due_idx ON event_deliveries(next_attempt_at) WHERE state IN ('pending','sending');
