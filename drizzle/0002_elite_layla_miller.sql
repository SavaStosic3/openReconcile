CREATE TABLE `local_credentials` (
	`username` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_credentials_user_idx` ON `local_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `local_login_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`window_start` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `local_login_limits_time_idx` ON `local_login_limits` (`window_start`);--> statement-breakpoint
CREATE TABLE `local_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`user_updated_at` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `local_sessions_user_idx` ON `local_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `local_sessions_expiry_idx` ON `local_sessions` (`expires_at`);