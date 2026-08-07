CREATE TABLE `launch_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`detail_json` text NOT NULL,
	`actor_email` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `launch_readiness_items` (
	`code` text PRIMARY KEY NOT NULL,
	`module` text NOT NULL,
	`title` text NOT NULL,
	`priority` text NOT NULL,
	`launch_stage` text NOT NULL,
	`owner_role` text NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
	`dependency_type` text DEFAULT 'internal' NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`evidence` text,
	`blocker_reason` text,
	`target_date` text,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `launch_uat_signoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`journey_code` text NOT NULL,
	`test_case` text NOT NULL,
	`device` text NOT NULL,
	`result` text NOT NULL,
	`evidence_reference` text,
	`defect_reference` text,
	`signed_by` text NOT NULL,
	`signed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operational_exceptions` (
	`id` text PRIMARY KEY NOT NULL,
	`module` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`booking_id` text,
	`owner_role` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_by` text,
	`resolved_at` integer
);
