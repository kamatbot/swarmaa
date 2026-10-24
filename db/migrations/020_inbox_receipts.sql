ALTER TABLE inbox ADD COLUMN delivery_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;

CREATE TABLE inbox_receipts (
  delivery_id uuid NOT NULL REFERENCES inbox(delivery_id),
  session text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state IN ('offered','accepted','unconfirmed','read')),
  offers integer NOT NULL DEFAULT 0 CHECK (offers BETWEEN 0 AND 3),
  offered_at timestamptz,
  confirm_by timestamptz,
  accepted_at timestamptz,
  read_at timestamptz,
  unconfirmed_at timestamptz,
  PRIMARY KEY (delivery_id,session)
);
CREATE INDEX inbox_receipts_expiry_idx ON inbox_receipts(confirm_by) WHERE state='offered';
CREATE INDEX inbox_recipient_idx ON inbox(tenant_id,recipient_principal,created_at,id);

-- Legacy delivery proves only a handoff, never acceptance. Unknown sessions stay principal-level.
INSERT INTO inbox_receipts(delivery_id,session,state,offers,offered_at,read_at,unconfirmed_at)
SELECT delivery_id,COALESCE(recipient_session,''),CASE WHEN read_at IS NULL THEN 'unconfirmed' ELSE 'read' END,
  CASE WHEN delivered_at IS NULL THEN 0 ELSE 1 END,delivered_at,read_at,
  CASE WHEN read_at IS NULL THEN delivered_at END
FROM inbox WHERE delivered_at IS NOT NULL OR read_at IS NOT NULL;

-- Expiry is visible even before another poll, without making reconciliation lookups write.
CREATE VIEW inbox_receipt_status AS
SELECT delivery_id,session,
  CASE WHEN state='offered' AND confirm_by<=clock_timestamp() THEN 'unconfirmed' ELSE state END AS state,
  offers,offered_at,confirm_by,accepted_at,read_at,
  CASE WHEN state='offered' AND confirm_by<=clock_timestamp() THEN confirm_by ELSE unconfirmed_at END AS unconfirmed_at,
  (offers=3 AND (state='unconfirmed' OR (state='offered' AND confirm_by<=clock_timestamp()))) AS stuck
FROM inbox_receipts;
