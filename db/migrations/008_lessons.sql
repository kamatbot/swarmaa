-- Reviewed lessons distilled from recorded chats (distill -> review -> reuse), and the distill job's progress.

-- More harnesses may record chats. Drop whatever CHECK guards chat_sessions.harness (its generated name is not relied on).
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'chat_sessions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%harness%'
  LOOP
    EXECUTE format('ALTER TABLE chat_sessions DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_harness_check CHECK (harness IN (
  'claude-code','codex','antigravity','dot','grok','cursor','opencode','copilot','cline','roo','devin','kiro',
  'windsurf','gemini','hermes','factory','pi','other'));

CREATE TABLE lessons (
  id text PRIMARY KEY CHECK (id ~ '^lesson_[0-9a-f]{64}$'),
  tenant_id text NOT NULL,
  scope text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('workflow','correction','debugging_pattern','gotcha','convention')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  applicability text NOT NULL CHECK (length(applicability) BETWEEN 1 AND 600),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  tags text[] NOT NULL DEFAULT '{}',
  -- [{session_id uuid, turns int[], summary text}]
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate','approved','rejected','superseded')),
  source text NOT NULL CHECK (source IN ('distill','agent','owner')),
  -- Safety lint finding ids; advisory for the reviewer.
  flags text[] NOT NULL DEFAULT '{}',
  proposed_by uuid NOT NULL REFERENCES principals(id),
  review_reason text,
  reviewed_by uuid REFERENCES principals(id),
  superseded_by text REFERENCES lessons(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_at timestamptz,
  CHECK ((state = 'superseded') = (superseded_by IS NOT NULL))
);
CREATE INDEX lessons_scope_state_idx ON lessons (tenant_id, scope, state, updated_at DESC);
CREATE INDEX lessons_search_idx ON lessons USING gin (to_tsvector('simple', title || ' ' || applicability || ' ' || body));

CREATE TABLE distill_runs (
  session_id uuid PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  task_id uuid REFERENCES tasks(id),
  state text NOT NULL CHECK (state IN ('submitted','harvested','skipped','failed')),
  reason text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX distill_runs_task_idx ON distill_runs (tenant_id, state, task_id);
