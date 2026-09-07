-- Persist two-checker payout authorization evidence independently of the payout instruction.
-- This table does not dispatch funds; partner payout execution remains sandbox-only.
CREATE TABLE IF NOT EXISTS partner_payout_instruction_approvals (
  instruction_id TEXT PRIMARY KEY,
  statement_approver TEXT,
  level_1_by TEXT,
  level_1_at INTEGER,
  level_2_by TEXT,
  level_2_at INTEGER,
  updated_at INTEGER NOT NULL
);
