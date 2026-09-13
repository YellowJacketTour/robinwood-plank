-- Presentation preference only. Completing or replaying the introduction never
-- grants inventory, experience, currency, or access to gameplay.
CREATE TABLE IF NOT EXISTS charmville_tutorial_preferences (
 profile_id bigint PRIMARY KEY REFERENCES plankspace_profiles(id) ON DELETE CASCADE,
 completed boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
