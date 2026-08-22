CREATE TABLE `friend_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requester_wallet` text NOT NULL,
	`requester_handle` text NOT NULL,
	`recipient_wallet` text NOT NULL,
	`recipient_handle` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `friend_requests_pair_unique` ON `friend_requests` (`requester_wallet`,`recipient_wallet`);--> statement-breakpoint
CREATE INDEX `friend_requests_recipient_idx` ON `friend_requests` (`recipient_wallet`,`status`,`created_at`);