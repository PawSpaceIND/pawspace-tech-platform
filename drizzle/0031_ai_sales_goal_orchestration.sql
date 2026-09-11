-- Goal-seeking AI sales control plane.
-- This migration plans outreach; delivery remains owned by the existing governed
-- outbound_routing_queue and communication_outbox execution paths.

CREATE TABLE IF NOT EXISTS ai_sales_targets (
  id TEXT PRIMARY KEY,
  target_date TEXT NOT NULL,
  target_type TEXT NOT NULL,
  service_code TEXT NOT NULL DEFAULT '',
  city_id TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  daily_goal INTEGER NOT NULL CHECK (daily_goal > 0),
  achieved_count INTEGER NOT NULL DEFAULT 0 CHECK (achieved_count >= 0),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','approved','active','paused','met','expired','cancelled')),
  max_discount_bps INTEGER NOT NULL DEFAULT 0
    CHECK (max_discount_bps BETWEEN 0 AND 5000),
  minimum_margin_bps INTEGER NOT NULL DEFAULT 0
    CHECK (minimum_margin_bps BETWEEN 0 AND 10000),
  free_upgrade_codes_json TEXT NOT NULL DEFAULT '[]',
  authorized_channels_json TEXT NOT NULL DEFAULT '[]',
  max_contacts_per_day INTEGER NOT NULL DEFAULT 0 CHECK (max_contacts_per_day >= 0),
  offer_policy_version TEXT NOT NULL,
  prompt_policy_version TEXT NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(target_date,target_type,service_code,city_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_sales_targets_dispatch
  ON ai_sales_targets(status,target_date,starts_at,ends_at);

-- Append-only business facts are authoritative. achieved_count is a cached projection.
CREATE TABLE IF NOT EXISTS ai_sales_target_events (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('lead_generated','booking_converted','subscription_renewed','training_closed','reversed')),
  delta INTEGER NOT NULL CHECK (delta <> 0),
  evidence_type TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_sales_target_events_target
  ON ai_sales_target_events(target_id,occurred_at);

-- Target-specific probability, separate from the current generic lead score.
CREATE TABLE IF NOT EXISTS ai_sales_lead_propensity (
  lead_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  service_code TEXT NOT NULL DEFAULT '',
  probability REAL NOT NULL CHECK (probability BETWEEN 0.0 AND 1.0),
  expected_value REAL NOT NULL DEFAULT 0 CHECK (expected_value >= 0),
  model_version TEXT NOT NULL,
  probability_basis_json TEXT NOT NULL,
  recommended_channel TEXT NOT NULL CHECK (recommended_channel IN ('voice','whatsapp')),
  scored_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(lead_id,target_type,service_code)
);

CREATE INDEX IF NOT EXISTS idx_ai_sales_propensity_rank
  ON ai_sales_lead_propensity(target_type,service_code,probability DESC,expected_value DESC,scored_at DESC);

CREATE TABLE IF NOT EXISTS ai_sales_conversion_rates (
  target_type TEXT NOT NULL,
  service_code TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL CHECK (channel IN ('voice','whatsapp','all')),
  segment_key TEXT NOT NULL DEFAULT 'all',
  sample_size INTEGER NOT NULL DEFAULT 0 CHECK (sample_size >= 0),
  contacted_count INTEGER NOT NULL DEFAULT 0 CHECK (contacted_count >= 0),
  converted_count INTEGER NOT NULL DEFAULT 0 CHECK (converted_count >= 0),
  conversion_rate REAL NOT NULL CHECK (conversion_rate > 0.0 AND conversion_rate <= 1.0),
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY(target_type,service_code,channel,segment_key)
);

CREATE TABLE IF NOT EXISTS ai_sales_dispatch_runs (
  id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL UNIQUE,
  target_id TEXT NOT NULL,
  scheduled_for INTEGER NOT NULL,
  gap_before INTEGER NOT NULL,
  historical_conversion_rate REAL NOT NULL,
  required_contacts INTEGER NOT NULL,
  selected_contacts INTEGER NOT NULL DEFAULT 0,
  voice_queued INTEGER NOT NULL DEFAULT 0,
  whatsapp_queued INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning','completed','partial','blocked','failed')),
  result_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS ai_sales_dispatch_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('voice','whatsapp')),
  probability REAL NOT NULL CHECK (probability BETWEEN 0.0 AND 1.0),
  expected_value REAL NOT NULL DEFAULT 0,
  quota_gap_snapshot INTEGER NOT NULL,
  pressure_level TEXT NOT NULL CHECK (pressure_level IN ('steady','watch','urgent')),
  offer_envelope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'selected'
    CHECK (status IN ('selected','queued','suppressed','completed','failed')),
  downstream_ref TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(target_id,lead_id,channel)
);

CREATE INDEX IF NOT EXISTS idx_ai_sales_dispatch_items_run
  ON ai_sales_dispatch_items(run_id,status,probability DESC);
