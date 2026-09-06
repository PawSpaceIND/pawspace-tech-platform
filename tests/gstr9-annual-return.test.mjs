/**
 * GSTR-9 annual return — EXECUTED.
 *
 * WHAT THIS FILE USED TO BE. ONE test that read `lib/gst-accounting.ts` and
 * `app/api/gst-accounting/route.ts` as strings and made fourteen `assert.match` calls against them,
 * including a template literal pinned character for character:
 *
 *   assert.match(lib, /const fyLabel=`\$\{startYear\}-\$\{String\(\(startYear\+1\)%100\)/);
 *
 * That asserts a line of source exists. It cannot tell you that FY2026-27 runs April 2026 to March
 * 2027, that a March-2026 tax row stays out of it, that another legal entity's tax stays out of it, or
 * that net tax payable is output plus adjustments minus eligible credit. This is a statutory return.
 *
 * lib/gst-accounting.ts carries a comment explaining exactly why the finance suites were written this
 * way: a TypeScript constructor parameter property in `ConfigurationRequired` could not be erased by
 * `node --experimental-strip-types`, so every module reaching this file was unimportable from the test
 * runner and "the finance suites all read their routes as TEXT instead of executing them". That was
 * fixed. These tests are the other half of that fix.
 *
 * Now four EXECUTED tests driving generateAnnualReturn / approveAnnualReturn and the real
 * POST /api/gst-accounting against a real SQLite-backed D1, on https://ops.pawspace.example rather
 * than localhost — on a preview host the maker and the checker below would be the same superuser and
 * the whole maker/checker claim would be untestable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__GSTR9_DB__", "__GSTR9_ENV__");

const gst = await import("../lib/gst-accounting.ts");
const gstRoute = await import("../app/api/gst-accounting/route.ts");

const ENTITY = "pawspace_india";
const OTHER_ENTITY = "pawspace_singapore";
const REG = "taxreg_karnataka";
const OTHER_REG = "taxreg_maharashtra";
const FY = "2026-27";
const MAKER = "maker.tax@pawspace.test";
const CHECKER = "checker.tax@pawspace.test";
// `manager` holds no finance permission at all — the contrast that makes the route gate a real gate.
const MANAGER = "ops.manager@pawspace.test";
const ORIGIN = "https://ops.pawspace.example";

/**
 * Two legal entities, two registrations, and the two staff identities a maker/checker claim needs.
 *
 * Every table comes from ensureGstAccountingTables — the module owns its own DDL, so a migration
 * reaches this file instead of being shadowed by schema copied by hand.
 */
async function taxWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__GSTR9_DB__ = db;
  globalThis.__GSTR9_ENV__ = {};
  await gst.ensureGstAccountingTables(db);

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  const staff = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'finance','active',?,?)");
  staff.run("U-TAX-MAKER", MAKER, "Maker Tax", now, now);
  staff.run("U-TAX-CHECKER", CHECKER, "Checker Tax", now, now);
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'manager','active',?,?)")
    .run("U-TAX-MGR", MANAGER, "Ops Manager", now, now);

  const entity = sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)");
  entity.run(ENTITY, "PawSpace India Private Limited", "IN", now, now);
  entity.run(OTHER_ENTITY, "PawSpace Pte Ltd", "SG", now, now);
  const registration = sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,created_at,updated_at) VALUES (?,?,?,'gst',?,'active','2020-01-01',?,?)");
  registration.run(REG, ENTITY, "KA", "29AABCP0000A1Z5", now, now);
  registration.run(OTHER_REG, ENTITY, "MH", "27AABCP0000A1Z1", now, now);
  return { sqlite, db };
}

/** One output-tax row in the canonical ledger. The invoice path that writes these rows for real is
 * executed in tests/finance-filing-closeout.test.mjs; here the ledger is the input under test. */
