PRAGMA foreign_keys = ON;

-- Paise-native payment intent. Existing booking_payments remains the booking-facing projection;
-- this table is the durable gateway command/state authority.
CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'razorpay',
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','live')),
  idempotency_key TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  state TEXT NOT NULL DEFAULT 'CREATED' CHECK (state IN ('CREATED','AUTHORIZED','CAPTURED','SETTLED','FAILED','CANCELLED')),
  order_request_state TEXT NOT NULL DEFAULT 'PAYMENT_ORDER_REQUESTED' CHECK (order_request_state IN ('PAYMENT_ORDER_REQUESTED','PROCESSING','ORDER_CREATED','RECONCILIATION_REQUIRED','FAILED')),
  gateway_order_id TEXT,
  gateway_payment_id TEXT,
  gateway_settlement_id TEXT,
  gross_service_value_paise INTEGER NOT NULL CHECK (gross_service_value_paise >= 0),
  platform_fee_paise INTEGER NOT NULL CHECK (platform_fee_paise >= 0),
  partner_earning_paise INTEGER NOT NULL CHECK (partner_earning_paise >= 0),
  tds_paise INTEGER NOT NULL DEFAULT 0 CHECK (tds_paise >= 0),
  gst_paise INTEGER NOT NULL DEFAULT 0 CHECK (gst_paise >= 0),
  commission_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (commission_rate_bps BETWEEN 0 AND 10000),
  commission_rate_version TEXT NOT NULL,
  tax_rule_version TEXT NOT NULL,
  commercial_snapshot_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(customer_id, booking_id, idempotency_key),
  UNIQUE(gateway_order_id),
  UNIQUE(gateway_payment_id),
  UNIQUE(gateway_settlement_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_payment_id ON payment_intents(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_booking ON payment_intents(booking_id);

CREATE TABLE IF NOT EXISTS financial_outbox (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','SUCCEEDED','RETRY','RECONCILIATION_REQUIRED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  request_json TEXT,
  response_json TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_financial_outbox_due ON financial_outbox(status,next_attempt_at,lease_expires_at);

-- Immutable raw webhook inbox. Domain code inserts here before JSON normalization/processing.
CREATE TABLE IF NOT EXISTS gateway_webhook_events (
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
);

CREATE TRIGGER IF NOT EXISTS gateway_webhook_events_immutable_update
BEFORE UPDATE OF provider,environment,event_id,raw_payload,payload_sha256,signature,received_at ON gateway_webhook_events
BEGIN
  SELECT RAISE(ABORT,'gateway webhook evidence is immutable');
END;
CREATE TRIGGER IF NOT EXISTS gateway_webhook_events_immutable_delete
BEFORE DELETE ON gateway_webhook_events
BEGIN
  SELECT RAISE(ABORT,'gateway webhook evidence cannot be deleted');
END;

-- External identity registry makes IDs unique even when they originate in different finance tables.
CREATE TABLE IF NOT EXISTS gateway_object_identities (
  provider TEXT NOT NULL,
  object_type TEXT NOT NULL CHECK (object_type IN ('order','payment','refund','transfer','payout','settlement','payment_link')),
  external_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(provider,object_type,external_id)
);

CREATE TABLE IF NOT EXISTS journal_transactions (
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
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  account_code TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  booking_id TEXT,
  partner_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(transaction_id) REFERENCES journal_transactions(id)
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_transaction ON journal_entries(transaction_id);

CREATE TRIGGER IF NOT EXISTS journal_entries_no_update
BEFORE UPDATE ON journal_entries
WHEN EXISTS (SELECT 1 FROM journal_transactions jt WHERE jt.id=OLD.transaction_id AND jt.status IN ('POSTED','REVERSED'))
BEGIN
  SELECT RAISE(ABORT,'posted journal entries are immutable');
END;
CREATE TRIGGER IF NOT EXISTS journal_entries_no_delete
BEFORE DELETE ON journal_entries
WHEN EXISTS (SELECT 1 FROM journal_transactions jt WHERE jt.id=OLD.transaction_id AND jt.status IN ('POSTED','REVERSED'))
BEGIN
  SELECT RAISE(ABORT,'posted journal entries cannot be deleted');
END;
CREATE TRIGGER IF NOT EXISTS journal_transactions_post_balanced
BEFORE UPDATE OF status ON journal_transactions
WHEN NEW.status='POSTED' AND OLD.status='DRAFT'
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM journal_entries WHERE transaction_id=NEW.id) < 2
    THEN RAISE(ABORT,'journal requires at least two entries') END;
  SELECT CASE WHEN
    COALESCE((SELECT SUM(amount_paise) FROM journal_entries WHERE transaction_id=NEW.id AND direction='DEBIT'),0)
    !=
    COALESCE((SELECT SUM(amount_paise) FROM journal_entries WHERE transaction_id=NEW.id AND direction='CREDIT'),0)
    THEN RAISE(ABORT,'journal is not balanced') END;
END;
CREATE TRIGGER IF NOT EXISTS journal_transactions_posted_immutable
BEFORE UPDATE ON journal_transactions
WHEN OLD.status IN ('POSTED','REVERSED') AND (
  NEW.source_type<>OLD.source_type OR NEW.source_id<>OLD.source_id OR NEW.source_event_id<>OLD.source_event_id OR
  NEW.currency<>OLD.currency OR NEW.narration<>OLD.narration OR COALESCE(NEW.reversal_of,'')<>COALESCE(OLD.reversal_of,'') OR NEW.created_at<>OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT,'posted journal transaction is immutable');
END;
CREATE TRIGGER IF NOT EXISTS journal_transactions_no_delete
BEFORE DELETE ON journal_transactions
WHEN OLD.status IN ('POSTED','REVERSED')
BEGIN
  SELECT RAISE(ABORT,'posted journal transaction cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS partner_earning_pending (
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
);

CREATE TABLE IF NOT EXISTS partner_payable_released (
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
);

CREATE TRIGGER IF NOT EXISTS partner_release_requires_completed_booking
BEFORE INSERT ON partner_payable_released
WHEN NOT EXISTS (SELECT 1 FROM canonical_bookings b WHERE b.id=NEW.booking_id AND lower(b.status)='completed')
BEGIN
  SELECT RAISE(ABORT,'partner earning can be released only for a completed booking');
END;

CREATE TABLE IF NOT EXISTS tax_rule_versions (
  id TEXT PRIMARY KEY,
  rule_code TEXT NOT NULL,
  version TEXT NOT NULL,
  basis_points INTEGER NOT NULL CHECK (basis_points BETWEEN 0 AND 10000),
  calculation_basis TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(rule_code,version)
);
CREATE TRIGGER IF NOT EXISTS tax_rule_versions_no_update BEFORE UPDATE ON tax_rule_versions BEGIN SELECT RAISE(ABORT,'tax rule versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tax_rule_versions_no_delete BEFORE DELETE ON tax_rule_versions BEGIN SELECT RAISE(ABORT,'tax rule versions cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS gst_documents (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL CHECK (document_type IN ('TAX_INVOICE','CREDIT_NOTE')),
  document_number TEXT NOT NULL UNIQUE,
  booking_id TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  original_document_id TEXT,
  taxable_value_paise INTEGER NOT NULL CHECK (taxable_value_paise >= 0),
  cgst_paise INTEGER NOT NULL DEFAULT 0 CHECK (cgst_paise >= 0),
  sgst_paise INTEGER NOT NULL DEFAULT 0 CHECK (sgst_paise >= 0),
  igst_paise INTEGER NOT NULL DEFAULT 0 CHECK (igst_paise >= 0),
  total_paise INTEGER NOT NULL CHECK (total_paise >= 0),
  seller_gstin TEXT,
  buyer_gstin TEXT,
  place_of_supply TEXT NOT NULL,
  tax_rule_version TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(payment_intent_id) REFERENCES payment_intents(id),
  FOREIGN KEY(original_document_id) REFERENCES gst_documents(id)
);
CREATE TRIGGER IF NOT EXISTS gst_documents_no_update BEFORE UPDATE ON gst_documents BEGIN SELECT RAISE(ABORT,'GST documents are immutable'); END;
CREATE TRIGGER IF NOT EXISTS gst_documents_no_delete BEFORE DELETE ON gst_documents BEGIN SELECT RAISE(ABORT,'GST documents cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS gateway_refunds (
  id TEXT PRIMARY KEY,
  payment_intent_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','PROCESSING','PROCESSED','FAILED','RECONCILIATION_REQUIRED')),
  gateway_refund_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(payment_intent_id) REFERENCES payment_intents(id)
);
