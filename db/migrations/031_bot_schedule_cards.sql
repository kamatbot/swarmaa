-- 030 is reserved for quiet scheduled runs; this migration is independent.
ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text','handoff','swarm','run','question','answer','notice','task','schedule'));
CREATE UNIQUE INDEX messages_bot_schedule_card_idx ON messages (tenant_id, thread_id, (ref->>'bot_id')) WHERE kind='schedule';
