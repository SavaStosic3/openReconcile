CREATE TABLE `model_grants` (
	`model_id` text NOT NULL,
	`user_id` text NOT NULL,
	`level` text NOT NULL,
	PRIMARY KEY(`model_id`, `user_id`),
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `model_grants_user_idx` ON `model_grants` (`user_id`);--> statement-breakpoint
CREATE TABLE `model_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`run_json` text NOT NULL,
	`started_at` text NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `model_runs_model_time_idx` ON `model_runs` (`model_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`model_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`edit_locked` integer DEFAULT false NOT NULL,
	`unpublish_locked` integer DEFAULT false NOT NULL,
	`schedule_json` text NOT NULL,
	`sources_json` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
