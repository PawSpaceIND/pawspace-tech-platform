-- Payment-level Razorpay settlement reconciliation evidence.
--
-- A Razorpay bank settlement is a batch: several payment transactions can legitimately share the
-- same settlement_id. payment_intents.gateway_settlement_id was introduced as a convenience field
-- with a one-to-one uniqueness constraint, so it is intentionally NOT used as the authoritative
-- mapping here. The payment-level evidence key is gateway_payment_id + gateway_settlement_id and
-- gateway_settlement_id itself is deliberately non-unique.

CREATE TABLE IF NOT EXISTS payment_settlement_reconciliations (
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
  UNIQUE(provider, environment, gateway_payment_id, gateway_settlement_id),
  FOREIGN KEY(payment_intent_id) REFERENCES payment_intents(id)
);

CREATE INDEX IF NOT EXISTS payment_settlement_recon_settlement_idx
  ON payment_settlement_reconciliations(provider, environment, gateway_settlement_id);
CREATE INDEX IF NOT EXISTS payment_settlement_recon_intent_idx
  ON payment_settlement_reconciliations(payment_intent_id, settled_at);

CREATE TABLE IF NOT EXISTS razorpay_settlement_recon_runs (
  run_key TEXT PRIMARY KEY NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
  status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts >= 1),
  result_json TEXT,
  last_error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS razorpay_settlement_recon_runs_status_idx
  ON razorpay_settlement_recon_runs(environment, status, started_at);
