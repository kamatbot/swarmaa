-- 046's tool split moved push, voice memo, watch memo and local action tools behind the new app:device
-- permission. Identities created before it (the Mac app and paired iPhones) hold thread:write but not
-- app:device, so grant it to every live frontend identity that already has the native app's thread access.
UPDATE principals
SET permissions = array_append(permissions, 'app:device')
WHERE role = 'frontend'
  AND 'thread:write' = ANY(permissions)
  AND NOT ('app:device' = ANY(permissions));
