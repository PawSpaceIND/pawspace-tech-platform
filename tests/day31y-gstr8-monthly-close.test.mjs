/*
 * Day-31: the monthly s.52 TCS close - computeMonthlyTcsStatutory() and prepareGstr8Statutory().
 *
 * This is the pair that turns a month of marketplace payouts into the figure PawSpace files with
 * the government as GSTR-8. Wave 1b tested the RATE this module resolves; nothing tested the
 * MONTHLY CLOSE itself. The distinction matters, because almost every way to get GSTR-8 wrong is
 * an aggregation mistake rather than a rate mistake:
 *
 *   - a refund that does not reduce the supply value, so TCS is collected on money returned;
 *   - a re-run that appends instead of replacing, so the period doubles;
 *   - a booking from a neighbouring month drawn in by a UTC window rather than an IST one;
 *   - a summary total that does not equal the sum of the supplier lines it claims to summarise;
 *   - an own-supply booking treated as a marketplace supply, making PawSpace collect TCS from
 *     itself.
 *
 * Each of those files a wrong number quietly, and nobody finds out until a notice arrives. So the
 * assertions below check arithmetic against hand-computed figures, not against whatever the code
 * happens to produce.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31Y_TCS_DB__", "__D31Y_TCS_ENV__");

const tcs = await import("../lib/statutory-tcs.ts");

const PERIOD = "2025-04";
/** The exact epoch millisecond of an India wall-clock time. */
const istInstant = (iso) => Date.parse(`${iso}+05:30`);
/** Comfortably inside April 2025 IST, and after the 2024-07-10 rate change, so the rate is 0.5%. */
const IN_PERIOD = istInstant("2025-04-15T11:00:00");
const RATE = { total: 0.005, half: 0.0025 };

const OPERATOR_GSTIN = "29AABCP1234A1Z5";   // Karnataka (29), PawSpace itself
const KA_PROVIDER_GSTIN = "29AACCP9876B1Z2"; // Karnataka provider -> intra-state -> CGST+SGST
const MH_PROVIDER_GSTIN = "27AADCP5555C1Z9"; // Maharashtra provider -> inter-state -> IGST

function schema(sqlite) {
  sqlite.exec(`
    CREATE TABLE tax_registrations (entity_id TEXT,registration_reference TEXT,status TEXT,effective_from TEXT,effective_to TEXT,approved_at INTEGER);
    CREATE TABLE provider_commercial_terms (id TEXT PRIMARY KEY,engagement_model TEXT NOT NULL);
    CREATE TABLE provider_payout_computations (booking_id TEXT,provider_id TEXT,service_code TEXT,term_id TEXT,order_value REAL,provider_gst_deducted REAL,computed_at INTEGER);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,status TEXT);
    CREATE TABLE boarding_refund_ledger (id TEXT PRIMARY KEY,booking_id TEXT,amount REAL,status TEXT);
  `);
  sqlite.prepare("INSERT INTO tax_registrations (entity_id,registration_reference,status,effective_from,effective_to,approved_at) VALUES ('pawspace_india',?,'active',NULL,NULL,1)").run(OPERATOR_GSTIN);
  sqlite.prepare("INSERT INTO provider_commercial_terms (id,engagement_model) VALUES ('TERM-MKT','commission_standard')").run();
  sqlite.prepare("INSERT INTO provider_commercial_terms (id,engagement_model) VALUES ('TERM-OWN','managed_own_supply')").run();
}

/** A booking in Bengaluru (POS 29) with a marketplace payout computation attached. */
function seedSupply(sqlite, { bookingId, providerId, orderValue, providerGst = 0, at = IN_PERIOD, term = "TERM-MKT", city = "blr", status = "completed" }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,status) VALUES (?,?,?,?)").run(bookingId, `CUST-${bookingId}`, city, status);
  sqlite.prepare("INSERT INTO provider_payout_computations (booking_id,provider_id,service_code,term_id,order_value,provider_gst_deducted,computed_at) VALUES (?,?,?,?,?,?,?)")
    .run(bookingId, providerId, "boarding", term, orderValue, providerGst, at);
}

async function closeWorld(taxProfiles = [{ providerId: "PRV-KA", gstin: KA_PROVIDER_GSTIN }]) {
  const { sqlite, db } = world("__D31Y_TCS_DB__", "__D31Y_TCS_ENV__");
  schema(sqlite);
  await tcs.ensureStatutoryTcsTables(db);
  for (const profile of taxProfiles) await tcs.saveProviderTaxProfile(db, profile, "finance@pawspace.in");
  return { sqlite, db };
}

