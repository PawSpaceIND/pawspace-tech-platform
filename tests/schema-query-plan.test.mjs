import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { d1 } from "./helpers/execution-harness.mjs";
import { ensureFinancialRuntimeTables } from "../lib/financial-runtime-schema.ts";
import { ensureLeadCallbackTables } from "../lib/lead-callback-governance.ts";

function assertLockedEnvironment() {
  assert.equal(process.env.PAWSPACE_PAYMENT_ENV, "sandbox");
  assert.equal(process.env.FORBID_PRODUCTION, "true");
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.APP_ENV, "staging");
}

function plan(sqlite, sql) {
  return sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => String(row.detail)).join("\n");
}

function assertIndexSearch(detail, index) {
  assert.match(detail, new RegExp(`SEARCH .* USING (?:COVERING )?INDEX ${index}`, "i"), `expected index search via ${index}, got:\n${detail}`);
  assert.doesNotMatch(detail, /\bSCAN\s+(?:main\.)?(?:payment_settlement_reconciliations|provider_capacity_profiles|lead_work_items)\b/i, `hot table regressed to full scan:\n${detail}`);
}

test("financial settlement lookup uses the governed settlement index", async () => {
  assertLockedEnvironment();
  const sqlite = new DatabaseSync(":memory:");
  await ensureFinancialRuntimeTables(d1(sqlite));
  const detail = plan(sqlite, "SELECT * FROM payment_settlement_reconciliations WHERE provider='razorpay' AND environment='sandbox' AND gateway_settlement_id='SET-1'");
  assertIndexSearch(detail, "payment_settlement_recon_settlement_idx");
});

test("provider matching uses city/live/status/effective lookup index", () => {
  assertLockedEnvironment();
  const source = readFileSync("lib/provider-capacity-governance.ts", "utf8");
  assert.match(source, /idx_provider_capacity_profiles_lookup ON provider_capacity_profiles\(city_id,live,status,effective_from,effective_to\)/);
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,live INTEGER NOT NULL,status TEXT NOT NULL,effective_from TEXT NOT NULL,effective_to TEXT);
    CREATE INDEX idx_provider_capacity_profiles_lookup ON provider_capacity_profiles(city_id,live,status,effective_from,effective_to);
  `);
  const detail = plan(sqlite, "SELECT * FROM provider_capacity_profiles WHERE city_id='blr' AND live=1 AND status='active' AND effective_from<='2026-09-07' AND (effective_to IS NULL OR effective_to>='2026-09-07')");
  assertIndexSearch(detail, "idx_provider_capacity_profiles_lookup");
});

test("CRM owner, recycle and SLA hot paths use secondary indexes", async () => {
  assertLockedEnvironment();
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE lead_work_items (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL,
    status TEXT NOT NULL, first_action_at INTEGER, manager_alert_at INTEGER NOT NULL,
    converted_booking_id TEXT, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0,
    opt_out INTEGER NOT NULL DEFAULT 0, next_action_at INTEGER, updated_at INTEGER NOT NULL
  )`);
  await ensureLeadCallbackTables(d1(sqlite));

  assertIndexSearch(plan(sqlite, "SELECT * FROM lead_work_items WHERE owner='rep@pawspace.in'"), "idx_lead_work_items_owner");
  assertIndexSearch(plan(sqlite, "SELECT * FROM lead_work_items WHERE status='cold' AND opt_out=0 AND converted_booking_id IS NULL AND recycle_at IS NOT NULL AND recycle_at<=123 AND recycle_cycle<3"), "idx_lead_work_items_recycle_due");
  assertIndexSearch(plan(sqlite, "SELECT * FROM lead_work_items WHERE status='active' AND first_action_at IS NULL AND manager_alert_at<=123"), "idx_lead_work_items_sla_due");
});
