INSERT OR IGNORE INTO `profiles` (`wallet`, `handle`, `display_name`, `bio`, `moderation_status`)
VALUES ('0x725b9c03d07450a5d66fe5266a9a50dcccfa590f', 'bfl', 'BFL🍊', '"What if I told you, it''s all just a meme?"', 'approved');
--> statement-breakpoint
UPDATE `profiles`
SET `display_name` = 'BFL🍊',
    `bio` = '"What if I told you, it''s all just a meme?"',
    `moderation_status` = 'approved',
    `moderation_note` = '',
    `updated_at` = CURRENT_TIMESTAMP
WHERE lower(`wallet`) = '0x725b9c03d07450a5d66fe5266a9a50dcccfa590f';
--> statement-breakpoint
INSERT OR IGNORE INTO `profiles` (`wallet`, `handle`, `display_name`, `bio`, `moderation_status`)
VALUES ('0x2bb7e2184b2dfc2595d6a8a557507bb763c4eb44', 'byronstyles', 'ByronStyles', '$RTRD on Cronos | Sonic is, $DUMB on $S | XCH / Chia | PLANK''R on RH' || char(10) || 'Doer of things and stuff on the intah-webs | Part-time shit poster', 'approved');
--> statement-breakpoint
UPDATE `profiles`
SET `display_name` = 'ByronStyles',
    `bio` = '$RTRD on Cronos | Sonic is, $DUMB on $S | XCH / Chia | PLANK''R on RH' || char(10) || 'Doer of things and stuff on the intah-webs | Part-time shit poster',
    `moderation_status` = 'approved',
    `moderation_note` = '',
    `updated_at` = CURRENT_TIMESTAMP
WHERE lower(`wallet`) = '0x2bb7e2184b2dfc2595d6a8a557507bb763c4eb44';
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`, `target_handle`, `kind`, `rank`)
SELECT '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d', 'bfl', 'top8', COALESCE(MAX(`rank`), 0) + 1
FROM `profile_relations`
WHERE `owner_wallet` = '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d'
  AND `kind` = 'top8'
HAVING EXISTS (SELECT 1 FROM `profiles` WHERE `handle` = 'bfl')
   AND COUNT(*) < 8;
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`, `target_handle`, `kind`, `rank`)
SELECT '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d', 'byronstyles', 'top8', COALESCE(MAX(`rank`), 0) + 1
FROM `profile_relations`
WHERE `owner_wallet` = '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d'
  AND `kind` = 'top8'
HAVING EXISTS (SELECT 1 FROM `profiles` WHERE `handle` = 'byronstyles')
   AND COUNT(*) < 8;
