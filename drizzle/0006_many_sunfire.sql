CREATE TABLE `dynamic_pricing_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`service_code` text NOT NULL,
	`package_code` text,
	`city_id` text DEFAULT 'blr' NOT NULL,
	`zone_id` text,
	`rule_type` text NOT NULL,
	`days_json` text DEFAULT '[]' NOT NULL,
	`start_time` text,
	`end_time` text,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`adjustment_type` text NOT NULL,
	`adjustment_value` real NOT NULL,
	`coupon_policy` text DEFAULT 'stackable' NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pricing_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`actor_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `service_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`service_code` text NOT NULL,
	`package_code` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`base_price` real NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`tax_inclusive` integer DEFAULT true NOT NULL,
	`slot_minutes` integer NOT NULL,
	`blocking_minutes` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_packages_package_code_unique` ON `service_packages` (`package_code`);