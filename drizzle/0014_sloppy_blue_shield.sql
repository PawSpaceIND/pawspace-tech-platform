CREATE TABLE `command_report_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`report_date` text NOT NULL,
	`period_type` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`status` text DEFAULT 'uat_queued' NOT NULL,
	`metrics_json` text NOT NULL,
	`recipients_json` text NOT NULL,
	`delivery_channels_json` text NOT NULL,
	`generated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `communication_delivery_events` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`channel` text NOT NULL,
	`provider` text NOT NULL,
	`template_code` text NOT NULL,
	`consent_status` text NOT NULL,
	`delivery_status` text DEFAULT 'uat_queued' NOT NULL,
	`provider_reference` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `finance_day_closures` (
	`closure_date` text PRIMARY KEY NOT NULL,
	`checklist_json` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`variance_amount` real DEFAULT 0 NOT NULL,
	`note` text,
	`submitted_by` text,
	`submitted_at` integer,
	`approved_by` text,
	`approved_at` integer,
	`escalation_level` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lead_reopen_events` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`cycle` integer NOT NULL,
	`reopened_at` integer NOT NULL,
	`assigned_owner` text NOT NULL,
	`previous_status` text NOT NULL,
	`outcome` text DEFAULT 'reopened' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ops_completion_controls` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`vertical` text NOT NULL,
	`owner` text NOT NULL,
	`scheduled_end_at` integer NOT NULL,
	`status` text DEFAULT 'in_progress' NOT NULL,
	`service_evidence` text,
	`customer_update_at` integer,
	`payment_confirmed` integer DEFAULT false NOT NULL,
	`provider_settlement_ready` integer DEFAULT false NOT NULL,
	`exception_reason` text,
	`escalation_level` integer DEFAULT 0 NOT NULL,
	`completed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sales_performance_daily` (
	`id` text PRIMARY KEY NOT NULL,
	`performance_date` text NOT NULL,
	`employee_name` text NOT NULL,
	`target_revenue` real NOT NULL,
	`eligible_revenue` real NOT NULL,
	`collections` real NOT NULL,
	`conversions` integer NOT NULL,
	`renewals` integer NOT NULL,
	`sla_percent` real NOT NULL,
	`rnr_percent` real NOT NULL,
	`refunds` real NOT NULL,
	`incentive_amount` real NOT NULL,
	`rank` integer NOT NULL,
	`status` text DEFAULT 'provisional' NOT NULL,
	`updated_at` integer NOT NULL
);
