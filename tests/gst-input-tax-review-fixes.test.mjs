/*
 * Input tax credit review fixes (round 3): re-importing the same GSTR-2B matches what Finance has fixed since; credit that can
 * never be taken (section 16(4)) is expensed, not left as input tax; the statutory package, monthly close and GSTR-9C use a
 * month's saved ITC computation (what GSTR-3B files); and the sample vendors carry valid GSTINs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__ITC_FIXES_DB__", "__ITC_FIXES_ENV__");
const control = await import("../app/api/finance-control/route.ts");
const gstRoute = await import("../app/api/gst-accounting/route.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const returns = await import("../lib/gst-returns.ts");
const inputTax = await import("../lib/gst-input-tax.ts");
const closeout = await import("../lib/finance-filing-closeout.ts");
const monthlyClose = await import("../lib/finance-monthly-close.ts");

const ENTITY = "pawspace_india", REG = "REG-KA", GSTIN = "29AAICT7352F1Z0"; // TK Petcare, Karnataka
const MAKER = "maker@pawspace.in", CHECKER = "checker@pawspace.in", ASSOCIATE = "associate@pawspace.in";
const NET = { id: "ven_net", gstin: "29AABCI1234K1ZM" }; // Karnataka internet provider
const GARAGE = { id: "ven_garage", gstin: "29AACFB5678L1ZW" }; // Karnataka garage
const MUMBAI = { id: "ven_mumbai", gstin: "27AAACF9999M1ZM" }; // Maharashtra consultant
const OTHER = { id: "ven_other", gstin: "29AADCS4321P1ZY" };
const PERIOD = "2026-07";

async function itcWorld() {
  const { sqlite, db } = world("__ITC_FIXES_DB__", "__ITC_FIXES_ENV__", {});
  await seedActors(sqlite, db, [{ id: "U-MK", email: MAKER, role: "finance" }, { id: "U-CK", email: CHECKER, role: "finance" }, { id: "U-AS", email: ASSOCIATE, role: "associate" }]);
  await gstAccounting.ensureGstAccountingTables(db);
  await returns.ensureGstReturnTables(db);
  await control.GET(asActor(MAKER, "/api/finance-control")); // provisions the finance-control tables the way the screen does
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,'active','founder',1,1,1)").run(ENTITY, "TK PETCARE SOLUTIONS PRIVATE LIMITED", "IN");
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'Karnataka','gstin',?,'active','2020-01-01',NULL,'founder',1,1,1)").run(REG, ENTITY, GSTIN);
  for (const vendor of [NET, GARAGE, MUMBAI, OTHER]) sqlite.prepare("INSERT INTO finance_vendors (id,name,gstin,pan,payment_terms_days,bank_reference,tds_section,status,created_at,updated_at) VALUES (?,?,?,NULL,30,NULL,NULL,'active',1,1)").run(vendor.id, `Vendor ${vendor.id}`, vendor.gstin);
  return { sqlite, db };
}
const json = async (response) => ({ status: response.status, body: await response.json() });
const createBill = (email, body) => control.POST(asActor(email, "/api/finance-control", { method: "POST", body: JSON.stringify({ entity: "bill", entityId: ENTITY, dueDate: "2026-08-10", ...body }) })).then(json);
function patchBill(sqlite, email, id, action, extra = {}) {
  const row = sqlite.prepare("SELECT updated_at FROM finance_bills WHERE id=?").get(id);
  return control.PATCH(asActor(email, "/api/finance-control", { method: "PATCH", headers: { "if-match": `"${row.updated_at}"` }, body: JSON.stringify({ entity: "bill", id, action, reason: "Checked against the supplier invoice", ...extra }) })).then(json);
}
const gst = (email, body) => gstRoute.POST(asActor(email, "/api/gst-accounting", { method: "POST", body: JSON.stringify(body) })).then(json);
const balanced = (sqlite) => { const r = sqlite.prepare("SELECT ROUND(SUM(debit),2) d,ROUND(SUM(credit),2) c FROM finance_journal_entries").get(); return r.d === r.c; };
function gstr2b(period, invoices) {
  const [y, m] = period.split("-"), bySupplier = new Map();
  for (const { ctin, ...inv } of invoices) bySupplier.set(ctin, [...(bySupplier.get(ctin) ?? []), { typ: "R", rev: "N", itcavl: "Y", pos: "29", val: inv.txval + inv.igst + inv.cgst + inv.sgst, cess: 0, ...inv }]);
  return { data: { gstin: GSTIN, rtnprd: `${m}${y}`, version: "1.0", gendt: "14-08-2026", docdata: { b2b: [...bySupplier].map(([ctin, inv]) => ({ ctin, trdnm: `Supplier ${ctin}`, supprd: `${m}${y}`, inv })) } } };
}
const scope = { entityId: ENTITY, registrationId: REG };
const internetBill = { vendorId: NET.id, billNumber: "INV-001", billDate: "2026-07-10", taxableAmount: 10000, gstAmount: 1800, totalAmount: 11800, categoryCode: "EXP-OFF-INTERNET", placeOfSupply: "29", sacCode: "998422", cgstAmount: 900, sgstAmount: 900 };

const net = (sqlite, account) => sqlite.prepare("SELECT ROUND(COALESCE(SUM(debit)-SUM(credit),0),2) n FROM finance_journal_entries WHERE account_code=?").get(account).n;
async function approvedInternetBill(sqlite, overrides = {}) {
  const created = await createBill(MAKER, { ...internetBill, ...overrides });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const approved = await patchBill(sqlite, CHECKER, created.body.data.id, "approve");
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return created.body.data.id;
}

test("re-importing the same GSTR-2B after the bill is booked matches it, without a second import", async () => {
  const { sqlite } = await itcWorld();
  const file = gstr2b(PERIOD, [{ ctin: NET.gstin, inum: "inv001", dt: "10-07-2026", txval: 10000, igst: 0, cgst: 900, sgst: 900 }]);
  const first = await gst(MAKER, { action: "import_gstr2b", ...scope, reason: "July GSTR-2B from the portal", gstr2b: file });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.data.unmatchedInBooks.map((m) => m.invoiceNumber), ["inv001"], "the supplier reported it before the bill was booked");
  const billId = await approvedInternetBill(sqlite);
  const again = await gst(MAKER, { action: "import_gstr2b", ...scope, reason: "July GSTR-2B again after booking the bill", gstr2b: file });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.data.duplicatePrevented, true);
  assert.equal(again.body.data.rematched, 1);
  assert.deepEqual(again.body.data.matched.map((m) => [m.billId, m.status]), [[billId, "matched"]]);
  assert.deepEqual(again.body.data.unmatchedInBooks, []);
  assert.equal(sqlite.prepare("SELECT gstr2b_status FROM finance_bills WHERE id=?").get(billId).gstr2b_status, "matched");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_gstr2b_imports").get().n, 1, "still one import");
  assert.deepEqual([net(sqlite, "1180-Input CGST"), net(sqlite, "1181-Input SGST"), net(sqlite, "1185-Input tax not yet in GSTR-2B")], [900, 900, 0], "the credit moved out of 'not yet in GSTR-2B'");
  const third = await gst(MAKER, { action: "import_gstr2b", ...scope, reason: "July GSTR-2B a third time", gstr2b: file });
  assert.equal(third.body.data.rematched, 0, "nothing left to match: a true no-op");
  assert.ok(balanced(sqlite));
});

test("credit that can never be taken (section 16(4) time limit) leaves input tax for the expense when the month is saved", async () => {
  const { sqlite } = await itcWorld();
  const billId = await approvedInternetBill(sqlite, { billNumber: "INV-OLD", billDate: "2024-05-10", dueDate: "2024-06-10" });
  const imported = await gst(MAKER, { action: "import_gstr2b", ...scope, reason: "July GSTR-2B from the portal", gstr2b: gstr2b(PERIOD, [{ ctin: NET.gstin, inum: "INV-OLD", dt: "10-05-2024", txval: 10000, igst: 0, cgst: 900, sgst: 900 }]) });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.deepEqual([net(sqlite, "1180-Input CGST"), net(sqlite, "1181-Input SGST")], [900, 900], "matched: booked as input tax");
  const saved = await gst(MAKER, { action: "save_itc_computation", ...scope, periodCode: PERIOD, reason: "July input tax credit" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const figures = saved.body.data.figures ?? saved.body.data.computation?.figures ?? saved.body.data;
  assert.deepEqual(figures.table4?.d2_ineligible ?? figures.figures?.table4?.d2_ineligible, { igst: 0, cgst: 900, sgst: 900, cess: 0 }, "reported in 4(D)(2)");
  assert.deepEqual([net(sqlite, "1180-Input CGST"), net(sqlite, "1181-Input SGST")], [0, 0], "no phantom input tax is left in the books");
  assert.equal(net(sqlite, "6090-Office and Administration (2)"), 11800, "the lost credit is an expense");
  assert.ok(balanced(sqlite));
  assert.ok(billId);
});

test("the statutory package, the monthly close and GSTR-9C use a month's saved ITC computation instead of the older reviewed figure", async () => {
  const { sqlite, db } = await itcWorld();
  const billId = await approvedInternetBill(sqlite);
  sqlite.prepare("INSERT INTO finance_vendor_tax_reviews (id,vendor_id,bill_id,supplier_invoice_number,eligible_tax_amount,review_status,created_at,updated_at) VALUES ('vr1',?,?,'INV-001',500,'eligible',1,1)").run(NET.id, billId);
  const pkg = () => closeout.generateStatutoryPackageSafe(db, { ...scope, periodCode: PERIOD, reason: "July package" }, MAKER);
  const close = () => monthlyClose.monthlyCloseView(db, { period: PERIOD, actorId: MAKER });
  assert.equal((await pkg()).summary.eligibleInputTax, 500, "no saved computation yet: the older reviewed figure");
  assert.equal((await close()).gst.eligibleInputTax, 500);
  await gst(MAKER, { action: "import_gstr2b", ...scope, reason: "July GSTR-2B from the portal", gstr2b: gstr2b(PERIOD, [{ ctin: NET.gstin, inum: "inv001", dt: "10-07-2026", txval: 10000, igst: 0, cgst: 900, sgst: 900 }]) });
  const saved = await gst(MAKER, { action: "save_itc_computation", ...scope, periodCode: PERIOD, reason: "July input tax credit" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const threeB = await returns.generateGstr3b(db, { ...scope, periodCode: PERIOD }, MAKER);
  assert.equal(threeB.summary.eligibleInputTax, 1800);
  assert.equal((await pkg()).summary.eligibleInputTax, 1800, "the package agrees with GSTR-3B");
  assert.equal((await close()).gst.eligibleInputTax, 1800, "so does the monthly close");
  const nineC = await returns.generateGstr9c(db, { ...scope, financialYear: "2026-27", reason: "FY 2026-27 reconciliation" }, MAKER);
  assert.equal(nineC.summary.booksItc, 1800, "and GSTR-9C's books figure");
});

test("the sample vendors seeded for Finance carry GSTINs with valid check characters, and older sample rows are corrected", async () => {
  // The samples are seeded only where the staging sign-in is on.
  const { sqlite, db } = world("__ITC_FIXES_DB__", "__ITC_FIXES_ENV__", { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: "k".repeat(64) });
  await seedActors(sqlite, db, [{ id: "U-MK", email: MAKER, role: "finance" }]);
  assert.equal((await control.GET(asActor(MAKER, "/api/finance-control"))).status, 200);
  sqlite.prepare("UPDATE finance_vendors SET gstin='29AAACS0001A1Z5' WHERE id='ven_fuel'").run();
  sqlite.prepare("UPDATE finance_vendors SET gstin='27AAACF9999M1ZM' WHERE id='ven_food'").run();
  await control.GET(asActor(MAKER, "/api/finance-control"));
  const rows = Object.fromEntries(sqlite.prepare("SELECT id,gstin FROM finance_vendors WHERE id IN ('ven_fuel','ven_food','ven_software')").all().map((r) => [r.id, r.gstin]));
  assert.equal(rows.ven_fuel, "29AAACS0001A1ZB", "the old sample value is corrected");
  assert.equal(rows.ven_food, "27AAACF9999M1ZM", "a GSTIN Finance changed is left alone");
  for (const gstin of ["29AAACS0001A1ZB", "29AAHFT2201B1ZP", "29AABCC2233D1Z6"]) assert.equal(inputTax.validateGstin(gstin).ok, true, gstin);
});
