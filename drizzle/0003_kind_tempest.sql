CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`model_id` text,
	`model_name` text,
	`category` text NOT NULL,
	`action` text NOT NULL,
	`summary` text NOT NULL,
	`target_id` text,
	`target_name` text,
	`changes_json` text NOT NULL,
	`revision_before` integer,
	`revision_after` integer,
	`truncated` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_time_idx` ON `audit_events` (`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `audit_events_model_time_idx` ON `audit_events` (`model_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `audit_events_actor_time_idx` ON `audit_events` (`actor_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE TABLE `audit_readings` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`model_id` text NOT NULL,
	`item_id` text NOT NULL,
	`item_name` text NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`unit` text,
	`previous_unit` text,
	`metric` text,
	`previous_metric` text,
	`meter_type` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_readings_model_item_idx` ON `audit_readings` (`model_id`,`item_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `audit_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`retention_days` integer DEFAULT 365 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text,
	`updated_by_id` text,
	`updated_by_name` text
);
