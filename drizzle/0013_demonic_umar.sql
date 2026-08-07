CREATE TABLE `crm_engine_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`actor_email` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customer_experience_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text,
	`booking_id` text,
	`lead_id` text,
	`category` text NOT NULL,
	`priority` text NOT NULL,
	`subject` text NOT NULL,
	`detail` text NOT NULL,
	`owner` text NOT NULL,
	`manager` text NOT NULL,
	`sla_due_at` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`escalation_level` integer DEFAULT 0 NOT NULL,
	`customer_status` text DEFAULT 'We received your request' NOT NULL,
	`resolution` text,
	`root_cause` text,
	`resolution_evidence` text,
	`reopened_count` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE TABLE `lead_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`channel` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`outcome` text NOT NULL,
	`note` text,
	`provider_status` text DEFAULT 'uat_queued' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lead_work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`source` text NOT NULL,
	`service` text NOT NULL,
	`owner` text NOT NULL,
	`manager` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`stage` text DEFAULT 'day_1' NOT NULL,
	`work_day` integer DEFAULT 1 NOT NULL,
	`assigned_at` integer NOT NULL,
	`first_action_due_at` integer NOT NULL,
	`manager_alert_at` integer NOT NULL,
	`first_action_at` integer,
	`call_attempts` integer DEFAULT 0 NOT NULL,
	`whatsapp_attempts` integer DEFAULT 0 NOT NULL,
	`last_outcome` text,
	`next_action_at` integer,
	`recycle_at` integer,
	`recycle_cycle` integer DEFAULT 0 NOT NULL,
	`opt_out` integer DEFAULT false NOT NULL,
	`converted_booking_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `revenue_opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`opportunity_date` text NOT NULL,
	`customer_id` text NOT NULL,
	`lead_id` text,
	`booking_id` text,
	`opportunity_type` text NOT NULL,
	`reason` text NOT NULL,
	`score` integer NOT NULL,
	`rank` integer NOT NULL,
	`expected_revenue` real NOT NULL,
	`margin_percent` real NOT NULL,
	`suggested_offer` text NOT NULL,
	`preferred_channel` text NOT NULL,
	`owner` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`due_at` integer NOT NULL,
	`signals_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
