INSERT OR IGNORE INTO `profiles` (`wallet`, `handle`, `display_name`, `bio`, `moderation_status`)
VALUES (
  '0x8439bf8e1fdd160da268a89c397d0921a17043b4',
  'generaldeez',
  'GeneralDeez',
  'Based ass OG! Ya betta axe somebody!' || char(10) || char(10) ||
  'Remember when you could do a little recreational cocain without the dear of dying?',
  'approved'
);
--> statement-breakpoint
UPDATE `profiles`
SET `display_name` = 'GeneralDeez',
    `bio` = 'Based ass OG! Ya betta axe somebody!' || char(10) || char(10) ||
      'Remember when you could do a little recreational cocain without the dear of dying?',
    `moderation_status` = 'approved',
    `moderation_note` = '',
    `updated_at` = CURRENT_TIMESTAMP
WHERE lower(`wallet`) = '0x8439bf8e1fdd160da268a89c397d0921a17043b4';
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`, `target_handle`, `kind`, `rank`)
SELECT
  '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d',
  'generaldeez',
  'top8',
  COALESCE(MAX(`rank`), 0) + 1
FROM `profile_relations`
WHERE `owner_wallet` = '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d'
  AND `kind` = 'top8'
HAVING EXISTS (SELECT 1 FROM `profiles` WHERE `handle` = 'generaldeez')
   AND COUNT(*) < 8;
