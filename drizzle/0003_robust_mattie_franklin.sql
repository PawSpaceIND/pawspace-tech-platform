CREATE TABLE `business_metric_definitions` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`formula_json` text NOT NULL,
	`source_tables_json` text NOT NULL,
	`owner_role` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `report_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`metrics_json` text NOT NULL,
	`dimensions_json` text NOT NULL,
	`filters_json` text NOT NULL,
	`formats_json` text NOT NULL,
	`schedule_json` text,
	`recipient_rules_json` text,
	`active` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `report_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`status` text NOT NULL,
	`format` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`snapshot_at` integer NOT NULL,
	`requested_by` text NOT NULL,
	`purpose` text NOT NULL,
	`masked` integer DEFAULT true NOT NULL,
	`output_reference` text,
	`created_at` integer NOT NULL
);
