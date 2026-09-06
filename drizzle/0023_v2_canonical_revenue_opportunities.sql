PRAGMA foreign_keys = ON;

-- V2 normalized extension for canonical_revenue_opportunities.
-- The V1 canonical opportunity table is deliberately not rebuilt or mutated.
CREATE TABLE IF NOT EXISTS canonical_revenue_opportunity_context (
  opportunity_id TEXT PRIMARY KEY,
  pet_id TEXT,
  household_id TEXT,
  target_service_code TEXT NOT NULL,
  pet_snapshot_json TEXT NOT NULL DEFAULT '{}',
  service_history_snapshot_json TEXT NOT NULL DEFAULT '[]',
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  score INTEGER NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 100),
  urgency INTEGER NOT NULL DEFAULT 0 CHECK(urgency BETWEEN 0 AND 100),
  expected_revenue REAL NOT NULL DEFAULT 0 CHECK(expected_revenue >= 0),
  expected_contribution REAL,
  contribution_basis_json TEXT NOT NULL DEFAULT '{}',
  owner_id TEXT,
  eligible_at INTEGER,
  expires_at INTEGER,
  attribution_id TEXT,
  policy_evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(opportunity_id) REFERENCES canonical_revenue_opportunities(id),
  CHECK(expected_contribution IS NULL OR expected_contribution <= expected_revenue)
);

CREATE INDEX IF NOT EXISTS idx_revenue_opportunity_context_pet_service
  ON canonical_revenue_opportunity_context(pet_id, target_service_code);
CREATE INDEX IF NOT EXISTS idx_revenue_opportunity_context_owner_urgency
  ON canonical_revenue_opportunity_context(owner_id, urgency, eligible_at);
CREATE INDEX IF NOT EXISTS idx_revenue_opportunity_context_household
  ON canonical_revenue_opportunity_context(household_id, target_service_code);

CREATE TABLE IF NOT EXISTS canonical_revenue_opportunity_service_history (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  service_code TEXT NOT NULL,
  completed_count INTEGER NOT NULL DEFAULT 0 CHECK(completed_count >= 0),
  last_completed_at INTEGER,
  next_booking_at INTEGER,
  active_entitlement_units INTEGER NOT NULL DEFAULT 0 CHECK(active_entitlement_units >= 0),
  source_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY(opportunity_id) REFERENCES canonical_revenue_opportunities(id),
  UNIQUE(opportunity_id, service_code)
);

CREATE INDEX IF NOT EXISTS idx_revenue_opportunity_history_service
  ON canonical_revenue_opportunity_service_history(service_code, last_completed_at);
