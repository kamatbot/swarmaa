-- Worker runs are recorded as chats; task_id marks a chat as a swarm run (set by workers only).
ALTER TABLE chat_sessions ADD COLUMN task_id uuid NULL;
CREATE INDEX chat_sessions_task_idx ON chat_sessions(tenant_id, task_id) WHERE task_id IS NOT NULL;
