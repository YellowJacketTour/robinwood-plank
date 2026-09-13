ALTER TABLE charmville_encounters ADD COLUMN IF NOT EXISTS origin_region_id text;
ALTER TABLE charmville_encounters ADD COLUMN IF NOT EXISTS terminal_at timestamptz;
UPDATE charmville_encounters SET origin_region_id=region_id WHERE origin_region_id IS NULL;
UPDATE charmville_encounters SET terminal_at=clock_timestamp() WHERE terminal_at IS NULL AND (hp=0 OR captured);
CREATE OR REPLACE FUNCTION charmville_encounter_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN NEW.origin_region_id=NEW.region_id;
 ELSE NEW.origin_region_id=OLD.origin_region_id; END IF;
 IF (NEW.hp=0 OR NEW.captured) AND NEW.terminal_at IS NULL THEN NEW.terminal_at=clock_timestamp(); END IF;
 RETURN NEW;END $$;
DROP TRIGGER IF EXISTS charmville_encounter_history_trigger ON charmville_encounters;
CREATE TRIGGER charmville_encounter_history_trigger BEFORE INSERT OR UPDATE ON charmville_encounters FOR EACH ROW EXECUTE FUNCTION charmville_encounter_history();
CREATE TABLE IF NOT EXISTS charmville_habitat_budget(region_id text PRIMARY KEY,window_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),spawn_count integer NOT NULL DEFAULT 1 CHECK(spawn_count BETWEEN 1 AND 3));
