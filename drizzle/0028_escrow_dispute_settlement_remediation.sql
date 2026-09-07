-- Escrow dispute/arbitration settlement remediation review migration.
-- Runtime ensureEscrowCustodyTables() performs additive column upgrades idempotently.
-- New durable structures are declared here so migration/schema review tracks the runtime contract.

CREATE TABLE IF NOT EXISTS escrow_ledger_heads (
  custodial_account_id TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  last_hash TEXT NOT NULL DEFAULT 'GENESIS',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS escrow_settlement_outbox (
  id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,dispute_id TEXT,booking_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('REFUND','PAYOUT')),amount REAL NOT NULL CHECK(amount>0),currency TEXT NOT NULL DEFAULT 'INR',
  payload_json TEXT NOT NULL DEFAULT '{}',idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','RETRY','DELIVERED','DEAD_LETTER')),
  attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,locked_by TEXT,locked_at INTEGER,last_error TEXT,
  external_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,delivered_at INTEGER
);
CREATE TABLE IF NOT EXISTS escrow_settlement_receipts (
  outbox_id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,booking_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('REFUND','PAYOUT')),amount REAL NOT NULL CHECK(amount>0),external_reference TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS escrow_audit_events (
  id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,dispute_id TEXT,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS escrow_lifecycle_outbox (
  id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,dispute_id TEXT,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DELIVERED')),
  created_at INTEGER NOT NULL,delivered_at INTEGER
);
CREATE TABLE IF NOT EXISTS escrow_reconciliation_alarms (
  id TEXT PRIMARY KEY,booking_id TEXT,custodial_account_id TEXT,dispute_id TEXT,alarm_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('P0','P1','P2')),details_json TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_escrow_settlement_due ON escrow_settlement_outbox(status,next_attempt_at,created_at);

CREATE TRIGGER IF NOT EXISTS trg_escrow_ledger_no_update BEFORE UPDATE ON escrow_ledger_transactions BEGIN SELECT RAISE(ABORT,'escrow_ledger_append_only'); END;
CREATE TRIGGER IF NOT EXISTS trg_escrow_ledger_no_delete BEFORE DELETE ON escrow_ledger_transactions BEGIN SELECT RAISE(ABORT,'escrow_ledger_append_only'); END;
CREATE TRIGGER IF NOT EXISTS trg_escrow_audit_no_update BEFORE UPDATE ON escrow_audit_events BEGIN SELECT RAISE(ABORT,'escrow_audit_append_only'); END;
CREATE TRIGGER IF NOT EXISTS trg_escrow_audit_no_delete BEFORE DELETE ON escrow_audit_events BEGIN SELECT RAISE(ABORT,'escrow_audit_append_only'); END;
CREATE TRIGGER IF NOT EXISTS trg_escrow_receipt_no_update BEFORE UPDATE ON escrow_settlement_receipts BEGIN SELECT RAISE(ABORT,'escrow_settlement_receipt_append_only'); END;
CREATE TRIGGER IF NOT EXISTS trg_escrow_receipt_no_delete BEFORE DELETE ON escrow_settlement_receipts BEGIN SELECT RAISE(ABORT,'escrow_settlement_receipt_append_only'); END;