const outputTax = (sqlite, { period, component = "cgst", amount, entityId = ENTITY, registrationId = REG, key }) =>
  sqlite.prepare("INSERT INTO finance_tax_ledger (id,entity_id,registration_id,period_code,component,ledger_type,source_type,source_id,amount,source_event_key,created_at) VALUES (?,?,?,?,?,'output','invoice',?,?,?,?)")
    .run(`tax_${key}`, entityId, registrationId, period, component, `inv_${key}`, amount, key, Date.now());

const adjustment = (sqlite, { period, amount, key, entityId = ENTITY, registrationId = REG }) =>
  sqlite.prepare("INSERT INTO finance_tax_ledger (id,entity_id,registration_id,period_code,component,ledger_type,source_type,source_id,amount,source_event_key,created_at) VALUES (?,?,?,?,'aggregate_tax','adjustment','credit_note',?,?,?,?)")
    .run(`tax_${key}`, entityId, registrationId, period, `adj_${key}`, amount, key, Date.now());

/** A vendor bill with its ITC review, which is what eligible input tax is computed from. */
const eligibleCredit = (sqlite, { billDate, tax, key, status = "eligible" }) => {
  const now = Date.now();
  sqlite.prepare("INSERT INTO finance_bills (id,vendor_id,bill_number,bill_date,due_date,cost_centre,vertical,taxable_amount,gst_amount,total_amount,status,created_at,updated_at) VALUES (?,?,?,?,?,'Bengaluru Ops','All verticals',?,?,?,'approved',?,?)")
    .run(`bill_${key}`, "ven_food", `BILL-${key}`, billDate, billDate, tax * 5, tax, tax * 6, now, now);
  sqlite.prepare("INSERT INTO finance_vendor_tax_reviews (id,vendor_id,bill_id,supplier_invoice_number,eligible_tax_amount,review_status,review_reason,reviewed_by,reviewed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'reviewed',?,?,?,?)")
    .run(`vtx_${key}`, "ven_food", `bill_${key}`, `SUP-${key}`, tax, status, MAKER, now, now, now);
};

/** A reviewed monthly statutory package, which is what the annual reconciliation counts. */
const approvedMonthlyPackage = (sqlite, period, version = 1) =>
  sqlite.prepare("INSERT INTO finance_statutory_packages (id,entity_id,registration_id,period_code,version,status,summary_json,variance_json,prepared_by,prepared_at,reviewed_by,reviewed_at,approval_reference) VALUES (?,?,?,?,?,'reviewed','{}','[]',?,?,?,?,'BOARD-2026-11')")
    .run(`statpkg_${period}_v${version}`, ENTITY, REG, period, version, MAKER, Date.now(), CHECKER, Date.now());

const ALL_MONTHS = [
  "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
  "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03",
];

