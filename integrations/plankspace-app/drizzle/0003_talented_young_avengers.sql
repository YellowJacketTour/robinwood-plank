CREATE TABLE `profile_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_handle` text NOT NULL,
	`author` text DEFAULT 'Anonymous Board' NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
