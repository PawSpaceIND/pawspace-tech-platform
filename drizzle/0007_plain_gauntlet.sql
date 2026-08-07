CREATE TABLE `marketing_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`detail_json` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `marketing_automation_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`trigger_code` text NOT NULL,
	`condition_json` text NOT NULL,
	`action_json` text NOT NULL,
	`approval_mode` text DEFAULT 'human_approval' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`last_run_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `marketing_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`objective` text NOT NULL,
	`vertical` text NOT NULL,
	`city` text NOT NULL,
	`audience` text NOT NULL,
	`daily_budget` real NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`utm_json` text NOT NULL,
	`attribution_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `marketing_promotions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`promotion_type` text NOT NULL,
	`vertical` text NOT NULL,
	`audience` text NOT NULL,
	`value` real NOT NULL,
	`budget_cap` real NOT NULL,
	`holdout_percent` integer DEFAULT 10 NOT NULL,
	`coupon_policy` text NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
