CREATE TABLE `pi_configuration` (
	`id` integer PRIMARY KEY NOT NULL,
	`encrypted_json` text NOT NULL,
	`revision` integer NOT NULL,
	`mutation_id` text NOT NULL,
	`updated_at` text NOT NULL
);
