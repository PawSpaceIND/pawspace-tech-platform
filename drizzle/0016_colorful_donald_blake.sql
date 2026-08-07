CREATE TABLE `system_integration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`internal_passed` integer NOT NULL,
	`internal_total` integer NOT NULL,
	`external_ready` integer NOT NULL,
	`external_total` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`actor_email` text NOT NULL,
	`created_at` integer NOT NULL
);
