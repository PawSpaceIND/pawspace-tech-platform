-- Middle-platform hardening: non-null case SLA deadlines and multi-vertical subscription wallet rails.

-- Runtime-owned legacy tables are declared here as well so this migration is safe on a fresh D1 database.
CREATE TABLE IF NOT EXISTS unified_cases (
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, case_type TEXT NOT NULL, severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', title TEXT NOT NULL, description TEXT NOT NULL, customer_id TEXT, booking_id TEXT,
  payment_id TEXT, lead_id TEXT, provider_id TEXT, source_type TEXT NOT NULL, source_id TEXT NOT NULL, owner_team TEXT NOT NULL,
  owner_email TEXT, policy_id TEXT, policy_version INTEGER, first_response_due_at INTEGER NOT NULL, resolution_due_at INTEGER NOT NULL,
  manager_escalation_due_at INTEGER NOT NULL, first_responded_at INTEGER, resolved_at INTEGER, closed_at INTEGER, resolution_code TEXT,
  resolution_note TEXT, reopen_count INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_grooming_subscriptions (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, plan_code TEXT NOT NULL, service_package_code TEXT NOT NULL,
  total_sessions INTEGER NOT NULL, sessions_reserved INTEGER NOT NULL DEFAULT 0, sessions_consumed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, source_booking_id TEXT NOT NULL UNIQUE,
  catalogue_version TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS case_global_sla_defaults (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  first_response_minutes INTEGER NOT NULL CHECK (first_response_minutes > 0),
  manager_escalation_minutes INTEGER NOT NULL CHECK (manager_escalation_minutes > 0),
  resolution_minutes INTEGER NOT NULL CHECK (resolution_minutes > 0),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO case_global_sla_defaults
  (id, first_response_minutes, manager_escalation_minutes, resolution_minutes, version, updated_at)
VALUES ('global', 60, 720, 1440, 1, 0);

UPDATE unified_cases
SET first_response_due_at = COALESCE(first_response_due_at, created_at + 3600000),
    manager_escalation_due_at = COALESCE(manager_escalation_due_at, created_at + 43200000),
    resolution_due_at = COALESCE(resolution_due_at, created_at + 86400000),
    policy_id = COALESCE(policy_id, 'GLOBAL_DEFAULT_SLA'),
    policy_version = COALESCE(policy_version, 1)
WHERE first_response_due_at IS NULL
   OR manager_escalation_due_at IS NULL
   OR resolution_due_at IS NULL;

CREATE TRIGGER IF NOT EXISTS unified_cases_deadlines_not_null_insert
BEFORE INSERT ON unified_cases
WHEN NEW.first_response_due_at IS NULL
  OR NEW.manager_escalation_due_at IS NULL
  OR NEW.resolution_due_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'case_sla_deadline_required');
END;

CREATE TRIGGER IF NOT EXISTS unified_cases_deadlines_not_null_update
BEFORE UPDATE OF first_response_due_at, manager_escalation_due_at, resolution_due_at ON unified_cases
WHEN NEW.first_response_due_at IS NULL
  OR NEW.manager_escalation_due_at IS NULL
  OR NEW.resolution_due_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'case_sla_deadline_required');
END;

CREATE TABLE IF NOT EXISTS subscription_vertical_eligibility (
  subscription_id TEXT NOT NULL,
  service_code TEXT NOT NULL,
  package_codes_json TEXT NOT NULL DEFAULT '[]',
  credits_per_booking INTEGER NOT NULL DEFAULT 1 CHECK (credits_per_booking > 0),
  status TEXT NOT NULL DEFAULT 'active',
  effective_from INTEGER NOT NULL,
  effective_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, service_code)
);

INSERT OR IGNORE INTO subscription_vertical_eligibility
  (subscription_id, service_code, package_codes_json, credits_per_booking, status, effective_from, effective_until, created_at, updated_at)
SELECT id, 'grooming', '[]', 1, 'active', started_at, NULL, created_at, updated_at
FROM customer_grooming_subscriptions;

CREATE TABLE IF NOT EXISTS subscription_auto_renewal (
  subscription_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  billing_interval_months INTEGER NOT NULL DEFAULT 1 CHECK (billing_interval_months > 0),
  renewal_lead_days INTEGER NOT NULL DEFAULT 3 CHECK (renewal_lead_days >= 0),
  payment_method_reference TEXT,
  next_renewal_at INTEGER,
  status TEXT NOT NULL DEFAULT 'disabled',
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_renewal_cycles (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  cycle_number INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  amount_minor INTEGER,
  currency TEXT NOT NULL DEFAULT 'INR',
  payment_trigger_reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (subscription_id, cycle_number)
);
