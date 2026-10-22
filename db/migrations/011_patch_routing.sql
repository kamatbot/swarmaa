-- Patch work routes like reads: tasks get an optional base_ref, and saved policies gain "patch" for providers whose default allows it.
ALTER TABLE tasks ADD COLUMN base_ref text;
-- Patches run in isolated git worktrees, so a resource lease is optional.
DO $$ DECLARE c text; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='tasks'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%resource_key IS NOT NULL%' LOOP
    EXECUTE format('ALTER TABLE tasks DROP CONSTRAINT %I',c);
  END LOOP;
END $$;
UPDATE routing_policies SET policy=jsonb_set(policy,'{providers}',(
  SELECT jsonb_agg(CASE WHEN p->>'provider' IN ('claude','codex','antigravity') AND NOT (p->'kinds') ? 'patch'
    THEN jsonb_set(p,'{kinds}',(p->'kinds')||'["patch"]'::jsonb) ELSE p END ORDER BY ord)
  FROM jsonb_array_elements(policy->'providers') WITH ORDINALITY AS t(p,ord)))
WHERE jsonb_typeof(policy->'providers')='array';
