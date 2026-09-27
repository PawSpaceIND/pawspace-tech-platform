/*
 * GST payment and set-off (section 49(5), section 49A, Rule 88A; round3/gst-law.md section 4) and GSTR-3B Table 6.1.
 *
 *   - Rule 88A: IGST credit is used first and in full, against IGST and then CGST and SGST in the split that leaves the least
 *     cash; CGST credit pays CGST then IGST; SGST credit pays SGST then IGST, only after CGST credit; CGST never pays SGST.
 *   - A real month end to end (a Rs 1,000 grooming booking at 70/30 files CGST 27 + SGST 27; Google India bills IGST 40 to the
 *     Karnataka registration): the IGST credit is split across CGST and SGST (20 + 20), 7 + 7 is paid in cash, and one balanced
 *     journal debits 2130 with 54, credits 1182 with 40 and the bank with 14. Table 6.1 of the GSTR-3B shows the same set-off.
 *   - Paying more than is owed, a date in the future, a month whose ITC computation is not saved, and a draft older than the
 *     computation are refused; the challan is recorded once; the older "Record tax paid" form cannot pay the month again.
 *   - Paid after the 20th of the next month: 18% a year on the cash for the days late, and the section 47 late fee.
 *   - A month whose net ITC is negative (a Rule 37 reversal) adds it to the liability and the journal never touches 2130 for it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__GST_SETOFF_DB__", "__GST_SETOFF_ENV__");
const control = await import("../app/api/finance-control/route.ts");
const gstRoute = await import("../app/api/gst-accounting/route.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const returns = await import("../lib/gst-returns.ts");
const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const supplies = await import("../lib/service-output-tax.ts");
const setoff = await import("../lib/gst-setoff.ts");
const taxPayments = await import("../lib/gst-tax-payments.ts");

const ENTITY = "pawspace_india", REG = "REG-KA", GSTIN = "29AAICT7352F1Z0";
const MAKER = "maker@pawspace.in", CHECKER = "checker@pawspace.in";
const GOOGLE_IN = { id: "ven_google", gstin: "06AACCG0527D1Z8" }; // Google India, Haryana: IGST to a Karnataka bill-to
const SOFTWARE = { id: "ven_software", gstin: "29AACFB5678L1ZW" };
const scope = { entityId: ENTITY, registrationId: REG };
const H = (igst, cgst, sgst, cess = 0) => ({ igst, cgst, sgst, cess });
const CPIN = "26072900012345";

test("Rule 88A: IGST credit is used first and in full, split across CGST and SGST to leave the least cash", () => {
  const split = setoff.rule88aSetOff(H(0, 500, 500), H(600, 400, 0));
  assert.deepEqual(split.used, { igst_igst: 0, igst_cgst: 100, igst_sgst: 500, cgst_cgst: 400, cgst_igst: 0, sgst_sgst: 0, sgst_igst: 0, cess_cess: 0 }, "IGST covers what CGST and SGST credit cannot");
  assert.deepEqual(split.cash, H(0, 0, 0), "no cash: IGST 'CGST first, then SGST' would have left 400 of SGST in cash");
  const first = setoff.rule88aSetOff(H(0, 300, 300), H(200, 300, 300));
  assert.deepEqual([first.used.igst_cgst, first.used.igst_sgst, first.used.cgst_cgst, first.used.sgst_sgst], [100, 100, 200, 200], "IGST credit is exhausted before any CGST or SGST credit is used");
  assert.deepEqual(first.creditLeft, H(0, 100, 100));
  const never = setoff.rule88aSetOff(H(0, 0, 500), H(0, 500, 0));
  assert.deepEqual([never.cash.sgst, never.creditLeft.cgst], [500, 500], "CGST credit never pays SGST");
  const igstLiability = setoff.rule88aSetOff(H(1000, 0, 0), H(200, 500, 500));
  assert.deepEqual([igstLiability.used.igst_igst, igstLiability.used.cgst_igst, igstLiability.used.sgst_igst], [200, 500, 300], "IGST liability: IGST credit, then CGST credit, then SGST credit");
  assert.deepEqual(igstLiability.cash, H(0, 0, 0));
  assert.deepEqual(setoff.rule88aSetOff(H(0, 0, 0, 100), H(100, 100, 100, 40)).cash, H(0, 0, 0, 60), "cess is paid only by cess credit");
  const paise = setoff.rule88aSetOff(H(0.1, 0.2, 0.3), H(0.3, 0, 0));
  assert.deepEqual(paise.cash, H(0, 0.12, 0.18), "worked in paise: the 0.20 of IGST credit left is shared in proportion to the shortfalls (0.20 : 0.30), with no floating-point drift");
});

async function setoffWorld() {
  const { sqlite, db } = world("__GST_SETOFF_DB__", "__GST_SETOFF_ENV__", {});
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
  for (const vendor of [GOOGLE_IN, SOFTWARE]) sqlite.prepare("INSERT INTO finance_vendors (id,name,gstin,pan,payment_terms_days,bank_reference,tds_section,status,created_at,updated_at) VALUES (?,?,?,NULL,30,NULL,NULL,'active',1,1)").run(vendor.id, `Vendor ${vendor.id}`, vendor.gstin);
  return { sqlite, db };
}
const json = async (response) => ({ status: response.status, body: await response.json() });
function patchBill(sqlite, email, id, action, extra = {}) {
  const row = sqlite.prepare("SELECT updated_at FROM finance_bills WHERE id=?").get(id);
  return control.PATCH(asActor(email, "/api/finance-control", { method: "PATCH", headers: { "if-match": `"${row.updated_at}"` }, body: JSON.stringify({ entity: "bill", id, action, reason: "Checked against the supplier invoice", ...extra }) })).then(json);
}
const gst = (body) => gstRoute.POST(asActor(MAKER, "/api/gst-accounting", { method: "POST", body: JSON.stringify(body) })).then(json);
const setoffView = (period, paidOn) => gstRoute.GET(asActor(MAKER, `/api/gst-accounting?view=gst_setoff&entityId=${ENTITY}&registrationId=${REG}&period=${period}${paidOn ? `&paidOn=${paidOn}` : ""}`)).then(json);
async function approvedBill(sqlite, body) {
  const created = await json(await control.POST(asActor(MAKER, "/api/finance-control", { method: "POST", body: JSON.stringify({ entity: "bill", entityId: ENTITY, ...body }) })));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await patchBill(sqlite, CHECKER, created.body.data.id, "approve")).status, 200);
  return created.body.data.id;
}
async function julyMonth(sqlite, db) {
  const draft = await terms.saveCommercialTerm(db, { serviceCode: "grooming", engagementModel: "commission_groomer", providerSharePct: 0.7, effectiveFrom: "2026-01-01", reason: "grooming owner model terms", actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: "APR-grooming", actorId: CHECKER });
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','CUS-1','blr','blr-east','grooming','pkg','Package','PRV-G','2026-07-15T05:00:00.000Z','2026-07-15T06:00:00.000Z','completed',1000,'INR',1,1)").run();
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-1','BK-1','CUS-1',1000,1000,'INR','upi','prepaid','captured','razorpay','idem-1','{}',1,1)").run();
  assert.equal((await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-1", actorId: MAKER, completedAt: Date.parse("2026-07-15T12:00:00+05:30") })).gstLiability, 54);
  await supplies.assignPeriodServiceOwnership(db, { periodCode: "2026-07", ...scope, reason: "TK Petcare files every Karnataka supply" }, MAKER);
  const ads = await approvedBill(sqlite, { dueDate: "2026-08-10", vendorId: GOOGLE_IN.id, billNumber: "GIN-7788", billDate: "2026-07-31", categoryCode: "EXP-MKT-GOOGLE", placeOfSupply: "29", sacCode: "998365", taxableAmount: 222.22, igstAmount: 40, totalAmount: 262.22 });
  assert.equal((await gst({ action: "confirm_bill_itc", billId: ads, claimPeriod: "2026-07", reason: "In GSTR-2B for July, checked on the portal" })).status, 200);
  return ads;
}
const account = (sqlite, code) => sqlite.prepare("SELECT ROUND(COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0),2) net FROM finance_journal_entries WHERE account_code=?").get(code).net;

test("a month end to end: the IGST credit is split across CGST and SGST, the rest is paid in cash, one balanced journal, and Table 6.1 agrees", async () => {
  const { sqlite, db } = await setoffWorld();
  await julyMonth(sqlite, db);
  const pay = (body) => gst({ action: "record_gst_setoff_payment", ...scope, periodCode: "2026-07", challanReference: CPIN, paidOn: "2026-08-18", cash: { cgst: 7, sgst: 7 }, reason: "July GSTR-3B paid on the portal", ...body });

  const unsaved = await pay({});
  assert.equal(unsaved.status, 409, "refused before the month's ITC computation is saved");
  assert.match(unsaved.body.error, /Save the input tax credit computation for 2026-07 first/);
  const saved = await gst({ action: "save_itc_computation", ...scope, periodCode: "2026-07", reason: "July input tax credit" });
  assert.deepEqual(saved.body.data.figures.netItc, H(40, 0, 0));
  const noDraft = await pay({});
  assert.equal(noDraft.status, 409);
  assert.match(noDraft.body.error, /Generate the GSTR-3B draft for 2026-07/);

  const gstr3b = await returns.generateGstr3b(db, { ...scope, periodCode: "2026-07" }, MAKER);
  assert.deepEqual(gstr3b.payload.sup_details.osup_det, { txval: 300, iamt: 0, camt: 27, samt: 27, csamt: 0 }, "the output tax is the draft's own 3.1(a)");
  assert.deepEqual(gstr3b.payload.tx_pmt.pditc, { i_pdi: 0, i_pdc: 0, i_pds: 0, c_pdi: 20, c_pdc: 0, s_pdi: 20, s_pds: 0, cs_pdcs: 0 }, "Table 6.1: IGST credit pays 20 of CGST and 20 of SGST");
  assert.deepEqual([gstr3b.payload.tx_pmt.pdcash[0].cpd, gstr3b.payload.tx_pmt.pdcash[0].spd, gstr3b.payload.tx_pmt.pdcash[0].ipd], [7, 7, 0], "and 7 + 7 in cash");
  assert.equal(gstr3b.summary.netTaxPayable, 14, "the cash to pay");
  assert.equal(gstr3b.summary.eligibleInputTax, 40);

  const view = await setoffView("2026-07", "2026-08-18");
  assert.equal(view.body.data.ready, true, JSON.stringify(view.body.data.blockers));
  assert.deepEqual(view.body.data.remainingCash, H(0, 7, 7));
  assert.equal(view.body.data.dueDate, "2026-08-20");
  assert.deepEqual(view.body.data.charges.interestDue, H(0, 0, 0), "paid before the due date");

  const more = await pay({ cash: { cgst: 8, sgst: 7 } });
  assert.equal(more.status, 409);
  assert.match(more.body.error, /CGST cash of 8 is more than the 7 still owed/);
  const future = await pay({ paidOn: "2099-01-01" });
  assert.equal(future.status, 400, "a payment date in the future is refused");
  const badChallan = await pay({ challanReference: "CPIN-1" });
  assert.equal(badChallan.status, 400, "cash needs the 14-digit CPIN");

  const paid = await pay({});
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.deepEqual(paid.body.data.creditUsedByHead, H(40, 0, 0));
  assert.deepEqual(paid.body.data.journal, [
    { account: "1010-Bank", debit: 0, credit: 14 },
    { account: "1182-Input IGST", debit: 0, credit: 40 },
    { account: "2130-GST Payable", debit: 54, credit: 0 },
  ], "Dr GST payable 54; Cr input IGST 40 and the bank 14");
  const rows = sqlite.prepare("SELECT ROUND(SUM(debit),2) d,ROUND(SUM(credit),2) c FROM finance_journal_entries WHERE source_type='gst_setoff_payment'").get();
  assert.equal(rows.d, rows.c, "the payment journal balances");
  assert.equal(account(sqlite, "2130-GST Payable"), 0, "the month's output GST is settled");
  assert.equal(account(sqlite, "1182-Input IGST"), 0, "the IGST credit is used");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM gst_accounting_audit_events WHERE entity_type='gst_setoff_payment'").get().n, 1, "audited");

  const payable = await taxPayments.taxPayableReconciliation(db, { periodCode: "2026-07" });
  assert.deepEqual([payable.gst.settledThroughSetoffForPeriod, payable.gst.unpaidForPeriod], [54, 0], "the GST payable screen sees the month as settled (the journal itself is dated in August, when it was paid)");
  const itc = await import("../lib/gst-input-tax.ts");
  assert.deepEqual(await itc.netItcForPeriods(db, { ...scope, fromPeriod: "2026-04", toPeriod: "2027-03" }), { netItc: H(40, 0, 0), total: 40, monthsSaved: ["2026-07"] }, "the saved net ITC the other reports can read");
  assert.equal((await pay({})).body.data.duplicatePrevented, true, "the same challan is recorded once");
  const again = await pay({ challanReference: "26072900099999" });
  assert.equal(again.status, 409, "nothing is left to pay");
  const oldForm = await taxPayments.recordTaxPayment(db, { taxKind: "gst", periodCode: "2026-07", amount: 14, challanReference: "OLD-CHALLAN-1", paidOn: "2026-08-19", reason: "Paid July GST again" }, MAKER).then(() => null, (error) => error);
  assert.equal(oldForm?.status, 409, "the older Record tax paid form cannot pay the month a second time");
  const frozen = await gst({ action: "save_itc_computation", ...scope, periodCode: "2026-07", reason: "Change July after paying" });
  assert.equal(frozen.status, 409, "a paid month's ITC is final");
});

test("paid after the due date: 18% a year on the cash for the days late, and the section 47 late fee; more than is due is refused", async () => {
  const { sqlite, db } = await setoffWorld();
  await julyMonth(sqlite, db);
  await gst({ action: "save_itc_computation", ...scope, periodCode: "2026-07", reason: "July input tax credit" });
  await returns.generateGstr3b(db, { ...scope, periodCode: "2026-07" }, MAKER);
  const view = await setoffView("2026-07", "2026-09-19");
  const charges = view.body.data.charges;
  assert.equal(charges.daysLate, 30);
  assert.deepEqual(charges.lateInterest, H(0, 0.1, 0.1), "7 x 18% x 30 / 365 = 0.10 on each head");
  assert.deepEqual(charges.lateFee, H(0, 750, 750), "Rs 25 + Rs 25 a day before the turnover cap");
  const tooMuch = await gst({ action: "record_gst_setoff_payment", ...scope, periodCode: "2026-07", challanReference: CPIN, paidOn: "2026-09-19", cash: { cgst: 7, sgst: 7 }, interest: { cgst: 5 }, reason: "July GSTR-3B paid late" });
  assert.equal(tooMuch.status, 409);
  assert.match(tooMuch.body.error, /interest of 5 is more than the 0\.1 due/);
  const paid = await gst({ action: "record_gst_setoff_payment", ...scope, periodCode: "2026-07", challanReference: CPIN, paidOn: "2026-09-19", cash: { cgst: 7, sgst: 7 }, interest: { cgst: 0.1, sgst: 0.1 }, lateFee: { cgst: 750, sgst: 750 }, reason: "July GSTR-3B paid late with interest and late fee" });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.data.totalPaid, 1514.2);
  assert.equal(account(sqlite, "6130-Rates and Taxes (3)"), 1500.2, "interest and late fee go to Interest/Late Fee on GST");
  assert.equal(account(sqlite, "1010-Bank"), -1514.2);
});

test("a month whose net ITC is negative (a Rule 37 reversal) adds it to the liability; the credit carried in pays it and 2130 is untouched", async () => {
  const { sqlite, db } = await setoffWorld();
  const bill = await approvedBill(sqlite, { dueDate: "2026-02-10", vendorId: SOFTWARE.id, billNumber: "NET-1", billDate: "2026-01-10", categoryCode: "EXP-OFF-INTERNET", placeOfSupply: "29", taxableAmount: 10000, cgstAmount: 900, sgstAmount: 900, totalAmount: 11800 });
  await gst({ action: "confirm_bill_itc", billId: bill, claimPeriod: "2026-01", reason: "In GSTR-2B for January, checked on the portal" });
  await gst({ action: "save_itc_computation", ...scope, periodCode: "2026-01", reason: "January input tax credit" });
  await returns.generateGstr3b(db, { ...scope, periodCode: "2026-01" }, MAKER);
  sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES ('2026-03','locked','[]',1,'finance',1)").run();
  const lockedDate = await gst({ action: "record_gst_setoff_payment", ...scope, periodCode: "2026-01", challanReference: "AA290126000001X", paidOn: "2026-03-02", reason: "January GSTR-3B filed, nothing to pay" });
  assert.equal(lockedDate.status, 409, "even a nil return is not recorded with a date in a locked month");
  const january = await gst({ action: "record_gst_setoff_payment", ...scope, periodCode: "2026-01", challanReference: "AA290126000001X", paidOn: "2026-02-18", reason: "January GSTR-3B filed, nothing to pay" });
  assert.equal(january.status, 200, JSON.stringify(january.body));
  assert.deepEqual(january.body.data.journal, [], "a nil return: nothing to post, the month is marked filed");

  const july = await gst({ action: "save_itc_computation", ...scope, periodCode: "2026-07", reason: "July input tax credit" });
  assert.deepEqual(july.body.data.figures.netItc, H(0, -900, -900), "the Rule 37 reversal makes the net ITC negative");
  const gstr3b = await returns.generateGstr3b(db, { ...scope, periodCode: "2026-07" }, MAKER);
  assert.deepEqual(gstr3b.summary.setOff.negativeItcAddedToLiability, H(0, 900, 900));
  assert.deepEqual(gstr3b.summary.setOff.openingCredit, H(0, 900, 900), "January's unused credit is carried in");
  assert.deepEqual(gstr3b.summary.setOff.cashDue, H(0, 0, 0));
  const paid = await gst({ action: "record_gst_setoff_payment", ...scope, periodCode: "2026-07", challanReference: "AA290726000001X", paidOn: "2026-08-18", reason: "July GSTR-3B filed against carried credit" });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.deepEqual(paid.body.data.journal, [], "the reversal journal already took the credit out of 1180 / 1181");
  assert.equal(account(sqlite, "2130-GST Payable"), 0);
  assert.deepEqual([account(sqlite, "1180-Input CGST"), account(sqlite, "1181-Input SGST")], [0, 0]);
});
