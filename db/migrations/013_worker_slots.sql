-- How many tasks a worker runs at once (its bridge's max_concurrent), so agents can see free capacity.
ALTER TABLE principals ADD COLUMN worker_slots integer CHECK (worker_slots BETWEEN 1 AND 16);