const collected = (sqlite, period = PERIOD) =>
  sqlite.prepare("SELECT booking_id,supplier_id,supply_type,gross_supply_value,returned_supply_value,net_taxable_value,cgst_tcs,sgst_tcs,igst_tcs,tcs_total,rate_version FROM tcs_collections WHERE period=? ORDER BY booking_id").all(period);

test("an intra-state marketplace supply collects CGST+SGST at half the rate each, and nothing as IGST", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-1", providerId: "PRV-KA", orderValue: 10000, providerGst: 1000 });

  const result = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  // Base is order value less the provider's own GST: 10000 - 1000 = 9000. At 0.5%: 45.
  assert.equal(result.totalNetValue, 9000, "the s.52 base excludes the provider's own GST");
  assert.equal(result.totalTcs, 45, "0.5% of 9000");
  assert.equal(result.cgstTcs, 22.5, "an intra-state supply splits evenly across CGST and SGST");
  assert.equal(result.sgstTcs, 22.5);
  assert.equal(result.igstTcs, 0, "an intra-state supply must never carry IGST");
  assert.equal(result.supplierCount, 1);

  const [row] = collected(sqlite);
  assert.equal(row.supply_type, "intra", "supplier state 29 == place of supply 29");
  assert.equal(row.rate_version, "s52-0.5pct-from-2024-07-10", "the rate in force must be recorded, not just applied");
});

test("an inter-state marketplace supply collects IGST only", async () => {
  const { sqlite, db } = await closeWorld([{ providerId: "PRV-MH", gstin: MH_PROVIDER_GSTIN }]);
  seedSupply(sqlite, { bookingId: "BKG-2", providerId: "PRV-MH", orderValue: 20000, providerGst: 0 });

  const result = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  assert.equal(result.igstTcs, 100, "0.5% of 20000, entirely as IGST");
  assert.equal(result.cgstTcs, 0, "a supplier in Maharashtra supplying into Karnataka is inter-state");
  assert.equal(result.sgstTcs, 0);
  assert.equal(collected(sqlite)[0].supply_type, "inter");
});

test("a refund reduces the supply value TCS is collected on, proportionally to the taxable base", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-3", providerId: "PRV-KA", orderValue: 10000, providerGst: 1000 });
  sqlite.prepare("INSERT INTO boarding_refund_ledger (id,booking_id,amount,status) VALUES ('RF-1','BKG-3',2000,'processed')").run();

  const result = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  // 2000 of 10000 gross came back; the same fraction of the 9000 taxable base is 1800.
  assert.equal(result.returnedSupplyValue, 2000, "the gross value returned is reported as returned, not netted away silently");
  assert.equal(result.totalNetValue, 7200, "9000 base less the 1800 proportional share of the refund");
  assert.equal(result.totalTcs, 36, "0.5% of 7200 - TCS is not owed on money given back");
});

test("a rejected refund does not reduce the supply value", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-4", providerId: "PRV-KA", orderValue: 10000, providerGst: 1000 });
  sqlite.prepare("INSERT INTO boarding_refund_ledger (id,booking_id,amount,status) VALUES ('RF-2','BKG-4',2000,'rejected')").run();

  const result = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  assert.equal(result.returnedSupplyValue, 0, "a refund that was refused is not money returned");
  assert.equal(result.totalTcs, 45, "the full 0.5% of 9000 remains owed");
});

test("a cancelled booking with no refund row still counts as fully returned", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-5", providerId: "PRV-KA", orderValue: 10000, providerGst: 1000, status: "cancelled" });

  const result = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  assert.equal(result.returnedSupplyValue, 10000, "a cancelled supply is not a supply");
  assert.equal(result.totalTcs, 0, "no TCS on a supply that did not happen");
});

test("an own-supply engagement model is not a marketplace supply and carries no s.52 TCS", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-6", providerId: "PRV-KA", orderValue: 50000, term: "TERM-OWN" });

  const result = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  assert.equal(result.supplierCount, 0, "s.52 applies to supplies made THROUGH the operator, not BY it");
  assert.equal(result.totalTcs, 0);
  assert.equal(collected(sqlite).length, 0);
});

