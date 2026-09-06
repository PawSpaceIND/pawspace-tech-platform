type Db = D1Database;

/**
 * Tables that are consumed directly by the financial runtime but historically existed only in
 * drizzle migrations. Keep this list small and explicit: these are the objects whose absence makes a
 * deployed worker able to accept payment state while failing to persist the corresponding accounting
 * evidence.
 */
export const FINANCIAL_RUNTIME_REQUIRED_TABLES = [
  "gateway_webhook_events",
  "gateway_object_identities",
  "journal_transactions",
  "journal_entries",
  "partner_earning_pending",
  "partner_payable_released",
  "payment_settlement_reconciliations",
  "razorpay_settlement_recon_runs",
] as const;

/**
 * Runtime safety net for the finance schema.
 *
 * The canonical definitions live in drizzle/0017_financial_lifecycle_hardening.sql and
 * drizzle/0019_razorpay_settlement_reconciliation.sql. The deploy history predates a reliable D1
 * migration pipeline, so production databases can legitimately have a mixed history of runtime-created
 * and migration-created objects. Every statement below is therefore additive/idempotent and mirrors
 * the canonical constraints/triggers needed by the executing modules.
 *
 * This is deliberately NOT permission to stop fixing migrations. It is the fail-safe that prevents a
 * missing deployment migration from turning a successful payment into an unbooked accounting event.
 */
