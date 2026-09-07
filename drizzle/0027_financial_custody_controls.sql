-- Financial custody state for partner earnings. Runtime code also creates this table fail-closed so
-- release protection does not depend on migration ordering.
CREATE TABLE IF NOT EXISTS partner_fund_custody (
  booking_id TEXT PRIMARY KEY,
  pending_earning_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN (
    'HELD',
    'DISPUTED_FROZEN',
    'ARBITRATION_RELEASE_APPROVED',
    'ARBITRATION_REALLOCATION_REQUIRED',
    'RELEASED'
  )),
  dispute_case_id TEXT,
  arbitration_decision TEXT,
  arbitration_actor TEXT,
  arbitration_at INTEGER,
  released_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_partner_fund_custody_state ON partner_fund_custody(state, updated_at);
