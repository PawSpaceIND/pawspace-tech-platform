import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite } from "./helpers/voice-harness.mjs";

// [audit P1] The nightly Diamond-CRM sweep — pipeline sync, lead-score refresh, probabilistic forecast,
// report-export generation + delivery, email + outbound-AI dispatch — had ZERO executable coverage
// (no test imported diamond-crm-scheduler). This drives the REAL orchestrator against a real in-memory
// D1 so a throw/crash regression in any of its nine stages is caught rather than shipping silently.
installWorkersHooks("__DIAMOND_SWEEP_SMOKE_DB__");
const { runDiamondCrmScheduledSweep } = await import("../lib/diamond-crm-scheduler.ts");
const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");

test("runDiamondCrmScheduledSweep executes every stage end-to-end without throwing", async () => {
  const db = makeD1(freshSqlite());
  // The sweep reads the upstream canonical schema (created by the customer/booking flow in production);
  // seed those base tables so the sweep's own stages can ensure and run their CRM tables on top.
  await ensureCustomerAccountTables(db);
  const result = await runDiamondCrmScheduledSweep(
    db,
    { PAWSPACE_PAYMENT_ENV: "sandbox" },
    { asOf: Date.UTC(2026, 4, 15, 2, 0), actorId: "auditor" },
  );
  for (const key of ["pipeline", "scoring", "outboundRouting", "outboundAi", "forecast", "schedules", "exports", "reportDelivery", "emailDelivery"]) {
    assert.ok(key in result, `sweep result must include the ${key} stage`);
  }
});
