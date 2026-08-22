UPDATE `profiles`
SET `bio` = '#TangGang | Opinions my own,  nothing here is financial advice.',
    `updated_at` = CURRENT_TIMESTAMP
WHERE `handle` = 'bullish0x';
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`,`target_handle`,`kind`,`rank`)
SELECT `wallet`, 'degenwaffle', 'friend', 0
FROM `profiles`
WHERE `handle` <> 'degenwaffle';
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`,`target_handle`,`kind`,`rank`)
SELECT '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d', `handle`, 'friend', 0
FROM `profiles`
WHERE `handle` <> 'degenwaffle';
