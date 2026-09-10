ALTER TABLE charmville_creature_entities ADD COLUMN IF NOT EXISTS following boolean NOT NULL DEFAULT false;
-- Import the starter preference once; other creatures never inherit its toggle.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='charmville_following_compat') THEN
  UPDATE charmville_creature_entities e SET following=c.following FROM charmville_companions c WHERE c.id=e.id;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION charmville_import_following() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.acquisition_kind='starter' THEN
  NEW.following=COALESCE((SELECT following FROM charmville_companions WHERE id=NEW.id),false);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS charmville_following_compat ON charmville_creature_entities;
CREATE TRIGGER charmville_following_compat BEFORE INSERT ON charmville_creature_entities FOR EACH ROW EXECUTE FUNCTION charmville_import_following();
-- Older clients can still change their starter, never the rest of the roster.
CREATE OR REPLACE FUNCTION charmville_sync_starter_following() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE charmville_creature_entities SET following=NEW.following WHERE id=NEW.id AND following<>NEW.following;
 IF FOUND THEN
  UPDATE charmville_creature_rosters SET revision=revision+1 WHERE profile_id=NEW.owner_profile_id;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS charmville_starter_following_compat ON charmville_companions;
CREATE TRIGGER charmville_starter_following_compat AFTER UPDATE OF following ON charmville_companions FOR EACH ROW EXECUTE FUNCTION charmville_sync_starter_following();
