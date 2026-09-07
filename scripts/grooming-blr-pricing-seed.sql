-- PawSpace Grooming UAT pricing-resolution probe.
-- STAGING/TEST ONLY: these rows are deliberately isolated from customer-facing package codes.
-- The canonical application city code is lower-case `blr`; "BLR" is the human region label.
--
-- Purpose: prove catalogue resolution prefers a city-specific row over the standard ALL-city row
-- without changing any signed-off (or still-pending) launch price such as dog-basic.

CREATE TABLE IF NOT EXISTS catalogue_packages (
  id TEXT PRIMARY KEY,
  service_code TEXT NOT NULL,
  package_code TEXT NOT NULL,
  city_id TEXT NOT NULL DEFAULT 'ALL',
  zone_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  base_price REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  tax_inclusive INTEGER NOT NULL DEFAULT 1,
  slot_minutes INTEGER NOT NULL DEFAULT 60,
  blocking_minutes INTEGER NOT NULL DEFAULT 90,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(service_code, package_code, city_id, zone_id)
);

CREATE INDEX IF NOT EXISTS idx_catalogue_lookup
  ON catalogue_packages(service_code, package_code, city_id, active);

CREATE TABLE IF NOT EXISTS catalogue_audit (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Standard catalogue control row: Rs 1,000.
INSERT INTO catalogue_packages (
  id, service_code, package_code, city_id, zone_id, name, description,
  base_price, currency, tax_inclusive, slot_minutes, blocking_minutes,
  active, version, effective_from, effective_to, created_by, updated_by, updated_at
)
SELECT
  'uat_grooming_price_probe_all', 'grooming', 'qa-blr-price-probe', 'ALL', NULL,
  'UAT Grooming Price Probe', 'UAT-only standard catalogue control row; never expose as a customer offer',
  1000, 'INR', 1, 60, 90, 1, 1, '2026-09-01', NULL,
  'uat_setup_seed', 'uat_setup_seed', 1788220800000
WHERE NOT EXISTS (
  SELECT 1 FROM catalogue_packages
  WHERE service_code='grooming'
    AND package_code='qa-blr-price-probe'
    AND city_id='ALL'
    AND COALESCE(zone_id, '')=''
);

-- Bangalore/BLR override row: Rs 1,150 (+15% versus the standard control row).
INSERT INTO catalogue_packages (
  id, service_code, package_code, city_id, zone_id, name, description,
  base_price, currency, tax_inclusive, slot_minutes, blocking_minutes,
  active, version, effective_from, effective_to, created_by, updated_by, updated_at
)
SELECT
  'uat_grooming_price_probe_blr', 'grooming', 'qa-blr-price-probe', 'blr', NULL,
  'UAT Grooming Price Probe - BLR', 'UAT-only BLR catalogue override used to verify city-specific resolution',
  1150, 'INR', 1, 60, 90, 1, 1, '2026-09-01', NULL,
  'uat_setup_seed', 'uat_setup_seed', 1788220800000
WHERE NOT EXISTS (
  SELECT 1 FROM catalogue_packages
  WHERE service_code='grooming'
    AND package_code='qa-blr-price-probe'
    AND city_id='blr'
    AND COALESCE(zone_id, '')=''
);

INSERT OR IGNORE INTO catalogue_audit (
  id, package_id, action, before_json, after_json, actor_id, reason, created_at
)
SELECT
  'uat_catalogue_audit_price_probe_all', id, 'seeded', NULL,
  '{"serviceCode":"grooming","packageCode":"qa-blr-price-probe","cityId":"ALL","basePrice":1000}',
  'uat_setup_seed', 'Seed standard UAT catalogue control row for BLR resolution test', 1788220800000
FROM catalogue_packages WHERE id='uat_grooming_price_probe_all';

INSERT OR IGNORE INTO catalogue_audit (
  id, package_id, action, before_json, after_json, actor_id, reason, created_at
)
SELECT
  'uat_catalogue_audit_price_probe_blr', id, 'seeded', NULL,
  '{"serviceCode":"grooming","packageCode":"qa-blr-price-probe","cityId":"blr","basePrice":1150}',
  'uat_setup_seed', 'Seed BLR UAT catalogue override for city-resolution test', 1788220800000
FROM catalogue_packages WHERE id='uat_grooming_price_probe_blr';
