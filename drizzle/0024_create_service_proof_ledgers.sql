-- V2 Growth OS: immutable post-service proof ledger for customer trust.
-- SQLite stores arrays and objects as JSON text; CHECK constraints preserve their shape.

CREATE TABLE IF NOT EXISTS service_proof_ledgers (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  check_in_gps TEXT NOT NULL,
  check_out_gps TEXT NOT NULL,
  media_urls TEXT NOT NULL DEFAULT '[]',
  structured_report TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  CHECK (json_valid(check_in_gps) AND json_type(check_in_gps) = 'object'),
  CHECK (json_valid(check_out_gps) AND json_type(check_out_gps) = 'object'),
  CHECK (json_valid(media_urls) AND json_type(media_urls) = 'array'),
  CHECK (json_valid(structured_report) AND json_type(structured_report) = 'object')
);

CREATE INDEX IF NOT EXISTS service_proof_ledgers_provider_created_idx
  ON service_proof_ledgers(provider_id, created_at);
