-- Device actions (docs/RING-AGENT.md §11.3): reminders, events and timers may run on the iPhone instead of the Mac.
-- runner='device' rows are never executed by the Mac; the phone claims them (device_id) and reports the outcome.
-- device_id on a Mac row is the phone that sent the memo, so a Mac permission failure can flip the row to it.
ALTER TABLE local_actions
 ADD COLUMN runner text NOT NULL DEFAULT 'mac' CHECK (runner IN ('mac','device')),
 ADD COLUMN device_id uuid;
ALTER TABLE local_actions DROP CONSTRAINT local_actions_status_check;
ALTER TABLE local_actions ADD CONSTRAINT local_actions_status_check
 CHECK (status IN ('queued','running','done','failed','undoing','undone'));

DROP INDEX local_actions_pending_idx;
CREATE INDEX local_actions_pending_idx ON local_actions (updated_at) WHERE status IN ('queued','running') AND runner = 'mac';
CREATE INDEX local_actions_device_idx ON local_actions (tenant_id, updated_at) WHERE runner = 'device' AND status IN ('queued','undoing');

-- The memo request carried device_actions (a current iPhone client): a Mac permission failure goes to the phone.
ALTER TABLE voice_intents ADD COLUMN device_capable boolean NOT NULL DEFAULT false;
