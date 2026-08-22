INSERT OR IGNORE INTO `profiles` (`wallet`, `handle`, `display_name`, `bio`, `moderation_status`)
VALUES (
  '0xf899f549aaf979d8e451d42c31c48a4e39ac59c9',
  'aster_cast',
  'aster_cast',
  'lovecaster3000 | 🏠: @awizardxch |' || char(10) ||
  '@aster0x | Comics, Cards, Seeds, Fish and Wood',
  'approved'
);
--> statement-breakpoint
UPDATE `profiles`
SET `display_name` = 'aster_cast',
    `bio` = 'lovecaster3000 | 🏠: @awizardxch |' || char(10) ||
      '@aster0x | Comics, Cards, Seeds, Fish and Wood',
    `moderation_status` = 'approved',
    `moderation_note` = '',
    `updated_at` = CURRENT_TIMESTAMP
WHERE lower(`wallet`) = '0xf899f549aaf979d8e451d42c31c48a4e39ac59c9';
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`, `target_handle`, `kind`, `rank`)
SELECT
  '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d',
  'aster_cast',
  'top8',
  COALESCE(MAX(`rank`), 0) + 1
FROM `profile_relations`
WHERE `owner_wallet` = '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d'
  AND `kind` = 'top8'
HAVING EXISTS (SELECT 1 FROM `profiles` WHERE `handle` = 'aster_cast')
   AND COUNT(*) < 8;
