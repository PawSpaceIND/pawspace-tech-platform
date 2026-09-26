/*
 * Review regressions for the GST engine (work package A, owner decisions of 26 Sept 2026), run through the REAL
 * completion, payout-preview, taxi and GSTR-8 code on the in-memory harness in production mode.
 *
 *   1. A booking completed BEFORE the owner's model (a legacy carve row with no finalized_at, and its completion
 *      journal already posted) keeps its month and its posted figures when completion is re-run - the training
 *      read model re-runs it on every read. Without this the first re-read after the change recomputed it under
 *      the new model and moved it into the re-read's month (the verifier's "July GSTR-8 drops to 0" case, G25).
 *   2. Funeral / memorial is an exempt supply: no s.52 TCS is withheld from, or filed for, a GST-registered vendor,
 *      whichever engagement model the term names.
 *   3. Finance's payout preview of a completed booking shows the TCS completion actually withheld (the payable the
 *      ledger holds), not a fresh decision from today's tax profile.
 *   4. Re-running a Pet Taxi completion replays what was posted: the owner's settlement row stays equal to the
 *      posted Provider Payable, so a later GSTIN or GST-setting change neither blocks nor changes the payout.
 *   5. Finance's compute_payout on a completed Pet Taxi booking returns the fleet record, complete, for the owner.
 *   6. Two requests adding the new payout columns at the same time do not fail with "duplicate column name".
 *   7. The GST setting screen shows Finance why a publish was refused (not "Unable to update Grooming finance ledger")
 *      and offers every launched city, so the assisted-booking message "publish a GST setting for this city" can be acted on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__GST_REVIEW_DB__", "__GST_REVIEW_ENV__");
const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const statutoryTcs = await import("../lib/statutory-tcs.ts");
const payoutStatutory = await import("../lib/provider-payout-statutory.ts");
const taxiFinance = await import("../lib/taxi-completion-finance.ts");
const taxiFleet = await import("../lib/taxi-fleet-governance.ts");
const accounts = await import("../lib/finance-accounts.ts");
const gstSetting = await import("../lib/gst-setting.ts");

const PROD_ENV = { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" };
const OPERATOR_GSTIN = "29AABCP1234A1Z5", PROVIDER_GSTIN = "29AACCP9876B1Z2";
const MAKER = "maker@pawspace.in", CHECKER = "checker@pawspace.in", FINANCE = "finance@pawspace.in";
const COMPLETED = Date.parse("2026-09-15T12:00:00+05:30");

function reviewWorld() {
  const { sqlite, db } = world("__GST_REVIEW_DB__", "__GST_REVIEW_ENV__", PROD_ENV);
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,currency TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tax_registrations (id TEXT,entity_id TEXT,registration_reference TEXT,status TEXT,effective_from TEXT,effective_to TEXT,approved_at INTEGER);
    CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,provider_model TEXT NOT NULL);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  sqlite.prepare("INSERT INTO tax_registrations VALUES ('REG-1','pawspace_india',?,'active','2020-01-01',NULL,1)").run(OPERATOR_GSTIN);
  return { sqlite, db };
}
function booking(sqlite, id, { service, provider, amount = 1000, date = "2026-09-15" }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,provider_id,scheduled_start,scheduled_end,status,total_amount,currency,created_at,updated_at) VALUES (?,?,'blr','blr-east',?,'pkg','Package',?,?,?,'completed',?,'INR',1,1)")
    .run(id, `CUS-${id}`, service, provider, `${date}T05:00:00.000Z`, `${date}T06:00:00.000Z`, amount);
}
async function activeTerm(db, { service, model, share, gstMode }) {
  const draft = await terms.saveCommercialTerm(db, { serviceCode: service, engagementModel: model, providerSharePct: share, gstMode, effectiveFrom: "2026-01-01", reason: `${service} review terms`, actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: `APR-${service}-${share}`, actorId: CHECKER });
}
const payoutRow = (sqlite, id) => sqlite.prepare("SELECT * FROM provider_payout_computations WHERE booking_id=?").get(id);
const payable = (sqlite, id) => Math.round(Number(sqlite.prepare("SELECT COALESCE(SUM(credit-debit),0) amount FROM finance_journal_entries WHERE source_type='service_completion' AND source_id=? AND account_code='2110-Provider Payable'").get(id).amount) * 100) / 100;

test("a booking completed before the owner's model keeps its month and its posted figures when completion is re-run", async () => {
  const { sqlite, db } = reviewWorld();
  await activeTerm(db, { service: "dog_training", model: "commission_standard", share: 0.70, gstMode: "provider_gst_on_behalf" });
  await statutoryTcs.saveProviderTaxProfile(db, { providerId: "PRV-TRAINER", gstin: PROVIDER_GSTIN }, FINANCE);
  booking(sqlite, "BK-LEGACY", { service: "dog_training", provider: "PRV-TRAINER", date: "2026-07-10" });
  const july = Date.parse("2026-07-10T12:00:00+05:30");
  // What completion wrote in July under the retired carve model: the payout row (never finalised - the column did
  // not exist) and the completion journal it posted (593.22 - 4.24 TCS payable, 198.30 GST, 208.48 revenue).
  await terms.ensureCommercialTermsTables(db);
  const termId = sqlite.prepare("SELECT id FROM provider_commercial_terms WHERE service_code='dog_training' AND status='active'").get().id;
  const legacy = { bookingId: "BK-LEGACY", serviceCode: "dog_training", providerId: "PRV-TRAINER", engagementModel: "commission_standard", orderValue: 1000, providerSharePct: 0.7, platformFeePct: 0.3, platformFee: 254.24, platformGstRate: 0.18, platformGst: 45.76, providerGrossShare: 593.22, providerGstMode: "provider_gst_on_behalf", providerGstDeducted: 152.54, providerNetPayout: 593.22, pawspaceGstOnOrder: 0, directInvoice: false, cashAllowed: false, termId, termSource: "service_default", gstExempt: false, standardReferencePrice: 0, payoutBasis: "net_pool" };
  sqlite.prepare("INSERT INTO provider_payout_computations (booking_id,provider_id,service_code,order_value,provider_net_payout,platform_fee,platform_gst,provider_gst_deducted,pawspace_gst_on_order,breakdown_json,term_id,computed_by,computed_at) VALUES ('BK-LEGACY','PRV-TRAINER','dog_training',1000,593.22,254.24,45.76,152.54,0,?,?,'training_finance_read_model',?)").run(JSON.stringify(legacy), termId, july);
  await accounts.postJournal(db, { groupKey: "SERVICE-COMPLETION-BK-LEGACY", entryDate: "2026-07-10", periodCode: "2026-07", sourceType: "service_completion", sourceId: "BK-LEGACY", narration: "Legacy completion", metadata: { bookingId: "BK-LEGACY", serviceCode: "dog_training", transactionAt: july }, lines: [{ accountCode: "2230-Customer Collections", debit: 1000 }, { accountCode: "2110-Provider Payable", credit: 588.98 }, { accountCode: "2140-TCS Payable", credit: 4.24 }, { accountCode: "2130-GST Payable", credit: 198.3 }, { accountCode: "4000-Service Revenue", credit: 208.48 }] });

  // September: the training read model re-runs completion finance with completedAt = now.
  const again = await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-LEGACY", actorId: "training_finance_read_model", completedAt: COMPLETED });
  assert.deepEqual([again.providerPayoutAccrued, again.tcsWithheld, again.gstLiability, again.platformRevenueNetOfGst], [588.98, 4.24, 198.3, 208.48], "the re-run replays what the July journal posted");
  const row = payoutRow(sqlite, "BK-LEGACY");
  assert.equal(row.computed_at, july, "the booking stays in July: its TCS, TDS and settlement period never moves");
  assert.deepEqual([row.provider_net_payout, row.platform_gst, row.provider_gst_deducted], [593.22, 45.76, 152.54], "the tax record the journal was posted from is not rewritten");
  assert.ok(Number(row.finalized_at) > 0, "and it is now locked like every new completion");
  assert.equal(payable(sqlite, "BK-LEGACY"), 588.98);
  await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-LEGACY", actorId: "training_finance_read_model", completedAt: Date.parse("2026-10-02T12:00:00+05:30") });
  assert.equal(payoutRow(sqlite, "BK-LEGACY").computed_at, july, "every later re-read keeps it there too");
  const julyClose = await statutoryTcs.computeMonthlyTcsStatutory(db, { period: "2026-07", actorId: FINANCE });
  assert.equal(julyClose.totalTcs, 4.24, "the July GSTR-8 still files the July supply");
  assert.equal((await statutoryTcs.computeMonthlyTcsStatutory(db, { period: "2026-09", actorId: FINANCE })).totalTcs, 0, "and September does not pick it up");
});

test("funeral / memorial is exempt: no TCS is withheld from or filed for a GST-registered vendor, on any engagement model", async () => {
  const { sqlite, db } = reviewWorld();
  await activeTerm(db, { service: "funeral_memorial", model: "commission_standard", share: 0.70 });
  await activeTerm(db, { service: "funeral", model: "funeral_exempt", share: 0.70 });
  await statutoryTcs.saveProviderTaxProfile(db, { providerId: "PRV-VENDOR", gstin: PROVIDER_GSTIN }, FINANCE);
  booking(sqlite, "BK-FUN-COMM", { service: "funeral_memorial", provider: "PRV-VENDOR" });
  booking(sqlite, "BK-FUN-EXEMPT", { service: "funeral", provider: "PRV-VENDOR" });
  for (const id of ["BK-FUN-COMM", "BK-FUN-EXEMPT"]) {
    const fact = await completion.resolveServiceCompletionFinance(db, { bookingId: id, actorId: FINANCE, completedAt: COMPLETED });
    assert.deepEqual([fact.providerGrossPayout, fact.gstLiability, fact.tcsWithheld, fact.providerPayoutAccrued], [700, 0, 0, 700], `${id}: exempt supply, so no TCS either`);
    assert.equal(payable(sqlite, id), 700);
  }
  booking(sqlite, "BK-FUN-PREVIEW", { service: "funeral_memorial", provider: "PRV-VENDOR" });
  const preview = await payoutStatutory.computeOrderPayoutStatutory(db, { bookingId: "BK-FUN-PREVIEW", actorId: FINANCE, persist: false });
  assert.deepEqual([preview.tcsWithheld, preview.providerSettlement], [0, 700], "the Finance preview agrees");
  const close = await statutoryTcs.computeMonthlyTcsStatutory(db, { period: "2026-09", actorId: FINANCE });
  assert.equal(close.totalTcs, 0, "GSTR-8 files no TCS on an exempt supply");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM tcs_collections WHERE period='2026-09'").get().n, 0);
});

test("the Finance payout preview of a completed booking shows the TCS completion withheld, not today's decision", async () => {
  const { sqlite, db } = reviewWorld();
  await activeTerm(db, { service: "boarding", model: "commission_standard", share: 0.70 });
  booking(sqlite, "BK-UNREG-THEN", { service: "boarding", provider: "PRV-LATE" });
  booking(sqlite, "BK-REG-THEN", { service: "boarding", provider: "PRV-EARLY" });
  await statutoryTcs.saveProviderTaxProfile(db, { providerId: "PRV-EARLY", gstin: PROVIDER_GSTIN }, FINANCE);
  await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-UNREG-THEN", actorId: FINANCE, completedAt: COMPLETED });
  await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-REG-THEN", actorId: FINANCE, completedAt: COMPLETED });
  // Afterwards one provider registers for GST and the other's profile lapses.
  await statutoryTcs.saveProviderTaxProfile(db, { providerId: "PRV-LATE", gstin: PROVIDER_GSTIN }, FINANCE);
  sqlite.prepare("UPDATE finance_provider_tax_profiles SET status='inactive' WHERE provider_id='PRV-EARLY'").run();
  const late = await payoutStatutory.computeOrderPayoutStatutory(db, { bookingId: "BK-UNREG-THEN", actorId: FINANCE });
  assert.deepEqual([late.tcsWithheld, late.providerSettlement], [0, payable(sqlite, "BK-UNREG-THEN")], "nothing was withheld at completion, so the preview pays the posted 700");
  const early = await payoutStatutory.computeOrderPayoutStatutory(db, { bookingId: "BK-REG-THEN", actorId: FINANCE });
  assert.deepEqual([early.tcsWithheld, early.providerSettlement, early.supplierGstin], [5, payable(sqlite, "BK-REG-THEN"), PROVIDER_GSTIN], "5 was withheld at completion and is what GSTR-8 files, so the preview shows 695");
  const close = await statutoryTcs.computeMonthlyTcsStatutory(db, { period: "2026-09", actorId: FINANCE });
  assert.equal(close.totalTcs, 5, "GSTR-8 files exactly what completion withheld");
});

async function taxiWorld() {
  const { sqlite, db } = reviewWorld();
  await taxiFleet.ensureTaxiFleetTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO taxi_fleet_vehicles (id,vehicle_class,label,registration_suffix,ownership_model,pawspace_share_percent,owner_commission_percent,gst_rate,gst_base,inspection_status,active,features_json,created_at,updated_at,city_id,owner_provider_id,commercial_mode) VALUES ('TXF-REV','citroen_ec3','Review eC3','R001','owner_vehicle',30,70,18,'pawspace_share','uat_verified',1,'[]',?,?,'blr','PRV-OWNER','fixed')").run(now, now);
  sqlite.prepare("INSERT INTO taxi_fleet_reservations (id,vehicle_id,provider_id,quote_id,booking_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('TXR-REV','TXF-REV','DRV-1','Q-REV','BK-TAXI','2026-09-15T05:00:00.000Z','2026-09-15T08:00:00.000Z','confirmed',?,?)").run(now, now);
  booking(sqlite, "BK-TAXI", { service: "pet_taxi", provider: "DRV-1" });
  return { sqlite, db };
}

test("re-running a Pet Taxi completion replays what was posted, so the owner's settlement still matches the Provider Payable", async () => {
  const { sqlite, db } = await taxiWorld();
  const first = await taxiFinance.resolveTaxiCompletionFinance(db, { bookingId: "BK-TAXI", actorId: FINANCE, completedAt: COMPLETED });
  assert.deepEqual([first.ownerCommissionAccrued, first.gstLiability, first.tcsWithheld], [700, 54, 0], "an unregistered owner is paid in full");
  // Later the owner registers for GST and Finance switches the setting; a second capture replays completion.
  await statutoryTcs.saveProviderTaxProfile(db, { providerId: "PRV-OWNER", gstin: PROVIDER_GSTIN }, FINANCE);
  await gstSetting.saveGstSetting(db, { cityId: "*", ratePercent: 18, method: "extract_inclusive", effectiveFrom: "2026-01-01", reason: "CA says prices include GST", actorId: FINANCE });
  const again = await taxiFinance.resolveTaxiCompletionFinance(db, { bookingId: "BK-TAXI", actorId: "razorpay_capture_saga", completedAt: Date.parse("2026-10-01T12:00:00+05:30") });
  assert.deepEqual([again.ownerCommissionAccrued, again.gstLiability, again.tcsWithheld], [700, 54, 0], "the replay reports the posted figures");
  const owner = sqlite.prepare("SELECT owner_commission_amount,gst_liability,computed_at FROM taxi_vehicle_owner_payout_computations WHERE booking_id='BK-TAXI'").get();
  assert.equal(owner.owner_commission_amount, payable(sqlite, "BK-TAXI"), "the settlement row still equals the posted payable (taxi settlement refuses a mismatch)");
  assert.equal(owner.gst_liability, 54);
  const row = payoutRow(sqlite, "BK-TAXI");
  assert.deepEqual([row.provider_net_payout, row.platform_gst, row.tcs_withheld, row.computed_at], [700, 54, 0, COMPLETED]);
});

test("Finance's compute_payout on a completed Pet Taxi booking returns the fleet record for the owner, complete", async () => {
  const { db } = await taxiWorld();
  await taxiFinance.resolveTaxiCompletionFinance(db, { bookingId: "BK-TAXI", actorId: FINANCE, completedAt: COMPLETED });
  const outcome = await attempt(() => payoutStatutory.computeOrderPayoutStatutory(db, { bookingId: "BK-TAXI", actorId: FINANCE }));
  assert.equal(outcome.ok, true, `compute_payout must answer: ${outcome.body ?? ""}`);
  const p = outcome.value;
  assert.deepEqual({ providerId: p.providerId, orderValue: p.orderValue, net: p.providerNetPayout, fee: p.platformFee, gst: p.platformGst, own: p.pawspaceGstOnOrder, carve: p.providerGstDeducted, model: p.engagementModel, settlement: p.providerSettlement },
    { providerId: "PRV-OWNER", orderValue: 1000, net: 700, fee: 300, gst: 54, own: 0, carve: 0, model: "commission_standard", settlement: 700 }, "the vehicle owner, never the salaried driver, and the posted figures");
});

test("two requests adding the new payout columns at once do not fail with a duplicate column", async () => {
  const { sqlite, db } = reviewWorld();
  sqlite.exec("CREATE TABLE provider_payout_computations (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,order_value REAL NOT NULL,provider_net_payout REAL NOT NULL,platform_fee REAL NOT NULL,platform_gst REAL NOT NULL,provider_gst_deducted REAL NOT NULL,pawspace_gst_on_order REAL NOT NULL,breakdown_json TEXT NOT NULL,term_id TEXT NOT NULL,computed_by TEXT NOT NULL,computed_at INTEGER NOT NULL)");
  const results = await Promise.allSettled([terms.ensureCommercialTermsTables(db), terms.ensureCommercialTermsTables(db), terms.ensureCommercialTermsTables(db)]);
  assert.deepEqual(results.map((r) => r.status === "fulfilled" ? "ok" : String(r.reason?.message ?? r.reason)), ["ok", "ok", "ok"]);
  const columns = new Set(sqlite.prepare("PRAGMA table_info(provider_payout_computations)").all().map((c) => c.name));
  for (const column of ["finalized_at", "taxable_commission", "tcs_withheld", "engagement_model"]) assert.ok(columns.has(column), column);
});

test("the GST setting screen shows why a publish was refused and offers every launched city", async () => {
  const { sqlite, db } = reviewWorld();
  await seedActors(sqlite, db, [{ id: "U-FIN", email: FINANCE, role: "finance" }]);
  sqlite.exec("CREATE TABLE city_launch_configs (id TEXT PRIMARY KEY,city_code TEXT NOT NULL UNIQUE,city TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO city_launch_configs VALUES ('bengaluru','blr','Bengaluru'),('hyderabad','hyd','Hyderabad')").run();
  const route = await import("../app/api/grooming-finance/route.ts");
  const refused = await route.POST(asActor(FINANCE, "/api/grooming-finance", { method: "POST", body: JSON.stringify({ action: "save_gst_setting", cityId: "hyd", ratePercent: 18, method: "percent_of_base", effectiveFrom: "2026-09-01", reason: "short" }) }));
  assert.equal(refused.status, 400);
  assert.match(String((await refused.json()).error), /reason of at least 8 characters/, "Finance is told what to fix");
  const read = await route.GET(asActor(FINANCE, "/api/grooming-finance?scope=gst_setting"));
  const known = (await read.json()).data.knownCities;
  assert.deepEqual(known, [{ cityId: "blr", name: "Bengaluru" }, { cityId: "hyd", name: "Hyderabad" }], "Hyderabad can be chosen on the screen before it has a setting of its own");
});
