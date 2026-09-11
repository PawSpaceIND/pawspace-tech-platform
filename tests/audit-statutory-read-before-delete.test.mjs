import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite } from "./helpers/voice-harness.mjs";

// [AUDIT-C3 extension] A statutory recompute must READ its sources (and resolve place-of-supply) BEFORE
// it DELETEs the period's rows, so a source-read/POS-resolution failure REFUSES rather than destroying
// the existing computation and silently recomputing to zero. The salary (s192) path was already fixed;
// these cover the provider-section TDS (194H/194J) reads and the TCS place-of-supply resolution.
installWorkersHooks("__STATUTORY_RBD_DB__");
const { computeMonthlyTds, ensureTdsTables } = await import("../lib/tds-governance.ts");
const { computeMonthlyTcs, ensureTcsTables } = await import("../lib/tcs-governance.ts");

const PERIOD = "2026-05";
const IN_PERIOD = Date.UTC(2026, 4, 15); // mid-May 2026, inside the period window

test("TDS: a provider-source read failure preserves the period's tds_deductions (read-before-delete)", async () => {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  await ensureTdsTables(db);
  // A pre-existing computation for the period that must NOT be destroyed by a failed recompute.
  sqlite.prepare("INSERT INTO tds_deductions (id,period,section,deductee_type,deductee_id,deductee_name,pan_status,base_amount,rate_pct,tds_amount,source_type,source_ref,computed_at) VALUES ('TDS-EXIST',?,'194H','provider','PRV-1','PRV-1','pending_verification',100000,2,2000,'payout','BKG-1',?)")
    .run(PERIOD, IN_PERIOD);
  // provider_payout_computations EXISTS (so it is not a legitimately-empty month) but its JOIN target
  // provider_commercial_terms does NOT — so the FY read throws, the drift case the guard is for.
  // employee_payroll_results is absent -> salary reads as legitimately empty (no throw there).
  sqlite.exec("CREATE TABLE provider_payout_computations (id TEXT, booking_id TEXT, provider_id TEXT, service_code TEXT, order_value REAL, provider_gst_deducted REAL, provider_net_payout REAL, computed_at INTEGER, term_id TEXT)");

  await assert.rejects(
    computeMonthlyTds(db, { period: PERIOD, actorId: "auditor" }),
    /refusing to recompute/,
    "a provider-source read failure must refuse, not recompute",
  );
  const remaining = sqlite.prepare("SELECT COUNT(*) c FROM tds_deductions WHERE period=?").get(PERIOD);
  assert.equal(Number(remaining.c), 1, "the existing tds_deductions row must be preserved, not deleted then zeroed");
});

test("TCS: an unresolvable place-of-supply preserves the period's tcs_collections (resolve-before-delete)", async () => {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  await ensureTcsTables(db);
  // A pre-existing TCS computation for the period.
  sqlite.prepare("INSERT INTO tcs_collections (id,period,supplier_id,service_code,booking_id,supply_type,order_value,net_taxable_value,cgst_tcs,sgst_tcs,igst_tcs,tcs_total,rate_pct,source_ref,computed_at) VALUES ('TCS-EXIST',?,'PRV-1','grooming','BKG-OLD','intra',1000,900,4.5,4.5,0,9,1,'BKG-OLD',?)")
    .run(PERIOD, IN_PERIOD);
  // A marketplace payout for a booking whose place-of-supply cannot be resolved (no canonical_bookings row).
  sqlite.exec("CREATE TABLE provider_commercial_terms (id TEXT PRIMARY KEY, engagement_model TEXT)");
  sqlite.prepare("INSERT INTO provider_commercial_terms (id,engagement_model) VALUES ('TERM-1','commission_standard')").run();
  sqlite.exec("CREATE TABLE provider_payout_computations (id TEXT, booking_id TEXT, provider_id TEXT, service_code TEXT, order_value REAL, provider_gst_deducted REAL, provider_net_payout REAL, computed_at INTEGER, term_id TEXT)");
  sqlite.prepare("INSERT INTO provider_payout_computations (id,booking_id,provider_id,service_code,order_value,provider_gst_deducted,provider_net_payout,computed_at,term_id) VALUES ('PPC-1','BKG-NOPOS','PRV-2','grooming',2000,200,1600,?,'TERM-1')")
    .run(IN_PERIOD);
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT, city_id TEXT)"); // exists, but BKG-NOPOS absent -> 404

  await assert.rejects(
    computeMonthlyTcs(db, { period: PERIOD, actorId: "auditor" }),
    "an unresolvable place-of-supply must refuse before any delete",
  );
  const remaining = sqlite.prepare("SELECT COUNT(*) c FROM tcs_collections WHERE period=?").get(PERIOD);
  assert.equal(Number(remaining.c), 1, "the existing tcs_collections row must be preserved, not deleted before the failure");
});
