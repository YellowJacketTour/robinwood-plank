INSERT OR IGNORE INTO `profiles` (`wallet`,`handle`,`display_name`,`bio`,`moderation_status`)
VALUES ('0x7304b78e28370f45fdf77ca67bdbbf550c3aac34','sawtoshiknotamoto','Sawtoshi Knotamoto','Life on the Planktation','approved');
--> statement-breakpoint
UPDATE `profiles` SET `display_name`='Sawtoshi Knotamoto',`bio`='Life on the Planktation',`moderation_status`='approved',`moderation_note`='',`updated_at`=CURRENT_TIMESTAMP
WHERE lower(`wallet`)='0x7304b78e28370f45fdf77ca67bdbbf550c3aac34';
--> statement-breakpoint
INSERT OR IGNORE INTO `profiles` (`wallet`,`handle`,`display_name`,`bio`,`moderation_status`)
VALUES (
 '0x7a354040b3aeff974b7be38259d923fa0969ee1a',
 'ibenpharmin',
 'IbenPharmin',
 'GenX | Content Creator | Decentralized Generation @OnTheBlokkchain #EnTRAPreneur' || char(10) ||
 '@aWizardxch #HighCouncil #TangGang' || char(10) ||
 'Meme what you say & Say what you meme..',
 'approved'
);
--> statement-breakpoint
UPDATE `profiles`
SET `display_name`='IbenPharmin',
    `bio`='GenX | Content Creator | Decentralized Generation @OnTheBlokkchain #EnTRAPreneur' || char(10) || '@aWizardxch #HighCouncil #TangGang' || char(10) || 'Meme what you say & Say what you meme..',
    `moderation_status`='approved',`moderation_note`='',`updated_at`=CURRENT_TIMESTAMP
WHERE lower(`wallet`)='0x7a354040b3aeff974b7be38259d923fa0969ee1a';
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`,`target_handle`,`kind`,`rank`)
VALUES ('0x7304b78e28370f45fdf77ca67bdbbf550c3aac34','degenwaffle','friend',0);
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`,`target_handle`,`kind`,`rank`)
VALUES ('0x7a354040b3aeff974b7be38259d923fa0969ee1a','degenwaffle','friend',0);
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`,`target_handle`,`kind`,`rank`)
VALUES ('0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d','sawtoshiknotamoto','friend',0);
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_relations` (`owner_wallet`,`target_handle`,`kind`,`rank`)
VALUES ('0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d','ibenpharmin','friend',0);
