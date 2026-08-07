CREATE TABLE `booking_admin_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`actor_email` text NOT NULL,
	`created_at` integer NOT NULL
);
