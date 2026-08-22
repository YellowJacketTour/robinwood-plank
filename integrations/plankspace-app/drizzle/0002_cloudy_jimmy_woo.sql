ALTER TABLE `profiles` ADD `hobbies` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `interests` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `music` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `heroes` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `looking_to_meet` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `avatar_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `mood` text DEFAULT 'feeling board' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `mood_text` text DEFAULT 'holding down the lumberyard.' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `moderation_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `moderation_note` text DEFAULT '' NOT NULL;