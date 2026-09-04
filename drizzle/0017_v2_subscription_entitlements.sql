-- V2 Growth OS foundation: generic multi-service subscription entitlements.
-- Additive only. No V1 wallet table is altered or read by this migration.

CREATE TABLE IF NOT EXISTS `subscription_entitlements` (
  `id` text PRIMARY KEY NOT NULL,
  `customer_id` text NOT NULL,
  `pet_id` text,
  `service_code` text NOT NULL,
  `plan_code` text NOT NULL,
  `plan_version` text NOT NULL,
  `entitlement_scope` text NOT NULL DEFAULT 'customer',
  `unit_type` text NOT NULL,
  `total_units` integer NOT NULL,
  `reserved_units` integer NOT NULL DEFAULT 0,
  `consumed_units` integer NOT NULL DEFAULT 0,
  `released_units` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL DEFAULT 'active',
  `started_at` integer NOT NULL,
  `expires_at` integer,
  `grace_ends_at` integer,
  `renewal_window_starts_at` integer,
  `source_booking_id` text,
  `source_payment_id` text,
  `source_contract_id` text,
  `policy_snapshot_json` text NOT NULL DEFAULT '{}',
  `metadata_json` text NOT NULL DEFAULT '{}',
  `revision` integer NOT NULL DEFAULT 1,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK (`entitlement_scope` IN ('customer','pet','household')),
  CHECK (`total_units` >= 0),
  CHECK (`reserved_units` >= 0),
  CHECK (`consumed_units` >= 0),
  CHECK (`released_units` >= 0),
  CHECK (`reserved_units` + `consumed_units` <= `total_units`),
  CHECK (`status` IN ('pending','active','paused','exhausted','expired','suspended','cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS `subscription_entitlements_source_booking_idx`
  ON `subscription_entitlements` (`source_booking_id`)
  WHERE `source_booking_id` IS NOT NULL;

CREATE INDEX IF NOT EXISTS `subscription_entitlements_customer_service_status_idx`
  ON `subscription_entitlements` (`customer_id`, `service_code`, `status`, `updated_at`);

CREATE INDEX IF NOT EXISTS `subscription_entitlements_expiry_idx`
  ON `subscription_entitlements` (`status`, `expires_at`);

CREATE TABLE IF NOT EXISTS `subscription_entitlement_booking_usage` (
  `id` text PRIMARY KEY NOT NULL,
  `entitlement_id` text NOT NULL,
  `booking_id` text NOT NULL UNIQUE,
  `customer_id` text NOT NULL,
  `service_code` text NOT NULL,
  `units_reserved` integer NOT NULL DEFAULT 0,
  `units_consumed` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL DEFAULT 'reserved',
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK (`units_reserved` >= 0),
  CHECK (`units_consumed` >= 0),
  CHECK (`status` IN ('reserved','consumed','released','cancelled'))
);

CREATE INDEX IF NOT EXISTS `subscription_entitlement_usage_entitlement_idx`
  ON `subscription_entitlement_booking_usage` (`entitlement_id`, `status`, `updated_at`);

CREATE TABLE IF NOT EXISTS `subscription_entitlement_events` (
  `id` text PRIMARY KEY NOT NULL,
  `entitlement_id` text NOT NULL,
  `booking_id` text,
  `event_type` text NOT NULL,
  `units` integer NOT NULL DEFAULT 0,
  `available_units_after` integer NOT NULL,
  `idempotency_key` text NOT NULL UNIQUE,
  `actor_id` text NOT NULL,
  `detail_json` text NOT NULL DEFAULT '{}',
  `created_at` integer NOT NULL,
  CHECK (`units` >= 0),
  CHECK (`available_units_after` >= 0)
);

CREATE INDEX IF NOT EXISTS `subscription_entitlement_events_entitlement_idx`
  ON `subscription_entitlement_events` (`entitlement_id`, `created_at`);
