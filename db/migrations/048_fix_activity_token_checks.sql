-- 042's checks used {1,512}; PostgreSQL regexes allow at most 255 repetitions, so every insert of a Live Activity
-- token failed with "invalid repetition count(s)". Same rule, written as a length check plus a hex check.
ALTER TABLE push_devices DROP CONSTRAINT push_devices_activity_start_token_check;
ALTER TABLE push_devices ADD CONSTRAINT push_devices_activity_start_token_check
  CHECK (activity_start_token IS NULL OR (activity_start_token ~ '^[0-9a-f]+$' AND length(activity_start_token) <= 512));

ALTER TABLE bot_activity_tokens DROP CONSTRAINT bot_activity_tokens_token_check;
ALTER TABLE bot_activity_tokens ADD CONSTRAINT bot_activity_tokens_token_check
  CHECK (token ~ '^[0-9a-f]+$' AND length(token) <= 512);
