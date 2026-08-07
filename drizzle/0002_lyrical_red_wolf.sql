CREATE TABLE `grooming_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_key` text NOT NULL,
	`pet_ids_json` text NOT NULL,
	`plan_code` text NOT NULL,
	`status` text NOT NULL,
	`sessions_total` integer NOT NULL,
	`sessions_used` integer DEFAULT 0 NOT NULL,
	`starts_at` integer NOT NULL,
	`renews_at` integer NOT NULL,
	`cadence_days` integer DEFAULT 15 NOT NULL,
	`auto_renew` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscription_automation_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`trigger_code` text NOT NULL,
	`offsets_json` text NOT NULL,
	`channels_json` text NOT NULL,
	`bot_call_enabled` integer DEFAULT false NOT NULL,
	`quiet_hours_start` text DEFAULT '20:00' NOT NULL,
	`quiet_hours_end` text DEFAULT '09:00' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscription_events` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`event_type` text NOT NULL,
	`channel` text,
	`status` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`scheduled_at` integer,
	`created_at` integer NOT NULL
);
