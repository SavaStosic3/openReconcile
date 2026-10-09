ALTER TABLE `models` ADD `published_model_json` text;--> statement-breakpoint
ALTER TABLE `models` ADD `published_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `published_at` text;
