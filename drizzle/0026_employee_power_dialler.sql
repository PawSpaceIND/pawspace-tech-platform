-- Canonical persistence for the employee power dialler introduced by PR #517.
-- This intentionally mirrors ensureEmployeePowerDiallerTables() so fresh D1
-- environments and runtime self-healing converge on the same schema.

CREATE TABLE IF NOT EXISTS employee_power_calls (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  queue_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  employee_id TEXT,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'exotel',
  provider_call_id TEXT,
  provider_status TEXT,
  duration_seconds INTEGER,
  recording_url TEXT,
  employee_phone_hash TEXT NOT NULL,
  employee_phone_last4 TEXT NOT NULL,
  customer_phone_hash TEXT NOT NULL,
  customer_phone_last4 TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  disposition TEXT,
  failure_detail TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS employee_power_calls_queue_idx
  ON employee_power_calls(queue_id, started_at DESC);

CREATE INDEX IF NOT EXISTS employee_power_calls_actor_idx
  ON employee_power_calls(actor_id, status, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_employee_power_call_active_actor
  ON employee_power_calls(actor_id)
  WHERE status IN ('dialing', 'connected');
