/*
 * Input tax credit, part 1: the purchase register and GSTR-2B (owner decision E, 27 Sept 2026; round3/gst-law.md section 4).
 *
 * Driven through the REAL Finance routes (app/api/finance-control for bills, app/api/gst-accounting for GST actions) as real
 * Finance users on a real https origin, and the real GSTR-3B generator:
 *   - a CGST + SGST bill is credited as CGST and SGST in the ITC computation and GSTR-3B Table 4. Before this change GSTR-3B
 *     reported every rupee of eligible input tax as IGST ("OTH" iamt), whatever the vendor charged;
 *   - a bill not in GSTR-2B is not credited until it is matched, or confirmed by Finance with a reason (audited);
 *   - the GSTR-2B import matches "INV-001" in the books to "inv001" in GSTR-2B and lists what did not match on either side;
 *   - a 17(5) blocked bill is never credited: its GST stays in the expense, and in GSTR-2B it is reported and reversed in full;
 *   - tax heads must suit the place of supply, the GSTIN check character is verified, and departing from the category default
 *     (gst-law.md: "Finance can override with a reason") needs a reason;
 *   - a bill written before this change (aggregate GST only) is excluded until split; splitting an approved bill posts only the
 *     difference, once; a month that is locked refuses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__ITC_REGISTER_DB__", "__ITC_REGISTER_ENV__");
const control = await import("../app/api/finance-control/route.ts");
const gstRoute = await import("../app/api/gst-accounting/route.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const returns = await import("../lib/gst-returns.ts");

const ENTITY = "pawspace_india", REG = "REG-KA", GSTIN = "29AAICT7352F1Z0"; // TK Petcare, Karnataka
const MAKER = "maker@pawspace.in", CHECKER = "checker@pawspace.in", ASSOCIATE = "associate@pawspace.in";
const NET = { id: "ven_net", gstin: "29AABCI1234K1ZM" }; // Karnataka internet provider
const GARAGE = { id: "ven_garage", gstin: "29AACFB5678L1ZW" }; // Karnataka garage
const MUMBAI = { id: "ven_mumbai", gstin: "27AAACF9999M1ZM" }; // Maharashtra consultant
const OTHER = { id: "ven_other", gstin: "29AADCS4321P1ZY" };
const PERIOD = "2026-07";

async function itcWorld() {
  const { sqlite, db } = world("__ITC_REGISTER_DB__", "__ITC_REGISTER_ENV__", {});
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
const view = (email, query) => gstRoute.GET(asActor(email, `/api/gst-accounting?${new URLSearchParams(query)}`)).then(json);
const books = (sqlite, billId) => Object.fromEntries(sqlite.prepare("SELECT account_code,ROUND(SUM(debit)-SUM(credit),2) net FROM finance_journal_entries WHERE source_id=? GROUP BY account_code").all(billId).filter((r) => r.net !== 0).map((r) => [r.account_code, r.net]));
const balanced = (sqlite) => { const r = sqlite.prepare("SELECT ROUND(SUM(debit),2) d,ROUND(SUM(credit),2) c FROM finance_journal_entries").get(); return r.d === r.c; };
function gstr2b(period, invoices) {
  const [y, m] = period.split("-"), bySupplier = new Map();
  for (const { ctin, ...inv } of invoices) bySupplier.set(ctin, [...(bySupplier.get(ctin) ?? []), { typ: "R", rev: "N", itcavl: "Y", pos: "29", val: inv.txval + inv.igst + inv.cgst + inv.sgst, cess: 0, ...inv }]);
  return { data: { gstin: GSTIN, rtnprd: `${m}${y}`, version: "1.0", gendt: "14-08-2026", docdata: { b2b: [...bySupplier].map(([ctin, inv]) => ({ ctin, trdnm: `Supplier ${ctin}`, supprd: `${m}${y}`, inv })) } } };
}
const scope = { entityId: ENTITY, registrationId: REG };
const internetBill = { vendorId: NET.id, billNumber: "INV-001", billDate: "2026-07-10", taxableAmount: 10000, gstAmount: 1800, totalAmount: 11800, categoryCode: "EXP-OFF-INTERNET", placeOfSupply: "29", sacCode: "998422", cgstAmount: 900, sgstAmount: 900 };

test("a CGST + SGST bill is credited as CGST and SGST in the ITC computation and GSTR-3B Table 4, never as IGST", async () => {
  const { sqlite, db } = await itcWorld();
  const created = await createBill(MAKER, internetBill);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const billId = created.body.data.id;
  // The review row the old GSTR-3B read: before this change all 1,800 was reported as IGST.
  sqlite.prepare("INSERT INTO finance_vendor_tax_reviews (id,vendor_id,bill_id,supplier_invoice_number,eligible_tax_amount,review_status,created_at,updated_at) VALUES ('vr1',?,?,'INV-001',1800,'eligible',1,1)").run(NET.id, billId);
  const approved = await patchBill(sqlite, CHECKER, billId, "approve");
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const before = await returns.generateGstr3b(db, { ...scope, periodCode: PERIOD }, MAKER);
  assert.deepEqual(before.payload.itc_elg.itc_net, { iamt: 0, camt: 0, samt: 0, csamt: 0 }, "not in GSTR-2B yet: nothing is credited, and never as IGST");
  assert.deepEqual(books(sqlite, billId), { "6090-Office and Administration (2)": 10000, "1185-Input tax not yet in GSTR-2B": 1800, "2200-Accounts payable": -11800 }, "creditable GST waits in 1185 until GSTR-2B");

  const imported = await gst(MAKER, { action: "import_gstr2b", ...scope, reason: "July GSTR-2B from the portal", gstr2b: gstr2b(PERIOD, [{ ctin: NET.gstin, inum: "inv001", dt: "10-07-2026", txval: 10000, igst: 0, cgst: 900, sgst: 900 }]) });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.data.matched.length, 1);
  assert.deepEqual(books(sqlite, billId), { "6090-Office and Administration (2)": 10000, "1180-Input CGST": 900, "1181-Input SGST": 900, "2200-Accounts payable": -11800 }, "matched: the credit moves to the CGST and SGST accounts");

  const saved = await gst(MAKER, { action: "save_itc_computation", ...scope, periodCode: PERIOD, reason: "July input tax credit" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.data.figures.table4.a5_allOther, { igst: 0, cgst: 900, sgst: 900, cess: 0 });
  assert.deepEqual(saved.body.data.figures.netItc, { igst: 0, cgst: 900, sgst: 900, cess: 0 });

  const gstr3b = await returns.generateGstr3b(db, { ...scope, periodCode: PERIOD }, MAKER);
  assert.deepEqual(gstr3b.payload.itc_elg.itc_avl.find((r) => r.ty === "OTH"), { ty: "OTH", iamt: 0, camt: 900, samt: 900, csamt: 0 }, "Table 4(A)(5) by head");
  assert.deepEqual(gstr3b.payload.itc_elg.itc_net, { iamt: 0, camt: 900, samt: 900, csamt: 0 }, "Table 4(C) by head");
  assert.equal(gstr3b.summary.eligibleInputTax, 1800);
  assert.equal(gstr3b.summary.itcComputationId, saved.body.data.id, "the draft names the saved computation it used");
  assert.equal(balanced(sqlite), true);
});

test("a bill not in GSTR-2B is excluded until it is matched or confirmed by Finance with a reason, and the confirmation is audited", async () => {
  const { sqlite } = await itcWorld();
  const billId = (await createBill(MAKER, internetBill)).body.data.id;
  assert.equal((await patchBill(sqlite, CHECKER, billId, "approve")).status, 200);
  const first = await gst(MAKER, { action: "save_itc_computation", ...scope, periodCode: PERIOD, reason: "July input tax credit" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.data.figures.netItc, { igst: 0, cgst: 0, sgst: 0, cess: 0 }, "not credited while it is not in GSTR-2B");
  assert.deepEqual(first.body.data.figures.notCredited.waitingForGstr2b.map((b) => b.billId), [billId], "listed as waiting for GSTR-2B");

  const noReason = await gst(MAKER, { action: "confirm_bill_itc", billId, claimPeriod: PERIOD, reason: "ok" });
  assert.equal(noReason.status, 400, "a confirmation needs a reason");
  const confirmed = await gst(CHECKER, { action: "confirm_bill_itc", billId, claimPeriod: PERIOD, reason: "In GSTR-2B under the supplier's typed number INV 1" });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.data.gstr2bStatus, "manual_confirmed");
  const audit = sqlite.prepare("SELECT actor_id,reason FROM gst_accounting_audit_events WHERE entity_id=? AND action='itc_manual_confirmed'").get(billId);
  assert.deepEqual({ ...audit }, { actor_id: CHECKER, reason: "In GSTR-2B under the supplier's typed number INV 1" });
  assert.equal((await gst(CHECKER, { action: "confirm_bill_itc", billId, claimPeriod: PERIOD, reason: "In GSTR-2B under the supplier's typed number INV 1" })).body.data.duplicatePrevented, true, "idempotent");

  const second = await gst(MAKER, { action: "save_itc_computation", ...scope, periodCode: PERIOD, reason: "July input tax credit after confirmation" });
  assert.equal(second.body.data.version, 2);
  assert.deepEqual(second.body.data.figures.netItc, { igst: 0, cgst: 900, sgst: 900, cess: 0 }, "credited once confirmed");
  const replay = await gst(MAKER, { action: "save_itc_computation", ...scope, periodCode: PERIOD, reason: "July input tax credit again" });
  assert.equal(replay.body.data.duplicatePrevented, true, "saving the same figures again is a no-op");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_itc_computations").get().n, 2);
});

test("the GSTR-2B import matches INV-001 to inv001 and lists what did not match on either side; a re-import is a no-op", async () => {
  const { sqlite } = await itcWorld();
  const matchedBill = (await createBill(MAKER, internetBill)).body.data.id;
  const missingIn2b = (await createBill(MAKER, { ...internetBill, vendorId: OTHER.id, billNumber: "B-77" })).body.data.id;
  const wrongAmount = (await createBill(MAKER, { ...internetBill, billNumber: "INV-002", taxableAmount: 5000, cgstAmount: 450, sgstAmount: 450, gstAmount: 900, totalAmount: 5900 })).body.data.id;
  const file = gstr2b(PERIOD, [
    { ctin: NET.gstin, inum: "inv001", dt: "10-07-2026", txval: 10000, igst: 0, cgst: 900, sgst: 900 },
    { ctin: NET.gstin, inum: "INV/002", dt: "10-07-2026", txval: 5100, igst: 0, cgst: 459, sgst: 459 },
    { ctin: MUMBAI.gstin, inum: "XYZ-9", dt: "12-07-2026", txval: 2000, igst: 360, cgst: 0, sgst: 0 },
  ]);
  const result = await gst(MAKER, { action: "import_gstr2b", ...scope, reason: "July GSTR-2B from the portal", gstr2b: file });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const data = result.body.data;
  assert.deepEqual(data.matched.map((m) => [m.invoiceNumber, m.billId]), [["inv001", matchedBill]]);
  assert.deepEqual(data.unmatchedInBooks.map((m) => m.invoiceNumber), ["XYZ-9"]);
  assert.deepEqual(data.unmatchedIn2b.map((b) => b.billId), [missingIn2b]);
  assert.deepEqual(data.needsAttention.map((m) => [m.billId, m.status]), [[wrongAmount, "amount_mismatch"]], "INV/002 is found, but its amounts differ by more than Rs 1");
  assert.equal(sqlite.prepare("SELECT gstr2b_status FROM finance_bills WHERE id=?").get(matchedBill).gstr2b_status, "matched");
  assert.equal(sqlite.prepare("SELECT gstr2b_status FROM finance_bills WHERE id=?").get(wrongAmount).gstr2b_status, "not_in_2b");
  const again = await gst(MAKER, { action: "import_gstr2b", ...scope, reason: "July GSTR-2B from the portal", gstr2b: JSON.stringify(file) });
  assert.equal(again.body.data.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_gstr2b_lines").get().n, 3, "the same file is stored once");
  const wrongGstin = await gst(MAKER, { action: "import_gstr2b", ...scope, reason: "Wrong registration file", gstr2b: { data: { ...file.data, gstin: MUMBAI.gstin } } });
  assert.equal(wrongGstin.status, 400);
  assert.match(wrongGstin.body.error, /not the selected registration/);
  const listed = await view(MAKER, { view: "gstr2b_imports", registrationId: REG, period: PERIOD });
  assert.equal(listed.body.data.length, 1);
});

test("a section 17(5) blocked bill is never credited: its GST stays in the expense and, once in GSTR-2B, is reported and reversed in full", async () => {
  const { sqlite } = await itcWorld();
  const created = await createBill(MAKER, { vendorId: GARAGE.id, billNumber: "SRV-5", billDate: "2026-07-12", taxableAmount: 10000, gstAmount: 1800, totalAmount: 11800, categoryCode: "EXP-TAXI-MAINTENANCE", placeOfSupply: "29", sacCode: "998714", cgstAmount: 900, sgstAmount: 900 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const billId = created.body.data.id;
  const row = sqlite.prepare("SELECT itc_treatment,itc_clause FROM finance_bills WHERE id=?").get(billId);
  assert.deepEqual({ ...row }, { itc_treatment: "blocked_17_5", itc_clause: "17(5)(ab) motor vehicle repair and maintenance" }, "the category default from gst-law.md");
  assert.equal((await patchBill(sqlite, CHECKER, billId, "approve")).status, 200);
  assert.deepEqual(books(sqlite, billId), { "6170-Taxi Related Expenses (4)": 11800, "2200-Accounts payable": -11800 }, "the blocked GST is part of the expense; no input tax");
  await gst(MAKER, { action: "import_gstr2b", ...scope, reason: "July GSTR-2B from the portal", gstr2b: gstr2b(PERIOD, [{ ctin: GARAGE.gstin, inum: "SRV-5", dt: "12-07-2026", txval: 10000, igst: 0, cgst: 900, sgst: 900 }]) });
  assert.deepEqual(books(sqlite, billId), { "6170-Taxi Related Expenses (4)": 11800, "2200-Accounts payable": -11800 }, "a GSTR-2B match never moves blocked GST into input tax");
  const saved = await gst(MAKER, { action: "save_itc_computation", ...scope, periodCode: PERIOD, reason: "July input tax credit" });
  const f = saved.body.data.figures;
  assert.deepEqual(f.table4.a5_allOther, { igst: 0, cgst: 900, sgst: 900, cess: 0 }, "availed through GSTR-2B");
  assert.deepEqual(f.table4.b1_rules42_43_s17_5, { igst: 0, cgst: 900, sgst: 900, cess: 0 }, "reversed in full in 4(B)(1)");
  assert.deepEqual(f.netItc, { igst: 0, cgst: 0, sgst: 0, cess: 0 }, "never claimed");
  assert.deepEqual(f.blocked.reported, { igst: 0, cgst: 900, sgst: 900, cess: 0 }, "shown separately");
  assert.deepEqual(f.rule42.t3_blocked, { igst: 0, cgst: 900, sgst: 900, cess: 0 }, "T3 in the Rule 42 working");
});

test("tax heads must suit the place of supply, the GSTIN check character is verified, and departing from the category default needs a reason", async () => {
  const { sqlite } = await itcWorld();
  const sameState = await createBill(MAKER, { ...internetBill, cgstAmount: 0, sgstAmount: 0, igstAmount: 1800 });
  assert.equal(sameState.status, 400);
  assert.match(sameState.body.error, /same state, so the tax is CGST \+ SGST/);
  const otherState = await createBill(MAKER, { ...internetBill, vendorId: MUMBAI.id });
  assert.equal(otherState.status, 400);
  assert.match(otherState.body.error, /different states, so the tax is IGST/);
  const badGstin = await createBill(MAKER, { ...internetBill, supplierGstin: "29AABCI1234K1ZA" });
  assert.equal(badGstin.status, 400);
  assert.match(badGstin.body.error, /check character \(it should end in M\)/);
  const health = { vendorId: OTHER.id, billNumber: "POL-1", billDate: "2026-07-05", taxableAmount: 10000, gstAmount: 1800, totalAmount: 11800, categoryCode: "EXP-SAL-HEALTH", placeOfSupply: "29", cgstAmount: 900, sgstAmount: 900, itcTreatment: "eligible" };
  const noReason = await createBill(MAKER, health);
  assert.equal(noReason.status, 400);
  assert.match(noReason.body.error, /departs from the category default.*give the reason/);
  const withReason = await createBill(MAKER, { ...health, itcOverrideReason: "Group health cover required by the ESI Act for these staff" });
  assert.equal(withReason.status, 201, JSON.stringify(withReason.body));
  assert.equal(sqlite.prepare("SELECT itc_override_reason FROM finance_bills WHERE id=?").get(withReason.body.data.id).itc_override_reason, "Group health cover required by the ESI Act for these staff");
  const denied = await createBill(ASSOCIATE, internetBill);
  assert.equal(denied.status, 403, "only finance.manage can write the purchase register");
});

test("a bill with only an aggregate GST amount is excluded until split; splitting it after approval posts only the difference, once", async () => {
  const { sqlite } = await itcWorld();
  const legacy = await createBill(MAKER, { vendorId: NET.id, billNumber: "OLD-9", billDate: "2026-07-03", taxableAmount: 10000, gstAmount: 1800, totalAmount: 11800 });
  assert.equal(legacy.status, 201);
  const billId = legacy.body.data.id;
  assert.equal((await patchBill(sqlite, CHECKER, billId, "approve")).status, 200);
  assert.deepEqual(books(sqlite, billId), { "6300-Vendor expense": 11800, "2200-Accounts payable": -11800 }, "the old pair, unchanged");
  const pending = await view(MAKER, { view: "itc_summary", ...scope, period: PERIOD });
  assert.deepEqual(pending.body.data.live.notCredited.needsComponentSplit.map((b) => [b.billId, b.gstAmount]), [[billId, 1800]]);
  assert.deepEqual(pending.body.data.live.netItc, { igst: 0, cgst: 0, sgst: 0, cess: 0 }, "an aggregate GST amount is never credited");

  const split = await patchBill(sqlite, MAKER, billId, "classify", { categoryCode: "EXP-OFF-INTERNET", placeOfSupply: "29", cgstAmount: 900, sgstAmount: 900, reason: "Split from the supplier invoice" });
  assert.equal(split.status, 200, JSON.stringify(split.body));
  assert.deepEqual(books(sqlite, billId), { "6090-Office and Administration (2)": 10000, "1185-Input tax not yet in GSTR-2B": 1800, "2200-Accounts payable": -11800 }, "moved out of the old expense account into the right one and into input tax");
  // Each difference journal claims "<bill>#<n>" (the route's legacy backfill also adds a plain "<bill>" row for any journal source).
  const syncs = () => sqlite.prepare("SELECT COUNT(*) n FROM finance_journal_posting_claims WHERE source_type='vendor_bill_itc' AND instr(source_id,'#')>0").get().n;
  assert.equal(syncs(), 1, "one difference journal");
  const again = await patchBill(sqlite, MAKER, billId, "classify", { categoryCode: "EXP-OFF-INTERNET", placeOfSupply: "29", cgstAmount: 900, sgstAmount: 900, reason: "Same split again" });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.journalGroup, null, "already in line: nothing is posted twice");
  assert.equal(syncs(), 1);
  const amounts = await patchBill(sqlite, MAKER, billId, "classify", { taxableAmount: 9000, placeOfSupply: "29", cgstAmount: 900, sgstAmount: 900, reason: "Try to change the amount" });
  assert.equal(amounts.status, 409, "an approved bill's amounts cannot change");

  await gst(CHECKER, { action: "confirm_bill_itc", billId, claimPeriod: PERIOD, reason: "In GSTR-2B for July, checked on the portal" });
  const saved = await gst(MAKER, { action: "save_itc_computation", ...scope, periodCode: PERIOD, reason: "July input tax credit" });
  assert.deepEqual(saved.body.data.figures.netItc, { igst: 0, cgst: 900, sgst: 900, cess: 0 });
  const final = await patchBill(sqlite, MAKER, billId, "classify", { categoryCode: "EXP-OFF-INTERNET", placeOfSupply: "29", cgstAmount: 900, sgstAmount: 900, itcTreatment: "common_rule_42", itcOverrideReason: "Also serves funeral", reason: "Reclassify after saving" });
  assert.equal(final.status, 409, "credit taken in a saved computation is final");
  assert.equal(balanced(sqlite), true);
});

test("a locked month refuses the ITC computation, a confirmation into it and a Rule 37A check dated in it", async () => {
  const { sqlite } = await itcWorld();
  const billId = (await createBill(MAKER, internetBill)).body.data.id;
  assert.equal((await patchBill(sqlite, CHECKER, billId, "approve")).status, 200);
  sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES (?, 'locked','[]',1,'finance',1)").run(PERIOD);
  const saved = await gst(MAKER, { action: "save_itc_computation", ...scope, periodCode: PERIOD, reason: "July input tax credit" });
  assert.equal(saved.status, 409);
  assert.match(saved.body.error, /closed and locked/);
  const confirmed = await gst(MAKER, { action: "confirm_bill_itc", billId, claimPeriod: PERIOD, reason: "In GSTR-2B for July, checked on the portal" });
  assert.equal(confirmed.status, 409);
  const rule37a = await gst(MAKER, { action: "mark_supplier_gstr3b", billId, filed: false, checkedOn: "2026-07-20", reason: "Supplier GSTR-3B not filed, checked on the portal" });
  assert.equal(rule37a.status, 409, "a Rule 37A check dated in a locked month is refused");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_itc_computations").get().n, 0);
});
