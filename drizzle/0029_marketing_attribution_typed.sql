-- Extend the canonical first-party ad attribution model without introducing a parallel ledger.
-- SQLite/D1 does not support ALTER TABLE ... ADD COLUMN IF NOT EXISTS. These governed
-- directives are replay-safe through scripts/schema/apply-idempotent-drizzle.mjs.
-- @add-column-if-missing lead_intake_ad_attribution|gbraid|TEXT
-- @add-column-if-missing lead_intake_ad_attribution|utm_content|TEXT
-- @add-column-if-missing lead_intake_ad_attribution|utm_term|TEXT
-- @add-column-if-missing crm_contacts|gbraid|TEXT
-- @add-column-if-missing crm_contacts|utm_content|TEXT
-- @add-column-if-missing crm_contacts|utm_term|TEXT

CREATE TABLE IF NOT EXISTS marketing_conversion_facts (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  business_reference TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  booking_id TEXT,
  payment_id TEXT,
  value_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(event_type,business_reference)
);
CREATE INDEX IF NOT EXISTS idx_marketing_conversion_facts_lead ON marketing_conversion_facts(lead_id,occurred_at);

CREATE TABLE IF NOT EXISTS marketing_conversion_feedback_outbox (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  provider_request_id TEXT,
  external_mutation INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(fact_id,platform)
);
CREATE INDEX IF NOT EXISTS idx_marketing_conversion_feedback_due ON marketing_conversion_feedback_outbox(status,next_attempt_at);
