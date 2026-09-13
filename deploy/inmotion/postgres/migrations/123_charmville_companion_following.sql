ALTER TABLE charmville_companions ADD COLUMN IF NOT EXISTS following boolean NOT NULL DEFAULT false;
ALTER TABLE charmville_companions ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0);
