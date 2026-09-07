-- Privacy / webhook resilience / payout-beneficiary closure.
-- Additive only; live payout remains disabled by application policy.

CREATE TABLE IF NOT EXISTS dpdp_erasure_requests (
  id TEXT PRIMARY KEY,
  customer_id_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  ledger_before_json TEXT NOT NULL DEFAULT '{}',
  ledger_after_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dpdp_erasure_status ON dpdp_erasure_requests(status,created_at);

CREATE TABLE IF NOT EXISTS gateway_inbound_queue (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  route_key TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','uat','live')),
  event_id TEXT NOT NULL,
  message_id TEXT,
  payload_sha256 TEXT NOT NULL,
  raw_payload TEXT,
  headers_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','PROCESSING','RETRY','PROCESSED','DEAD_LETTER','REJECTED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 12),
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  processed_at INTEGER,
  payload_expires_at INTEGER NOT NULL,
  UNIQUE(provider,environment,route_key,event_id),
  UNIQUE(provider,environment,route_key,payload_sha256)
);
CREATE INDEX IF NOT EXISTS idx_gateway_inbound_due ON gateway_inbound_queue(status,next_attempt_at,lease_expires_at);
CREATE TABLE IF NOT EXISTS gateway_inbound_dead_letters (
  queue_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  route_key TEXT NOT NULL,
  environment TEXT NOT NULL,
  event_id TEXT NOT NULL,
  message_id TEXT,
  payload_sha256 TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  failure_reason TEXT NOT NULL,
  dead_lettered_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gateway_inbound_dlq_provider ON gateway_inbound_dead_letters(provider,dead_lettered_at DESC);

CREATE TABLE IF NOT EXISTS payout_beneficiary_preauthorizations (
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  razorpayx_contact_id TEXT NOT NULL,
  razorpayx_fund_account_id TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(scope_type,scope_id)
);

-- provider_order_payouts and partner_payout_instructions are runtime-owned tables rather than
-- guaranteed migration-time tables. Their additive snapshot columns and fail-closed triggers are
-- installed by ensurePayoutBeneficiarySnapshotSchema() only after those tables exist.

DROP TRIGGER IF EXISTS gateway_webhook_events_immutable_update;
CREATE TRIGGER IF NOT EXISTS gateway_webhook_events_immutable_update
BEFORE UPDATE OF provider,environment,event_id,payload_sha256,signature,received_at ON gateway_webhook_events
BEGIN
  SELECT RAISE(ABORT,'gateway webhook evidence is immutable');
END;
CREATE TRIGGER IF NOT EXISTS gateway_webhook_events_raw_payload_scrub_only
BEFORE UPDATE OF raw_payload ON gateway_webhook_events
WHEN NEW.raw_payload <> '{}'
BEGIN
  SELECT RAISE(ABORT,'gateway webhook raw payload may only be privacy-scrubbed');
END;

-- Razorpay already owns a stronger signed inbox. Mirror each accepted event into the universal inbox
-- inside the same INSERT transaction, before reconciliation/business processing begins.
CREATE TRIGGER IF NOT EXISTS gateway_webhook_to_universal_inbox
AFTER INSERT ON gateway_webhook_events
BEGIN
  INSERT OR IGNORE INTO gateway_inbound_queue
    (id,provider,route_key,environment,event_id,message_id,payload_sha256,raw_payload,headers_json,status,attempts,max_attempts,next_attempt_at,received_at,updated_at,payload_expires_at)
  VALUES
    ('GIN-RZP-' || NEW.id,NEW.provider,'razorpay-webhook',NEW.environment,NEW.event_id,NULL,NEW.payload_sha256,NEW.raw_payload,json_object('x-razorpay-event-id',NEW.event_id,'x-razorpay-signature',NEW.signature),'RECEIVED',0,5,NEW.received_at,NEW.received_at,NEW.received_at,NEW.received_at + 604800000);
END;
CREATE TRIGGER IF NOT EXISTS gateway_webhook_sync_universal_status
AFTER UPDATE OF processing_status ON gateway_webhook_events
BEGIN
  UPDATE gateway_inbound_queue
  SET status=CASE NEW.processing_status
      WHEN 'PROCESSING' THEN 'PROCESSING'
      WHEN 'PROCESSED' THEN 'PROCESSED'
      WHEN 'REJECTED' THEN 'REJECTED'
      WHEN 'FAILED' THEN 'RETRY'
      WHEN 'DEFERRED' THEN 'RETRY'
      ELSE status END,
      raw_payload=CASE WHEN NEW.processing_status IN ('PROCESSED','REJECTED') THEN NULL ELSE raw_payload END,
      headers_json=CASE WHEN NEW.processing_status IN ('PROCESSED','REJECTED') THEN '{}' ELSE headers_json END,
      processed_at=CASE WHEN NEW.processing_status IN ('PROCESSED','REJECTED') THEN COALESCE(NEW.processed_at,strftime('%s','now')*1000) ELSE processed_at END,
      updated_at=strftime('%s','now')*1000
  WHERE provider=NEW.provider AND environment=NEW.environment AND route_key='razorpay-webhook' AND event_id=NEW.event_id;
END;
