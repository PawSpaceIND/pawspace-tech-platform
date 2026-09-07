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

-- Payout maker/checker evidence is separate from the payout command so approvals remain explicit and
-- auditable. The payout instruction itself remains sandbox-only and no row here dispatches money.
CREATE TABLE IF NOT EXISTS partner_payout_instruction_approvals (
  instruction_id TEXT PRIMARY KEY,
  statement_approver TEXT,
  level_1_by TEXT,
  level_1_at INTEGER,
  level_2_by TEXT,
  level_2_at INTEGER,
  updated_at INTEGER NOT NULL
);
