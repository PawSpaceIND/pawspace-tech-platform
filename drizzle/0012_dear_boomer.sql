CREATE TABLE `booking_customer_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`customer_id` text,
	`channel` text NOT NULL,
	`template_code` text NOT NULL,
	`message` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`event_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `booking_operational_events` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`event_type` text NOT NULL,
	`reason` text NOT NULL,
	`impact_minutes` integer DEFAULT 0 NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `booking_rebooking_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`source_event_id` text NOT NULL,
	`status` text DEFAULT 'offered' NOT NULL,
	`reason` text NOT NULL,
	`eligible_at` integer NOT NULL,
	`selected_start` text,
	`assigned_provider_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `booking_refund_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`payment_id` text,
	`amount` real DEFAULT 0 NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`requested_by` text NOT NULL,
	`approved_by` text,
	`gateway_reference` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
