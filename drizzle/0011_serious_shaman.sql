CREATE TABLE `booking_lifecycle_events` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`event_type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `booking_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`amount` real NOT NULL,
	`amount_due_now` real NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`method` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`gateway` text DEFAULT 'uat_sandbox' NOT NULL,
	`idempotency_key` text NOT NULL,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_payments_booking_id_unique` ON `booking_payments` (`booking_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `booking_payments_idempotency_key_unique` ON `booking_payments` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `canonical_bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`customer_id` text NOT NULL,
	`pet_ids_json` text NOT NULL,
	`source_pet_ids_json` text NOT NULL,
	`city_id` text NOT NULL,
	`zone_id` text NOT NULL,
	`service_code` text NOT NULL,
	`package_code` text NOT NULL,
	`package_name` text NOT NULL,
	`schedule_group_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`scheduled_start` text NOT NULL,
	`scheduled_end` text NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`channel` text DEFAULT 'customer_app' NOT NULL,
	`total_amount` real NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`pricing_json` text DEFAULT '{}' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canonical_bookings_idempotency_key_unique` ON `canonical_bookings` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `canonical_bookings_schedule_group_id_unique` ON `canonical_bookings` (`schedule_group_id`);--> statement-breakpoint
CREATE TABLE `canonical_customers` (
	`id` text PRIMARY KEY NOT NULL,
	`city_id` text NOT NULL,
	`name` text NOT NULL,
	`primary_phone` text NOT NULL,
	`secondary_phone` text,
	`email` text,
	`source` text DEFAULT 'uat_customer_app' NOT NULL,
	`consent_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `canonical_pets` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`name` text NOT NULL,
	`species` text NOT NULL,
	`breed` text,
	`vaccination_status` text DEFAULT 'not_provided' NOT NULL,
	`source_pet_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_work_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`schedule_group_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_name` text NOT NULL,
	`provider_model` text NOT NULL,
	`service_code` text NOT NULL,
	`scheduled_start` text NOT NULL,
	`scheduled_end` text NOT NULL,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'assigned' NOT NULL,
	`assignment_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_work_orders_booking_id_unique` ON `provider_work_orders` (`booking_id`);