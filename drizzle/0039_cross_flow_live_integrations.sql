CREATE TABLE IF NOT EXISTS live_payout_queue (
  id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE, provider_id TEXT NOT NULL,
  amount_paise INTEGER NOT NULL, currency TEXT NOT NULL, fund_account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, provider_payout_id TEXT UNIQUE, provider_status TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL, last_error TEXT, last_utr TEXT, reconciliation_checked_at INTEGER,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_payout_due ON live_payout_queue(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS live_payout_events (
  id TEXT PRIMARY KEY, queue_id TEXT NOT NULL, event_type TEXT NOT NULL, provider_event_id TEXT,
  payload_hash TEXT, detail_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
  UNIQUE(queue_id,provider_event_id)
);
CREATE TABLE IF NOT EXISTS payroll_live_disbursement_approvals (
  run_id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL,
  mfa_session_id TEXT NOT NULL, mfa_verified_at INTEGER NOT NULL, approved_at INTEGER NOT NULL
);
