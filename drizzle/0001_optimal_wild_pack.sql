CREATE TABLE `app_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role_code` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_users_email_unique` ON `app_users` (`email`);--> statement-breakpoint
CREATE TABLE `communication_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_key` text NOT NULL,
	`booking_id` text,
	`actor_email` text NOT NULL,
	`channel` text NOT NULL,
	`target` text NOT NULL,
	`outcome` text NOT NULL,
	`provider` text NOT NULL,
	`provider_reference` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `data_import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`row_count` integer NOT NULL,
	`imported_count` integer NOT NULL,
	`rejected_count` integer NOT NULL,
	`status` text NOT NULL,
	`imported_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `role_definitions` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`permissions_json` text NOT NULL,
	`system_role` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscription_customers` (
	`customer_key` text PRIMARY KEY NOT NULL,
	`customer_name` text NOT NULL,
	`primary_phone` text,
	`secondary_phone` text,
	`segment` text NOT NULL,
	`outbound_priority` text NOT NULL,
	`next_best_action` text NOT NULL,
	`first_service_date` text NOT NULL,
	`last_service_date` text NOT NULL,
	`days_since_last_service` integer NOT NULL,
	`dormancy_bucket` text NOT NULL,
	`orders` integer NOT NULL,
	`gross_sales` real NOT NULL,
	`aov` real NOT NULL,
	`services_used` text NOT NULL,
	`primary_service` text NOT NULL,
	`grooming_orders` integer NOT NULL,
	`grooming_subscription_orders` integer NOT NULL,
	`training_orders` integer NOT NULL,
	`boarding_orders` integer NOT NULL,
	`pet_sitting_orders` integer NOT NULL,
	`subscription_target_score` real NOT NULL,
	`import_batch_id` text NOT NULL,
	`updated_at` integer NOT NULL
);
