ALTER TABLE events DROP CONSTRAINT events_name_check;
ALTER TABLE events ADD CONSTRAINT events_name_check CHECK (name IN ('task.updated','memory.changed','message.created','message.updated','message.deleted','swarm.updated','agent.updated','question.created','question.answered','thread.read','bot.updated','source.delivery'));

DO $$
BEGIN
  IF to_regclass('event_subscriptions') IS NOT NULL THEN
    ALTER TABLE event_subscriptions DROP CONSTRAINT IF EXISTS event_subscriptions_name_check;
    ALTER TABLE event_subscriptions ADD CONSTRAINT event_subscriptions_name_check CHECK (name IN ('task.updated','memory.changed','message.created','message.updated','message.deleted','swarm.updated','agent.updated','question.created','question.answered','thread.read','bot.updated','source.delivery'));
  END IF;
END $$;
