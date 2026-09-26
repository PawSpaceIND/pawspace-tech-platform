/*
 * Every service reaches GST filing with the owner's numbers (work package B, owner decisions of 26 Sept 2026:
 * "all of this must flow into GST filing"). Driven through the REAL completion path, then the REAL statutory
 * package, monthly close, GSTR-1 and GSTR-3B, and checked against ledger account 2130-GST Payable.
 *
 *   Commission job, Rs 1,000 at 70/30: PawSpace files 54 GST on a 300 taxable value (its commission).
 *   Own supply, Rs 1,000: 180 on 820 under "percent_of_base"; 152.54 on 847.46 under "extract_inclusive".
 *   Funeral / memorial: 0 GST, reported as an exempt supply (GSTR-1 nil, GSTR-3B 3.1(c)).
 *   Boarding, sitting, walking, training and the Pet Taxi owner vehicle file exactly like grooming.
 *
 * Before this change the returns read the customer invoice's tax: a completion Finance never invoiced by hand
 * (boarding, sitting, walking, taxi, training, funeral) reached no return at all, grooming filed 54 on 946,
 * GSTR-1 had no service lines in b2cs / hsn, GSTR-3B carried service tax in no CGST/SGST/IGST field, and the
 * monthly close could lock a month whose invoices were unassigned so its returns could never be prepared (G22).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__GST_FILING_DB__", "__GST_FILING_ENV__");
const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const taxiFinance = await import("../lib/taxi-completion-finance.ts");
const taxiFleet = await import("../lib/taxi-fleet-governance.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const returns = await import("../lib/gst-returns.ts");
const close = await import("../lib/finance-monthly-close.ts");
const supplies = await import("../lib/service-output-tax.ts");
const gstSetting = await import("../lib/gst-setting.ts");
const statutory = await import("../lib/statutory-compliance.ts");

const PROD_ENV = { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" };
const ENTITY = "pawspace_india", REG = "REG-KA", OPERATOR_GSTIN = "29AABCP1234A1Z5";
const MAKER = "maker@pawspace.in", CHECKER = "checker@pawspace.in", FINANCE = "finance@pawspace.in";
const PERIOD = "2026-09", COMPLETED = Date.parse("2026-09-15T12:00:00+05:30");
const r2 = (value) => Math.round(Number(value) * 100) / 100;

async function filingWorld() {
  const { sqlite, db } = world("__GST_FILING_DB__", "__GST_FILING_ENV__", PROD_ENV);
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,currency TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,provider_model TEXT NOT NULL);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE payroll_runs (id TEXT PRIMARY KEY,period_start INTEGER,period_end INTEGER,status TEXT);
    CREATE TABLE employee_payroll_results (id TEXT PRIMARY KEY,run_id TEXT,employee_id TEXT,gross_earnings REAL);
    CREATE TABLE boarding_host_settlement_ledger (booking_id TEXT,provider_id TEXT,payout_amount REAL,eligible_at INTEGER);
  `);
  await gstAccounting.ensureGstAccountingTables(db);
  await returns.ensureGstReturnTables(db);
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,'active','founder',1,1,1)").run(ENTITY, "PawSpace Pvt Ltd", "IN");
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'Karnataka','gstin',?,'active','2020-01-01',NULL,'founder',1,1,1)").run(REG, ENTITY, OPERATOR_GSTIN);
  return { sqlite, db };
}
function booking(sqlite, id, { service, provider, amount = 1000, city = "blr" }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,provider_id,scheduled_start,scheduled_end,status,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,'pkg','Package',?,'2026-09-15T05:00:00.000Z','2026-09-15T06:00:00.000Z','completed',?,'INR',1,1)")
    .run(id, `CUS-${id}`, city, `${city}-east`, service, provider, amount);
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,?,?,'INR','upi','prepaid','captured','razorpay',?,'{}',1,1)").run(`PAY-${id}`, id, `CUS-${id}`, amount, amount, `idem-${id}`);
}
async function activeTerm(db, { service, model, share }) {
  const draft = await terms.saveCommercialTerm(db, { serviceCode: service, engagementModel: model, providerSharePct: share, effectiveFrom: "2026-01-01", reason: `${service} owner model terms`, actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: `APR-${service}`, actorId: CHECKER });
}
const complete = (db, bookingId) => completion.resolveServiceCompletionFinance(db, { bookingId, actorId: FINANCE, completedAt: COMPLETED });
const ledgerGst = (sqlite, ids) => r2(sqlite.prepare(`SELECT COALESCE(SUM(credit-debit),0) gst FROM finance_journal_entries WHERE account_code='2130-GST Payable' AND source_id IN (${ids.map(() => "?").join(",")})`).get(...ids).gst);
const assignSeptember = (db) => supplies.assignPeriodServiceOwnership(db, { periodCode: PERIOD, entityId: ENTITY, registrationId: REG, reason: "PawSpace India files every Karnataka service supply" }, FINANCE);
const scope = { entityId: ENTITY, registrationId: REG, periodCode: PERIOD, reason: "September filing" };
async function fileSeptember(db) {
  const pkg = await gstAccounting.generateStatutoryPackage(db, scope, MAKER);
  const view = await close.monthlyCloseView(db, { period: PERIOD, actorId: FINANCE });
  const gstr1 = await returns.generateGstr1(db, scope, MAKER);
  const gstr3b = await returns.generateGstr3b(db, scope, MAKER);
  return { pkg, view, gstr1, gstr3b };
}
const b2csTax = (gstr1) => r2(gstr1.payload.b2cs.reduce((sum, b) => sum + b.iamt + b.camt + b.samt, 0));
const osupTax = (gstr3b) => { const o = gstr3b.payload.sup_details.osup_det; return r2(o.iamt + o.camt + o.samt); };

test("a Rs 1,000 grooming commission booking files 54 GST on 300 in every return, with no manual invoice, and matches 2130", async () => {
  const { sqlite, db } = await filingWorld();
  await activeTerm(db, { service: "grooming", model: "commission_groomer", share: 0.70 });
  booking(sqlite, "BK-GROOM", { service: "grooming", provider: "PRV-G" });
  const fact = await complete(db, "BK-GROOM");
  assert.equal(fact.gstLiability, 54);
  assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='booking_invoices'").get(), undefined, "nobody issued an invoice for this booking");
  await assignSeptember(db);

  const { pkg, view, gstr1, gstr3b } = await fileSeptember(db);
  assert.equal(pkg.summary.serviceOutputTax, 54, "statutory package: 18% of the 300 commission");
  assert.equal(pkg.summary.serviceTaxableValue, 300, "statutory package: the taxable value is PawSpace's commission, not the 1,000 order");
  assert.equal(pkg.summary.ledgerCheck.postedGst, 54);
  assert.equal(pkg.summary.ledgerCheck.agrees, true, "the filing and 2130-GST Payable agree for the same booking");
  assert.deepEqual(pkg.variance, []);
  assert.equal(view.gst.outputTax, 54, "monthly close");
  assert.equal(view.gst.serviceTaxableValue, 300);
  const bucket = gstr1.payload.b2cs.find((b) => b.pos === "29" && b.rt === 18);
  assert.deepEqual(bucket, { sply_ty: "INTRA", pos: "29", typ: "OE", rt: 18, txval: 300, iamt: 0, camt: 27, samt: 27, csamt: 0 }, "GSTR-1 b2cs by place of supply and rate");
  const hsn = gstr1.payload.hsn.data.find((h) => h.hsn_sc === "998599");
  assert.deepEqual([hsn.txval, hsn.camt, hsn.samt, hsn.num], [300, 27, 27, 1], "GSTR-1 hsn by SAC (the default commission SAC until the CA confirms it)");
  assert.equal(gstr1.summary.totalOutputTax, 54);
  assert.equal(gstr1.summary.reconciliation.serviceVerticalTaxExcludedFromSections, 0, "nothing is left out of the sections");
  assert.deepEqual(gstr3b.payload.sup_details.osup_det, { txval: 300, iamt: 0, camt: 27, samt: 27, csamt: 0 }, "GSTR-3B 3.1(a) carries the value AND the tax");
  assert.equal(gstr3b.summary.totalOutputTax, 54);
  assert.equal(ledgerGst(sqlite, ["BK-GROOM"]), 54);
  assert.equal(gstr3b.liveFilingEnabled, false);
  assert.equal(gstr1.liveFilingEnabled, false);
});

test("a booking in another state is filed under its own place of supply as IGST", async () => {
  const { sqlite, db } = await filingWorld();
  await activeTerm(db, { service: "grooming", model: "commission_groomer", share: 0.70 });
  booking(sqlite, "BK-BLR", { service: "grooming", provider: "PRV-G" });
  booking(sqlite, "BK-HYD", { service: "grooming", provider: "PRV-H", city: "hyd" });
  await complete(db, "BK-BLR");
  await complete(db, "BK-HYD");
  await assignSeptember(db);
  const { gstr1, gstr3b } = await fileSeptember(db);
  assert.deepEqual(gstr1.payload.b2cs.find((b) => b.pos === "36"), { sply_ty: "INTER", pos: "36", typ: "OE", rt: 18, txval: 300, iamt: 54, camt: 0, samt: 0, csamt: 0 }, "Telangana supply from the Karnataka registration");
  assert.deepEqual(gstr1.payload.b2cs.find((b) => b.pos === "29"), { sply_ty: "INTRA", pos: "29", typ: "OE", rt: 18, txval: 300, iamt: 0, camt: 27, samt: 27, csamt: 0 });
  assert.deepEqual(gstr3b.payload.sup_details.osup_det, { txval: 600, iamt: 54, camt: 27, samt: 27, csamt: 0 });
  assert.equal(gstr3b.summary.totalOutputTax, ledgerGst(sqlite, ["BK-BLR", "BK-HYD"]));
});

test("boarding, sitting, walking, training and the taxi owner vehicle file like grooming; every return and the journal show the same totals", async () => {
  const { sqlite, db } = await filingWorld();
  // pet_taxi here is the legacy (non-fleet) taxi completion, which runs through the same engine; BK-TAXI below is the fleet path.
  const services = [["grooming", "commission_groomer"], ["boarding", "commission_standard"], ["pet_sitting", "commission_standard"], ["dog_walking", "commission_standard"], ["dog_training", "commission_standard"], ["pet_taxi", "commission_standard"]];
  for (const [service, model] of services) {
    await activeTerm(db, { service, model, share: 0.70 });
    booking(sqlite, `BK-${service}`, { service, provider: `PRV-${service}` });
    await complete(db, `BK-${service}`);
  }
  await taxiFleet.ensureTaxiFleetTables(db);
  sqlite.prepare("INSERT INTO taxi_fleet_vehicles (id,vehicle_class,label,registration_suffix,ownership_model,pawspace_share_percent,owner_commission_percent,gst_rate,gst_base,inspection_status,active,features_json,created_at,updated_at,city_id,owner_provider_id,commercial_mode) VALUES ('TXF-1','citroen_ec3','eC3','T001','owner_vehicle',30,70,18,'pawspace_share','uat_verified',1,'[]',1,1,'blr','PRV-OWNER','fixed')").run();
  sqlite.prepare("INSERT INTO taxi_fleet_reservations (id,vehicle_id,provider_id,quote_id,booking_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('TXR-1','TXF-1','DRV-1','Q-1','BK-TAXI','2026-09-15T05:00:00.000Z','2026-09-15T08:00:00.000Z','confirmed',1,1)").run();
  booking(sqlite, "BK-TAXI", { service: "pet_taxi", provider: "DRV-1" });
  const taxi = await taxiFinance.resolveTaxiCompletionFinance(db, { bookingId: "BK-TAXI", actorId: FINANCE, completedAt: COMPLETED });
  assert.equal(taxi.gstLiability, 54);
  await assignSeptember(db);

  const register = await supplies.serviceVerticalOutputTax(db, Date.UTC(2026, 7, 31, 18, 30), Date.UTC(2026, 8, 30, 18, 30), { entityId: ENTITY, registrationId: REG });
  const byBooking = Object.fromEntries(register.lines.map((l) => [l.bookingId, [l.treatment, l.taxableValue, l.gst]]));
  for (const id of ["BK-grooming", "BK-boarding", "BK-pet_sitting", "BK-dog_walking", "BK-dog_training", "BK-pet_taxi", "BK-TAXI"]) assert.deepEqual(byBooking[id], ["commission", 300, 54], `${id} files 54 on its 300 commission`);

  const { pkg, view, gstr1, gstr3b } = await fileSeptember(db);
  const journal = ledgerGst(sqlite, Object.keys(byBooking));
  assert.equal(journal, 378, "seven bookings x 54 in 2130-GST Payable");
  for (const [label, value] of [["statutory package", pkg.summary.serviceOutputTax], ["monthly close", view.gst.outputTax], ["GSTR-1", gstr1.summary.totalOutputTax], ["GSTR-1 b2cs", b2csTax(gstr1)], ["GSTR-3B", gstr3b.summary.totalOutputTax], ["GSTR-3B 3.1(a) tax", osupTax(gstr3b)]]) assert.equal(value, journal, `${label} shows the journal's 378`);
  assert.equal(pkg.summary.serviceTaxableValue, 2100);
  assert.equal(gstr3b.payload.sup_details.osup_det.txval, 2100);
  assert.equal(r2(gstr1.payload.b2cs.reduce((s, b) => s + b.txval, 0)), 2100);
  assert.equal(pkg.summary.ledgerCheck.agrees, true);
  assert.equal(pkg.summary.serviceSupplies.commission.count, 7);
});

test("own supply files 180 on 820 under percent_of_base, and 152.54 on 847.46 when Finance switches to extract_inclusive", async () => {
  const { sqlite, db } = await filingWorld();
  await activeTerm(db, { service: "grooming", model: "commission_groomer", share: 0.70 });
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-FT','full_time')").run();
  booking(sqlite, "BK-OWN", { service: "grooming", provider: "PRV-FT" });
  assert.equal((await complete(db, "BK-OWN")).gstLiability, 180);
  await assignSeptember(db);
  const { pkg, gstr1, gstr3b } = await fileSeptember(db);
  assert.deepEqual([pkg.summary.serviceOutputTax, pkg.summary.serviceTaxableValue], [180, 820], "180 on 820");
  assert.deepEqual(gstr1.payload.b2cs.find((b) => b.pos === "29"), { sply_ty: "INTRA", pos: "29", typ: "OE", rt: 18, txval: 820, iamt: 0, camt: 90, samt: 90, csamt: 0 });
  assert.ok(gstr1.payload.hsn.data.some((h) => h.hsn_sc === "999799" && h.txval === 820), "own supply is filed under the service's own SAC, not the commission SAC");
  assert.deepEqual(gstr3b.payload.sup_details.osup_det, { txval: 820, iamt: 0, camt: 90, samt: 90, csamt: 0 });
  assert.equal(ledgerGst(sqlite, ["BK-OWN"]), 180);

  const inclusive = await filingWorld();
  await gstSetting.saveGstSetting(inclusive.db, { cityId: "*", ratePercent: 18, method: "extract_inclusive", effectiveFrom: "2026-01-01", reason: "CA says the price includes GST", actorId: FINANCE });
  await activeTerm(inclusive.db, { service: "grooming", model: "commission_groomer", share: 0.70 });
  inclusive.sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-FT','full_time')").run();
  booking(inclusive.sqlite, "BK-OWN", { service: "grooming", provider: "PRV-FT" });
  assert.equal((await complete(inclusive.db, "BK-OWN")).gstLiability, 152.54);
  await assignSeptember(inclusive.db);
  const extracted = await fileSeptember(inclusive.db);
  assert.deepEqual([extracted.pkg.summary.serviceOutputTax, extracted.pkg.summary.serviceTaxableValue], [152.54, 847.46], "152.54 on 847.46");
  assert.equal(extracted.gstr3b.summary.totalOutputTax, 152.54);
  assert.equal(extracted.gstr3b.payload.sup_details.osup_det.txval, 847.46);
  assert.equal(osupTax(extracted.gstr3b), 152.54);
  assert.equal(ledgerGst(inclusive.sqlite, ["BK-OWN"]), 152.54);
});

test("a funeral booking files 0 GST as an exempt supply: GSTR-1 nil and GSTR-3B 3.1(c)", async () => {
  const { sqlite, db } = await filingWorld();
  await activeTerm(db, { service: "funeral_memorial", model: "commission_standard", share: 0.70 });
  booking(sqlite, "BK-FUN", { service: "funeral_memorial", provider: "PRV-VENDOR" });
  assert.equal((await complete(db, "BK-FUN")).gstLiability, 0);
  // A manual funeral order is PawSpace's own supply, exempt too.
  const funeralOrders = await import("../lib/funeral-manual-order.ts");
  await funeralOrders.recordFuneralConvertedOrder(db, { customerName: "Asha", phone: "9000000000", paymentMethod: "upi", orderValue: 5000, orderDate: "2026-09-20", actorId: FINANCE });
  await assignSeptember(db);
  const { pkg, view, gstr1, gstr3b } = await fileSeptember(db);
  assert.equal(pkg.summary.serviceOutputTax, 0);
  assert.equal(pkg.summary.serviceExemptValue, 5300, "PawSpace's 300 funeral commission plus the 5,000 manual order, both exempt");
  assert.equal(view.gst.outputTax, 0);
  assert.equal(view.gst.serviceExemptValue, 5300);
  assert.deepEqual(gstr1.payload.nil, { inv: [{ sply_ty: "INTRAB2C", expt_amt: 5300, nil_amt: 0, ngsup_amt: 0 }] });
  assert.deepEqual(gstr1.payload.b2cs, [], "an exempt supply is not a taxable b2cs line");
  assert.deepEqual(gstr3b.payload.sup_details.osup_nil_exmp, { txval: 5300 });
  assert.deepEqual(gstr3b.payload.sup_details.osup_det, { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
  assert.equal(ledgerGst(sqlite, ["BK-FUN"]), 0);
});

test("relocation, vet and food keep today's tax but are reported, clearly labelled, instead of being dropped", async () => {
  const { sqlite, db } = await filingWorld();
  const at = COMPLETED;
  sqlite.exec(`
    CREATE TABLE relocation_vendor_settlements (case_id TEXT PRIMARY KEY,vendor_id TEXT,gross_paid_value REAL,vendor_cost REAL,tax_amount REAL,revenue_net REAL,tax_status TEXT,created_at INTEGER);
    CREATE TABLE vet_visit_kpis (id TEXT PRIMARY KEY,appointment_id TEXT UNIQUE,provider_id TEXT,contract_type TEXT,visit_count INTEGER,provider_payout_paise INTEGER,platform_retained_paise INTEGER,tax_paise INTEGER,created_at INTEGER);
    CREATE TABLE food_orders (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,status TEXT,total_amount REAL,created_at INTEGER);
  `);
  sqlite.prepare("INSERT INTO relocation_vendor_settlements VALUES ('REL-1','V1',20000,15000,0,5000,'disabled_by_policy',?)").run(at);
  sqlite.prepare("INSERT INTO vet_visit_kpis VALUES ('K1','APT-1','VET-1','commission',1,41930,17970,0,?)").run(at);
  sqlite.prepare("INSERT INTO food_orders VALUES ('FO-1','C1','blr','delivered',799,?)").run(at);
  const pending = await attempt(() => gstAccounting.generateStatutoryPackage(db, scope, MAKER));
  assert.equal(pending.ok, false, "they are real supplies: they need an owner like any other");
  await assignSeptember(db);
  const { pkg, gstr1, gstr3b } = await fileSeptember(db);
  const verticals = Object.fromEntries(pkg.summary.notYetClassified.verticals.map((v) => [v.source, v]));
  assert.equal(pkg.summary.notYetClassified.count, 3);
  assert.deepEqual([verticals.relocation.orderValue, verticals.relocation.gst], [20000, 0]);
  assert.match(verticals.relocation.label, /not classified by the owner yet/);
  assert.deepEqual([verticals.vet.orderValue, verticals.vet.gst], [599, 0]);
  assert.match(verticals.vet.label, /Vet visit/);
  assert.deepEqual([verticals.food_order.orderValue, verticals.food_order.gst], [799, 0]);
  assert.match(verticals.food_order.label, /Food/);
  assert.equal(pkg.summary.serviceOutputTax, 0, "their tax behaviour is unchanged: 0 today");
  assert.equal(gstr1.summary.notYetClassified.count, 3);
  assert.deepEqual(gstr1.payload.b2cs, [], "not classified, so not fabricated into GSTR-1 lines");
  assert.equal(gstr3b.payload.sup_details.osup_det.txval, 0, "nor into 3.1(a) while they carry no tax");
});

test("G22: returns and the monthly close refuse while a completed service is unassigned; a closed month cannot be assigned", async () => {
  const { sqlite, db } = await filingWorld();
  await activeTerm(db, { service: "boarding", model: "commission_standard", share: 0.70 });
  booking(sqlite, "BK-STAY", { service: "boarding", provider: "PRV-HOST" });
  await complete(db, "BK-STAY");

  const pkg = await attempt(() => gstAccounting.generateStatutoryPackage(db, scope, MAKER));
  assert.equal(pkg.ok, false);
  assert.match(pkg.body, /Assign each service invoice and completed service to its legal entity and GST registration.*\(1 not assigned yet\)/);
  const view = await close.monthlyCloseView(db, { period: PERIOD, actorId: FINANCE });
  const item = view.checklist.find((entry) => entry.key === "service_supplies_assigned");
  assert.deepEqual([item.ok, item.value], [false, 1]);
  await statutory.recordBoardApproval(db, { period: PERIOD, approvedBy: "founder@pawspace.in", approverRole: "founder" });
  const refused = await attempt(() => close.closeMonth(db, { period: PERIOD, actorId: FINANCE }));
  assert.equal(refused.status, 409);
  assert.match(refused.body, /1 service invoice\(s\) or completed service\(s\) in 2026-09 are not assigned/);
  assert.match(refused.body, /A closed month can no longer be assigned/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_close_periods WHERE period_code=?").get(PERIOD).n, 0, "the month stays open, so it can still be fixed");

  // The completed booking has no invoice: the ownership screen lists it as a supply, and assigning it works.
  const listed = await supplies.serviceSupplyOwnershipSnapshot(db);
  assert.deepEqual(listed.map((row) => row.id), ["SUPPLY:booking:BK-STAY"]);
  await supplies.assignServiceSupplyOwnership(db, { supplyKey: "booking:BK-STAY", entityId: ENTITY, registrationId: REG, reason: "PawSpace India files Karnataka stays" }, FINANCE);
  const closed = await attempt(() => close.closeMonth(db, { period: PERIOD, actorId: FINANCE }));
  assert.equal(closed.ok, true, closed.body);
  assert.equal(sqlite.prepare("SELECT status FROM finance_close_periods WHERE period_code=?").get(PERIOD).status, "locked");
  const filed = await gstAccounting.generateStatutoryPackage(db, scope, MAKER);
  assert.equal(filed.summary.serviceOutputTax, 54, "the closed month's returns can still be prepared");

  // Anything completed into the closed month afterwards cannot be slipped in by assignment.
  const late = await attempt(() => supplies.assignPeriodServiceOwnership(db, { periodCode: PERIOD, entityId: ENTITY, registrationId: REG, reason: "Late assignment attempt" }, FINANCE));
  assert.equal(late.status, 409);
  assert.match(late.body, /closed and locked/);
});
