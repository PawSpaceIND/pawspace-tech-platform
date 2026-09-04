-- Epic #475 / V2 Growth OS foundation.
--
-- Persist the canonical revenue-opportunity authority already used by
-- lib/revenue-opportunity-governance.ts. This migration intentionally mirrors
-- that runtime contract so a fresh database has the same schema regardless of
-- whether migrations or runtime bootstrapping execute first.
--
-- Additive only: no V1 table is renamed, dropped, backfilled, or rerouted.

CREATE TABLE IF NOT EXISTS canonical_revenue_opportunities (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL,
  opportunity_type TEXT NOT NULL,
  service_code TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  preferred_channel TEXT NOT NULL,
  estimated_value REAL NOT NULL DEFAULT 0 CHECK (estimated_value >= 0),
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  signal_snapshot_json TEXT NOT NULL,
  suppression_reasons_json TEXT NOT NULL DEFAULT '[]',
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  converted_booking_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (customer_id, source_key, policy_id, policy_version)
);

CREATE INDEX IF NOT EXISTS revenue_opportunity_customer_status_idx
  ON canonical_revenue_opportunities(customer_id, status, created_at);
