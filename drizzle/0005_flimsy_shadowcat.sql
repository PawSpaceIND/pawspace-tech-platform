CREATE TABLE `scheduling_assignment_decisions` (
	`group_id` text PRIMARY KEY NOT NULL,
	`strategy` text NOT NULL,
	`shortlist_json` text NOT NULL,
	`selected_provider_id` text,
	`status` text NOT NULL,
	`actor_id` text,
	`reason` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scheduling_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`service_code` text,
	`city_id` text,
	`zone_id` text,
	`priority` integer DEFAULT 100 NOT NULL,
	`condition_json` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