export async function ensureFinancialRuntimeSupportTables(db: Db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS gateway_webhook_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      environment TEXT NOT NULL CHECK (environment IN ('sandbox','live')),
      event_id TEXT NOT NULL,
      event_type TEXT,
      raw_payload TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      signature TEXT NOT NULL,
      processing_status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (processing_status IN ('RECEIVED','PROCESSING','PROCESSED','DEFERRED','REJECTED','FAILED')),
      failure_reason TEXT,
      received_at INTEGER NOT NULL,
      processed_at INTEGER,
      UNIQUE(provider,event_id)
    )`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS gateway_webhook_events_immutable_update
      BEFORE UPDATE OF provider,environment,event_id,raw_payload,payload_sha256,signature,received_at ON gateway_webhook_events
      BEGIN SELECT RAISE(ABORT,'gateway webhook evidence is immutable'); END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS gateway_webhook_events_immutable_delete
      BEFORE DELETE ON gateway_webhook_events
      BEGIN SELECT RAISE(ABORT,'gateway webhook evidence cannot be deleted'); END`),

    db.prepare(`CREATE TABLE IF NOT EXISTS gateway_object_identities (
      provider TEXT NOT NULL,
      object_type TEXT NOT NULL CHECK (object_type IN ('order','payment','refund','transfer','payout','settlement','payment_link')),
      external_id TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(provider,object_type,external_id)
    )`),

    db.prepare(`CREATE TABLE IF NOT EXISTS journal_transactions (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_event_id TEXT NOT NULL UNIQUE,
      currency TEXT NOT NULL DEFAULT 'INR',
      status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','REVERSED')),
      reversal_of TEXT,
      narration TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      posted_at INTEGER,
      FOREIGN KEY(reversal_of) REFERENCES journal_transactions(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      account_code TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
      amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
      booking_id TEXT,
      partner_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(transaction_id) REFERENCES journal_transactions(id)
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_journal_entries_transaction ON journal_entries(transaction_id)"),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS journal_entries_no_update
      BEFORE UPDATE ON journal_entries
      WHEN EXISTS (SELECT 1 FROM journal_transactions jt WHERE jt.id=OLD.transaction_id AND jt.status IN ('POSTED','REVERSED'))
      BEGIN SELECT RAISE(ABORT,'posted journal entries are immutable'); END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS journal_entries_no_delete
      BEFORE DELETE ON journal_entries
      WHEN EXISTS (SELECT 1 FROM journal_transactions jt WHERE jt.id=OLD.transaction_id AND jt.status IN ('POSTED','REVERSED'))
      BEGIN SELECT RAISE(ABORT,'posted journal entries cannot be deleted'); END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS journal_transactions_post_balanced
      BEFORE UPDATE OF status ON journal_transactions
      WHEN NEW.status='POSTED' AND OLD.status='DRAFT'
      BEGIN
        SELECT CASE WHEN (SELECT COUNT(*) FROM journal_entries WHERE transaction_id=NEW.id) < 2
          THEN RAISE(ABORT,'journal requires at least two entries') END;
        SELECT CASE WHEN
          COALESCE((SELECT SUM(amount_paise) FROM journal_entries WHERE transaction_id=NEW.id AND direction='DEBIT'),0)
          != COALESCE((SELECT SUM(amount_paise) FROM journal_entries WHERE transaction_id=NEW.id AND direction='CREDIT'),0)
          THEN RAISE(ABORT,'journal is not balanced') END;
      END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS journal_transactions_posted_immutable
      BEFORE UPDATE ON journal_transactions
      WHEN OLD.status IN ('POSTED','REVERSED') AND (
        NEW.source_type<>OLD.source_type OR NEW.source_id<>OLD.source_id OR NEW.source_event_id<>OLD.source_event_id OR
        NEW.currency<>OLD.currency OR NEW.narration<>OLD.narration OR COALESCE(NEW.reversal_of,'')<>COALESCE(OLD.reversal_of,'') OR NEW.created_at<>OLD.created_at
      )
      BEGIN SELECT RAISE(ABORT,'posted journal transaction is immutable'); END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS journal_transactions_no_delete
      BEFORE DELETE ON journal_transactions
      WHEN OLD.status IN ('POSTED','REVERSED')
      BEGIN SELECT RAISE(ABORT,'posted journal transaction cannot be deleted'); END`),

    db.prepare(`CREATE TABLE IF NOT EXISTS partner_earning_pending (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL UNIQUE,
      partner_id TEXT NOT NULL,
      payment_intent_id TEXT NOT NULL,
      gross_service_value_paise INTEGER NOT NULL CHECK (gross_service_value_paise >= 0),
      platform_fee_paise INTEGER NOT NULL CHECK (platform_fee_paise >= 0),
      tds_paise INTEGER NOT NULL DEFAULT 0 CHECK (tds_paise >= 0),
      gst_paise INTEGER NOT NULL DEFAULT 0 CHECK (gst_paise >= 0),
      earning_paise INTEGER NOT NULL CHECK (earning_paise >= 0),
      currency TEXT NOT NULL DEFAULT 'INR',
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RELEASED','REVERSED')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(payment_intent_id) REFERENCES payment_intents(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS partner_payable_released (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      partner_id TEXT NOT NULL,
      pending_earning_id TEXT NOT NULL,
      release_type TEXT NOT NULL,
      amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
      currency TEXT NOT NULL DEFAULT 'INR',
      transfer_status TEXT NOT NULL DEFAULT 'ELIGIBLE' CHECK (transfer_status IN ('ELIGIBLE','QUEUED','PROCESSING','SETTLED','FAILED','REVERSED')),
      gateway_transfer_id TEXT UNIQUE,
      released_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(booking_id,release_type),
      FOREIGN KEY(pending_earning_id) REFERENCES partner_earning_pending(id)
    )`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS partner_release_requires_completed_booking
      BEFORE INSERT ON partner_payable_released
      WHEN NOT EXISTS (SELECT 1 FROM canonical_bookings b WHERE b.id=NEW.booking_id AND lower(b.status)='completed')
      BEGIN SELECT RAISE(ABORT,'partner earning can be released only for a completed booking'); END`),

    db.prepare(`CREATE TABLE IF NOT EXISTS payment_settlement_reconciliations (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL,
      environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
      payment_intent_id TEXT NOT NULL,
      gateway_payment_id TEXT NOT NULL,
      gateway_settlement_id TEXT NOT NULL,
      settlement_utr TEXT,
      amount_paise INTEGER NOT NULL CHECK(amount_paise >= 0),
      credit_paise INTEGER CHECK(credit_paise IS NULL OR credit_paise >= 0),
      debit_paise INTEGER CHECK(debit_paise IS NULL OR debit_paise >= 0),
      fee_paise INTEGER CHECK(fee_paise IS NULL OR fee_paise >= 0),
      tax_paise INTEGER CHECK(tax_paise IS NULL OR tax_paise >= 0),
      currency TEXT NOT NULL,
      settled_at INTEGER NOT NULL,
      recon_date TEXT NOT NULL,
      raw_payload_json TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      UNIQUE(provider, environment, gateway_payment_id),
      FOREIGN KEY(payment_intent_id) REFERENCES payment_intents(id)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS payment_settlement_recon_settlement_idx
      ON payment_settlement_reconciliations(provider, environment, gateway_settlement_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS payment_settlement_recon_intent_idx
      ON payment_settlement_reconciliations(payment_intent_id, settled_at)`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS payment_settlement_reconciliations_no_update
      BEFORE UPDATE ON payment_settlement_reconciliations
      BEGIN SELECT RAISE(ABORT,'payment settlement evidence is immutable'); END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS payment_settlement_reconciliations_no_delete
      BEFORE DELETE ON payment_settlement_reconciliations
      BEGIN SELECT RAISE(ABORT,'payment settlement evidence cannot be deleted'); END`),
    db.prepare(`CREATE TABLE IF NOT EXISTS razorpay_settlement_recon_runs (
      run_key TEXT PRIMARY KEY NOT NULL,
      environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
      status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED','FAILED')),
      attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts >= 1),
      result_json TEXT,
      last_error TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS razorpay_settlement_recon_runs_status_idx
      ON razorpay_settlement_recon_runs(environment, status, started_at)`),
  ]);
}
