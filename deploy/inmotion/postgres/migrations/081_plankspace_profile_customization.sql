ALTER TABLE plankspace_profiles
  ADD COLUMN IF NOT EXISTS custom_css text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS customization_warnings_json text NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS customization_version integer NOT NULL DEFAULT 1;

UPDATE plankspace_profiles
SET custom_css = substring(custom_html from '<style[^>]*>([\s\S]*?)</style>'),
    custom_html = regexp_replace(custom_html, '<style[^>]*>[\s\S]*?</style>', '', 'gi')
WHERE custom_css = '' AND custom_html ~* '<style';
