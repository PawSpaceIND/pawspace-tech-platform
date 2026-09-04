-- V2 Growth OS foundation: canonical revenue opportunity context and attribution.
-- The V1 canonical opportunity table remains authoritative and unchanged.

CREATE TABLE IF NOT EXISTS canonical_revenue_opportunity_context (
  opportunity_id TEXT PRIMARY KEY NOT NULL,
  pet_id TEXT,
  household_id TEXT,
  normalized_opportunity_type TEXT NOT NULL,
  target_service_code TEXT,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  explanation_json TEXT NOT NULL DEFAULT '{}',
  source_features_json TEXT NOT NULL DEFAULT '{}',
  service_history_json TEXT NOT NULL DEFAULT '[]',
  expected_contribution REAL,
  expected_contribution_status TEXT NOT NULL DEFAULT 'configuration_required',
  expected_contribution_basis_json TEXT NOT NULL DEFAULT '{}',
  urgency_score REAL NOT NULL DEFAULT 0,
  priority_score REAL NOT NULL DEFAULT 0,
  recommended_channel TEXT,
  recommended_offer_strategy TEXT,
  owner_id TEXT,
  eligible_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (normalized_opportunity_type IN (
    'new_lead','repeat_due','win_back','subscription_pitch','subscription_renewal',
    'subscription_low_balance','payment_recovery','cross_sell','loyalty','service_recovery'
  )),
  CHECK (expected_contribution_status IN ('configured','configuration_required','not_applicable')),
  CHECK (urgency_score >= 0 AND urgency_score <= 1),
  CHECK (priority_score >= 0)
);

CREATE INDEX IF NOT EXISTS revenue_opportunity_context_type_service_idx
  ON canonical_revenue_opportunity_context(normalized_opportunity_type, target_service_code, priority_score DESC);
CREATE INDEX IF NOT EXISTS revenue_opportunity_context_owner_idx
  ON canonical_revenue_opportunity_context(owner_id, eligible_at, priority_score DESC);
CREATE INDEX IF NOT EXISTS revenue_opportunity_context_pet_idx
  ON canonical_revenue_opportunity_context(pet_id, target_service_code, updated_at);

CREATE TABLE IF NOT EXISTS canonical_revenue_opportunity_attribution (
  id TEXT PRIMARY KEY NOT NULL,
  opportunity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  booking_id TEXT,
  payment_id TEXT,
  service_code TEXT,
  gross_revenue REAL,
  collected_revenue REAL,
  contribution REAL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL UNIQUE,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS revenue_opportunity_attribution_opportunity_idx
  ON canonical_revenue_opportunity_attribution(opportunity_id, occurred_at);
CREATE INDEX IF NOT EXISTS revenue_opportunity_attribution_booking_idx
  ON canonical_revenue_opportunity_attribution(booking_id)
  WHERE booking_id IS NOT NULL;
