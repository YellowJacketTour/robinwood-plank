CREATE TABLE `board_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sender_wallet` text NOT NULL,
	`sender_handle` text NOT NULL,
	`recipient_wallet` text NOT NULL,
	`recipient_handle` text NOT NULL,
	`subject` text DEFAULT 'Board Mail' NOT NULL,
	`body` text NOT NULL,
	`read_at` text,
	`deleted_by_sender` integer DEFAULT false NOT NULL,
	`deleted_by_recipient` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `board_messages_recipient_idx` ON `board_messages` (`recipient_wallet`,`created_at`);--> statement-breakpoint
CREATE INDEX `board_messages_sender_idx` ON `board_messages` (`sender_wallet`,`created_at`);--> statement-breakpoint
CREATE TABLE `game_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wallet` text NOT NULL,
	`handle` text NOT NULL,
	`score` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `game_scores_score_idx` ON `game_scores` (`score`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipient_wallet` text NOT NULL,
	`actor_wallet` text DEFAULT '' NOT NULL,
	`actor_handle` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`href` text DEFAULT '/' NOT NULL,
	`read_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_recipient_idx` ON `notifications` (`recipient_wallet`,`created_at`);--> statement-breakpoint
CREATE TABLE `owner_access_attempts` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`window_started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reporter_wallet` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reports_status_idx` ON `reports` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `posts` ADD `moderation_status` text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE `profile_comments` ADD `moderation_status` text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE `profile_relations` ADD `rank` integer DEFAULT 0 NOT NULL;