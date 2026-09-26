/*
 * Staging sets up PawSpace's legal entity, TK PETCARE SOLUTIONS PRIVATE LIMITED (GSTIN 29AAICT7352F1Z0), under
 * the entity id SEEDFE-TKPET. The monthly TCS close only ever looked for an entity called "pawspace_india", so on
 * staging it always stopped with "configuration_required: active_operator_gstin" although the GSTIN was set up
 * and approved. The close now uses the one active GSTIN when "pawspace_india" is not registered, and still refuses
 * to choose between two.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__TCS_OPERATOR_DB__", "__TCS_OPERATOR_ENV__");
const tcs = await import("../lib/statutory-tcs.ts");

const PERIOD = "2025-04";
const IN_PERIOD = Date.parse("2025-04-15T11:00:00+05:30");
const TK_PETCARE = "29AAICT7352F1Z0";

async function closeWorld(registrations) {
  const { sqlite, db } = world("__TCS_OPERATOR_DB__", "__TCS_OPERATOR_ENV__");
  sqlite.exec(`
    CREATE TABLE tax_registrations (entity_id TEXT,registration_reference TEXT,status TEXT,effective_from TEXT,effective_to TEXT,approved_at INTEGER);
    CREATE TABLE provider_commercial_terms (id TEXT PRIMARY KEY,engagement_model TEXT NOT NULL);
    CREATE TABLE provider_payout_computations (booking_id TEXT,provider_id TEXT,service_code TEXT,term_id TEXT,order_value REAL,provider_gst_deducted REAL,computed_at INTEGER);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,status TEXT);
    CREATE TABLE boarding_refund_ledger (id TEXT PRIMARY KEY,booking_id TEXT,amount REAL,status TEXT);
  `);
  for (const [entity, gstin, status = "active", from = "2024-01-01"] of registrations)
    sqlite.prepare("INSERT INTO tax_registrations VALUES (?,?,?,?,NULL,1)").run(entity, gstin, status, from);
  sqlite.prepare("INSERT INTO provider_commercial_terms VALUES ('TERM-MKT','commission_standard')").run();
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BKG-1','CUST-1','blr','completed')").run();
  sqlite.prepare("INSERT INTO provider_payout_computations VALUES ('BKG-1','PRV-KA','grooming','TERM-MKT',10000,0,?)").run(IN_PERIOD);
  await tcs.ensureStatutoryTcsTables(db);
  await tcs.saveProviderTaxProfile(db, { providerId: "PRV-KA", gstin: "29AACCP9876B1Z2" }, "finance@pawspace.in");
  return { sqlite, db };
}
const operatorOf = sqlite => sqlite.prepare("SELECT DISTINCT operator_gstin FROM tcs_collections WHERE period=?").all(PERIOD).map(row => row.operator_gstin);

test("the TCS close runs for the GSTIN staging set up under its own entity id", async () => {
  const { sqlite, db } = await closeWorld([["SEEDFE-TKPET", TK_PETCARE]]);
  const result = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });
  assert.equal(result.totalTcs, 50, "0.5% of 10000");
  assert.deepEqual(operatorOf(sqlite), [TK_PETCARE]);
});

test("a registration that is revoked or not yet in force is not used as the operator", async () => {
  const { db } = await closeWorld([["SEEDFE-TKPET", TK_PETCARE, "revoked"], ["LATER", "29AABCP1234A1Z5", "active", "2026-01-01"]]);
  const outcome = await attempt(() => tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.body, /configuration_required:active_operator_gstin/);
});

test("two different active GSTINs are never chosen between; naming the entity settles it", async () => {
  const { sqlite, db } = await closeWorld([["SEEDFE-TKPET", TK_PETCARE], ["OTHER", "27AADCP5555C1Z9"]]);
  const outcome = await attempt(() => tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.body, /configuration_required:active_operator_gstin/);
  await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in", entityId: "SEEDFE-TKPET" });
  assert.deepEqual(operatorOf(sqlite), [TK_PETCARE]);
});

test("a registered pawspace_india entity is still preferred over any other", async () => {
  const { sqlite, db } = await closeWorld([["pawspace_india", TK_PETCARE], ["OTHER", "27AADCP5555C1Z9"]]);
  await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });
  assert.deepEqual(operatorOf(sqlite), [TK_PETCARE]);
});
