-- AUDIT lens 4 #3 (2026-09-06): a token whose tokenURI host is dead was
-- re-tried every 30 minutes forever, so a collection's rarity could never
-- finalize (Pudgy Penguins sat at 8,871 of 8,888 for hours). Count attempts;
-- after the cap the token is marked 'empty' with the reason and the
-- collection can finalize on the tokens that exist.
ALTER TABLE plank_collection_tokens ADD COLUMN IF NOT EXISTS metadata_attempts INTEGER NOT NULL DEFAULT 0;
