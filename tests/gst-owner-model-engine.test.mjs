/*
 * The owner's GST and split model (decisions of 26 Sept 2026), driven through the REAL completion path.
 *
 *   Commission, every service except funeral: provider share and PawSpace commission are percentages of the
 *   amount the customer PAID, nothing taken off first; PawSpace GST = the one GST setting on its commission.
 *   Rs 1,000 at 70/30 -> 700 / 300 / GST 54 / PawSpace keeps 246. At 80/20 -> 800 / 200 / 36 / 164.
 *   Own supply (a full-time provider, a company vehicle): GST on the whole 1,000 -> 180, PawSpace keeps 820.
 *   Funeral / memorial: GST exempt -> 700 / 300 / 0.
 *   s.52 TCS (0.5% = Rs 5): only from a provider with an active GSTIN; nobody is blocked for lacking one.
 *
 * Before this change boarding/sitting/training/walking carved 1000 x 18/118 off the top (593.22 / 254.24 /
 * 45.76 plus a 152.54 carve booked as GST), own supply was 152.54, a full-time groomer on the service default
 * was paid commission, completion refused a provider without a GSTIN, taxi owner vehicles withheld no TCS and
 * never reached GSTR-8, a recompute moved a booking into a later month, an exclusive-mode grooming/boarding/sitting
 * invoice recorded 1,000 against a 1,180 charge (G24), and the margin check left the carve out of GST (G23).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__GST_OWNER_DB__", "__GST_OWNER_ENV__");
const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const statutoryTcs = await import("../lib/statutory-tcs.ts");
const payoutStatutory = await import("../lib/provider-payout-statutory.ts");
const taxiFinance = await import("../lib/taxi-completion-finance.ts");
const taxiFleet = await import("../lib/taxi-fleet-governance.ts");
const groomingInvoice = await import("../lib/grooming-invoice.ts");
const boardingInvoice = await import("../lib/boarding-invoice.ts");
const sittingInvoice = await import("../lib/sitting-invoice.ts");
const margin = await import("../lib/finance-margin-validator.ts");
const special = await import("../lib/special-service-finance-policy.ts");

const PROD_ENV = { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" };
const OPERATOR_GSTIN = "29AABCP1234A1Z5", PROVIDER_GSTIN = "29AACCP9876B1Z2";
const MAKER = "maker@pawspace.in", CHECKER = "checker@pawspace.in", FINANCE = "finance@pawspace.in";
const COMPLETED = Date.parse("2026-09-15T12:00:00+05:30");
const r2 = (value) => Math.round(Number(value) * 100) / 100;

function gstWorld() {
  const { sqlite, db } = world("__GST_OWNER_DB__", "__GST_OWNER_ENV__", PROD_ENV);
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,currency TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tax_registrations (id TEXT,entity_id TEXT,registration_reference TEXT,status TEXT,effective_from TEXT,effective_to TEXT,approved_at INTEGER);
    CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,provider_model TEXT NOT NULL);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  sqlite.prepare("INSERT INTO tax_registrations VALUES ('REG-1','pawspace_india',?,'active','2020-01-01',NULL,1)").run(OPERATOR_GSTIN);
  return { sqlite, db };
}
function booking(sqlite, id, { service, provider, amount = 1000, date = "2026-09-15", city = "blr" }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,provider_id,scheduled_start,scheduled_end,status,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,'pkg','Package',?,?,?,'completed',?,'INR',1,1)")
    .run(id, `CUS-${id}`, city, `${city}-east`, service, provider, `${date}T05:00:00.000Z`, `${date}T06:00:00.000Z`, amount);
}
async function activeTerm(db, { service, model, share, gstMode, providerId = null }) {
  const draft = await terms.saveCommercialTerm(db, { serviceCode: service, providerId, engagementModel: model, providerSharePct: share, gstMode, effectiveFrom: "2026-01-01", reason: `${service} owner model terms`, actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: `APR-${service}`, actorId: CHECKER });
  return draft.id;
}
const complete = (db, bookingId, completedAt = COMPLETED) => completion.resolveServiceCompletionFinance(db, { bookingId, actorId: FINANCE, completedAt });
const ledger = (sqlite, bookingId) => Object.fromEntries(sqlite.prepare("SELECT account_code,SUM(credit) credit FROM finance_journal_entries WHERE source_type='service_completion' AND source_id=? GROUP BY account_code").all(bookingId).map((row) => [row.account_code, r2(row.credit)]));
const payoutRow = (sqlite, bookingId) => sqlite.prepare("SELECT * FROM provider_payout_computations WHERE booking_id=?").get(bookingId);

const COMMISSION_SERVICES = [["grooming", "commission_groomer"], ["boarding", "commission_standard"], ["pet_sitting", "commission_standard"], ["dog_training", "commission_standard"], ["dog_walking", "commission_standard"]];

test("every commission service at 70/30 on Rs 1,000: provider 700, commission 300, GST 54, PawSpace keeps 246 - in the fact, the ledger and the payout row", async () => {
  for (const [service, model] of COMMISSION_SERVICES) {
    const { sqlite, db } = gstWorld();
    // The standard model's old default carve mode is still on this stored term: it is retired and must behave like "none".
    await activeTerm(db, { service, model, share: 0.70, gstMode: model === "commission_standard" ? "provider_gst_on_behalf" : undefined });
    booking(sqlite, `BK-${service}`, { service, provider: `PRV-${service}` });
    const fact = await complete(db, `BK-${service}`);
    assert.equal(fact.providerGrossPayout, 700, `${service}: provider share is 70% of the 1,000 paid`);
    assert.equal(fact.platformFee, 300, `${service}: PawSpace commission is the other 300`);
    assert.equal(fact.gstLiability, 54, `${service}: GST is 18% of the 300 commission, nothing carved first`);
    assert.equal(fact.platformRevenueNetOfGst, 246, `${service}: PawSpace keeps 246`);
    assert.equal(fact.tcsWithheld, 0, `${service}: no GSTIN on file, so no TCS`);
    assert.equal(fact.providerPayoutAccrued, 700, `${service}: an unregistered provider is paid in full`);
    assert.equal(fact.commercial.providerGstDeducted, 0);
    assert.deepEqual(ledger(sqlite, `BK-${service}`), { "2110-Provider Payable": 700, "2130-GST Payable": 54, "2230-Customer Collections": 0, "4000-Service Revenue": 246 }, `${service}: the ledger books exactly the owner's numbers (no TCS line when none is withheld)`);
    const row = payoutRow(sqlite, `BK-${service}`);
    assert.deepEqual({ net: row.provider_net_payout, fee: row.platform_fee, gst: row.platform_gst, carve: row.provider_gst_deducted, taxable: row.taxable_commission, method: row.gst_method, rate: row.gst_rate, model: row.engagement_model, registered: row.provider_gst_registered, tcs: row.tcs_withheld },
      { net: 700, fee: 300, gst: 54, carve: 0, taxable: 300, method: "percent_of_base", rate: 18, model, registered: 0, tcs: 0 }, `${service}: the payout row carries what filing needs`);
  }
});

test("80/20 on Rs 1,000: provider 800, commission 200, GST 36, PawSpace keeps 164", async () => {
  const { sqlite, db } = gstWorld();
  await activeTerm(db, { service: "boarding", model: "commission_standard", share: 0.80 });
  booking(sqlite, "BK-8020", { service: "boarding", provider: "PRV-HOST" });
  const fact = await complete(db, "BK-8020");
  assert.deepEqual([fact.providerGrossPayout, fact.platformFee, fact.gstLiability, fact.platformRevenueNetOfGst], [800, 200, 36, 164]);
});

test("TCS of 0.5% (Rs 5) is withheld only from a provider with an active GSTIN; one without is never blocked", async () => {
  const { sqlite, db } = gstWorld();
  await activeTerm(db, { service: "grooming", model: "commission_groomer", share: 0.70 });
  await statutoryTcs.saveProviderTaxProfile(db, { providerId: "PRV-REG", gstin: PROVIDER_GSTIN }, FINANCE);
  booking(sqlite, "BK-REG", { service: "grooming", provider: "PRV-REG" });
  booking(sqlite, "BK-UNREG", { service: "grooming", provider: "PRV-UNREG" });

  const registered = await complete(db, "BK-REG");
  assert.equal(registered.tcsWithheld, 5, "0.5% of the 1,000 the customer paid");
  assert.equal(registered.providerPayoutAccrued, 695);
  assert.equal(registered.gstLiability, 54, "TCS never changes PawSpace's own GST");
  assert.equal(registered.providerGstRegistered, true);
  assert.equal(ledger(sqlite, "BK-REG")["2140-TCS Payable"], 5);

  const unregistered = await attempt(() => complete(db, "BK-UNREG"));
  assert.equal(unregistered.ok, true, `no 409 for a provider without a GSTIN: ${unregistered.body ?? ""}`);
  assert.equal(unregistered.value.tcsWithheld, 0);
  assert.equal(unregistered.value.providerPayoutAccrued, 700);

  // The Finance payout preview follows the same rule instead of refusing with configuration_required.
  booking(sqlite, "BK-PREVIEW", { service: "grooming", provider: "PRV-UNREG" });
  const preview = await attempt(() => payoutStatutory.computeOrderPayoutStatutory(db, { bookingId: "BK-PREVIEW", actorId: FINANCE, persist: false }));
  assert.equal(preview.ok, true, `preview must not refuse: ${preview.body ?? ""}`);
  assert.equal(preview.value.tcsWithheld, 0);
  assert.equal(preview.value.providerSettlement, 700);

  // GSTR-8 files the registered provider's TCS and skips the unregistered one instead of stopping the close.
  const close = await statutoryTcs.computeMonthlyTcsStatutory(db, { period: "2026-09", actorId: FINANCE });
  assert.equal(close.totalTcs, 5);
  assert.deepEqual(sqlite.prepare("SELECT booking_id FROM tcs_collections WHERE period='2026-09' ORDER BY booking_id").all().map((row) => row.booking_id), ["BK-REG"]);
  assert.deepEqual(close.issues, ["provider_not_gst_registered_no_tcs:PRV-UNREG:BK-UNREG"]);
});

test("own supply: a full-time provider on the service's commission default is own supply in production - GST 180, PawSpace keeps 820", async () => {
  const { sqlite, db } = gstWorld();
  await activeTerm(db, { service: "grooming", model: "commission_groomer", share: 0.70 });
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,provider_model) VALUES ('PRV-FT','full_time')").run();
  booking(sqlite, "BK-FT", { service: "grooming", provider: "PRV-FT" });
  const fact = await complete(db, "BK-FT");
  assert.equal(fact.commercial.engagementModel, "direct_employee");
  assert.equal(fact.commercial.engagementSource, "provider_full_time");
  assert.equal(fact.providerGrossPayout, 0, "a full-time provider is never paid a commission share");
  assert.equal(fact.gstLiability, 180, "18% of the whole 1,000");
  assert.equal(fact.platformRevenueNetOfGst, 820);
  assert.equal(fact.tcsWithheld, 0);
  const row = payoutRow(sqlite, "BK-FT");
  assert.deepEqual({ own: row.pawspace_gst_on_order, taxable: row.own_supply_taxable_value, supply: row.supply_model }, { own: 180, taxable: 1000, supply: "own_supply" });
});

test("funeral / memorial is GST exempt: 70/30 gives 700 / 300 / 0, and funeral own supply is 0 too", async () => {
  const { sqlite, db } = gstWorld();
  // Even a plain commission term on the funeral service is exempt; so is the funeral_exempt model.
  await activeTerm(db, { service: "funeral_memorial", model: "commission_standard", share: 0.70 });
  await activeTerm(db, { service: "funeral", model: "funeral_exempt", share: 0.70 });
  booking(sqlite, "BK-FUN-1", { service: "funeral_memorial", provider: "PRV-VENDOR" });
  booking(sqlite, "BK-FUN-2", { service: "funeral", provider: "PRV-VENDOR" });
  for (const id of ["BK-FUN-1", "BK-FUN-2"]) {
    const fact = await complete(db, id);
    assert.deepEqual([fact.providerGrossPayout, fact.platformFee, fact.gstLiability, fact.platformRevenueNetOfGst, fact.tcsWithheld], [700, 300, 0, 300, 0], id);
  }
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,provider_model) VALUES ('PRV-FUN-FT','full_time')").run();
  booking(sqlite, "BK-FUN-OWN", { service: "funeral", provider: "PRV-FUN-FT" });
  const own = await complete(db, "BK-FUN-OWN");
  assert.deepEqual([own.providerGrossPayout, own.gstLiability, own.platformRevenueNetOfGst], [0, 0, 1000]);
});

async function taxiWorld({ ownerShare, ownerProviderId }) {
  const { sqlite, db } = gstWorld();
  await taxiFleet.ensureTaxiFleetTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO taxi_fleet_vehicles (id,vehicle_class,label,registration_suffix,ownership_model,pawspace_share_percent,owner_commission_percent,gst_rate,gst_base,inspection_status,active,features_json,created_at,updated_at,city_id,owner_provider_id,commercial_mode) VALUES ('TXF-TEST','citroen_ec3','Test eC3','T001',?,?,?,18,'pawspace_share','uat_verified',1,'[]',?,?,'blr',?,'fixed')")
    .run(ownerShare > 0 ? "owner_vehicle" : "company_vehicle", 100 - ownerShare, ownerShare, now, now, ownerProviderId);
  sqlite.prepare("INSERT INTO taxi_fleet_reservations (id,vehicle_id,provider_id,quote_id,booking_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('TXR-1','TXF-TEST','DRV-1','Q-1','BK-TAXI','2026-09-15T05:00:00.000Z','2026-09-15T08:00:00.000Z','confirmed',?,?)").run(now, now);
  booking(sqlite, "BK-TAXI", { service: "pet_taxi", provider: "DRV-1" });
  return { sqlite, db };
}

test("pet taxi owner vehicle is a commission job - 700 / 300 / 54 / 246 - with TCS only from a GST-registered owner, and it reaches GSTR-8", async () => {
  const { sqlite, db } = await taxiWorld({ ownerShare: 70, ownerProviderId: "PRV-OWNER" });
  await statutoryTcs.saveProviderTaxProfile(db, { providerId: "PRV-OWNER", gstin: PROVIDER_GSTIN }, FINANCE);
  const fact = await taxiFinance.resolveTaxiCompletionFinance(db, { bookingId: "BK-TAXI", actorId: FINANCE, completedAt: COMPLETED });
  assert.equal(fact.pawspaceGrossShare, 300);
  assert.equal(fact.gstLiability, 54, "18% of PawSpace's 300 commission, not 300 x 18/118");
  assert.equal(fact.platformRevenueNetOfGst, 246);
  assert.equal(fact.tcsWithheld, 5, "the owner holds a GSTIN, so 0.5% of the fare is withheld");
  assert.equal(fact.ownerCommissionAccrued, 695);
  assert.deepEqual(ledger(sqlite, "BK-TAXI"), { "2110-Provider Payable": 695, "2130-GST Payable": 54, "2140-TCS Payable": 5, "2230-Customer Collections": 0, "4000-Service Revenue": 246 });
  const row = payoutRow(sqlite, "BK-TAXI");
  assert.deepEqual({ fee: row.platform_fee, gst: row.platform_gst, own: row.pawspace_gst_on_order, model: row.engagement_model, taxable: row.taxable_commission }, { fee: 300, gst: 54, own: 0, model: "commission_standard", taxable: 300 }, "GST is recorded once, as commission GST");
  const close = await statutoryTcs.computeMonthlyTcsStatutory(db, { period: "2026-09", actorId: FINANCE });
  assert.equal(close.totalTcs, 5, "the TAXI-FLEET payout row is no longer dropped by a join on commercial terms");
});

test("pet taxi company vehicle is PawSpace's own supply: GST 180 on the fare, PawSpace keeps 820, no TCS", async () => {
  const { sqlite, db } = await taxiWorld({ ownerShare: 0, ownerProviderId: null });
  const fact = await taxiFinance.resolveTaxiCompletionFinance(db, { bookingId: "BK-TAXI", actorId: FINANCE, completedAt: COMPLETED });
  assert.deepEqual([fact.ownerCommissionAccrued, fact.gstLiability, fact.platformRevenueNetOfGst, fact.tcsWithheld], [0, 180, 820, 0]);
  const row = payoutRow(sqlite, "BK-TAXI");
  assert.deepEqual({ gst: row.platform_gst, own: row.pawspace_gst_on_order, supply: row.supply_model }, { gst: 0, own: 180, supply: "own_supply" });
});

test("a recompute never rewrites a completed booking's tax record or moves it into a later month", async () => {
  const { sqlite, db } = gstWorld();
  await activeTerm(db, { service: "dog_walking", model: "commission_standard", share: 0.70 });
  await statutoryTcs.saveProviderTaxProfile(db, { providerId: "PRV-WALK", gstin: PROVIDER_GSTIN }, FINANCE);
  booking(sqlite, "BK-JULY", { service: "dog_walking", provider: "PRV-WALK", date: "2026-07-10" });
  const july = Date.parse("2026-07-10T12:00:00+05:30");
  await complete(db, "BK-JULY", july);
  assert.equal(payoutRow(sqlite, "BK-JULY").computed_at, july, "completion pins the statutory period to the completion time");

  // August: Finance activates a new 80% term and someone recomputes the July booking.
  await activeTerm(db, { service: "dog_walking", model: "commission_standard", share: 0.80 });
  const recomputed = await terms.computeOrderPayout(db, { bookingId: "BK-JULY", actorId: FINANCE });
  assert.equal(recomputed.providerNetPayout, 700, "the completed record stands; it is not rewritten under the new term");
  const row = payoutRow(sqlite, "BK-JULY");
  assert.deepEqual([row.provider_net_payout, row.platform_gst, row.computed_at, row.tcs_withheld], [700, 54, july, 5]);
  const preview = await terms.computeOrderPayout(db, { bookingId: "BK-JULY", actorId: FINANCE, persist: false });
  assert.equal(preview.providerNetPayout, 800, "a non-persisting preview still shows the new term");

  // Re-running completion (training re-reads, walking settlement) replays the same figures.
  const again = await complete(db, "BK-JULY", Date.parse("2026-08-20T12:00:00+05:30"));
  assert.deepEqual([again.providerPayoutAccrued, again.tcsWithheld, again.gstLiability], [695, 5, 54]);
  const julyClose = await statutoryTcs.computeMonthlyTcsStatutory(db, { period: "2026-07", actorId: FINANCE });
  assert.equal(julyClose.totalTcs, 5, "the July GSTR-8 keeps the July supply");
});

test("an exclusive-mode grooming, boarding or sitting invoice records what the customer is charged (G24)", async () => {
  const { sqlite, db } = gstWorld();
  for (const [service, mod, save, issue] of [["grooming", groomingInvoice, "saveGroomingTaxPolicy", "issueGroomingInvoice"], ["boarding", boardingInvoice, "saveBoardingTaxPolicy", "issueBoardingInvoice"], ["pet_sitting", sittingInvoice, "saveSittingTaxPolicy", "issueSittingInvoice"]]) {
    await mod[save](db, { cityId: "blr", taxMode: "exclusive", taxRate: 18, effectiveFrom: "2026-01-01", actorId: FINANCE, reason: "Exclusive pricing trial" });
    booking(sqlite, `BK-INV-${service}`, { service, provider: "PRV-1" });
    sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,1000,1000,'INR','card','prepaid','captured','razorpay',?,'{}',1,1)").run(`PAY-${service}`, `BK-INV-${service}`, `CUS-BK-INV-${service}`, `idem-${service}`);
    await mod[issue](db, { bookingId: `BK-INV-${service}`, reason: "Issue the customer invoice", actorId: FINANCE });
    const stored = sqlite.prepare("SELECT gross_amount,tax_amount,net_amount FROM booking_invoices WHERE booking_id=?").get(`BK-INV-${service}`);
    assert.deepEqual([stored.gross_amount, stored.tax_amount, stored.net_amount], [1180, 180, 1180], `${service}: gross is the 1,180 charged, not the 1,000 total`);
  }
});

test("the margin check counts every GST the split books and no retired carve (G23)", async () => {
  const { sqlite, db } = gstWorld();
  await activeTerm(db, { service: "boarding", model: "commission_standard", share: 0.70, gstMode: "provider_gst_on_behalf" });
  booking(sqlite, "BK-MARGIN", { service: "boarding", provider: "PRV-HOST" });
  await margin.ensureMarginPolicyTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO finance_ai_margin_policies (id,service_code,city_id,version,status,minimum_margin_bps,minimum_margin_paise,razorpay_fee_bps,razorpay_fee_fixed_paise,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES ('MP-1','boarding','blr',1,'active',1000,15000,200,0,?,NULL,'finance',?,?,?)").run(now - 1000, now, now, now);
  const result = await margin.validateBookingMargin(db, { bookingId: "BK-MARGIN", offerPolicyVersion: "offer-v1", actorId: FINANCE, asOf: now });
  assert.deepEqual([result.partnerPayoutPaise, result.gstPaise, result.netPlatformMarginPaise], [70_000, 5_400, 22_600], "1,000 - 700 - 54 - 20 of fees = 226, the margin completion will actually book");
});

test("funeral stays GST exempt even with its tax toggle on; relocation keeps its current treatment until the owner classifies it", () => {
  const on = { taxEnabled: true, taxRatePercent: 18, taxMode: "inclusive", settlementDelayDays: 0 };
  assert.deepEqual(special.taxFromGrossMargin(300, on, { exempt: true }), { taxStatus: "resolved", taxAmount: 0, revenueNet: 300, exempt: true });
  assert.equal(special.taxFromGrossMargin(300, on).taxAmount, 45.76, "relocation with tax on: unchanged, taken out of the GST-inclusive margin by the one helper");
  assert.equal(special.taxFromGrossMargin(300, { ...on, taxEnabled: false }).taxAmount, 0);
});
