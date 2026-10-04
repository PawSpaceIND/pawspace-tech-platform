-- Local source only; apply only through the sole publisher after review.
CREATE TABLE IF NOT EXISTS appearance_preferences (
 subject_type TEXT NOT NULL CHECK(subject_type IN ('customer','provider')),
 subject_id TEXT NOT NULL CHECK(length(subject_id)>0),
 explicit_theme TEXT CHECK(explicit_theme IS NULL OR explicit_theme IN ('editorial','concierge')),
 assigned_theme TEXT NOT NULL CHECK(assigned_theme IN ('editorial','concierge')),
 mode TEXT NOT NULL DEFAULT 'system' CHECK(mode IN ('light','dark','system')),
 legacy_snapshot TEXT,
 record_version INTEGER NOT NULL DEFAULT 1 CHECK(record_version>0),
 updated_at INTEGER NOT NULL,
 updated_from TEXT NOT NULL CHECK(updated_from IN ('client','migration','admin-default')),
 PRIMARY KEY(subject_type,subject_id));
CREATE TABLE IF NOT EXISTS appearance_preference_mutations (
 subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 request_json TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
 record_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(subject_type,subject_id,idempotency_key));
CREATE INDEX IF NOT EXISTS appearance_mutations_rate_idx ON appearance_preference_mutations(subject_type,subject_id,created_at);
