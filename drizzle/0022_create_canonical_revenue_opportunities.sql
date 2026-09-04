-- Epic #475: canonical V2 revenue opportunity scaffold.
-- This table is intentionally parallel to the existing legacy revenue/targeting tables.
-- Do not rename, drop, backfill, or route V1 logic through this table in this migration.

CREATE TABLE IF NOT EXISTS canonical_revenue_opportunities (
  opportunity_id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  pet_id TEXT,
  opportunity_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  expected_revenue REAL NOT NULL DEFAULT 0 CHECK(expected_revenue >= 0),
  confidence_score REAL NOT NULL DEFAULT 0 CHECK(confidence_score >= 0 AND confidence_score <= 1),
  eligibility TEXT NOT NULL DEFAULT 'eligible',
  suppression_reason TEXT,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS canonical_revenue_opportunities_household_status_idx
  ON canonical_revenue_opportunities(household_id, status);
CREATE INDEX IF NOT EXISTS canonical_revenue_opportunities_pet_status_idx
  ON canonical_revenue_opportunities(pet_id, status);
CREATE INDEX IF NOT EXISTS canonical_revenue_opportunities_type_status_idx
  ON canonical_revenue_opportunities(opportunity_type, status);
