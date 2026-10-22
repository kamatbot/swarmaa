-- Owner passkey sign-in for the OAuth approval page. Single owner per tenant.
-- Invite codes, session tokens and browser bindings are stored only as sha256 hashes.
CREATE TABLE owner_passkeys (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX owner_passkeys_tenant_idx ON owner_passkeys(tenant_id);

CREATE TABLE passkey_invites (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE webauthn_challenges (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('register','authenticate')),
  challenge text NOT NULL,
  bound_to text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX webauthn_challenges_lookup_idx ON webauthn_challenges(challenge);
CREATE INDEX webauthn_challenges_expiry_idx ON webauthn_challenges(expires_at);

-- A signed-in browser. Never accepted as an MCP/REST bearer credential.
CREATE TABLE owner_sessions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX owner_sessions_expiry_idx ON owner_sessions(expires_at);
