import { ensureFinancialRuntimeSupportTables } from "./financial-runtime-schema";

type Db = D1Database;

let ready: Promise<void> | null = null;

/**
 * Ensure the minimum production money-path schema exists before any API or scheduled finance work can
 * execute. The runtime previously created payment_intents/financial_outbox lazily but left the journal,
 * partner earning and settlement tables to an unapplied migration directory. This bootstrap closes that
 * split without replaying historical migrations against an existing database.
 *
 * The promise is cached per Worker isolate so normal requests do not run DDL repeatedly. A failed
 * bootstrap is not cached: the next request/scheduled invocation may retry after a transient D1 error.
 */
export function ensureFinancialRuntimeSchema(db: Db) {
  if (!ready) {
    ready = (async () => {
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS payment_intents (
          id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, customer_id TEXT NOT NULL, payment_id TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT 'razorpay',
          environment TEXT NOT NULL CHECK (environment IN ('sandbox','live')),
          idempotency_key TEXT NOT NULL,
          amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
          currency TEXT NOT NULL DEFAULT 'INR',
          state TEXT NOT NULL DEFAULT 'CREATED' CHECK (state IN ('CREATED','AUTHORIZED','CAPTURED','SETTLED','FAILED','CANCELLED')),
          order_request_state TEXT NOT NULL DEFAULT 'PAYMENT_ORDER_REQUESTED' CHECK (order_request_state IN ('PAYMENT_ORDER_REQUESTED','PROCESSING','ORDER_CREATED','RECONCILIATION_REQUIRED','FAILED')),
          gateway_order_id TEXT, gateway_payment_id TEXT, gateway_settlement_id TEXT,
          gross_service_value_paise INTEGER NOT NULL CHECK (gross_service_value_paise >= 0),
          platform_fee_paise INTEGER NOT NULL CHECK (platform_fee_paise >= 0),
          partner_earning_paise INTEGER NOT NULL CHECK (partner_earning_paise >= 0),
          tds_paise INTEGER NOT NULL DEFAULT 0 CHECK (tds_paise >= 0),
          gst_paise INTEGER NOT NULL DEFAULT 0 CHECK (gst_paise >= 0),
          commission_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (commission_rate_bps BETWEEN 0 AND 10000),
          commission_rate_version TEXT NOT NULL, tax_rule_version TEXT NOT NULL,
          commercial_snapshot_json TEXT NOT NULL DEFAULT '{}',
          version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(customer_id, booking_id, idempotency_key), UNIQUE(gateway_order_id),
          UNIQUE(gateway_payment_id), UNIQUE(gateway_settlement_id)
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS financial_outbox (
          id TEXT PRIMARY KEY, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
          event_type TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','SUCCEEDED','RETRY','RECONCILIATION_REQUIRED','FAILED')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          lease_owner TEXT, lease_expires_at INTEGER, next_attempt_at INTEGER NOT NULL,
          request_json TEXT, response_json TEXT, last_error TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )`),
        // 0018 deliberately made this NON-unique because split payments can own several intents.
        db.prepare("CREATE INDEX IF NOT EXISTS idx_payment_intents_payment_id ON payment_intents(payment_id)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_payment_intents_booking ON payment_intents(booking_id)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_financial_outbox_due ON financial_outbox(status,next_attempt_at,lease_expires_at)"),
      ]);
      await ensureFinancialRuntimeSupportTables(db);
    })().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

/** Test-only reset for isolated database harnesses that create more than one D1 adapter per process. */
export function resetFinancialRuntimeSchemaForTests() {
  ready = null;
}
