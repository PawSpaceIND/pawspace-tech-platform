-- Review record for lib/escrow-custody-engine.ts.
-- Runtime ensureEscrowCustodyTables() remains the authoritative D1 bootstrap.

CREATE TABLE IF NOT EXISTS escrow_custodial_accounts (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  customer_id TEXT,
  currency TEXT NOT NULL DEFAULT 'INR',
  custody_amount REAL NOT NULL CHECK(custody_amount >= 0),
  held_amount REAL NOT NULL CHECK(held_amount >= 0),
  released_provider_amount REAL NOT NULL DEFAULT 0 CHECK(released_provider_amount >= 0),
  refunded_customer_amount REAL NOT NULL DEFAULT 0 CHECK(refunded_customer_amount >= 0),
  state TEXT NOT NULL CHECK(state IN ('CUSTODY_HELD','DISPUTE_FROZEN','ARBITRATION_REFUND_CUSTOMER','ARBITRATION_RELEASE_PROVIDER','PARTIAL_SPLIT')),
  environment TEXT NOT NULL DEFAULT 'sandbox' CHECK(environment = 'sandbox'),
  live_approved INTEGER NOT NULL DEFAULT 0 CHECK(live_approved = 0),
  capture_evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS escrow_holds (
  id TEXT PRIMARY KEY,
  custodial_account_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  payment_reference TEXT,
  amount REAL NOT NULL CHECK(amount >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  state TEXT NOT NULL DEFAULT 'HELD' CHECK(state IN ('HELD','RELEASED_PROVIDER','REFUND_CUSTOMER','PARTIAL_SPLIT')),
  source_reference TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  held_at INTEGER NOT NULL,
  released_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dispute_freezes (
  id TEXT PRIMARY KEY,
  custodial_account_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  dispute_reference TEXT NOT NULL UNIQUE,
  amount_frozen REAL NOT NULL CHECK(amount_frozen >= 0),
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVING','RESOLVED')),
  resolution TEXT,
  opened_by TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  resolved_by TEXT,
  resolved_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS escrow_ledger_transactions (
  id TEXT PRIMARY KEY,
  custodial_account_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  amount REAL NOT NULL CHECK(amount >= 0),
  provider_amount REAL NOT NULL DEFAULT 0 CHECK(provider_amount >= 0),
  customer_amount REAL NOT NULL DEFAULT 0 CHECK(customer_amount >= 0),
  state_from TEXT,
  state_to TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  journal_group TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_escrow_accounts_state ON escrow_custodial_accounts(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_dispute_freezes_booking ON dispute_freezes(booking_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_escrow_ledger_booking ON escrow_ledger_transactions(booking_id, created_at);
