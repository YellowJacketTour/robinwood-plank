CREATE TABLE `post_likes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`wallet` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_likes_unique` ON `post_likes` (`post_id`,`wallet`);--> statement-breakpoint
ALTER TABLE `posts` ADD `author_wallet` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `profile_comments` ADD `author_wallet` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `profile_comments_handle_idx` ON `profile_comments` (`profile_handle`);--> statement-breakpoint
CREATE INDEX `profile_comments_author_time_idx` ON `profile_comments` (`author_wallet`,`created_at`);--> statement-breakpoint
CREATE INDEX `auth_challenges_wallet_idx` ON `auth_challenges` (`wallet`);--> statement-breakpoint
CREATE INDEX `auth_challenges_expiry_idx` ON `auth_challenges` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `profile_relations_unique` ON `profile_relations` (`owner_wallet`,`target_handle`,`kind`);