CREATE TABLE `schedule_authorizations` (
	`model_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`generation` integer NOT NULL,
	`configured_at` text NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `scheduled_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`trigger` text NOT NULL DEFAULT 'scheduled',
	`generation` integer NOT NULL,
	`scheduled_at` text NOT NULL,
	`owner_token` text NOT NULL,
	`lease_until` integer NOT NULL,
	`state` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`run_json` text NOT NULL,
	`claimed_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE no action,
	CONSTRAINT `scheduled_jobs_state_check` CHECK (`state` IN ('claimed','running','output','finished','interrupted','cancelled')),
	CONSTRAINT `scheduled_jobs_trigger_check` CHECK (`trigger` IN ('scheduled','manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_jobs_occurrence_idx` ON `scheduled_jobs` (`model_id`,`generation`,`scheduled_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_jobs_active_model_idx` ON `scheduled_jobs` (`model_id`) WHERE `state` IN ('claimed','running','output');
--> statement-breakpoint
CREATE INDEX `scheduled_jobs_lease_idx` ON `scheduled_jobs` (`state`,`lease_until`);
--> statement-breakpoint
CREATE INDEX `scheduled_jobs_model_time_idx` ON `scheduled_jobs` (`model_id`,`claimed_at`);
