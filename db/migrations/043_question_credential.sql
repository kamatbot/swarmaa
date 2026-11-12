-- A question that asks the owner for a credential (an environment variable name). Its value is never
-- sent through Swarmaa: the owner stores it in the Mac's Keychain and the bridge passes it to that bot.
ALTER TABLE questions ADD COLUMN credential text CHECK (credential ~ '^[A-Z][A-Z0-9_]{1,63}$' AND credential !~ '^(COLLECTIVE|SWARMAA)_');
