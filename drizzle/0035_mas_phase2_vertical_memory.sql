CREATE TABLE IF NOT EXISTS atlas_vector_memories (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  pet_id TEXT,
  memory_type TEXT NOT NULL DEFAULT 'behavioral',
  sensitivity TEXT NOT NULL DEFAULT 'non_sensitive' CHECK(sensitivity='non_sensitive'),
  content_hash TEXT NOT NULL,
  content_text TEXT NOT NULL,
  vector_id TEXT NOT NULL UNIQUE,
  embedding_model TEXT NOT NULL DEFAULT '@cf/baai/bge-m3' CHECK(embedding_model='@cf/baai/bge-m3'),
  embedding_dimensions INTEGER NOT NULL DEFAULT 1024 CHECK(embedding_dimensions=1024),
  vector_metric TEXT NOT NULL DEFAULT 'cosine' CHECK(vector_metric='cosine'),
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_atlas_vector_memories_scope ON atlas_vector_memories(customer_id,pet_id,status,updated_at DESC);

CREATE TABLE IF NOT EXISTS atlas_secure_context_facts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  pet_id TEXT,
  fact_type TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK(sensitivity IN ('pii','credential','restricted')),
  ciphertext_b64 TEXT NOT NULL,
  iv_b64 TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);CREATE INDEX IF NOT EXISTS idx_atlas_secure_context_scope ON atlas_secure_context_facts(customer_id,pet_id,status,updated_at DESC);

CREATE TABLE IF NOT EXISTS atlas_memory_audit (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  pet_id TEXT,
  action TEXT NOT NULL,
  storage_class TEXT NOT NULL CHECK(storage_class IN ('vector','secure_context')),
  content_hash TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS atlas_pending_approvals (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','executing','executed','execution_failed')),
  requested_by TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  requested_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  decision_note TEXT,
  executed_at INTEGER,
  execution_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_atlas_pending_approvals ON atlas_pending_approvals(domain,status,requested_at);