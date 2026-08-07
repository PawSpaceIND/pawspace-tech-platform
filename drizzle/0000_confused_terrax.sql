CREATE TABLE `crm_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `crm_automations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`trigger_name` text NOT NULL,
	`action_name` text NOT NULL,
	`enabled` integer DEFAULT true,
	`runs` integer DEFAULT 0,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `crm_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`primary_phone` text NOT NULL,
	`secondary_phone` text,
	`email` text,
	`area` text,
	`pet_names` text,
	`pet_summary` text,
	`stage` text DEFAULT 'New lead' NOT NULL,
	`owner` text DEFAULT 'Unassigned',
	`source` text DEFAULT 'Website',
	`lifetime_value` real DEFAULT 0,
	`next_action` text,
	`opportunity` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `crm_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text,
	`title` text NOT NULL,
	`owner` text NOT NULL,
	`due_at` integer,
	`priority` text DEFAULT 'Normal',
	`status` text DEFAULT 'Open',
	`created_at` integer NOT NULL
);
