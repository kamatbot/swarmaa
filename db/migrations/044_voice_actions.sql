-- Ring voice agent (docs/RING-AGENT.md §5.3, §8.3): one routing record per memo and durable local action rows.
-- Transcripts are not stored here; the redacted text lives in the "Voice memo" message.
CREATE TABLE voice_intents (
 tenant_id text NOT NULL, scope text NOT NULL, thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 memo_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES principals(id),
 transcript_sha256 text NOT NULL CHECK (transcript_sha256 ~ '^[0-9a-f]{64}$'),
 source text NOT NULL CHECK (source IN ('ring','watch','phone')),
 route text NOT NULL CHECK (route IN ('local','delegate','assistant')),
 hint text CHECK (hint IN ('freeform','multi','unparsed_time','meeting','no_transcript')),
 message_id uuid NOT NULL, message_seq bigint NOT NULL CHECK (message_seq > 0),
 delegated_bot_id uuid, delegated_name text CHECK (octet_length(delegated_name) <= 256),
 captured_at timestamptz NOT NULL, spoken_at timestamptz NOT NULL,
 time_zone text NOT NULL CHECK (octet_length(time_zone) BETWEEN 1 AND 64),
 duration_seconds double precision CHECK (duration_seconds BETWEEN 0 AND 86400),
 timings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(timings) = 'object' AND octet_length(timings::text) <= 4096),
 parse_ms integer CHECK (parse_ms >= 0), exec_ms integer CHECK (exec_ms >= 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (tenant_id, thread_id, memo_id)
);

-- origin_id: the memo id ('memo'), the turn task id ('turn') or principal:idempotency_key ('tool').
CREATE TABLE local_actions (
 id uuid PRIMARY KEY,
 tenant_id text NOT NULL, scope text NOT NULL, thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 origin_kind text NOT NULL CHECK (origin_kind IN ('memo','turn','tool')),
 origin_id text NOT NULL CHECK (octet_length(origin_id) BETWEEN 1 AND 256),
 ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
 type text NOT NULL CHECK (type IN ('reminder.create','event.create','note.append','timer.start')),
 action jsonb NOT NULL CHECK (jsonb_typeof(action) = 'object' AND octet_length(action::text) <= 32768),
 action_sha256 text NOT NULL CHECK (action_sha256 ~ '^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','undone')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
 code text CHECK (code IN ('permission_denied','action_disabled','timeout','unavailable','failed')),
 handle text CHECK (octet_length(handle) BETWEEN 1 AND 1024),
 summary text NOT NULL DEFAULT '' CHECK (octet_length(summary) <= 2000),
 message_id uuid, exec_ms integer CHECK (exec_ms >= 0),
 created_by uuid NOT NULL REFERENCES principals(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (tenant_id, origin_kind, origin_id, ordinal)
);
CREATE INDEX local_actions_pending_idx ON local_actions (updated_at) WHERE status IN ('queued','running');
CREATE INDEX local_actions_thread_idx ON local_actions (tenant_id, thread_id, created_at DESC);