async function refusal(promise) {
  try { await promise; return null; }
  catch (error) {
    if (error instanceof Response) return { status: error.status, body: await error.json().catch(() => null) };
    return { message: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------------------------
test("GSTR-9 consolidates the Indian April-March financial year and nothing outside it", async () => {
  const { sqlite, db } = await taxWorld();

  // Inside FY2026-27: April 2026 and March 2027 are the boundary months and must both be included.
  outputTax(sqlite, { period: "2026-04", amount: 1000, key: "apr-cgst" });
  outputTax(sqlite, { period: "2026-04", component: "sgst", amount: 1000, key: "apr-sgst" });
  outputTax(sqlite, { period: "2027-03", amount: 500, key: "mar-cgst" });
  outputTax(sqlite, { period: "2027-03", component: "sgst", amount: 500, key: "mar-sgst" });
  // OUTSIDE it: March 2026 belongs to the previous year and April 2027 to the next one. A calendar-year
  // window, or an inclusive-of-March-2026 one, would sweep these in.
  outputTax(sqlite, { period: "2026-03", amount: 9999, key: "prev-fy" });
  outputTax(sqlite, { period: "2027-04", amount: 8888, key: "next-fy" });

  const generated = await gst.generateAnnualReturn(db, { entityId: ENTITY, registrationId: REG, financialYear: FY, reason: "annual close" }, MAKER);

  assert.equal(generated.summary.returnType, "GSTR-9");
  assert.equal(generated.summary.financialYear, "2026-27", "the FY label is the Indian April-March form");
  assert.equal(generated.summary.fromPeriod, "2026-04");
  assert.equal(generated.summary.toPeriod, "2027-03");
  assert.equal(generated.summary.totalOutputTax, 3000, "only the twelve months of the year are consolidated");
  assert.deepEqual(generated.summary.outputTaxByComponent, { cgst: 1500, sgst: 1500 },
    "and the components are kept apart, because a GST return files them separately");
  assert.deepEqual(Object.keys(generated.summary.monthlyOutputTax), ALL_MONTHS,
    "all twelve months appear, including the ones with no tax");
  assert.equal(generated.summary.monthlyOutputTax["2026-04"], 2000);
  assert.equal(generated.summary.monthlyOutputTax["2027-03"], 1000);
  assert.equal(generated.summary.monthlyOutputTax["2026-07"], 0, "a month with no invoices reports zero, not absent");

  // Persisted as a versioned DRAFT, and a second generation supersedes rather than overwrites — an
  // amended return must not erase the figures a reviewer already saw.
  const stored = sqlite.prepare("SELECT status,version,financial_year,prepared_by,supersedes_id FROM finance_annual_returns WHERE id=?").get(generated.id);
  assert.equal(String(stored.status), "draft");
  assert.equal(Number(stored.version), 1);
  assert.equal(String(stored.financial_year), "2026-27");
  assert.equal(String(stored.prepared_by), MAKER);
  assert.equal(stored.supersedes_id, null);
  const amended = await gst.generateAnnualReturn(db, { entityId: ENTITY, registrationId: REG, financialYear: FY, reason: "amended" }, MAKER);
  assert.equal(amended.version, 2);
  assert.equal(String(sqlite.prepare("SELECT supersedes_id FROM finance_annual_returns WHERE id=?").get(amended.id).supersedes_id), generated.id);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM finance_annual_returns").get().c), 2, "both versions are kept");

  // A financial year that is not one is refused rather than producing a return for year zero.
  assert.match(String((await refusal(gst.generateAnnualReturn(db, { entityId: ENTITY, registrationId: REG, financialYear: "not-a-year" }, MAKER)))?.message), /valid_financial_year_required/);
  assert.match(String((await refusal(gst.generateAnnualReturn(db, { entityId: ENTITY, registrationId: REG, financialYear: "1899-00" }, MAKER)))?.message), /valid_financial_year_required/);
  assert.match(String((await refusal(gst.generateAnnualReturn(db, { registrationId: REG, financialYear: FY }, MAKER)))?.message), /annual_return_source_required/);
  assert.match(String((await refusal(gst.generateAnnualReturn(db, { entityId: ENTITY, financialYear: FY }, MAKER)))?.message), /annual_return_source_required/);
});

// ---------------------------------------------------------------------------------------------
test("GSTR-9 is scoped to one legal entity and one registration", async () => {
  const { sqlite, db } = await taxWorld();
  outputTax(sqlite, { period: "2026-06", amount: 700, key: "mine" });
  // Same financial year, same period, DIFFERENT registration — a GST return is filed per registration,
  // so Maharashtra tax must never appear in the Karnataka return.
  outputTax(sqlite, { period: "2026-06", amount: 300, registrationId: OTHER_REG, key: "other-reg" });
  // And a different legal entity entirely.
  outputTax(sqlite, { period: "2026-06", amount: 400, entityId: OTHER_ENTITY, registrationId: OTHER_REG, key: "other-entity" });
  adjustment(sqlite, { period: "2026-06", amount: -50, registrationId: OTHER_REG, key: "other-adj" });

  const mine = await gst.generateAnnualReturn(db, { entityId: ENTITY, registrationId: REG, financialYear: FY }, MAKER);
  assert.equal(mine.summary.totalOutputTax, 700, "only this entity+registration's output tax");
  assert.equal(mine.summary.totalAdjustments, 0, "and only its adjustments");

  // NON-VACUITY: the other registration's return really does see its own 300, so the filter above is a
  // filter and not an empty table.
  const other = await gst.generateAnnualReturn(db, { entityId: ENTITY, registrationId: OTHER_REG, financialYear: FY }, MAKER);
  assert.equal(other.summary.totalOutputTax, 300);
  assert.equal(other.summary.totalAdjustments, -50);
});

// ---------------------------------------------------------------------------------------------
test("GSTR-9 net tax payable is output plus adjustments minus eligible credit", async () => {
  const { sqlite, db } = await taxWorld();
  outputTax(sqlite, { period: "2026-09", amount: 5000, key: "out" });
  // A credit note reduces the liability; a debit note would raise it.
  adjustment(sqlite, { period: "2026-10", amount: -400, key: "credit-note" });
  // ITC: one eligible bill inside the year, one eligible bill OUTSIDE it, and one bill inside the year
  // whose review is still held. Only the first may be claimed.
  eligibleCredit(sqlite, { billDate: "2026-11-14", tax: 1200, key: "in-year" });
  eligibleCredit(sqlite, { billDate: "2026-02-14", tax: 9999, key: "prev-year" });
  eligibleCredit(sqlite, { billDate: "2026-12-01", tax: 7777, key: "held", status: "held" });

  const annual = await gst.generateAnnualReturn(db, { entityId: ENTITY, registrationId: REG, financialYear: FY }, MAKER);
  assert.equal(annual.summary.totalOutputTax, 5000);
  assert.equal(annual.summary.totalAdjustments, -400);
  assert.equal(annual.summary.totalEligibleItc, 1200, "an out-of-year bill and a held review are not credit");
  assert.equal(annual.summary.netTaxPayable, 3400, "5000 output - 400 credit note - 1200 ITC");

  // The SECOND, disjoint output-tax source: the five service verticals write their tax into
  // booking_invoices, and only PawSpace's OWN share of it belongs in its own GSTR-9. The provider-supply
  // GST collected on the provider's behalf is disclosed separately (s52 TCS / GSTR-8) and must NOT be
  // added to the outward tax here — folding it in would overstate the statutory liability.
  const issuedAt = Date.UTC(2026, 8, 15); // 15 September 2026, inside FY2026-27
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,gross_amount REAL NOT NULL,tax_amount REAL NOT NULL,status TEXT NOT NULL DEFAULT 'issued',issued_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_payout_computations (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,platform_fee REAL NOT NULL DEFAULT 0,platform_gst REAL NOT NULL DEFAULT 0,provider_gst_deducted REAL NOT NULL DEFAULT 0)");
  sqlite.prepare("INSERT INTO booking_invoices (id,booking_id,gross_amount,tax_amount,status,issued_at) VALUES ('binv_1','bkg_1',11800,1800,'issued',?)").run(issuedAt);
  sqlite.prepare("INSERT INTO provider_payout_computations (id,booking_id,platform_fee,platform_gst,provider_gst_deducted) VALUES ('ppc_1','bkg_1',2000,360,1800)").run();

  const withService = await gst.generateAnnualReturn(db, { entityId: ENTITY, registrationId: REG, financialYear: FY }, MAKER);
  assert.equal(withService.summary.serviceOutputTax, 360, "only the commission GST is PawSpace's own output tax");
  assert.equal(withService.summary.providerSupplyGstCollectedOnBehalf, 1440, "the provider's Rs 1,440 is disclosed, not filed here");
  assert.equal(withService.summary.totalOutputTax, 5360, "5000 from the ledger plus 360 of commission GST");
  assert.equal(withService.summary.taxCollectedFromCustomers, 6800, "5000 + the full 1800 actually collected");
  assert.equal(withService.summary.netTaxPayable, 3760, "5360 - 400 - 1200");
  assert.equal(withService.summary.monthlyOutputTax["2026-09"], 5360, "and it lands in the month it was issued");
});

// ---------------------------------------------------------------------------------------------
test("GSTR-9 approval needs a clean year, a different human, a reference — and never files", async () => {
  const { sqlite, db } = await taxWorld();
  outputTax(sqlite, { period: "2026-05", amount: 2500, key: "out" });

  // With no reviewed monthly packages, the year does not reconcile and says which months are missing.
  const unreconciled = await gst.generateAnnualReturn(db, { entityId: ENTITY, registrationId: REG, financialYear: FY }, MAKER);
  assert.equal(unreconciled.reconciliation.reconciled, false);
  assert.equal(unreconciled.reconciliation.monthsInYear, 12);
  assert.equal(unreconciled.reconciliation.monthsWithApprovedMonthlyReturn, 0);
  assert.deepEqual(unreconciled.reconciliation.monthsMissingApprovedMonthlyReturn, ALL_MONTHS);
  assert.equal(unreconciled.liveFilingEnabled, false, "an internal package is never a live filing");

  // ELEVEN of twelve is still not a year: the annual return must not close over a month nobody reviewed.
  for (const period of ALL_MONTHS.slice(0, 11)) approvedMonthlyPackage(sqlite, period);
  const nearly = await gst.generateAnnualReturn(db, { entityId: ENTITY, registrationId: REG, financialYear: FY }, MAKER);
  assert.equal(nearly.reconciliation.reconciled, false);
  assert.deepEqual(nearly.reconciliation.monthsMissingApprovedMonthlyReturn, ["2027-03"]);
  // A DRAFT monthly package does not count either — only a reviewed one.
  sqlite.prepare("INSERT INTO finance_statutory_packages (id,entity_id,registration_id,period_code,version,status,summary_json,variance_json,prepared_by,prepared_at) VALUES ('statpkg_draft',?,?,'2027-03',1,'draft','{}','[]',?,?)")
    .run(ENTITY, REG, MAKER, Date.now());
  const stillNearly = await gst.generateAnnualReturn(db, { entityId: ENTITY, registrationId: REG, financialYear: FY }, MAKER);
  assert.deepEqual(stillNearly.reconciliation.monthsMissingApprovedMonthlyReturn, ["2027-03"], "a draft month is not a reviewed month");

  // Version 2 supersedes the draft above; an amended month is still one reviewed month.
  approvedMonthlyPackage(sqlite, "2027-03", 2);
  const clean = await gst.generateAnnualReturn(db, { entityId: ENTITY, registrationId: REG, financialYear: FY }, MAKER);
  assert.equal(clean.reconciliation.reconciled, true);
  assert.equal(clean.reconciliation.monthsWithApprovedMonthlyReturn, 12);

  // MAKER/CHECKER: the human who prepared it cannot approve it.
  assert.match(String((await refusal(gst.approveAnnualReturn(db, { id: clean.id, approvalReference: "BOARD-2027-04" }, MAKER)))?.message), /maker_checker_required/);
  assert.equal(String(sqlite.prepare("SELECT status FROM finance_annual_returns WHERE id=?").get(clean.id).status), "draft");
  // And an approval with no board reference is refused: a statutory sign-off must be traceable.
  assert.match(String((await refusal(gst.approveAnnualReturn(db, { id: clean.id }, CHECKER)))?.message), /approval_reference_required/);
  assert.equal(String(sqlite.prepare("SELECT status FROM finance_annual_returns WHERE id=?").get(clean.id).status), "draft");

  const approved = await gst.approveAnnualReturn(db, { id: clean.id, approvalReference: "BOARD-2027-04", reason: "board approved" }, CHECKER);
  assert.equal(approved.status, "reviewed");
  assert.equal(approved.liveFilingEnabled, false, "approval is an internal sign-off, not a submission to the GST portal");
  const row = sqlite.prepare("SELECT status,reviewed_by,approval_reference FROM finance_annual_returns WHERE id=?").get(clean.id);
  assert.deepEqual({ status: String(row.status), by: String(row.reviewed_by), ref: String(row.approval_reference) },
    { status: "reviewed", by: CHECKER, ref: "BOARD-2027-04" });
  // Approving twice is refused — a reviewed return is not a draft.
  assert.match(String((await refusal(gst.approveAnnualReturn(db, { id: clean.id, approvalReference: "BOARD-AGAIN" }, CHECKER)))?.message), /annual_return_not_draft/);
  assert.match(String((await refusal(gst.approveAnnualReturn(db, { id: "gstr9_nope", approvalReference: "X" }, CHECKER)))?.message), /annual_return_not_found/);

  // THE ROUTE, on a real hostname: both actions are wired, finance.manage is required, and the response
  // says on its face that nothing was filed.
  const post = async (actorEmail, body, extraHeaders = {}) => {
    const headers = { "content-type": "application/json", ...extraHeaders, ...(actorEmail ? { "oai-authenticated-user-email": actorEmail } : {}) };
    const response = await gstRoute.POST(new Request(`${ORIGIN}/api/gst-accounting`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const generateBody = { action: "generate_annual_return", entityId: ENTITY, registrationId: REG, financialYear: FY, reason: "annual close via route" };
  assert.ok([401, 403].includes((await post("", generateBody)).status), "an anonymous caller cannot generate a statutory return");
  // A SIGNED-IN staff member without finance.manage is refused too. This is the assertion that covers
  // the permission check rather than the sign-in check: resolveActor already refuses the anonymous call
  // above, so on its own that case would still pass with requirePermission deleted entirely.
  const wrongRole = await post(MANAGER, generateBody);
  assert.equal(wrongRole.status, 403, `a manager holds no finance permission and must be refused: ${JSON.stringify(wrongRole)}`);
  assert.equal(wrongRole.body?.data, undefined, "and generates nothing");
  const viaRoute = await post(MAKER, generateBody);
  assert.equal(viaRoute.status, 200, `finance.manage must be allowed through: ${JSON.stringify(viaRoute)}`);
  assert.equal(viaRoute.body?.data?.summary?.returnType, "GSTR-9");
  assert.equal(viaRoute.body?.liveFilingEnabled, false);
  assert.equal(viaRoute.body?.productionReady, false);
  // The preparer recorded is the AUTHENTICATED actor, not a body field.
  assert.equal(String(sqlite.prepare("SELECT prepared_by FROM finance_annual_returns WHERE id=?").get(viaRoute.body.data.id).prepared_by), MAKER);
  const selfApproveViaRoute = await post(MAKER, { action: "approve_annual_return", id: viaRoute.body.data.id, approvalReference: "BOARD-X" });
  assert.ok(selfApproveViaRoute.status >= 400, `the route must not let a maker approve their own return: ${JSON.stringify(selfApproveViaRoute)}`);
  const approvedViaRoute = await post(CHECKER, { action: "approve_annual_return", id: viaRoute.body.data.id, approvalReference: "BOARD-2027-04", reason: "board approved" });
  assert.equal(approvedViaRoute.status, 200, `${JSON.stringify(approvedViaRoute)}`);
  assert.equal(approvedViaRoute.body?.data?.status, "reviewed");
  assert.equal(String(sqlite.prepare("SELECT reviewed_by FROM finance_annual_returns WHERE id=?").get(viaRoute.body.data.id).reviewed_by), CHECKER);
  // A cross-origin write is blocked outright.
  assert.equal((await post(MAKER, generateBody, { origin: "https://evil.example" })).status, 403);
});
