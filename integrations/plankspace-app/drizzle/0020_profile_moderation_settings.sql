CREATE TABLE IF NOT EXISTS `site_settings` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_by` text NOT NULL DEFAULT '',
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO `site_settings` (`key`, `value`)
VALUES ('auto_approve_profiles', 'false')
ON CONFLICT (`key`) DO NOTHING;