test("recomputing a period replaces it rather than adding to it", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-7", providerId: "PRV-KA", orderValue: 10000, providerGst: 1000 });

  const first = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });
  const second = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  assert.equal(second.totalTcs, first.totalTcs, "a re-run of an unchanged month must report the same liability");
  assert.equal(collected(sqlite).length, 1, "the month must hold one row per supply, not one per run");
});

test("the month window is an India month, so a supply just outside it is not drawn in", async () => {
  const { sqlite, db } = await closeWorld();
  // 2025-04-01 00:00 IST is 2025-03-31 18:30 UTC. A UTC-based window would place this in March.
  seedSupply(sqlite, { bookingId: "BKG-IN", providerId: "PRV-KA", orderValue: 10000, at: istInstant("2025-04-01T00:00:00") });
  // The last millisecond of March, India time: belongs to the previous return.
  seedSupply(sqlite, { bookingId: "BKG-OUT", providerId: "PRV-KA", orderValue: 90000, at: istInstant("2025-03-31T23:59:59.999") });

  const result = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  assert.deepEqual(collected(sqlite).map(r => r.booking_id), ["BKG-IN"], "the April return holds April's supplies only");
  assert.equal(result.totalTcs, 50, "0.5% of the single in-period 10000 supply");
});

test("a provider with no GSTIN on file stops the close instead of filing them at zero", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-8", providerId: "PRV-UNKNOWN", orderValue: 10000 });

  const outcome = await attempt(() => tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" }));

  assert.equal(outcome.ok, false, "an unidentifiable supplier must not be filed");
  assert.match(outcome.body, /configuration_required:provider_gstin:PRV-UNKNOWN/, "and the refusal must name what is missing");
});

test("GSTR-8 reports every supplier, and its totals equal the sum of the lines it summarises", async () => {
  const { sqlite, db } = await closeWorld([
    { providerId: "PRV-KA", gstin: KA_PROVIDER_GSTIN },
    { providerId: "PRV-MH", gstin: MH_PROVIDER_GSTIN },
  ]);
  seedSupply(sqlite, { bookingId: "BKG-A", providerId: "PRV-KA", orderValue: 10000, providerGst: 1000 });
  seedSupply(sqlite, { bookingId: "BKG-B", providerId: "PRV-KA", orderValue: 6000 });
  seedSupply(sqlite, { bookingId: "BKG-C", providerId: "PRV-MH", orderValue: 20000 });

  await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });
  const gstr8 = await tcs.prepareGstr8Statutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  assert.equal(gstr8.returnType, "GSTR-8");
  assert.equal(gstr8.supplierCount, 2, "one line per registered supplier, not one per booking");

  const ka = gstr8.suppliers.find(s => s.supplierGstin === KA_PROVIDER_GSTIN);
  assert.equal(ka.netTaxableValue, 15000, "9000 from BKG-A plus 6000 from BKG-B");
  assert.equal(ka.tcsTotal, 75, "0.5% of 15000");
  assert.equal(ka.cgstTcs + ka.sgstTcs, 75, "a Karnataka supplier's TCS is entirely CGST+SGST");
  assert.equal(ka.igstTcs, 0);
  assert.deepEqual(ka.placesOfSupply, ["29"], "both supplies were made in Karnataka");

  // The reconciliation a filing actually turns on: the header must equal the detail.
  const lineSum = gstr8.suppliers.reduce((total, s) => total + s.tcsTotal, 0);
  assert.equal(gstr8.totalTcs, Math.round(lineSum * 100) / 100, "the summary must equal the lines beneath it");
  assert.equal(gstr8.totalTcs, 175, "75 from Karnataka plus 100 from Maharashtra");
  assert.equal(gstr8.totalNetValue, 35000);
  assert.equal(gstr8.liveFilingEnabled, false, "the module must keep saying it cannot file for real");
});

test("GSTR-8 for a period with nothing in it reports zero rather than the previous month", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-9", providerId: "PRV-KA", orderValue: 10000 });
  await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  const may = await tcs.prepareGstr8Statutory(db, { period: "2025-05", actorId: "finance@pawspace.in" });

  assert.equal(may.supplierCount, 0, "an empty month is empty");
  assert.equal(may.totalTcs, 0);
  assert.deepEqual(may.suppliers, []);
});

test("a malformed period is refused before anything is written", async () => {
  const { db } = await closeWorld();
  for (const period of ["2025-13", "not-a-period", "2025"]) {
    const outcome = await attempt(() => tcs.computeMonthlyTcsStatutory(db, { period, actorId: "finance@pawspace.in" }));
    assert.equal(outcome.ok, false, `${period} must not be accepted as a return period`);
    assert.match(outcome.body, /TCS period must be YYYY-MM/);
  }
});

