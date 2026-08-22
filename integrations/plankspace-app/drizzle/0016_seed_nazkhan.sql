INSERT OR IGNORE INTO `profiles` (`wallet`, `handle`, `display_name`, `bio`, `moderation_status`)
VALUES (
  '0x70d50867373331acda3513fd353ec4d394f2331c',
  'nazkhan',
  'Naz Khan',
  'The message has always been PLANK.LOVE' || char(10) || '#TangGang' || char(10) || '#9mmPro',
  'approved'
);
--> statement-breakpoint
UPDATE `profiles`
SET `display_name` = 'Naz Khan',
    `bio` = 'The message has always been PLANK.LOVE' || char(10) || '#TangGang' || char(10) || '#9mmPro',
    `moderation_status` = 'approved',
    `moderation_note` = '',
    `updated_at` = CURRENT_TIMESTAMP
WHERE lower(`wallet`) = '0x70d50867373331acda3513fd353ec4d394f2331c';
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`, `target_handle`, `kind`, `rank`)
SELECT '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d', 'nazkhan', 'top8', COALESCE(MAX(`rank`), 0) + 1
FROM `profile_relations`
WHERE `owner_wallet` = '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d' AND `kind` = 'top8'
HAVING COUNT(*) < 8;
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`, `target_handle`, `kind`, `rank`)
VALUES ('0x70d50867373331acda3513fd353ec4d394f2331c', 'degenwaffle', 'friend', 0);
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`, `target_handle`, `kind`, `rank`)
VALUES ('0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d', 'nazkhan', 'friend', 0);
