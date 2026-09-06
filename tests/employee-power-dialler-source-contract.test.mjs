import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("employee power dialler has canonical Drizzle persistence matching runtime bootstrap", () => {
  const migration = read("drizzle/0026_employee_power_dialler.sql");
  const runtime = read("lib/employee-power-dialler.ts");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS employee_power_calls/);
  for (const column of [
    "idempotency_key",
    "queue_id",
    "actor_id",
    "employee_id",
    "customer_id",
    "provider_call_id",
    "provider_status",
    "duration_seconds",
    "recording_url",
    "employee_phone_hash",
    "customer_phone_hash",
    "started_at",
    "ended_at",
    "disposition",
    "failure_detail",
    "updated_at",
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
    assert.match(runtime, new RegExp(`\\b${column}\\b`));
  }

  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS ux_employee_power_call_active_actor/);
  assert.match(migration, /WHERE status IN \('dialing', 'connected'\)/);
  assert.match(runtime, /ux_employee_power_call_active_actor/);
});

test("employee power dialler keeps Exotel callback authentication and secret-safe phone persistence", () => {
  const runtime = read("lib/employee-power-dialler.ts");
  const callback = read("app/api/dialler/callback/route.ts");

  assert.match(runtime, /callback authentication failed/i);
  assert.match(runtime, /employee_phone_hash/);
  assert.match(runtime, /customer_phone_hash/);
  assert.match(runtime, /employee_phone_last4/);
  assert.match(runtime, /customer_phone_last4/);
  assert.doesNotMatch(runtime, /employee_phone\s+TEXT/i);
  assert.doesNotMatch(runtime, /customer_phone\s+TEXT/i);
  assert.match(callback, /applyEmployeePowerDiallerCallback/);
  assert.match(callback, /status:\s*authFailure\s*\?\s*401\s*:\s*400/);
});

test("employee power dialler remains a three-second governed auto-advance flow", () => {
  const runtime = read("lib/employee-power-dialler.ts");
  const policy = read("lib/power-dialler-policy.ts");

  assert.match(policy, /POWER_DIALLER_AUTO_ADVANCE_MS\s*=\s*3000/);
  assert.match(runtime, /POWER_DIALLER_AUTO_ADVANCE_MS/);
  assert.match(runtime, /quiet/i);
  assert.match(runtime, /opt.?out/i);
});
