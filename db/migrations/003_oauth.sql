-- Public OAuth clients have no client secrets. All bearer/code material is hashed.
CREATE TABLE oauth_clients (
  client_id text PRIMARY KEY,
  client_name text NOT NULL,
  redirect_uris text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(redirect_uris) BETWEEN 1 AND 8)
);

CREATE TABLE oauth_pending (
  id uuid PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  state text,
  challenge text NOT NULL,
  resource text NOT NULL,
  csrf_hash text NOT NULL,
  browser_hash text NOT NULL,
  grant_snapshot jsonb,
  expires_at timestamptz NOT NULL
);
CREATE INDEX oauth_pending_expiry_idx ON oauth_pending(expires_at);

CREATE TABLE oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES principals(id),
  redirect_uri text NOT NULL,
  challenge text NOT NULL,
  resource text NOT NULL,
  grant_snapshot jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX oauth_codes_expiry_idx ON oauth_codes(expires_at);

-- A refresh family is also the authorization grant: replay revokes the family.
CREATE TABLE oauth_grants (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  resource text NOT NULL,
  grant_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX oauth_grants_principal_idx ON oauth_grants(principal_id);
CREATE INDEX oauth_grants_expiry_idx ON oauth_grants(expires_at);

CREATE TABLE oauth_access_tokens (
  token_hash text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_access_grant_idx ON oauth_access_tokens(grant_id);
CREATE INDEX oauth_access_expiry_idx ON oauth_access_tokens(expires_at);

CREATE TABLE oauth_refresh_tokens (
  token_hash text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_refresh_grant_idx ON oauth_refresh_tokens(grant_id);
CREATE INDEX oauth_refresh_expiry_idx ON oauth_refresh_tokens(expires_at);