test("the rate is resolved per supply, so a month straddling the rate change files both rates", async () => {
  const { sqlite, db } = await closeWorld();
  // July 2025 is entirely after the change, so build the straddle in July 2024 instead.
  seedSupply(sqlite, { bookingId: "BKG-OLD", providerId: "PRV-KA", orderValue: 10000, at: istInstant("2024-07-09T23:59:59.999") });
  seedSupply(sqlite, { bookingId: "BKG-NEW", providerId: "PRV-KA", orderValue: 10000, at: istInstant("2024-07-10T00:00:00.000") });

  const result = await tcs.computeMonthlyTcsStatutory(db, { period: "2024-07", actorId: "finance@pawspace.in" });

  const rows = collected(sqlite, "2024-07");
  assert.equal(rows.find(r => r.booking_id === "BKG-OLD").tcs_total, 100, "1% through 9 July");
  assert.equal(rows.find(r => r.booking_id === "BKG-NEW").tcs_total, 50, "0.5% from 10 July");
  assert.equal(result.totalTcs, 150, "the month owes the sum of two different rates, not one rate applied twice");
  assert.notEqual(
    rows.find(r => r.booking_id === "BKG-OLD").rate_version,
    rows.find(r => r.booking_id === "BKG-NEW").rate_version,
    "each row must carry the rate lineage it was actually computed under",
  );
});

test("a payout computation with no timestamp belongs to no return period at all", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-DATED", providerId: "PRV-KA", orderValue: 10000 });
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,status) VALUES ('BKG-NULL','CUST-N','blr','completed')").run();
  sqlite.prepare("INSERT INTO provider_payout_computations (booking_id,provider_id,service_code,term_id,order_value,provider_gst_deducted,computed_at) VALUES ('BKG-NULL','PRV-KA','boarding','TERM-MKT',10000,0,NULL)").run();

  const result = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  // The period window compares against computed_at, and NULL satisfies no comparison, so an undated
  // supply is dropped rather than mis-rated. That is the safe half: provider_payout_computations
  // declares computed_at NOT NULL, so it cannot arise from the canonical writer. The unsafe half
  // would be rating it anyway - 0 reads as 1970, which resolves to the pre-2024 1% rate, double
  // what is owed - and lib/tcs-rate.ts refuses that outright. Pinned so neither half drifts.
  assert.deepEqual(collected(sqlite).map(r => r.booking_id), ["BKG-DATED"], "an undated supply is not silently rated");
  assert.equal(result.totalTcs, 50, "only the dated supply is filed");
});

test("a supply into another state is inter-state even from a Karnataka supplier", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-MUM", providerId: "PRV-KA", orderValue: 10000, city: "mumbai" });

  const result = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  assert.equal(collected(sqlite)[0].supply_type, "inter", "supplier 29, place of supply 27");
  assert.equal(result.igstTcs, 50);
  assert.equal(result.cgstTcs + result.sgstTcs, 0);
});

test("a booking whose place of supply cannot be determined stops the close", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-NOWHERE", providerId: "PRV-KA", orderValue: 10000, city: "atlantis" });

  const outcome = await attempt(() => tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" }));

  assert.equal(outcome.ok, false, "TCS cannot be apportioned between CGST/SGST and IGST without a place of supply");
  assert.match(outcome.body, /configuration_required:place_of_supply:BKG-NOWHERE/);
});

test("a failed recompute leaves the previously filed period intact", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-GOOD", providerId: "PRV-KA", orderValue: 10000, providerGst: 1000 });
  const filed = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });
  assert.equal(filed.totalTcs, 45);

  // A new supply arrives from a provider nobody has recorded a GSTIN for.
  seedSupply(sqlite, { bookingId: "BKG-BAD", providerId: "PRV-NOBODY", orderValue: 999999 });
  const outcome = await attempt(() => tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" }));
  assert.equal(outcome.ok, false);

  const rows = collected(sqlite);
  assert.deepEqual(rows.map(r => r.booking_id), ["BKG-GOOD"], "a refused recompute must not wipe the month it refused to replace");
  assert.equal(rows[0].tcs_total, 45);
});

