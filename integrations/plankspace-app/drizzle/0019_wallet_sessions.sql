CREATE TABLE `wallet_sessions` (
  `token_hash` text PRIMARY KEY NOT NULL,
  `wallet` text NOT NULL,
  `expires_at` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `wallet_sessions_wallet_idx` ON `wallet_sessions` (`wallet`);
--> statement-breakpoint
CREATE INDEX `wallet_sessions_expiry_idx` ON `wallet_sessions` (`expires_at`);
