-- A swarm may name the git ref its edit steps branch from (default: the project checkout's HEAD).
ALTER TABLE swarms ADD COLUMN base_ref text;

-- Every task created for a swarm step inherits the swarm's base_ref, whichever path queues it.
CREATE FUNCTION tasks_inherit_swarm_base_ref() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.swarm_step_id IS NOT NULL AND NEW.base_ref IS NULL THEN
    SELECT sw.base_ref INTO NEW.base_ref FROM swarm_steps st JOIN swarms sw ON sw.id = st.swarm_id WHERE st.id = NEW.swarm_step_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tasks_inherit_swarm_base_ref BEFORE INSERT ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_inherit_swarm_base_ref();
