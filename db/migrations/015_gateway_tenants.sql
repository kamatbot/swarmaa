-- Discoverable sign-in has no tenant until its credential is resolved.
ALTER TABLE webauthn_challenges ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE webauthn_challenges ADD CHECK (purpose='authenticate' OR tenant_id IS NOT NULL);
UPDATE webauthn_challenges SET tenant_id=NULL WHERE purpose='authenticate' AND used_at IS NULL;

-- Owner consent stays bound to the signed-in tenant through approval.
ALTER TABLE oauth_pending ADD COLUMN owner_tenant text;
