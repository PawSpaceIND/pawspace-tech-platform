-- Epics #477/#478: generic multi-vertical subscription entitlement scaffold.
-- This schema is additive and does not modify V1 service-specific wallet tables.

CREATE TABLE IF NOT EXISTS subscription_entitlements (
  entitlement_id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  service_code TEXT NOT NULL,
  total_credits INTEGER NOT NULL CHECK(total_credits >= 0),
  consumed_credits INTEGER NOT NULL DEFAULT 0 CHECK(consumed_credits >= 0),
  status TEXT NOT NULL DEFAULT 'active',
  expiry_date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(consumed_credits <= total_credits)
);

CREATE INDEX IF NOT EXISTS subscription_entitlements_household_status_idx
  ON subscription_entitlements(household_id, status);
CREATE INDEX IF NOT EXISTS subscription_entitlements_service_status_idx
  ON subscription_entitlements(service_code, status);
CREATE INDEX IF NOT EXISTS subscription_entitlements_expiry_idx
  ON subscription_entitlements(expiry_date, status);
