-- V2 Growth OS foundation: generic multi-service subscription entitlements.
-- Additive only. No V1 wallet table is altered by this migration.

CREATE TABLE IF NOT EXISTS subscription_entitlements (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL,
  pet_id TEXT,
  household_id TEXT,
  service_code TEXT NOT NULL,
  plan_code TEXT NOT NULL,
  plan_version TEXT NOT NULL,
  entitlement_scope TEXT NOT NULL DEFAULT 'customer',
  unit_type TEXT NOT NULL,
  total_units INTEGER NOT NULL,
  reserved_units INTEGER NOT NULL DEFAULT 0,
  consumed_units INTEGER NOT NULL DEFAULT 0,
  released_units INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  started_at INTEGER NOT NULL,
  expires_at INTEGER,
  grace_ends_at INTEGER,
  renewal_window_starts_at INTEGER,
  source_booking_id TEXT,
  source_payment_id TEXT,
  source_contract_id TEXT,
  policy_snapshot_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (entitlement_scope IN ('customer','pet','household')),
  CHECK (unit_type IN ('session','visit','day','walk','credit','other')),
  CHECK (total_units >= 0),
  CHECK (reserved_units >= 0),
  CHECK (consumed_units >= 0),
  CHECK (released_units >= 0),
  CHECK (reserved_units + consumed_units <= total_units),
  CHECK (status IN ('pending','active','paused','exhausted','expired','suspended','cancelled'))
);

CREATE INDEX IF NOT EXISTS subscription_entitlements_customer_service_status_idx
  ON subscription_entitlements(customer_id, service_code, status, updated_at);
CREATE INDEX IF NOT EXISTS subscription_entitlements_pet_service_status_idx
  ON subscription_entitlements(pet_id, service_code, status, updated_at);
CREATE INDEX IF NOT EXISTS subscription_entitlements_expiry_idx
  ON subscription_entitlements(status, expires_at);

CREATE TABLE IF NOT EXISTS subscription_entitlement_booking_usage (
  id TEXT PRIMARY KEY NOT NULL,
  entitlement_id TEXT NOT NULL,
  booking_id TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL,
  service_code TEXT NOT NULL,
  units_reserved INTEGER NOT NULL DEFAULT 0,
  units_consumed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reserved',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (units_reserved >= 0),
  CHECK (units_consumed >= 0),
  CHECK (status IN ('reserved','consumed','released','cancelled'))
);

CREATE INDEX IF NOT EXISTS subscription_entitlement_usage_entitlement_idx
  ON subscription_entitlement_booking_usage(entitlement_id, status, updated_at);

CREATE TABLE IF NOT EXISTS subscription_entitlement_events (
  id TEXT PRIMARY KEY NOT NULL,
  entitlement_id TEXT NOT NULL,
  booking_id TEXT,
  event_type TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  available_units_after INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  CHECK (event_type IN ('created','activated','reserved','consumed','released','paused','resumed','expired','suspended','cancelled','renewed','adjusted')),
  CHECK (units >= 0),
  CHECK (available_units_after >= 0)
);

CREATE INDEX IF NOT EXISTS subscription_entitlement_events_entitlement_idx
  ON subscription_entitlement_events(entitlement_id, created_at);
