INSERT OR IGNORE INTO `profiles` (`wallet`, `handle`, `display_name`, `bio`, `moderation_status`)
VALUES (
  '0x72d0fd2f9cdd52905f8db816efba9cce8abf684d',
  'imirowav',
  'Imiro.wav',
  'Tang Gang - The Grove',
  'approved'
);
--> statement-breakpoint
UPDATE `profiles`
SET `display_name` = 'Imiro.wav',
    `bio` = 'Tang Gang - The Grove',
    `moderation_status` = 'approved',
    `moderation_note` = '',
    `updated_at` = CURRENT_TIMESTAMP
WHERE lower(`wallet`) = '0x72d0fd2f9cdd52905f8db816efba9cce8abf684d';
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`, `target_handle`, `kind`, `rank`)
SELECT '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d', 'imirowav', 'top8', COALESCE(MAX(`rank`), 0) + 1
FROM `profile_relations`
WHERE `owner_wallet` = '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d' AND `kind` = 'top8'
HAVING COUNT(*) < 8;
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`, `target_handle`, `kind`, `rank`)
VALUES ('0x72d0fd2f9cdd52905f8db816efba9cce8abf684d', 'degenwaffle', 'friend', 0);
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`, `target_handle`, `kind`, `rank`)
VALUES ('0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d', 'imirowav', 'friend', 0);
