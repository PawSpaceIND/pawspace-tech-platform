/*
 * Input tax credit, part 2: reversals and reverse charge in the monthly ITC computation (round3/gst-law.md section 4).
 *
 * Driven through the REAL Finance routes and the real completion path (a grooming booking completed at 70/30 files 300 of
 * taxable turnover), the real funeral order register and the real GSTR-3B generator:
 *   - Rule 42: common credit of 10,000 with an exempt share of 5% (E 300 of F 6,000) reverses 500 in 4(B)(1), by head, posted to
 *     "Ineligible ITC As Per Rule 42". With the legal default for funeral (Schedule III, gst-law.md) E excludes funeral, so the
 *     same month reverses nothing;
 *   - Rule 37: a credited bill still unpaid 180 days after its invoice is reversed in 4(B)(2); paying the supplier re-claims it in
 *     4(A)(5) with the detail in 4(D)(1). The journals move it from input tax to expense and back;
 *   - Rule 37A: a supplier who has not filed GSTR-3B by 30 September after the year: reversed from that return, re-claimed once filed;
 *   - reverse charge: legal fees from an advocate are a 3.1(d) liability paid in cash and credited in the same month in 4(A)(3); a
 *     service bought from outside India is IGST in 4(A)(2); reverse-charge tax is never paid from the credit ledger.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__ITC_REVERSALS_DB__", "__ITC_REVERSALS_ENV__");
const control = await import("../app/api/finance-control/route.ts");
const gstRoute = await import("../app/api/gst-accounting/route.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const returns = await import("../lib/gst-returns.ts");
const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const supplies = await import("../lib/service-output-tax.ts");
const funeralOrders = await import("../lib/funeral-manual-order.ts");
const funeralSetting = await import("../lib/funeral-gst-treatment.ts");

const ENTITY = "pawspace_india", REG = "REG-KA", GSTIN = "29AAICT7352F1Z0";
const MAKER = "maker@pawspace.in", CHECKER = "checker@pawspace.in";
const LANDLORD = { id: "ven_landlord", gstin: "29AABCI1234K1ZM" }, SOFTWARE = { id: "ven_software", gstin: "29AACFB5678L1ZW" };
const ADVOCATE = { id: "ven_advocate", gstin: null }, GOOGLE_IE = { id: "ven_google_ie", gstin: null };
const scope = { entityId: ENTITY, registrationId: REG };

async function reversalWorld() {
  const { sqlite, db } = world("__ITC_REVERSALS_DB__", "__ITC_REVERSALS_ENV__", {});
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,currency TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,provider_model TEXT NOT NULL);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE payroll_runs (id TEXT PRIMARY KEY,period_start INTEGER,period_end INTEGER,status TEXT);
    CREATE TABLE employee_payroll_results (id TEXT PRIMARY KEY,run_id TEXT,employee_id TEXT,gross_earnings REAL);
    CREATE TABLE boarding_host_settlement_ledger (booking_id TEXT,provider_id TEXT,payout_amount REAL,eligible_at INTEGER);
  `);
  await seedActors(sqlite, db, [{ id: "U-MK", email: MAKER, role: "finance" }, { id: "U-CK", email: CHECKER, role: "finance" }]);
  await gstAccounting.ensureGstAccountingTables(db);
  await returns.ensureGstReturnTables(db);
  await control.GET(asActor(MAKER, "/api/finance-control"));
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,'active','founder',1,1,1)").run(ENTITY, "TK PETCARE SOLUTIONS PRIVATE LIMITED", "IN");
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'Karnataka','gstin',?,'active','2020-01-01',NULL,'founder',1,1,1)").run(REG, ENTITY, GSTIN);
  for (const vendor of [LANDLORD, SOFTWARE, ADVOCATE, GOOGLE_IE]) sqlite.prepare("INSERT INTO finance_vendors (id,name,gstin,pan,payment_terms_days,bank_reference,tds_section,status,created_at,updated_at) VALUES (?,?,?,NULL,30,NULL,NULL,'active',1,1)").run(vendor.id, `Vendor ${vendor.id}`, vendor.gstin);
  return { sqlite, db };
}
const json = async (response) => ({ status: response.status, body: await response.json() });
const createBill = (body) => control.POST(asActor(MAKER, "/api/finance-control", { method: "POST", body: JSON.stringify({ entity: "bill", entityId: ENTITY, ...body }) })).then(json);
function patchBill(sqlite, email, id, action, extra = {}) {
  const row = sqlite.prepare("SELECT updated_at FROM finance_bills WHERE id=?").get(id);
  return control.PATCH(asActor(email, "/api/finance-control", { method: "PATCH", headers: { "if-match": `"${row.updated_at}"` }, body: JSON.stringify({ entity: "bill", id, action, reason: "Checked against the supplier invoice", ...extra }) })).then(json);
}
const gst = (body) => gstRoute.POST(asActor(MAKER, "/api/gst-accounting", { method: "POST", body: JSON.stringify(body) })).then(json);
async function approvedBill(sqlite, body) {
  const created = await createBill(body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const approved = await patchBill(sqlite, CHECKER, created.body.data.id, "approve");
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return created.body.data.id;
}
const save = async (period, reason = `Input tax credit for ${period}`) => { const r = await gst({ action: "save_itc_computation", ...scope, periodCode: period, reason }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data; };
const confirm = (billId, claimPeriod) => gst({ action: "confirm_bill_itc", billId, claimPeriod, reason: `In GSTR-2B for ${claimPeriod}, checked on the portal` });
const journalFor = (sqlite, sourceType, sourceId) => Object.fromEntries(sqlite.prepare("SELECT account_code,ROUND(SUM(debit)-SUM(credit),2) net FROM finance_journal_entries WHERE source_type=? AND source_id=? GROUP BY account_code").all(sourceType, sourceId).filter((r) => r.net !== 0).map((r) => [r.account_code, r.net]));
const H = (igst, cgst, sgst, cess = 0) => ({ igst, cgst, sgst, cess });

async function julyTurnover(sqlite, db) {
  // Taxable: a grooming booking of Rs 1,000 at 70/30 (PawSpace makes 300) and a canonical B2B invoice of 5,400. Funeral: 300.
  const draft = await terms.saveCommercialTerm(db, { serviceCode: "grooming", engagementModel: "commission_groomer", providerSharePct: 0.7, effectiveFrom: "2026-01-01", reason: "grooming owner model terms", actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: "APR-grooming", actorId: CHECKER });
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','CUS-1','blr','blr-east','grooming','pkg','Package','PRV-G','2026-07-15T05:00:00.000Z','2026-07-15T06:00:00.000Z','completed',1000,'INR',1,1)").run();
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-1','BK-1','CUS-1',1000,1000,'INR','upi','prepaid','captured','razorpay','idem-1','{}',1,1)").run();
  assert.equal((await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-1", actorId: MAKER, completedAt: Date.parse("2026-07-15T12:00:00+05:30") })).gstLiability, 54);
  await funeralOrders.recordFuneralConvertedOrder(db, { customerName: "Asha", phone: "9000000000", paymentMethod: "upi", orderValue: 300, orderDate: "2026-07-20", actorId: MAKER });
  sqlite.prepare("INSERT INTO finance_invoices (id,invoice_number,entity_id,customer_id,source_type,source_id,source_event_key,policy_id,registration_id,issue_date,currency,subtotal,tax_total,total,status,tax_snapshot_json,created_by,created_at) VALUES ('fi-1','TKP/26-27/00001',?,'B2B-1','b2b','b2b-1','b2b-1','pol',?,'2026-07-25','INR',5400,0,5400,'issued','{}','finance',1)").run(ENTITY, REG);
  await supplies.assignPeriodServiceOwnership(db, { periodCode: "2026-07", ...scope, reason: "TK Petcare files every Karnataka supply" }, MAKER);
}
// Finance's funeral GST setting (package A): the CA's "exempt" decision, from the start of the financial year.
const setFuneralTreatment = (db, treatment) => funeralSetting.saveFuneralGstTreatment(db, { treatment, effectiveFrom: "2026-04-01", reason: "CA decided funeral is an exempt supply", actorId: MAKER });

test("Rule 42: common credit of 10,000 with an exempt share of 5% reverses 500 in 4(B)(1), by head; under the Schedule III default nothing is reversed", async () => {
  const { sqlite, db } = await reversalWorld();
  await julyTurnover(sqlite, db);
  await setFuneralTreatment(db, "exempt");
  const common = { dueDate: "2026-08-10", placeOfSupply: "29", itcTreatment: "common_rule_42", itcOverrideReason: "Also used for the exempt funeral service" };
  const rent = await approvedBill(sqlite, { ...common, vendorId: LANDLORD.id, billNumber: "RENT-7", billDate: "2026-07-01", categoryCode: "EXP-OFF-RENT", taxableAmount: 27800, cgstAmount: 2500, sgstAmount: 2500, totalAmount: 32800 });
  const software = await approvedBill(sqlite, { ...common, vendorId: SOFTWARE.id, billNumber: "SW-7", billDate: "2026-07-02", categoryCode: "EXP-SOFTWARE", taxableAmount: 27800, cgstAmount: 2500, sgstAmount: 2500, totalAmount: 32800 });
  for (const billId of [rent, software]) assert.equal((await confirm(billId, "2026-07")).status, 200);

  const july = await save("2026-07");
  const r42 = july.figures.rule42;
  assert.deepEqual(r42.commonCredit, H(0, 5000, 5000), "C2 = 10,000");
  assert.deepEqual([r42.exemptTurnover, r42.totalTurnover, r42.ratio], [300, 6000, 0.05], "E = 300 (funeral, exempt), F = 300 commission + 5,400 invoice + 300 funeral");
  assert.deepEqual(r42.d1, H(0, 250, 250), "D1 = C2 x E / F = 500");
  assert.deepEqual(r42.d2, H(0, 0, 0), "D2 only when common inputs are also used for non-business purposes");
  assert.deepEqual(r42.c3_retained, H(0, 4750, 4750));
  assert.deepEqual(july.figures.table4.b1_rules42_43_s17_5, H(0, 250, 250), "reported in 4(B)(1)");
  assert.deepEqual(july.figures.netItc, H(0, 4750, 4750));
  assert.deepEqual(journalFor(sqlite, "itc_computation", `${ENTITY}:${REG}:2026-07`), { "6130-Rates and Taxes (2)": 500, "1180-Input CGST": -250, "1181-Input SGST": -250 }, "moved from input tax to the Rule 42 expense");

  await setFuneralTreatment(db, "schedule_iii");
  const summary = (await json(await gstRoute.GET(asActor(MAKER, `/api/gst-accounting?view=itc_summary&entityId=${ENTITY}&registrationId=${REG}&period=2026-07`)))).body.data;
  assert.equal(summary.live.rule42.funeralGstTreatment, "schedule_iii");
  assert.deepEqual([summary.live.rule42.exemptTurnover, summary.live.rule42.totalTurnover], [0, 5700], "Schedule III: funeral is in neither E nor F (Explanation to section 17(3))");
  assert.deepEqual(summary.live.rule42.reversal, H(0, 0, 0));
  assert.equal(summary.savedIsCurrent, false, "the saved computation no longer matches: save it again before paying");
  const resaved = await save("2026-07", "Funeral treated as Schedule III on the CA's advice");
  assert.equal(resaved.version, 2);
  assert.deepEqual(journalFor(sqlite, "itc_computation", `${ENTITY}:${REG}:2026-07`), {}, "version 2 posts only the difference: the 500 is reversed back into input tax");
});

test("Rule 37: a credited bill unpaid 180 days after its invoice is reversed in 4(B)(2); paying the supplier re-claims it in 4(A)(5) and 4(D)(1)", async () => {
  const { sqlite } = await reversalWorld();
  const bill = { dueDate: "2026-02-10", vendorId: SOFTWARE.id, categoryCode: "EXP-OFF-INTERNET", placeOfSupply: "29", taxableAmount: 10000, cgstAmount: 900, sgstAmount: 900, totalAmount: 11800 };
  const late = await approvedBill(sqlite, { ...bill, billNumber: "NET-1", billDate: "2026-01-10" });
  const onTime = await approvedBill(sqlite, { ...bill, billNumber: "NET-2", billDate: "2026-01-12" });
  for (const billId of [late, onTime]) assert.equal((await confirm(billId, "2026-01")).status, 200);
  assert.equal((await patchBill(sqlite, MAKER, onTime, "pay", { paidOn: "2026-03-01" })).status, 200, "paid within 180 days");
  const january = await save("2026-01");
  assert.deepEqual(january.figures.netItc, H(0, 1800, 1800));

  const july = await save("2026-07");
  assert.deepEqual(july.figures.rule37.reversals.map((r) => [r.billId, r.rule, r.dueBy]), [[late, "rule37", "2026-07-09"]], "only the bill unpaid after 180 days");
  assert.deepEqual(july.figures.table4.b2_others, H(0, 900, 900), "4(B)(2)");
  assert.deepEqual(journalFor(sqlite, "itc_computation", `${ENTITY}:${REG}:2026-07`), { "6090-Office and Administration (2)": 1800, "1180-Input CGST": -900, "1181-Input SGST": -900 }, "moved from input tax to the bill's expense");
  assert.equal(sqlite.prepare("SELECT rule37_reversed_period p FROM finance_bills WHERE id=?").get(late).p, "2026-07");

  assert.equal((await patchBill(sqlite, MAKER, late, "pay", { paidOn: "2026-08-05" })).status, 200);
  const august = await save("2026-08");
  assert.deepEqual(august.figures.rule37.reclaims.map((r) => [r.billId, r.reversedIn]), [[late, "2026-07"]]);
  assert.deepEqual(august.figures.table4.a5_allOther, H(0, 900, 900), "re-claimed in 4(A)(5)");
  assert.deepEqual(august.figures.table4.d1_reclaimed, H(0, 900, 900), "with the detail in 4(D)(1)");
  assert.deepEqual(journalFor(sqlite, "itc_computation", `${ENTITY}:${REG}:2026-08`), { "1180-Input CGST": 900, "1181-Input SGST": 900, "6090-Office and Administration (2)": -1800 }, "and back into input tax");
  const earlier = await gst({ action: "save_itc_computation", ...scope, periodCode: "2026-07", reason: "Try to change July after August" });
  assert.equal(earlier.status, 409, "a month before a saved month can no longer change");
});

test("Rule 37A: credit on a bill whose supplier has not filed GSTR-3B is reversed from the September after the year and re-claimed once filed", async () => {
  const { sqlite } = await reversalWorld();
  const billId = await approvedBill(sqlite, { dueDate: "2024-07-10", vendorId: SOFTWARE.id, billNumber: "SW-24", billDate: "2024-06-10", categoryCode: "EXP-SOFTWARE", placeOfSupply: "29", taxableAmount: 10000, cgstAmount: 900, sgstAmount: 900, totalAmount: 11800 });
  assert.equal((await confirm(billId, "2024-06")).status, 200);
  assert.equal((await patchBill(sqlite, MAKER, billId, "pay", { paidOn: "2024-07-01" })).status, 200, "paid on time: Rule 37 does not apply");
  await save("2024-06");
  const flagged = await gst({ action: "mark_supplier_gstr3b", billId, filed: false, checkedOn: "2025-10-01", reason: "Supplier's GSTR-3B for June 2024 not filed as of 30 Sept 2025" });
  assert.equal(flagged.status, 200, JSON.stringify(flagged.body));
  const october = await save("2025-10");
  assert.deepEqual(october.figures.rule37.reversals.map((r) => [r.billId, r.rule]), [[billId, "rule37a"]]);
  assert.deepEqual(october.figures.table4.b2_others, H(0, 900, 900), "reversed in 4(B)(2)");
  const filed = await gst({ action: "mark_supplier_gstr3b", billId, filed: true, checkedOn: "2025-11-15", reason: "Supplier filed its June 2024 GSTR-3B" });
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  const november = await save("2025-11");
  assert.deepEqual(november.figures.rule37.reclaims.map((r) => [r.billId, r.rule, r.reversedIn]), [[billId, "rule37a", "2025-10"]]);
  assert.deepEqual(november.figures.table4.d1_reclaimed, H(0, 900, 900));
  const audit = sqlite.prepare("SELECT action FROM gst_accounting_audit_events WHERE entity_id=? ORDER BY created_at").all(billId).map((r) => r.action);
  assert.deepEqual(audit.filter((a) => a.startsWith("supplier_gstr3b")), ["supplier_gstr3b_not_filed", "supplier_gstr3b_filed"]);
});

test("reverse charge: an advocate's fees are paid in cash and credited in the same month (3.1(d), 4(A)(3)); an import of services is IGST in 4(A)(2)", async () => {
  const { sqlite, db } = await reversalWorld();
  const legal = await approvedBill(sqlite, { dueDate: "2026-07-30", vendorId: ADVOCATE.id, billNumber: "ADV-3", billDate: "2026-07-05", categoryCode: "EXP-OTHER-INHOUSE-LEGAL", supplierType: "unregistered", supplierStateCode: "29", placeOfSupply: "29", reverseCharge: true, taxableAmount: 10000, cgstAmount: 900, sgstAmount: 900, totalAmount: 10000 });
  const journal = journalFor(sqlite, "vendor_bill", legal);
  assert.deepEqual(journal, { "6110-Other Inhouse Exp (2)": 10000, "1180-Input CGST": 900, "1181-Input SGST": 900, "2200-Accounts payable": -10000, "2135-GST Payable (reverse charge)": -1800 }, "the supplier is owed 10,000; PawSpace owes the 1,800 GST");
  assert.equal((await patchBill(sqlite, MAKER, legal, "pay", { paidOn: "2026-07-20" })).status, 200, "paid in July: its time of supply (section 13(3))");
  const ads = await approvedBill(sqlite, { dueDate: "2026-06-15", vendorId: GOOGLE_IE.id, billNumber: "IE-5501", billDate: "2026-05-15", categoryCode: "EXP-MKT-GOOGLE", supplierType: "overseas", placeOfSupply: "29", reverseCharge: true, taxableAmount: 10000, igstAmount: 1800, totalAmount: 10000 });
  const importNoRcm = await createBill({ dueDate: "2026-06-15", vendorId: GOOGLE_IE.id, billNumber: "IE-5502", billDate: "2026-05-15", categoryCode: "EXP-MKT-GOOGLE", supplierType: "overseas", placeOfSupply: "29", taxableAmount: 10000, igstAmount: 1800, totalAmount: 11800 });
  assert.equal(importNoRcm.status, 400, "a service from outside India is under reverse charge");

  const july = await save("2026-07");
  assert.deepEqual(july.figures.reverseCharge.liability, H(1800, 900, 900), "unpaid, the import falls due on the 61st day after its invoice: July");
  assert.deepEqual(july.figures.table4.a3_reverseCharge, H(0, 900, 900), "4(A)(3)");
  assert.deepEqual(july.figures.table4.a2_importOfServices, H(1800, 0, 0), "4(A)(2)");
  assert.deepEqual(july.figures.netItc, H(1800, 900, 900));
  assert.deepEqual(july.figures.credited.map((b) => b.billId).sort(), [ads, legal].sort());

  const gstr3b = await returns.generateGstr3b(db, { ...scope, periodCode: "2026-07" }, MAKER);
  assert.deepEqual(gstr3b.payload.sup_details.isup_rev, { txval: 20000, iamt: 1800, camt: 900, samt: 900, csamt: 0 }, "3.1(d)");
  assert.deepEqual(gstr3b.payload.itc_elg.itc_avl.find((r) => r.ty === "IMPS"), { ty: "IMPS", iamt: 1800, camt: 0, samt: 0, csamt: 0 });
  assert.deepEqual(gstr3b.payload.itc_elg.itc_avl.find((r) => r.ty === "ISRC"), { ty: "ISRC", iamt: 0, camt: 900, samt: 900, csamt: 0 });
  assert.deepEqual(gstr3b.summary.setOff.cashReverseCharge, H(1800, 900, 900), "reverse-charge tax is paid in cash");
  assert.deepEqual(gstr3b.summary.setOff.creditUsed, H(0, 0, 0), "never from the credit ledger");
  assert.deepEqual(gstr3b.summary.setOff.creditCarriedForward, H(1800, 900, 900), "the credit is carried forward for output tax");
  const rcmRow = gstr3b.payload.tx_pmt.tx_py.find((r) => r.trans_desc === "Reverse charge");
  assert.deepEqual([rcmRow.igst.tx, rcmRow.cgst.tx, rcmRow.sgst.tx], [1800, 900, 900], "Table 6.1 reverse-charge row");
});
