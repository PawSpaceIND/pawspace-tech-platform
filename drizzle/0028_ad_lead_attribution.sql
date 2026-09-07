-- Review record for intake-time advertising attribution.
-- Runtime public-contact bootstrap adds the crm_contacts columns with PRAGMA table_info
-- guards because SQLite ALTER TABLE ADD COLUMN does not support IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS lead_intake_ad_attribution (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL UNIQUE,
  lead_id TEXT NOT NULL UNIQUE,
  source_platform TEXT NOT NULL,
  gclid TEXT,
  fbclid TEXT,
  wbraid TEXT,
  click_id TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  campaign_id TEXT,
  ad_id TEXT,
  landing_url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lead_intake_ad_campaign
  ON lead_intake_ad_attribution(source_platform, campaign_id, ad_id, created_at);

-- crm_contacts additive columns, applied idempotently by app/api/public-contact/route.ts:
--   gclid TEXT
--   fbclid TEXT
--   wbraid TEXT
--   utm_source TEXT
--   utm_medium TEXT
--   utm_campaign TEXT
--   campaign_id TEXT
--   ad_id TEXT
