-- Recent chat turns recorded by each harness, so any harness can list and continue another's chat.
CREATE TABLE chat_sessions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  harness text NOT NULL CHECK (harness IN ('claude-code','codex','antigravity','dot','grok','other')),
  session_key text NOT NULL,
  principal_id uuid NOT NULL REFERENCES principals(id),
  title text,
  cwd text,
  turns jsonb NOT NULL DEFAULT '[]'::jsonb,
  turn_count integer NOT NULL DEFAULT 0,
  last_text text,
  ended boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, harness, session_key)
);

CREATE INDEX chat_sessions_recent_idx ON chat_sessions(tenant_id, scope, updated_at DESC);
