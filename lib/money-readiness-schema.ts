type SqlStatement = { run(): Promise<unknown> | unknown };
type Db = { prepare(sql: string): SqlStatement };
type Runtime = Record<string, unknown>;

export const MONEY_READINESS_REQUIRED_TABLES = [
  "business_metric_definitions",
  "canonical_revenue_opportunity_context",
  "canonical_revenue_opportunity_service_history",
  "grooming_subscriptions",
  "marketing_audit_events",
  "marketing_campaigns",
  "marketing_promotions",
  "payment_settlement_reconciliations",
  "razorpay_settlement_recon_runs",
  "report_definitions",
  "report_runs",
  "service_proof_ledgers",
  "subscription_automation_rules",
  "subscription_entitlement_events",
  "subscription_entitlements",
  "subscription_events",
] as const;

export const MONEY_READINESS_SCHEMA_CONFIG = Object.freeze({
  canonicalJournalTable: "finance_journal_entries" as const,
  scope: "staging-and-test" as const,
  productionTelemetryRequired: false,
});

const normalize = (value: unknown) => String(value ?? "").trim().toLowerCase();

export function isMoneyReadinessStagingRuntime(runtime: Runtime) {
  const deployment = normalize(runtime.PAWSPACE_DEPLOYMENT_ENV);
  const appEnv = normalize(runtime.APP_ENV);
  const nodeEnv = normalize(runtime.NODE_ENV);
  const forbidProduction = normalize(runtime.FORBID_PRODUCTION) === "true";
  if (deployment === "production" || appEnv === "production") return false;
  return deployment === "staging" || appEnv === "staging" || (nodeEnv === "test" && forbidProduction);
}

export function assertMoneyReadinessNonProduction(runtime: Runtime) {
  if (!isMoneyReadinessStagingRuntime(runtime)) {
    throw new Error("Money-readiness schema bootstrap is restricted to staging or isolated test runtimes.");
  }
}

