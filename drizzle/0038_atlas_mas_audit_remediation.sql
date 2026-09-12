ALTER TABLE atlas_secure_context_facts ADD COLUMN aad_agent_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE atlas_secure_context_facts ADD COLUMN aad_purpose TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE atlas_secure_context_facts ADD COLUMN aad_version INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_atlas_secure_context_scope;
CREATE INDEX IF NOT EXISTS idx_atlas_secure_context_scope
  ON atlas_secure_context_facts(customer_id,pet_id,aad_agent_id,aad_purpose,status,updated_at DESC);

CREATE TABLE IF NOT EXISTS atlas_memory_consents (
  customer_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('granted','revoked')),
  granted_by TEXT,
  granted_at INTEGER,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS atlas_tool_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
