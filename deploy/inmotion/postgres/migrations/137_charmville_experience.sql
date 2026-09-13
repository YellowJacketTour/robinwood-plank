CREATE TABLE IF NOT EXISTS charmville_creature_experience(creature_id uuid PRIMARY KEY REFERENCES charmville_creature_entities(id),xp integer NOT NULL CHECK(xp>=1));
CREATE TABLE IF NOT EXISTS charmville_defeat_awards(encounter_id uuid PRIMARY KEY REFERENCES charmville_encounters(id),result jsonb NOT NULL);