test("a refund larger than the order value cannot push the taxable value below zero", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-OVER", providerId: "PRV-KA", orderValue: 5000, providerGst: 500 });
  sqlite.prepare("INSERT INTO boarding_refund_ledger (id,booking_id,amount,status) VALUES ('RF-3','BKG-OVER',9000,'processed')").run();

  const result = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  assert.equal(result.returnedSupplyValue, 5000, "no more can come back than went out");
  assert.equal(result.totalNetValue, 0);
  assert.equal(result.totalTcs, 0, "an over-refund is not a negative tax credit");
});

test("what the close reports and what GSTR-8 reads back are the same figure", async () => {
  const { sqlite, db } = await closeWorld([
    { providerId: "PRV-KA", gstin: KA_PROVIDER_GSTIN },
    { providerId: "PRV-MH", gstin: MH_PROVIDER_GSTIN },
  ]);
  seedSupply(sqlite, { bookingId: "BKG-R1", providerId: "PRV-KA", orderValue: 12345.67, providerGst: 1234.56 });
  seedSupply(sqlite, { bookingId: "BKG-R2", providerId: "PRV-MH", orderValue: 7777.77, city: "mumbai" });
  sqlite.prepare("INSERT INTO boarding_refund_ledger (id,booking_id,amount,status) VALUES ('RF-4','BKG-R1',345.67,'processed')").run();

  const close = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });
  const gstr8 = await tcs.prepareGstr8Statutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  // The computation returns totals from memory; the return reads them back out of the database.
  // If these ever diverge, the number filed is not the number reviewed.
  assert.equal(gstr8.totalTcs, close.totalTcs, "the filed total must equal the computed total");
  assert.equal(gstr8.totalNetValue, close.totalNetValue);
  assert.equal(gstr8.grossSupplyValue, close.grossSupplyValue);
  assert.equal(gstr8.returnedSupplyValue, close.returnedSupplyValue);
  assert.equal(gstr8.supplierCount, close.supplierCount);
});

test("one supplier billing into two states reports both places of supply", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-P1", providerId: "PRV-KA", orderValue: 10000, city: "blr" });
  seedSupply(sqlite, { bookingId: "BKG-P2", providerId: "PRV-KA", orderValue: 10000, city: "hyderabad" });

  await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });
  const gstr8 = await tcs.prepareGstr8Statutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  assert.equal(gstr8.supplierCount, 1, "one GSTIN is one supplier line");
  assert.deepEqual([...gstr8.suppliers[0].placesOfSupply].sort(), ["29", "36"], "GSTR-8 is reported place of supply by place of supply");
  assert.equal(gstr8.suppliers[0].cgstTcs + gstr8.suppliers[0].sgstTcs, 50, "the Karnataka half is intra-state");
  assert.equal(gstr8.suppliers[0].igstTcs, 50, "the Telangana half is inter-state");
});

test("the close refuses to run without an active operator registration", async () => {
  const { sqlite, db } = await closeWorld();
  sqlite.prepare("UPDATE tax_registrations SET status='revoked'").run();
  seedSupply(sqlite, { bookingId: "BKG-NOREG", providerId: "PRV-KA", orderValue: 10000 });

  const outcome = await attempt(() => tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" }));

  assert.equal(outcome.ok, false, "an operator with no live GST registration cannot collect TCS");
  assert.match(outcome.body, /configuration_required:active_operator_gstin/);
});

test("a provider GSTIN that is not a GSTIN is refused when it is recorded, not when it is filed", async () => {
  const { db } = await closeWorld();
  const outcome = await attempt(() => tcs.saveProviderTaxProfile(db, { providerId: "PRV-BAD", gstin: "NOT-A-GSTIN" }, "finance@pawspace.in"));
  assert.equal(outcome.ok, false, "a malformed GSTIN must fail at the desk, not at the return");
  assert.match(outcome.body, /invalid_provider_gstin/);
});

test("the TCS deposit must equal the liability the statutory close computed, to the paisa", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-D1", providerId: "PRV-KA", orderValue: 10000, providerGst: 1000 });
  const close = await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });
  assert.equal(close.totalTcs, 45);

  const short = await attempt(() => tcs.recordTcsDeposit(db, { period: PERIOD, challanReference: "CHLN-1", amount: 40, actorId: "finance@pawspace.in" }));
  assert.equal(short.ok, false, "a challan for less than the liability leaves a shortfall nobody is tracking");
  assert.match(short.body, /45/, "and the refusal must state what was actually owed");

  const paid = await tcs.recordTcsDeposit(db, { period: PERIOD, challanReference: "CHLN-1", amount: 45, actorId: "finance@pawspace.in" });
  assert.equal(paid.amount, 45);
  assert.equal(paid.duplicatePrevented, false);
  assert.equal(paid.dueDate, close.depositDueDate, "the deposit and the close must agree on when it was due");
  assert.equal(paid.dueDate, "2025-05-10", "s.52 TCS for April is due by 10 May");

  const again = await tcs.recordTcsDeposit(db, { period: PERIOD, challanReference: "CHLN-2", amount: 45, actorId: "finance@pawspace.in" });
  assert.equal(again.duplicatePrevented, true, "a month must not be deposited twice");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM tcs_deposits WHERE period=?").get(PERIOD).n, 1);
});

