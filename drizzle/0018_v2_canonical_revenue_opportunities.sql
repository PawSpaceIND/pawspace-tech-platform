-- V2 Growth OS foundation: canonical revenue opportunity authority extensions.
-- The V1 canonical table is preserved. CREATE IF NOT EXISTS codifies its contract
-- for fresh databases; V2-only fields live in additive companion tables.

CREATE TABLE IF NOT EXISTS `canonical_revenue_opportunities` (
  `id` text PRIMARY KEY NOT NULL,
  `idempotency_key` text NOT NULL UNIQUE,
  `customer_id` text NOT NULL,
  `opportunity_type` text NOT NULL,
  `service_code` text,
  `reason` text NOT NULL,
  `status` text NOT NULL,
  `preferred_channel` text NOT NULL,
  `estimated_value` real NOT NULL DEFAULT 0,
  `confidence` real NOT NULL DEFAULT 0,
  `signal_snapshot_json` text NOT NULL,
  `suppression_reasons_json` text NOT NULL DEFAULT '[]',
  `policy_id` text NOT NULL,
  `policy_version` integer NOT NULL,
  `source_key` text NOT NULL,
  `converted_booking_id` text,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  UNIQUE (`customer_id`, `source_key`, `policy_id`, `policy_version`)
);

CREATE INDEX IF NOT EXISTS `revenue_opportunity_customer_status_idx`
  ON `canonical_revenue_opportunities` (`customer_id`, `status`, `created_at`);

CREATE TABLE IF NOT EXISTS `canonical_revenue_opportunity_context` (
  `opportunity_id` text PRIMARY KEY NOT NULL,
  `pet_id` text,
  `household_id` text,
  `normalized_opportunity_type` text NOT NULL,
  `target_service_code` text,
  `reason_codes_json` text NOT NULL DEFAULT '[]',
  `explanation_json` text NOT NULL DEFAULT '{}',
  `source_features_json` text NOT NULL DEFAULT '{}',
  `expected_contribution` real,
  `urgency_score` real NOT NULL DEFAULT 0,
  `priority_score` real NOT NULL DEFAULT 0,
  `recommended_channel` text,
  `recommended_offer_strategy` text,
  `owner_id` text,
  `eligible_at` integer,
  `expires_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK (`normalized_opportunity_type` IN (
    'new_lead',
    'repeat_due',
    'win_back',
    'subscription_pitch',
    'subscription_renewal',
    'subscription_low_balance',
    'payment_recovery',
    'cross_sell',
    'loyalty',
    'service_recovery'
  )),
  CHECK (`urgency_score` >= 0 AND `urgency_score` <= 1),
  CHECK (`priority_score` >= 0)
);

CREATE INDEX IF NOT EXISTS `revenue_opportunity_context_type_service_idx`
  ON `canonical_revenue_opportunity_context`
  (`normalized_opportunity_type`, `target_service_code`, `priority_score` DESC);

CREATE INDEX IF NOT EXISTS `revenue_opportunity_context_owner_idx`
  ON `canonical_revenue_opportunity_context`
  (`owner_id`, `eligible_at`, `priority_score` DESC);

CREATE TABLE IF NOT EXISTS `canonical_revenue_opportunity_attribution` (
  `id` text PRIMARY KEY NOT NULL,
  `opportunity_id` text NOT NULL,
  `event_type` text NOT NULL,
  `booking_id` text,
  `payment_id` text,
  `service_code` text,
  `gross_revenue` real,
  `collected_revenue` real,
  `contribution` real,
  `detail_json` text NOT NULL DEFAULT '{}',
  `idempotency_key` text NOT NULL UNIQUE,
  `occurred_at` integer NOT NULL,
  `created_at` integer NOT NULL
);

CREATE INDEX IF NOT EXISTS `revenue_opportunity_attribution_opportunity_idx`
  ON `canonical_revenue_opportunity_attribution` (`opportunity_id`, `occurred_at`);

CREATE INDEX IF NOT EXISTS `revenue_opportunity_attribution_booking_idx`
  ON `canonical_revenue_opportunity_attribution` (`booking_id`)
  WHERE `booking_id` IS NOT NULL;
