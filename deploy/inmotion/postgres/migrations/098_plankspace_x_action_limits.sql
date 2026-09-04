ALTER TABLE plankspace_x_accounts
  ADD COLUMN IF NOT EXISTS last_published_at text,
  ADD COLUMN IF NOT EXISTS last_imported_at text;

INSERT INTO plankspace_site_settings (key, value, updated_by, updated_at)
VALUES ('x_post_cooldown_minutes', '5', '', CURRENT_TIMESTAMP)
ON CONFLICT (key) DO NOTHING;
