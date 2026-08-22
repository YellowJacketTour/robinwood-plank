INSERT OR IGNORE INTO `profiles` (`wallet`, `handle`, `display_name`, `bio`, `moderation_status`)
VALUES (
  '0x7558cd06f3f53391e50d093ee000266b685fc875',
  'illl_umin8',
  'illL_umiN8',
  'shine in the dark so that they may see the light💡' || char(10) || char(10) ||
  'placebo yourself appropriately👁️' || char(10) || char(10) ||
  'part builder, part dreamer, full TangTard -  wandering somewhere in-between the space and time of the grove🍊' || char(10) || char(10) ||
  'here to create, learn, build, experiment, laugh at the absurdity of it all, and hopefully leave this place a little better than I found it👊' || char(10) || char(10) ||
  'seeds in the dirt. code in the ether.' || char(10) ||
  'chia growing. planks stacking. flame always lit❤️‍🔥' || char(10) || char(10) ||
  'stay curious. stay phunky. stay planked.🪵',
  'approved'
);
--> statement-breakpoint
UPDATE `profiles`
SET `display_name` = 'illL_umiN8',
    `bio` =
      'shine in the dark so that they may see the light💡' || char(10) || char(10) ||
      'placebo yourself appropriately👁️' || char(10) || char(10) ||
      'part builder, part dreamer, full TangTard -  wandering somewhere in-between the space and time of the grove🍊' || char(10) || char(10) ||
      'here to create, learn, build, experiment, laugh at the absurdity of it all, and hopefully leave this place a little better than I found it👊' || char(10) || char(10) ||
      'seeds in the dirt. code in the ether.' || char(10) ||
      'chia growing. planks stacking. flame always lit❤️‍🔥' || char(10) || char(10) ||
      'stay curious. stay phunky. stay planked.🪵',
    `moderation_status` = 'approved',
    `moderation_note` = '',
    `updated_at` = CURRENT_TIMESTAMP
WHERE lower(`wallet`) = '0x7558cd06f3f53391e50d093ee000266b685fc875';
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`, `target_handle`, `kind`, `rank`)
SELECT
  '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d',
  'illl_umin8',
  'top8',
  COALESCE(MAX(`rank`), 0) + 1
FROM `profile_relations`
WHERE `owner_wallet` = '0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d'
  AND `kind` = 'top8'
HAVING EXISTS (SELECT 1 FROM `profiles` WHERE `handle` = 'illl_umin8')
   AND COUNT(*) < 8;
