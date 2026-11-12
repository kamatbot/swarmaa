ALTER TABLE sources ADD COLUMN cooldown_seconds integer NOT NULL DEFAULT 0
  CHECK (cooldown_seconds >= 0 AND cooldown_seconds <= 86400);
