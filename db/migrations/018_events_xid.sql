ALTER TABLE events ADD COLUMN xid xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE INDEX events_scope_xid_seq_idx ON events(tenant_id, scope, xid, seq);

ALTER TABLE principals DROP CONSTRAINT principals_scopes_check;
ALTER TABLE principals ADD CONSTRAINT principals_scopes_check CHECK (cardinality(scopes) BETWEEN 1 AND 512);
