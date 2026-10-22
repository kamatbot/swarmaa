-- Registration hygiene: track who registered a client and when it was last used so unused
-- or long-dead registrations can be expired opportunistically (see OAuthService.registerClient).
ALTER TABLE oauth_clients ADD COLUMN created_ip_hash text;
ALTER TABLE oauth_clients ADD COLUMN last_used_at timestamptz;
CREATE INDEX oauth_clients_created_idx ON oauth_clients(created_at);
CREATE INDEX oauth_clients_ip_idx ON oauth_clients(created_ip_hash, created_at) WHERE created_ip_hash IS NOT NULL;
CREATE INDEX oauth_grants_client_idx ON oauth_grants(client_id);
CREATE INDEX oauth_pending_client_idx ON oauth_pending(client_id);
