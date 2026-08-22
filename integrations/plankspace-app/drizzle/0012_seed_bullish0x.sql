INSERT OR IGNORE INTO `profiles` (`wallet`, `handle`, `display_name`, `bio`, `moderation_status`)
VALUES (
  '0x471601f3071ce057b0ddd539dc0e0c78450e73f0',
  'bullish0x',
  'Bullish 0x',
  '',
  'approved'
);
--> statement-breakpoint
UPDATE `profiles`
SET `display_name` = 'Bullish 0x',
    `moderation_status` = 'approved',
    `moderation_note` = '',
    `updated_at` = CURRENT_TIMESTAMP
WHERE lower(`wallet`) = '0x471601f3071ce057b0ddd539dc0e0c78450e73f0';
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`, `target_handle`, `kind`, `rank`)
SELECT
  '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d',
  'bullish0x',
  'top8',
  COALESCE(MAX(`rank`), 0) + 1
FROM `profile_relations`
WHERE `owner_wallet` = '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d'
  AND `kind` = 'top8'
HAVING EXISTS (SELECT 1 FROM `profiles` WHERE `handle` = 'bullish0x')
   AND COUNT(*) < 8;
