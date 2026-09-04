-- Optional media attachments for Lumberyard posts and profile knocks.
-- Additive and backward-compatible: the previous release continues to read
-- the existing text/body columns and ignores these defaults.
ALTER TABLE plankspace_posts
  ADD COLUMN IF NOT EXISTS media_url text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS media_alt text NOT NULL DEFAULT '';

ALTER TABLE plankspace_profile_comments
  ADD COLUMN IF NOT EXISTS media_url text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS media_alt text NOT NULL DEFAULT '';
