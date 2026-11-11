ALTER TABLE watch_memos ADD COLUMN transcript text NOT NULL DEFAULT '' CHECK (octet_length(transcript) <= 16384);
ALTER TABLE watch_memos ADD COLUMN announced boolean NOT NULL DEFAULT false;
-- Memos stored before this migration were never announced; do not post them retroactively.
UPDATE watch_memos SET announced = true WHERE status = 'stored';
