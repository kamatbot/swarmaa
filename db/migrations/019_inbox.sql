CREATE TABLE inbox_sessions (
  tenant_id text NOT NULL,
  session text NOT NULL CHECK (length(session) <= 240),
  principal_id uuid NOT NULL REFERENCES principals(id),
  PRIMARY KEY (tenant_id, session)
);

CREATE TABLE task_watchers (
  task_id uuid NOT NULL REFERENCES tasks(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  session text NOT NULL,
  PRIMARY KEY (task_id, principal_id, session)
);

CREATE TABLE inbox (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  recipient_principal uuid NOT NULL REFERENCES principals(id),
  recipient_session text,
  kind text NOT NULL CHECK (kind IN ('task_finished','message')),
  scope text NOT NULL,
  task_id uuid REFERENCES tasks(id),
  task_version integer,
  from_principal uuid NOT NULL REFERENCES principals(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  read_at timestamptz,
  CHECK (kind <> 'task_finished' OR (task_id IS NOT NULL AND task_version IS NOT NULL))
);
CREATE INDEX inbox_pending_idx ON inbox(tenant_id, recipient_principal, created_at, id)
  WHERE delivered_at IS NULL AND read_at IS NULL;
CREATE INDEX inbox_sender_idx ON inbox(tenant_id, from_principal, created_at) WHERE kind='message';
CREATE UNIQUE INDEX inbox_finished_idx ON inbox(task_id, task_version, recipient_principal, COALESCE(recipient_session,''))
  WHERE kind='task_finished';

CREATE FUNCTION inbox_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('swarmaa_inbox', NEW.recipient_principal::text);
  RETURN NEW;
END;
$$;
CREATE TRIGGER inbox_inserted AFTER INSERT ON inbox FOR EACH ROW EXECUTE FUNCTION inbox_notify();