export const MONEY_READINESS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS grooming_subscriptions (
    id text PRIMARY KEY NOT NULL,
    customer_key text NOT NULL,
    pet_ids_json text NOT NULL,
    plan_code text NOT NULL,
    status text NOT NULL,
    sessions_total integer NOT NULL,
    sessions_used integer DEFAULT 0 NOT NULL,
    starts_at integer NOT NULL,
    renews_at integer NOT NULL,
    cadence_days integer DEFAULT 15 NOT NULL,
    auto_renew integer DEFAULT false NOT NULL,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS subscription_automation_rules (
    id text PRIMARY KEY NOT NULL,
    name text NOT NULL,
    trigger_code text NOT NULL,
    offsets_json text NOT NULL,
    channels_json text NOT NULL,
    bot_call_enabled integer DEFAULT false NOT NULL,
    quiet_hours_start text DEFAULT '20:00' NOT NULL,
    quiet_hours_end text DEFAULT '09:00' NOT NULL,
    active integer DEFAULT true NOT NULL,
    updated_at integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS subscription_events (
    id text PRIMARY KEY NOT NULL,
    subscription_id text NOT NULL,
    event_type text NOT NULL,
    channel text,
    status text NOT NULL,
    detail_json text DEFAULT '{}' NOT NULL,
    scheduled_at integer,
    created_at integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS business_metric_definitions (
    code text PRIMARY KEY NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    formula_json text NOT NULL,
    source_tables_json text NOT NULL,
    owner_role text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    active integer DEFAULT true NOT NULL,
    updated_at integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS report_definitions (
    id text PRIMARY KEY NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    metrics_json text NOT NULL,
    dimensions_json text NOT NULL,
    filters_json text NOT NULL,
    formats_json text NOT NULL,
    schedule_json text,
    recipient_rules_json text,
    active integer DEFAULT true NOT NULL,
    created_by text NOT NULL,
    updated_at integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS report_runs (
    id text PRIMARY KEY NOT NULL,
    report_id text NOT NULL,
    status text NOT NULL,
    format text NOT NULL,
    row_count integer DEFAULT 0 NOT NULL,
    snapshot_at integer NOT NULL,
    requested_by text NOT NULL,
    purpose text NOT NULL,
    masked integer DEFAULT true NOT NULL,
    output_reference text,
    created_at integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS marketing_audit_events (
    id text PRIMARY KEY NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    action text NOT NULL,
    detail_json text NOT NULL,
    actor_id text NOT NULL,
    created_at integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS marketing_campaigns (
    id text PRIMARY KEY NOT NULL,
    name text NOT NULL,
    platform text NOT NULL,
    objective text NOT NULL,
    vertical text NOT NULL,
    city text NOT NULL,
    audience text NOT NULL,
    daily_budget real NOT NULL,
    start_date text NOT NULL,
    end_date text,
    status text DEFAULT 'draft' NOT NULL,
    utm_json text NOT NULL,
    attribution_json text NOT NULL,
    created_by text NOT NULL,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS marketing_promotions (
    id text PRIMARY KEY NOT NULL,
    name text NOT NULL,
    promotion_type text NOT NULL,
    vertical text NOT NULL,
    audience text NOT NULL,
    value real NOT NULL,
    budget_cap real NOT NULL,
    holdout_percent integer DEFAULT 10 NOT NULL,
    coupon_policy text NOT NULL,
    start_at text NOT NULL,
    end_at text NOT NULL,
    status text DEFAULT 'draft' NOT NULL,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS payment_settlement_reconciliations (
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
  )`,
  `CREATE INDEX IF NOT EXISTS payment_settlement_recon_settlement_idx
    ON payment_settlement_reconciliations(provider, environment, gateway_settlement_id)`,
  `CREATE INDEX IF NOT EXISTS payment_settlement_recon_intent_idx
    ON payment_settlement_reconciliations(payment_intent_id, settled_at)`,
  `CREATE TRIGGER IF NOT EXISTS payment_settlement_reconciliations_no_update
    BEFORE UPDATE ON payment_settlement_reconciliations
    BEGIN
      SELECT RAISE(ABORT,'payment settlement evidence is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS payment_settlement_reconciliations_no_delete
    BEFORE DELETE ON payment_settlement_reconciliations
    BEGIN
      SELECT RAISE(ABORT,'payment settlement evidence cannot be deleted');
    END`,
  `CREATE TABLE IF NOT EXISTS razorpay_settlement_recon_runs (
    run_key TEXT PRIMARY KEY NOT NULL,
    environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
    status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED','FAILED')),
    attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts >= 1),
    result_json TEXT,
    last_error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS razorpay_settlement_recon_runs_status_idx
    ON razorpay_settlement_recon_runs(environment, status, started_at)`,
  `CREATE TABLE IF NOT EXISTS subscription_entitlements (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    pet_id TEXT,
    household_id TEXT,
    service_code TEXT NOT NULL,
    package_code TEXT,
    plan_code TEXT NOT NULL,
    plan_version TEXT NOT NULL,
    unit_type TEXT NOT NULL CHECK(unit_type IN ('session','visit','day','walk','credit','other')),
    total_units INTEGER NOT NULL CHECK(total_units >= 0),
    reserved_units INTEGER NOT NULL DEFAULT 0 CHECK(reserved_units >= 0),
    consumed_units INTEGER NOT NULL DEFAULT 0 CHECK(consumed_units >= 0),
    released_units INTEGER NOT NULL DEFAULT 0 CHECK(released_units >= 0),
    available_units INTEGER NOT NULL CHECK(available_units >= 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','suspended','cancelled','expired','exhausted')),
    starts_at INTEGER NOT NULL,
    expires_at INTEGER,
    grace_expires_at INTEGER,
    renewal_eligible_at INTEGER,
    pause_policy_json TEXT NOT NULL DEFAULT '{}',
    family_wallet_enabled INTEGER NOT NULL DEFAULT 0 CHECK(family_wallet_enabled IN (0,1)),
    source_purchase_id TEXT,
    source_booking_id TEXT,
    source_payment_id TEXT,
    policy_version TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK(reserved_units + consumed_units <= total_units),
    CHECK(available_units = total_units - reserved_units - consumed_units)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subscription_entitlements_customer_service
    ON subscription_entitlements(customer_id, service_code, status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_subscription_entitlements_pet
    ON subscription_entitlements(pet_id, service_code, status)`,
  `CREATE INDEX IF NOT EXISTS idx_subscription_entitlements_household
    ON subscription_entitlements(household_id, service_code, status)`,
  `CREATE TABLE IF NOT EXISTS subscription_entitlement_events (
    id TEXT PRIMARY KEY,
    entitlement_id TEXT NOT NULL,
    booking_id TEXT,
    event_type TEXT NOT NULL CHECK(event_type IN ('grant','reserve','consume','release','activate','pause','resume','suspend','expire','cancel')),
    units INTEGER NOT NULL DEFAULT 0 CHECK(units >= 0),
    total_after INTEGER NOT NULL CHECK(total_after >= 0),
    reserved_after INTEGER NOT NULL CHECK(reserved_after >= 0),
    consumed_after INTEGER NOT NULL CHECK(consumed_after >= 0),
    released_after INTEGER NOT NULL CHECK(released_after >= 0),
    available_after INTEGER NOT NULL CHECK(available_after >= 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    source_event_id TEXT,
    actor_id TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    FOREIGN KEY(entitlement_id) REFERENCES subscription_entitlements(id),
    CHECK(reserved_after + consumed_after <= total_after),
    CHECK(available_after = total_after - reserved_after - consumed_after)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subscription_entitlement_events_entitlement
    ON subscription_entitlement_events(entitlement_id, created_at, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_entitlement_events_source
    ON subscription_entitlement_events(source_event_id)
    WHERE source_event_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS canonical_revenue_opportunity_context (
    opportunity_id TEXT PRIMARY KEY,
    pet_id TEXT,
    household_id TEXT,
    target_service_code TEXT NOT NULL,
    pet_snapshot_json TEXT NOT NULL DEFAULT '{}',
    service_history_snapshot_json TEXT NOT NULL DEFAULT '[]',
    reason_codes_json TEXT NOT NULL DEFAULT '[]',
    score INTEGER NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 100),
    urgency INTEGER NOT NULL DEFAULT 0 CHECK(urgency BETWEEN 0 AND 100),
    expected_revenue REAL NOT NULL DEFAULT 0 CHECK(expected_revenue >= 0),
    expected_contribution REAL,
    contribution_basis_json TEXT NOT NULL DEFAULT '{}',
    owner_id TEXT,
    eligible_at INTEGER,
    expires_at INTEGER,
    attribution_id TEXT,
    policy_evidence_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(opportunity_id) REFERENCES canonical_revenue_opportunities(id),
    CHECK(expected_contribution IS NULL OR expected_contribution <= expected_revenue)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_revenue_opportunity_context_pet_service
    ON canonical_revenue_opportunity_context(pet_id, target_service_code)`,
  `CREATE INDEX IF NOT EXISTS idx_revenue_opportunity_context_owner_urgency
    ON canonical_revenue_opportunity_context(owner_id, urgency, eligible_at)`,
  `CREATE INDEX IF NOT EXISTS idx_revenue_opportunity_context_household
    ON canonical_revenue_opportunity_context(household_id, target_service_code)`,
  `CREATE TABLE IF NOT EXISTS canonical_revenue_opportunity_service_history (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    service_code TEXT NOT NULL,
    completed_count INTEGER NOT NULL DEFAULT 0 CHECK(completed_count >= 0),
    last_completed_at INTEGER,
    next_booking_at INTEGER,
    active_entitlement_units INTEGER NOT NULL DEFAULT 0 CHECK(active_entitlement_units >= 0),
    source_snapshot_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    FOREIGN KEY(opportunity_id) REFERENCES canonical_revenue_opportunities(id),
    UNIQUE(opportunity_id, service_code)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_revenue_opportunity_history_service
    ON canonical_revenue_opportunity_service_history(service_code, last_completed_at)`,
  `CREATE TABLE IF NOT EXISTS service_proof_ledgers (
    id TEXT PRIMARY KEY NOT NULL,
    job_id TEXT NOT NULL UNIQUE,
    provider_id TEXT NOT NULL,
    check_in_gps TEXT NOT NULL,
    check_out_gps TEXT NOT NULL,
    media_urls TEXT NOT NULL DEFAULT '[]',
    structured_report TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    CHECK (json_valid(check_in_gps) AND json_type(check_in_gps) = 'object'),
    CHECK (json_valid(check_out_gps) AND json_type(check_out_gps) = 'object'),
    CHECK (json_valid(media_urls) AND json_type(media_urls) = 'array'),
    CHECK (json_valid(structured_report) AND json_type(structured_report) = 'object')
  )`,
  `CREATE INDEX IF NOT EXISTS service_proof_ledgers_provider_created_idx
    ON service_proof_ledgers(provider_id, created_at)`,
] as const;

const ensuredDatabases = new WeakSet<object>();

export async function ensureMoneyReadinessTables(db: Db, runtime: Runtime) {
  assertMoneyReadinessNonProduction(runtime);
  if (ensuredDatabases.has(db as object)) return;
  for (const sql of MONEY_READINESS_SCHEMA_STATEMENTS) await db.prepare(sql).run();
  ensuredDatabases.add(db as object);
}

export function renderMoneyReadinessSchemaSql(runtime: Runtime) {
  assertMoneyReadinessNonProduction(runtime);
  return `${MONEY_READINESS_SCHEMA_STATEMENTS.join(";\n\n")};\n`;
}