test("the finance dashboard shows the collections the statutory close wrote", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-DASH", providerId: "PRV-KA", orderValue: 10000, providerGst: 1000 });
  await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  const dashboard = await tcs.tcsDashboard(db, PERIOD);

  assert.equal(dashboard.collections.length, 1, "what was computed must be visible to the people who sign the return");
  assert.equal(Number(dashboard.collections[0].tcs_total), 45);
  assert.equal(dashboard.productionReady, false, "the module must keep saying it is not production-ready");
});

test("preparing GSTR-8 leaves a record of what was prepared, by whom", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-REC", providerId: "PRV-KA", orderValue: 10000, providerGst: 1000 });
  await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  const gstr8 = await tcs.prepareGstr8Statutory(db, { period: PERIOD, actorId: "ca@pawspace.in" });

  // A statutory return is signed by a person. Six months later, when a notice asks what was filed
  // for April, the answer has to come from a record - not from re-running a computation over
  // source data that has moved on since.
  const statement = sqlite.prepare("SELECT total_net_value,total_tcs,cgst_tcs,sgst_tcs,igst_tcs,supplier_count,status,prepared_by,summary_json FROM tcs_statements WHERE period=?").get(PERIOD);
  assert.ok(statement, "a prepared return must be recorded, not just returned to the caller");
  assert.equal(Number(statement.total_tcs), gstr8.totalTcs, "the record must hold the figure that was prepared");
  assert.equal(Number(statement.supplier_count), gstr8.supplierCount);
  assert.equal(statement.status, "prepared");
  // Column order in a 12-value INSERT is easy to get wrong and impossible to see afterwards, so
  // pin the split, not just the total.
  assert.equal(Number(statement.cgst_tcs), 22.5, "an intra-state month records its CGST half");
  assert.equal(Number(statement.sgst_tcs), 22.5);
  assert.equal(Number(statement.igst_tcs), 0);
  assert.equal(Number(statement.total_net_value), 9000);
  assert.equal(statement.prepared_by, "ca@pawspace.in", "and who prepared it");
  assert.equal(JSON.parse(statement.summary_json).totalTcs, gstr8.totalTcs, "with the full supplier detail behind the total");

  // The dashboard finance signs off from must see it.
  const dashboard = await tcs.tcsDashboard(db, PERIOD);
  assert.ok(dashboard.statement, "the dashboard must not report a prepared return as missing");
  assert.equal(Number(dashboard.statement.total_tcs), gstr8.totalTcs);
});

test("re-preparing a period updates the record instead of failing on it", async () => {
  const { sqlite, db } = await closeWorld();
  seedSupply(sqlite, { bookingId: "BKG-RP", providerId: "PRV-KA", orderValue: 10000, providerGst: 1000 });
  await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });
  await tcs.prepareGstr8Statutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });

  // A late refund lands, the month is recomputed, and the return is prepared again.
  sqlite.prepare("INSERT INTO boarding_refund_ledger (id,booking_id,amount,status) VALUES ('RF-LATE','BKG-RP',10000,'processed')").run();
  await tcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: "finance@pawspace.in" });
  const revised = await tcs.prepareGstr8Statutory(db, { period: PERIOD, actorId: "ca@pawspace.in" });

  assert.equal(revised.totalTcs, 0, "the whole supply came back, so nothing is owed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM tcs_statements WHERE period=?").get(PERIOD).n, 1, "one record per period");
  const statement = sqlite.prepare("SELECT total_tcs,prepared_by FROM tcs_statements WHERE period=?").get(PERIOD);
  assert.equal(Number(statement.total_tcs), 0, "the record must hold the revised figure, not the superseded one");
  assert.equal(statement.prepared_by, "ca@pawspace.in");
});
