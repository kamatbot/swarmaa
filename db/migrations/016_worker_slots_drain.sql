-- A draining worker reports 0 slots: it finishes what it runs and takes nothing new.
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_worker_slots_check;
ALTER TABLE principals ADD CONSTRAINT principals_worker_slots_check CHECK (worker_slots BETWEEN 0 AND 16);
