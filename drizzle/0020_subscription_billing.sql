PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subscription_billing_plans (
  id TEXT PRIMARY KEY,
  plan_code TEXT NOT NULL UNIQUE,
  service_code TEXT NOT NULL,
  city_id TEXT,
  provider TEXT NOT NULL DEFAULT 'razorpay',
  provider_plan_id TEXT NOT NULL UNIQUE,
  charge_amount_paise INTEGER NOT NULL CHECK(charge_amount_paise>0),
  invoice_taxable_paise INTEGER NOT NULL CHECK(invoice_taxable_paise>0 AND invoice_taxable_paise<=charge_amount_paise),
  currency TEXT NOT NULL DEFAULT 'INR',
  interval_period TEXT,
  interval_count INTEGER,
  total_cycles INTEGER NOT NULL CHECK(total_cycles BETWEEN 1 AND 1200),
  trial_days INTEGER NOT NULL DEFAULT 0 CHECK(trial_days BETWEEN 0 AND 365),
  grace_days INTEGER NOT NULL DEFAULT 3 CHECK(grace_days BETWEEN 0 AND 30),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','retired')),
  finance_entity_id TEXT NOT NULL,
  provider_verified_at INTEGER,
  provider_plan_snapshot_json TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER
);
CREATE TABLE IF NOT EXISTS subscription_billing_contracts (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, entitlement_subscription_id TEXT,
  source_booking_id TEXT NOT NULL, plan_code TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'razorpay',
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')), provider_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','authenticated','active','past_due','suspended','cancelled','expired')),
  provider_status TEXT NOT NULL DEFAULT 'created', current_period_start INTEGER,current_period_end INTEGER,
  trial_end_at INTEGER,grace_expires_at INTEGER,cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  pending_plan_code TEXT,last_provider_event_id TEXT,version INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
  UNIQUE(customer_id,source_booking_id)
);
CREATE INDEX IF NOT EXISTS idx_subscription_billing_contract_status ON subscription_billing_contracts(status,grace_expires_at);
CREATE TABLE IF NOT EXISTS subscription_provider_commands (
  id TEXT PRIMARY KEY,contract_id TEXT NOT NULL,command_type TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('processing','succeeded','failed','reconciliation_required')),request_json TEXT NOT NULL,response_json TEXT,last_error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscription_billing_cycles (
  id TEXT PRIMARY KEY,contract_id TEXT NOT NULL,provider_payment_id TEXT NOT NULL UNIQUE,provider_invoice_id TEXT,
  provider_event_id TEXT NOT NULL UNIQUE,period_start INTEGER,period_end INTEGER,amount_paise INTEGER NOT NULL CHECK(amount_paise>0),currency TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'paid' CHECK(status IN ('paid','partially_refunded','refunded')),finance_invoice_id TEXT,accounting_status TEXT NOT NULL DEFAULT 'pending' CHECK(accounting_status IN ('pending','completed','exception')),accounting_error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscription_billing_events (
  id TEXT PRIMARY KEY,contract_id TEXT NOT NULL,provider_event_id TEXT NOT NULL UNIQUE,event_type TEXT NOT NULL,provider_status TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscription_refund_cases (
  id TEXT PRIMARY KEY,contract_id TEXT NOT NULL,cycle_id TEXT NOT NULL,amount_paise INTEGER NOT NULL CHECK(amount_paise>0),reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','processing','processed','rejected','failed')),requested_by TEXT NOT NULL,approved_by TEXT,approved_at INTEGER,gateway_refund_id TEXT UNIQUE,provider_payment_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscription_refund_transition_claims (
  id TEXT PRIMARY KEY,refund_case_id TEXT NOT NULL,from_status TEXT NOT NULL,to_status TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(refund_case_id,from_status)
);
CREATE TABLE IF NOT EXISTS subscription_provider_refunds (
  id TEXT PRIMARY KEY,cycle_id TEXT NOT NULL,gateway_refund_id TEXT NOT NULL UNIQUE,provider_event_id TEXT NOT NULL UNIQUE,amount_paise INTEGER NOT NULL CHECK(amount_paise>0),kind TEXT NOT NULL CHECK(kind IN ('maker_checker','provider_proration')),created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscription_entitlement_grants (
  cycle_id TEXT PRIMARY KEY,contract_id TEXT NOT NULL,entitlement_subscription_id TEXT NOT NULL,credits_granted INTEGER NOT NULL CHECK(credits_granted>0),amount_paise INTEGER NOT NULL CHECK(amount_paise>0),total_before INTEGER NOT NULL CHECK(total_before>=0),period_end INTEGER,refund_reserved_credits INTEGER NOT NULL DEFAULT 0 CHECK(refund_reserved_credits>=0),refunded_credits INTEGER NOT NULL DEFAULT 0 CHECK(refunded_credits>=0),refunded_paise INTEGER NOT NULL DEFAULT 0 CHECK(refunded_paise>=0),status TEXT NOT NULL DEFAULT 'applied' CHECK(status IN ('claiming','applied')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscription_entitlement_grants_subscription ON subscription_entitlement_grants(entitlement_subscription_id,created_at,cycle_id);
CREATE TABLE IF NOT EXISTS subscription_refund_entitlement_allocations (
  id TEXT PRIMARY KEY,allocation_key TEXT NOT NULL UNIQUE,cycle_id TEXT NOT NULL,refund_case_id TEXT UNIQUE,gateway_refund_id TEXT UNIQUE,amount_paise INTEGER NOT NULL CHECK(amount_paise>0),credits INTEGER NOT NULL CHECK(credits>0),kind TEXT NOT NULL CHECK(kind IN ('maker_checker','provider_proration')),status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','processed')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
