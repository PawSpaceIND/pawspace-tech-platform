PRAGMA foreign_keys = ON;

-- V2 additive foundation for a service-agnostic entitlement wallet.
-- V1 grooming wallet tables remain untouched during the migration period.
CREATE TABLE IF NOT EXISTS subscription_entitlements (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  pet_id TEXT,
  household_id TEXT,
  service_code TEXT NOT NULL,
  package_code TEXT,
  plan_code TEXT NOT NULL,
  plan_version TEXT NOT NULL,
  unit_type TEXT NOT NULL CHECK(unit_type IN ('session','visit','day','walk','credit','other')),
  total_units INTEGER NOT NULL CHECK(total_units >= 0),
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK(reserved_units >= 0),
  consumed_units INTEGER NOT NULL DEFAULT 0 CHECK(consumed_units >= 0),
  released_units INTEGER NOT NULL DEFAULT 0 CHECK(released_units >= 0),
  available_units INTEGER NOT NULL CHECK(available_units >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','suspended','cancelled','expired','exhausted')),
  starts_at INTEGER NOT NULL,
  expires_at INTEGER,
  grace_expires_at INTEGER,
  renewal_eligible_at INTEGER,
  pause_policy_json TEXT NOT NULL DEFAULT '{}',
  family_wallet_enabled INTEGER NOT NULL DEFAULT 0 CHECK(family_wallet_enabled IN (0,1)),
  source_purchase_id TEXT,
  source_booking_id TEXT,
  source_payment_id TEXT,
  policy_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(reserved_units + consumed_units <= total_units),
  CHECK(available_units = total_units - reserved_units - consumed_units)
);

CREATE INDEX IF NOT EXISTS idx_subscription_entitlements_customer_service
  ON subscription_entitlements(customer_id, service_code, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_subscription_entitlements_pet
  ON subscription_entitlements(pet_id, service_code, status);
CREATE INDEX IF NOT EXISTS idx_subscription_entitlements_household
  ON subscription_entitlements(household_id, service_code, status);

CREATE TABLE IF NOT EXISTS subscription_entitlement_events (
  id TEXT PRIMARY KEY,
  entitlement_id TEXT NOT NULL,
  booking_id TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN ('grant','reserve','consume','release','activate','pause','resume','suspend','expire','cancel')),
  units INTEGER NOT NULL DEFAULT 0 CHECK(units >= 0),
  total_after INTEGER NOT NULL CHECK(total_after >= 0),
  reserved_after INTEGER NOT NULL CHECK(reserved_after >= 0),
  consumed_after INTEGER NOT NULL CHECK(consumed_after >= 0),
  released_after INTEGER NOT NULL CHECK(released_after >= 0),
  available_after INTEGER NOT NULL CHECK(available_after >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  source_event_id TEXT,
  actor_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY(entitlement_id) REFERENCES subscription_entitlements(id),
  CHECK(reserved_after + consumed_after <= total_after),
  CHECK(available_after = total_after - reserved_after - consumed_after)
);

CREATE INDEX IF NOT EXISTS idx_subscription_entitlement_events_entitlement
  ON subscription_entitlement_events(entitlement_id, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_entitlement_events_source
  ON subscription_entitlement_events(source_event_id)
  WHERE source_event_id IS NOT NULL;
