CREATE TABLE `scheduling_availability` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`city_id` text NOT NULL,
	`zone_id` text NOT NULL,
	`date` text NOT NULL,
	`windows_json` text NOT NULL,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scheduling_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`service_code` text NOT NULL,
	`city_id` text NOT NULL,
	`zone_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`pet_ids_json` text NOT NULL,
	`scheduled_start` text NOT NULL,
	`scheduled_end` text NOT NULL,
	`capacity_units` integer DEFAULT 1 NOT NULL,
	`occurrence_number` integer DEFAULT 1 NOT NULL,
	`care_mode` text,
	`status` text DEFAULT 'assigned' NOT NULL,
	`explanation_json` text NOT NULL,
	`created_at` integer NOT NULL
);
