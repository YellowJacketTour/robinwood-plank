CREATE TABLE `moderation_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_wallet` text NOT NULL,
	`status` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`moderator_wallet` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profile_relations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_wallet` text NOT NULL,
	`target_handle` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_auth_challenges` (
	`nonce` text PRIMARY KEY NOT NULL,
	`wallet` text NOT NULL,
	`action` text NOT NULL,
	`resource` text NOT NULL,
	`payload_hash` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
DROP TABLE `auth_challenges`;--> statement-breakpoint
ALTER TABLE `__new_auth_challenges` RENAME TO `auth_challenges`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
