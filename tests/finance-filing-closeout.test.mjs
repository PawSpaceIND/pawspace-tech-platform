/**
 * Statutory filing closeout — EXECUTED.
 *
 * WHAT THIS FILE USED TO BE. Six tests, every one of them a string search over source. Two examples,
 * verbatim:
 *
 *   const matches = source.match(/b\.entity_id=\?/g) ?? [];
 *   assert.ok(matches.length >= 2, "monthly and annual ITC must both filter by bill entity");
 *
 *   assert.match(route, /const eligible=`[^`]*NOT EXISTS \(SELECT 1 FROM finance_close_periods
 *                        WHERE period_code=\? AND status='locked'\)`/s);
 *
 * The first counts occurrences of a SQL fragment. It passes if the fragment appears twice in comments.
 * The second pins a SQL template literal character for character: it fails when the query is
 * reformatted and passes when the query is correct-looking but bound to the wrong parameter. Neither
 * ever issued an invoice, computed a rupee of input tax credit, or approved anything.
 *
 * Now seven EXECUTED tests driving the real wrappers and the real POST/PATCH handlers of
 * /api/gst-accounting and /api/finance-control against a real SQLite-backed D1.
 *
 * Requests go to https://ops.pawspace.example, NOT localhost. The maker/checker separation on finance
 * approvals is a claim about two identities; on a preview host lib/development-preview.ts resolves one
 * superuser holding ["*"] for every request, and the claim would be untestable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__CLOSEOUT_DB__", "__CLOSEOUT_ENV__");

const closeout = await import("../lib/finance-filing-closeout.ts");
const gst = await import("../lib/gst-accounting.ts");
const gstRoute = await import("../app/api/gst-accounting/route.ts");
const financeRoute = await import("../app/api/finance-control/route.ts");

const ENTITY = "pawspace_india";
const OTHER_ENTITY = "pawspace_singapore";
const REG = "taxreg_karnataka";
const POLICY = "taxpol_v1";
const MAKER = "maker.close@pawspace.test";
const CHECKER = "checker.close@pawspace.test";
const MANAGER = "ops.manager@pawspace.test";
const ORIGIN = "https://ops.pawspace.example";

const ALL_MONTHS = [
  "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
  "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03",
];

/**
 * Two legal entities with an active GST policy, an invoice series and a classification for grooming.
 *
 * Tables come from ensureGstAccountingTables and ensureFinanceEntityScope — the modules own their DDL,
 * including the entity_id columns the closeout wrappers add, so this fixture cannot drift from the
 * migration.
 */
async function closeWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__CLOSEOUT_DB__ = db;
  globalThis.__CLOSEOUT_ENV__ = {};
  await closeout.ensureFinanceEntityScope(db);

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  const staff = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  staff.run("U-CLOSE-MAKER", MAKER, "Maker Close", "finance", now, now);
  staff.run("U-CLOSE-CHECKER", CHECKER, "Checker Close", "finance", now, now);
  // `manager` holds no finance permission at all, which is what makes the route gates real gates.
  staff.run("U-CLOSE-MGR", MANAGER, "Ops Manager", "manager", now, now);

  const entity = sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)");
  entity.run(ENTITY, "PawSpace India Private Limited", "IN", now, now);
  entity.run(OTHER_ENTITY, "PawSpace Pte Ltd", "SG", now, now);
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,created_at,updated_at) VALUES (?,?,'KA','gst',?,'active','2020-01-01',?,?)")
    .run(REG, ENTITY, "29AABCP0000A1Z5", now, now);
  sqlite.prepare("INSERT INTO tax_policy_versions (id,entity_id,version,status,effective_from,policy_json,approval_reference,created_at,updated_at) VALUES (?,?,1,'active','2020-01-01','{}','BOARD-1',?,?)")
    .run(POLICY, ENTITY, now, now);
  // Grooming at 18% split 9% CGST + 9% SGST, which is why the invoice below produces TWO ledger rows
  // per line rather than one.
  sqlite.prepare("INSERT INTO tax_classifications (id,policy_id,service_code,classification_code,tax_component_json,place_of_supply_rule,input_tax_rule,created_at) VALUES (?,?,'grooming','9987',?,'location_of_service','eligible',?)")
    .run("taxclass_grooming", POLICY, JSON.stringify([{ code: "cgst", rate: 9 }, { code: "sgst", rate: 9 }]), now);
  sqlite.prepare("INSERT INTO finance_document_series (id,entity_id,document_type,prefix,next_number,padding,policy_id,status,updated_at) VALUES (?,?,'invoice','PS/26-27/',1,6,?,'active',?)")
    .run("series_invoice", ENTITY, POLICY, now);
  return { sqlite, db };
}

/** A vendor bill with its ITC review, scoped to a legal entity. */
const billWithCredit = (sqlite, { key, entityId, billDate, tax, status = "eligible" }) => {
  const now = Date.now();
  sqlite.prepare("INSERT INTO finance_bills (id,entity_id,vendor_id,bill_number,bill_date,due_date,cost_centre,vertical,taxable_amount,gst_amount,total_amount,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'Bengaluru Ops','All verticals',?,?,?,'approved',?,?)")
    .run(`bill_${key}`, entityId, "ven_food", `BILL-${key}`, billDate, billDate, tax * 5, tax, tax * 6, now, now);
  sqlite.prepare("INSERT INTO finance_vendor_tax_reviews (id,vendor_id,bill_id,supplier_invoice_number,eligible_tax_amount,review_status,review_reason,reviewed_by,reviewed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'reviewed',?,?,?,?)")
    .run(`vtx_${key}`, "ven_food", `bill_${key}`, `SUP-${key}`, tax, status, MAKER, now, now, now);
};

const journal = (sqlite, { key, entityId, period, posted, debit = 100 }) =>
  sqlite.prepare("INSERT INTO finance_journal_entries (id,entity_id,entry_date,source_type,source_id,account_code,cost_centre,vertical,debit,credit,narration,period_code,posted,created_at) VALUES (?,?,?,'test',?,'6200-Operating expense','Bengaluru Ops','All verticals',?,0,?,?,?,?)")
    .run(`jrn_${key}`, entityId, `${period}-15`, `src_${key}`, debit, `journal ${key}`, period, posted ? 1 : 0, Date.now());

const activeMapping = (sqlite, entityId = ENTITY) =>
  sqlite.prepare("INSERT INTO accounting_mapping_versions (id,entity_id,version,status,effective_from,mapping_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES (?,?,1,'active','2020-01-01','{}','BOARD-MAP',?,?,?,?)")
    .run(`acctmap_${entityId}`, entityId, CHECKER, Date.now(), Date.now(), Date.now());

const approvedMonthlyPackage = (sqlite, period) =>
  sqlite.prepare("INSERT INTO finance_statutory_packages (id,entity_id,registration_id,period_code,version,status,summary_json,variance_json,prepared_by,prepared_at,reviewed_by,reviewed_at,approval_reference) VALUES (?,?,?,?,1,'reviewed','{}','[]',?,?,?,?,'BOARD-M')")
    .run(`statpkg_${period}`, ENTITY, REG, period, MAKER, Date.now(), CHECKER, Date.now());

const groomingInvoice = (overrides = {}) => ({
  action: "issue_invoice", entityId: ENTITY, customerId: "CUST-CLOSE-1",
  sourceType: "booking", sourceId: "BKG-CLOSE-1", sourceEventKey: "booking:BKG-CLOSE-1:invoice",
  issueDate: "2026-08-12", currency: "INR", reason: "service completed",
  lines: [
    { lineKey: "session-1", description: "Grooming session", serviceCode: "grooming", taxableAmount: 1000 },
    { lineKey: "session-2", description: "Grooming session", serviceCode: "grooming", taxableAmount: 1000 },
  ],
  ...overrides,
});

const taxLedger = (sqlite) =>
  sqlite.prepare("SELECT component,ledger_type,amount,source_event_key,period_code,entity_id FROM finance_tax_ledger ORDER BY source_event_key").all();

async function refusal(promise) {
  try { await promise; return null; }
  catch (error) {
    if (error instanceof Response) return { status: error.status, body: await error.json().catch(() => null) };
    return { message: error instanceof Error ? error.message : String(error) };
  }
}

const gstPost = async (actorEmail, body, extraHeaders = {}) => {
  const headers = { "content-type": "application/json", ...extraHeaders, ...(actorEmail ? { "oai-authenticated-user-email": actorEmail } : {}) };
  const response = await gstRoute.POST(new Request(`${ORIGIN}/api/gst-accounting`, { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json().catch(() => null) };
};

// ---------------------------------------------------------------------------------------------
test("The GST route routes filing actions through the closeout wrappers, not the bare functions", async () => {
  const { sqlite, db } = await closeWorld();
  billWithCredit(sqlite, { key: "mine", entityId: ENTITY, billDate: "2026-08-04", tax: 900 });
  // A bill belonging to the OTHER legal entity, same month. The bare generateStatutoryPackage does not
  // filter by entity; only the Safe wrapper does. So this figure is the proof the wrapper ran — a
  // stronger statement than the old test's `assert.match(route, /generateStatutoryPackageSafe/)`, which
  // the identifier appearing in a comment would have satisfied.
  billWithCredit(sqlite, { key: "theirs", entityId: OTHER_ENTITY, billDate: "2026-08-19", tax: 5000 });

  const viaRoute = await gstPost(MAKER, { action: "generate_statutory_package", entityId: ENTITY, registrationId: REG, periodCode: "2026-08", reason: "monthly close" });
  assert.equal(viaRoute.status, 200, `finance.manage must be allowed through: ${JSON.stringify(viaRoute)}`);
  assert.equal(viaRoute.body?.data?.summary?.eligibleInputTax, 900,
    "the entity-scoped wrapper ran: the other entity's Rs 5,000 of credit is not claimed here");
  // And the recomputed figure is PERSISTED, not just returned — the finance console reads the row.
  const stored = JSON.parse(String(sqlite.prepare("SELECT summary_json FROM finance_statutory_packages WHERE id=?").get(viaRoute.body.data.id).summary_json));
  assert.equal(stored.eligibleInputTax, 900);

  // Every filing-sensitive action reaches its handler through the route and comes back with the
  // not-live disclosure. Each is executed rather than matched.
  activeMapping(sqlite);
  const invoice = await gstPost(MAKER, groomingInvoice());
  assert.equal(invoice.status, 200, `${JSON.stringify(invoice)}`);
  assert.equal(String(invoice.body.data.invoice_number).startsWith("PS/26-27/"), true, "the document series allocated the number");
  const annual = await gstPost(MAKER, { action: "generate_annual_return", entityId: ENTITY, registrationId: REG, financialYear: "2026-27", reason: "annual" });
  assert.equal(annual.status, 200, `${JSON.stringify(annual)}`);
  const exported = await gstPost(MAKER, { action: "generate_accounting_export", entityId: ENTITY, periodCode: "2026-08", target: "tally", reason: "export" });
  assert.equal(exported.status, 200, `${JSON.stringify(exported)}`);
  assert.equal(exported.body.data.productionPost, false, "an export is never posted to the accounting system");
  for (const response of [invoice, annual, exported]) {
    assert.equal(response.body.liveFilingEnabled, false);
    assert.equal(response.body.productionReady, false);
  }

  // A missing configuration is reported as a 409 with the key, not a 500.
  const noMapping = await gstPost(MAKER, { action: "generate_accounting_export", entityId: OTHER_ENTITY, periodCode: "2026-08", reason: "export" });
  assert.equal(noMapping.status, 409);
  assert.deepEqual({ error: noMapping.body.error, key: noMapping.body.configurationKey }, { error: "configuration_required", key: "active_accounting_mapping" });

  // The gates: no identity, and a signed-in role without finance.manage.
  assert.ok([401, 403].includes((await gstPost("", groomingInvoice({ sourceEventKey: "booking:X:invoice" }))).status));
  assert.equal((await gstPost(MANAGER, groomingInvoice({ sourceEventKey: "booking:Y:invoice" }))).status, 403,
    "a manager holds no finance permission and must be refused");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM finance_invoices").get().c), 1, "only the authorised invoice exists");
});

// ---------------------------------------------------------------------------------------------
test("Repeated invoice lines get distinct tax rows through line identity", async () => {
  const { sqlite, db } = await closeWorld();

  // TWO lines with the SAME description, service code and amount, differing only by lineKey. The tax
  // ledger dedupes on source_event_key, so without line identity in that key the second line's tax
  // would be silently dropped by INSERT OR IGNORE and the return would understate the liability.
  const invoice = await closeout.issueInvoiceSafe(db, groomingInvoice(), MAKER);
  assert.equal(Number(invoice.subtotal), 2000);
  assert.equal(Number(invoice.tax_total), 360, "18% of Rs 2,000 across two lines");

  const rows = taxLedger(sqlite);
  assert.equal(rows.length, 4, "two lines times two components is four ledger rows, not two");
  assert.deepEqual(rows.map((row) => String(row.source_event_key)), [
    "booking:BKG-CLOSE-1:invoice:session-1:cgst",
    "booking:BKG-CLOSE-1:invoice:session-1:sgst",
    "booking:BKG-CLOSE-1:invoice:session-2:cgst",
    "booking:BKG-CLOSE-1:invoice:session-2:sgst",
  ], "the event key carries the line identity and the component");
  assert.equal(rows.reduce((sum, row) => sum + Number(row.amount), 0), 360, "and the four rows add to the invoice tax");
  assert.deepEqual([...new Set(rows.map((row) => String(row.period_code)))], ["2026-08"]);
  // The invoice LINES are stored per line key too, so a credit note can name one of them.
  assert.deepEqual(sqlite.prepare("SELECT line_key,tax_amount FROM finance_invoice_lines ORDER BY line_key").all().map((line) => [String(line.line_key), Number(line.tax_amount)]),
    [["session-1", 180], ["session-2", 180]]);

  // REISSUE with the same source event key: the prior invoice comes back and NOTHING is written twice.
  const replay = await closeout.issueInvoiceSafe(db, groomingInvoice(), MAKER);
  assert.equal(String(replay.id), String(invoice.id));
  assert.equal(taxLedger(sqlite).length, 4, "a replayed invoice does not double the tax");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM finance_invoices").get().c), 1);
  // And the document series did not burn a second number on the replay.
  assert.equal(Number(sqlite.prepare("SELECT next_number FROM finance_document_series WHERE id='series_invoice'").get().next_number), 2);

  // A LOCKED period refuses the invoice outright — filing-sensitive writes never land in a closed month.
  sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,updated_at) VALUES ('2026-09','locked','[]',?)").run(Date.now());
  assert.match(String((await refusal(closeout.issueInvoiceSafe(db, groomingInvoice({ sourceEventKey: "booking:LOCKED:invoice", sourceId: "BKG-LOCKED", issueDate: "2026-09-02" }), MAKER)))?.message), /period_locked/);
  assert.equal(taxLedger(sqlite).length, 4, "and writes nothing");

  // A service with no approved classification is a configuration refusal, not an untaxed invoice.
  const unclassified = await refusal(closeout.issueInvoiceSafe(db, groomingInvoice({ sourceEventKey: "booking:TAXI:invoice", sourceId: "BKG-TAXI", lines: [{ lineKey: "trip-1", description: "Pet taxi", serviceCode: "pet_taxi", taxableAmount: 500 }] }), MAKER));
  assert.match(String(unclassified?.message), /configuration_required:tax_classification:pet_taxi/);
  assert.equal(taxLedger(sqlite).length, 4);
  // And an invoice with no lines at all.
  assert.match(String((await refusal(closeout.issueInvoiceSafe(db, groomingInvoice({ sourceEventKey: "booking:EMPTY:invoice", sourceId: "BKG-EMPTY", lines: [] }), MAKER)))?.message), /invoice_lines_required/);
});

// ---------------------------------------------------------------------------------------------
test("Input tax credit is legal-entity scoped in both the monthly and the annual path", async () => {
  const { sqlite, db } = await closeWorld();
  // Same month, same financial year, two legal entities. India may claim its own Rs 900 only.
  billWithCredit(sqlite, { key: "in-aug", entityId: ENTITY, billDate: "2026-08-04", tax: 900 });
  billWithCredit(sqlite, { key: "sg-aug", entityId: OTHER_ENTITY, billDate: "2026-08-19", tax: 5000 });
  billWithCredit(sqlite, { key: "in-dec", entityId: ENTITY, billDate: "2026-12-11", tax: 100 });
  billWithCredit(sqlite, { key: "sg-dec", entityId: OTHER_ENTITY, billDate: "2026-12-11", tax: 7000 });
  // A held review is not credit in either path.
  billWithCredit(sqlite, { key: "in-held", entityId: ENTITY, billDate: "2026-10-01", tax: 4444, status: "held" });

  const monthly = await closeout.generateStatutoryPackageSafe(db, { entityId: ENTITY, registrationId: REG, periodCode: "2026-08", reason: "close" }, MAKER);
  assert.equal(monthly.summary.eligibleInputTax, 900, "the monthly package claims only this entity's August credit");

  const annual = await closeout.generateAnnualReturnSafe(db, { entityId: ENTITY, registrationId: REG, financialYear: "2026-27", reason: "annual" }, MAKER);
  assert.equal(annual.summary.totalEligibleItc, 1000, "the annual return claims Rs 900 + Rs 100, not the other entity's Rs 12,000");
  // netTaxPayable is recomputed from the entity-scoped credit, so the scope reaches the filed figure.
  assert.equal(annual.summary.netTaxPayable, Math.round((annual.summary.totalOutputTax + annual.summary.totalAdjustments - 1000) * 100) / 100);
  const storedAnnual = JSON.parse(String(sqlite.prepare("SELECT summary_json FROM finance_annual_returns WHERE id=?").get(annual.id).summary_json));
  assert.equal(storedAnnual.totalEligibleItc, 1000, "and the persisted row carries the scoped figure");

  // NON-VACUITY: Singapore's own package sees its own credit, so the filter above is a filter and not
  // an empty table.
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,created_at,updated_at) VALUES ('taxreg_sg',?,'SG','gst','SG-GST-1','active','2020-01-01',?,?)")
    .run(OTHER_ENTITY, Date.now(), Date.now());
  const theirs = await closeout.generateStatutoryPackageSafe(db, { entityId: OTHER_ENTITY, registrationId: "taxreg_sg", periodCode: "2026-08", reason: "close" }, MAKER);
  assert.equal(theirs.summary.eligibleInputTax, 5000);
});

// ---------------------------------------------------------------------------------------------
test("Annual approval fails closed until every month has a reviewed monthly return", async () => {
  const { sqlite, db } = await closeWorld();
  const draft = await closeout.generateAnnualReturnSafe(db, { entityId: ENTITY, registrationId: REG, financialYear: "2026-27", reason: "annual" }, MAKER);
  assert.equal(draft.reconciliation.reconciled, false);

  // The approval must refuse while any month is unreviewed, EVEN with a valid checker and reference.
  assert.match(String((await refusal(closeout.approveAnnualReturnSafe(db, { id: draft.id, approvalReference: "BOARD-2027-04" }, CHECKER)))?.message), /annual_reconciliation_not_clean/);
  assert.equal(String(sqlite.prepare("SELECT status FROM finance_annual_returns WHERE id=?").get(draft.id).status), "draft", "and nothing is approved");

  // ELEVEN of twelve still fails closed. The return must be regenerated to pick up the new packages —
  // the reconciliation is a snapshot, and approving an old snapshot is exactly what this guard stops.
  for (const period of ALL_MONTHS.slice(0, 11)) approvedMonthlyPackage(sqlite, period);
  const nearly = await closeout.generateAnnualReturnSafe(db, { entityId: ENTITY, registrationId: REG, financialYear: "2026-27" }, MAKER);
  assert.deepEqual(nearly.reconciliation.monthsMissingApprovedMonthlyReturn, ["2027-03"]);
  assert.match(String((await refusal(closeout.approveAnnualReturnSafe(db, { id: nearly.id, approvalReference: "BOARD-2027-04" }, CHECKER)))?.message), /annual_reconciliation_not_clean/);

  approvedMonthlyPackage(sqlite, "2027-03");
  // The STALE draft still carries its own dirty reconciliation and must still be refused: a clean year
  // does not retroactively clean a return generated before it.
  assert.match(String((await refusal(closeout.approveAnnualReturnSafe(db, { id: draft.id, approvalReference: "BOARD-2027-04" }, CHECKER)))?.message), /annual_reconciliation_not_clean/);

  const clean = await closeout.generateAnnualReturnSafe(db, { entityId: ENTITY, registrationId: REG, financialYear: "2026-27" }, MAKER);
  assert.equal(clean.reconciliation.reconciled, true);
  // Maker/checker still applies on top of reconciliation.
  assert.match(String((await refusal(closeout.approveAnnualReturnSafe(db, { id: clean.id, approvalReference: "BOARD-2027-04" }, MAKER)))?.message), /maker_checker_required/);
  const approved = await closeout.approveAnnualReturnSafe(db, { id: clean.id, approvalReference: "BOARD-2027-04", reason: "board approved" }, CHECKER);
  assert.equal(approved.status, "reviewed");
  assert.equal(approved.liveFilingEnabled, false);
  assert.match(String((await refusal(closeout.approveAnnualReturnSafe(db, { id: "gstr9_nope", approvalReference: "X" }, CHECKER)))?.message), /annual_return_not_found/);
});

// ---------------------------------------------------------------------------------------------
test("The accounting export contains only posted journals for the requested entity and period", async () => {
  const { sqlite, db } = await closeWorld();
  activeMapping(sqlite);
  journal(sqlite, { key: "mine-posted-a", entityId: ENTITY, period: "2026-08", posted: true, debit: 100 });
  journal(sqlite, { key: "mine-posted-b", entityId: ENTITY, period: "2026-08", posted: true, debit: 200 });
  // Each of these three must be absent: unposted, another entity, another period.
  journal(sqlite, { key: "mine-draft", entityId: ENTITY, period: "2026-08", posted: false, debit: 999 });
  journal(sqlite, { key: "theirs-posted", entityId: OTHER_ENTITY, period: "2026-08", posted: true, debit: 888 });
  journal(sqlite, { key: "mine-other-month", entityId: ENTITY, period: "2026-09", posted: true, debit: 777 });

  const exported = await closeout.generateAccountingExportSafe(db, { entityId: ENTITY, periodCode: "2026-08", target: "tally", reason: "monthly export" }, MAKER);
  assert.equal(exported.journalCount, 2, "two posted journals for this entity and month, and nothing else");
  assert.equal(exported.status, "generated");
  assert.equal(exported.productionPost, false);

  // Read the SNAPSHOT back, so the exclusion is proven by what the file would contain.
  const snapshot = JSON.parse(String(sqlite.prepare("SELECT source_snapshot_json FROM accounting_export_runs WHERE id=?").get(exported.id).source_snapshot_json));
  assert.deepEqual(snapshot.journals.map((row) => String(row.id)).sort(), ["jrn_mine-posted-a", "jrn_mine-posted-b"]);
  assert.equal(snapshot.entityId, ENTITY);
  assert.equal(snapshot.period, "2026-08");
  assert.equal(snapshot.target, "tally");

  // IDEMPOTENT by checksum: re-exporting the same content returns the same run rather than a second one.
  const again = await closeout.generateAccountingExportSafe(db, { entityId: ENTITY, periodCode: "2026-08", target: "tally", reason: "monthly export" }, MAKER);
  assert.equal(String(again.id), String(exported.id));
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM accounting_export_runs").get().c), 1);
  // But a NEW posted journal changes the checksum and therefore is a new run — an export must not go
  // stale silently.
  journal(sqlite, { key: "mine-posted-c", entityId: ENTITY, period: "2026-08", posted: true, debit: 300 });
  const refreshed = await closeout.generateAccountingExportSafe(db, { entityId: ENTITY, periodCode: "2026-08", target: "tally", reason: "monthly export" }, MAKER);
  assert.notEqual(String(refreshed.id), String(exported.id));
  assert.equal(refreshed.journalCount, 3);

  // Scope is mandatory, and a missing mapping is a configuration refusal rather than an empty export.
  assert.match(String((await refusal(closeout.generateAccountingExportSafe(db, { periodCode: "2026-08" }, MAKER)))?.message), /accounting_export_scope_required/);
  assert.match(String((await refusal(closeout.generateAccountingExportSafe(db, { entityId: ENTITY, periodCode: "August" }, MAKER)))?.message), /accounting_export_scope_required/);
  assert.match(String((await refusal(closeout.generateAccountingExportSafe(db, { entityId: OTHER_ENTITY, periodCode: "2026-08" }, MAKER)))?.message), /configuration_required:active_accounting_mapping/);

  // Every export writes an audit row naming the actor and disclosing that nothing was posted.
  const audit = sqlite.prepare("SELECT actor_id,action,after_json FROM gst_accounting_audit_events WHERE entity_id=?").get(exported.id);
  assert.equal(String(audit.actor_id), MAKER);
  assert.equal(String(audit.action), "generated");
  assert.equal(JSON.parse(String(audit.after_json)).productionPost, false);
});

// ---------------------------------------------------------------------------------------------
test("Finance approvals use the authenticated actor and refuse the maker", async () => {
  const { sqlite, db } = await closeWorld();
  const patch = async (actorEmail, body, extraHeaders = {}) => {
    const headers = { "content-type": "application/json", ...extraHeaders, ...(actorEmail ? { "oai-authenticated-user-email": actorEmail } : {}) };
    const response = await financeRoute.PATCH(new Request(`${ORIGIN}/api/finance-control`, { method: "PATCH", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const post = async (actorEmail, body) => {
    const headers = { "content-type": "application/json", ...(actorEmail ? { "oai-authenticated-user-email": actorEmail } : {}) };
    const response = await financeRoute.POST(new Request(`${ORIGIN}/api/finance-control`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // MAKER creates an expense. created_by is taken from the session, not the body — the body tries to
  // claim someone else and must be ignored.
  const created = await post(MAKER, { entity: "expense", expenseDate: "2026-08-04", merchant: "Shell", category: "Travel & fuel", amount: 2840, gstAmount: 433, createdBy: CHECKER, claimant: "Someone Else" });
  assert.equal(created.status, 201, `${JSON.stringify(created)}`);
  const expenseId = created.body.data.id;
  assert.equal(String(sqlite.prepare("SELECT created_by FROM finance_expenses WHERE id=?").get(expenseId).created_by), MAKER,
    "the maker recorded is the authenticated actor, never a body field");

  // The gates: no identity at all, and a signed-in role without finance.manage.
  assert.ok([401, 403].includes((await post("", { entity: "expense", expenseDate: "2026-08-04", merchant: "X", category: "Y", amount: 10 })).status));
  assert.equal((await post(MANAGER, { entity: "expense", expenseDate: "2026-08-04", merchant: "X", category: "Y", amount: 10 })).status, 403);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM finance_expenses").get().c), 1, "only the authorised expense exists");

  // A reason is mandatory on every state change.
  assert.equal((await patch(MAKER, { entity: "expense", id: expenseId, action: "approve" })).status, 400);
  assert.equal((await patch(MAKER, { entity: "expense", id: expenseId, action: "approve", reason: "ok" })).status, 400, "and must actually say something");

  /*
   * MAKER CANNOT APPROVE their own expense — 403, and no journal is posted.
   *
   * SABOTAGE NOTE. Deleting the route's early 403 does not redden this, and that is correct: the guard
   * is enforced twice. The claim insert in approveWithJournal carries
   * `(created_by IS NULL OR created_by<>?)` bound to the actor, so the claim takes no rows and the
   * fallback raises `maker_cannot_approve`, which the route's catch maps to the same 403 and the same
   * message. Removing either layer alone is observationally identical; the SQL-level one is the
   * decisive one. Recorded as an equivalent mutation.
   */
  const selfApproval = await patch(MAKER, { entity: "expense", id: expenseId, action: "approve", reason: "approving my own claim" });
  assert.equal(selfApproval.status, 403, `${JSON.stringify(selfApproval)}`);
  assert.match(String(selfApproval.body.error), /Maker cannot approve their own transaction/);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries").get().c), 0, "a refused approval posts nothing");
  assert.equal(String(sqlite.prepare("SELECT status FROM finance_expenses WHERE id=?").get(expenseId).status), "submitted");

  // A DIFFERENT finance actor approves, and the double entry lands, balanced and posted.
  const approved = await patch(CHECKER, { entity: "expense", id: expenseId, action: "approve", reason: "receipt verified against the card statement" });
  assert.equal(approved.status, 200, `${JSON.stringify(approved)}`);
  assert.equal(approved.body.data.status, "approved");
  const lines = sqlite.prepare("SELECT entity_id,account_code,debit,credit,period_code,posted FROM finance_journal_entries ORDER BY id").all();
  assert.equal(lines.length, 2);
  assert.equal(lines.reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0), 0, "the posted journal balances");
  assert.deepEqual([...new Set(lines.map((line) => String(line.period_code)))], ["2026-08"], "and is dated in the expense's month");
  assert.deepEqual([...new Set(lines.map((line) => Number(line.posted)))], [1]);
  assert.deepEqual([...new Set(lines.map((line) => String(line.entity_id)))], [ENTITY], "carrying the legal entity the closeout wrapper added");

  // Re-approval is a no-op, not a second journal: the posting claim is single-use.
  const twice = await patch(CHECKER, { entity: "expense", id: expenseId, action: "approve", reason: "approving again by mistake" });
  assert.equal(twice.status, 200);
  assert.equal(twice.body.data.duplicatePrevented, true);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries").get().c), 2, "still two lines, not four");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_posting_claims").get().c), 1);
  // And an approved expense can no longer be rejected.
  assert.equal((await patch(CHECKER, { entity: "expense", id: expenseId, action: "reject", reason: "changed my mind about it" })).status, 409);

  /*
   * THE REAL RACE, not a stand-in for one. Two approvals of ONE expense that both read status
   * 'submitted' must produce ONE journal.
   *
   * A `Promise.all` of two PATCH calls would not test this: statements against this shim are
   * synchronous, so the first call runs to completion — including its status transition — before the
   * second starts, and the second is then just an ordinary duplicate. The hook below fires a competing
   * approval in the exact gap between the first call CLAIMING the posting and APPLYING the transition,
   * which is where the double-post lives. The PRIMARY KEY on
   * finance_journal_posting_claims(source_type,source_id) is what refuses the second claim; without it
   * the competitor writes its own token and posts a second pair of journal lines against the same
   * expense.
   */
  const raced = await post(MAKER, { entity: "expense", expenseDate: "2026-08-06", merchant: "Indian Oil", category: "Travel & fuel", amount: 1200, gstAmount: 183 });
  assert.equal(raced.status, 201);
  const racedId = raced.body.data.id;
  let competitor = null;
  db.onSql("SET status='approved',updated_at=? WHERE id=? AND status NOT IN", async () => {
    competitor = await patch(CHECKER, { entity: "expense", id: racedId, action: "approve", reason: "competing approval in the claim gap" });
  });
  const winner = await patch(CHECKER, { entity: "expense", id: racedId, action: "approve", reason: "first approval of the fuel claim" });
  assert.ok(competitor, "the competing approval must actually have run inside the claim gap");
  assert.deepEqual([winner.status, competitor.status].sort(), [200, 409],
    `exactly one approval may win: ${JSON.stringify([winner, competitor])}`);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries WHERE source_id=?").get(racedId).c), 2,
    "one expense, one balanced journal — never two");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_posting_claims WHERE source_id=?").get(racedId).c), 1);
  assert.equal(String(sqlite.prepare("SELECT status FROM finance_expenses WHERE id=?").get(racedId).status), "approved");
  /*
   * SABOTAGE NOTE. Unbinding the journal-line inserts from the claim TOKEN (matching any claim row for
   * the source instead) does not redden this. It cannot: the competitor's claim insert fails on the
   * PRIMARY KEY first and rolls its whole batch back, so it never reaches its journal inserts at all.
   * The token is a second layer behind the key. Recorded as an equivalent mutation.
   */

  // Cross-origin writes are blocked outright.
  assert.equal((await patch(CHECKER, { entity: "expense", id: expenseId, action: "approve", reason: "cross origin attempt" }, { origin: "https://evil.example" })).status, 403);
});

// ---------------------------------------------------------------------------------------------
test("A locked period refuses finance writes and approvals atomically", async () => {
  const { sqlite, db } = await closeWorld();
  const patch = async (actorEmail, body) => {
    const response = await financeRoute.PATCH(new Request(`${ORIGIN}/api/finance-control`, {
      method: "PATCH", headers: { "content-type": "application/json", "oai-authenticated-user-email": actorEmail }, body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const post = async (actorEmail, body) => {
    const response = await financeRoute.POST(new Request(`${ORIGIN}/api/finance-control`, {
      method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": actorEmail }, body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // A bill dated in July, created before the lock.
  const bill = await post(MAKER, { entity: "bill", vendorId: "ven_food", billNumber: "HTF-882", billDate: "2026-07-28", dueDate: "2026-08-12", taxableAmount: 48000, gstAmount: 8640, totalAmount: 56640 });
  assert.equal(bill.status, 201, `${JSON.stringify(bill)}`);
  const billId = bill.body.data.id;

  // NON-VACUITY: while July is open the approval succeeds and posts.
  const openApproval = await patch(CHECKER, { entity: "bill", id: billId, action: "approve", reason: "goods received note matched" });
  assert.equal(openApproval.status, 200, `${JSON.stringify(openApproval)}`);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries").get().c), 2);

  // LOCK July through the real route, as a person would.
  const locked = await patch(CHECKER, { entity: "period", id: "2026-07", action: "lock", reason: "July close signed off" });
  assert.equal(locked.status, 200);
  assert.equal(String(sqlite.prepare("SELECT status,locked_by FROM finance_close_periods WHERE period_code='2026-07'").get().locked_by), CHECKER);

  // A NEW bill dated into the locked month is refused 409 and written nowhere.
  const intoLocked = await post(MAKER, { entity: "bill", vendorId: "ven_food", billNumber: "HTF-883", billDate: "2026-07-29", dueDate: "2026-08-12", taxableAmount: 1000, gstAmount: 180, totalAmount: 1180 });
  assert.equal(intoLocked.status, 409);
  assert.equal(String(intoLocked.body.error), "period_locked");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM finance_bills WHERE bill_number='HTF-883'").get().c), 0);
  // An expense too.
  assert.equal((await post(MAKER, { entity: "expense", expenseDate: "2026-07-15", merchant: "Shell", category: "Travel & fuel", amount: 100, gstAmount: 0 })).status, 409);

  // And an APPROVAL of a July bill created before the lock is refused, with no journal posted. This is
  // the atomic half: the claim insert carries the NOT-EXISTS-locked condition, so the refusal and the
  // posting cannot disagree.
  const second = await post(MAKER, { entity: "bill", vendorId: "ven_food", billNumber: "HTF-884", billDate: "2026-08-01", dueDate: "2026-08-20", taxableAmount: 2000, gstAmount: 360, totalAmount: 2360 });
  assert.equal(second.status, 201);
  sqlite.prepare("UPDATE finance_bills SET bill_date='2026-07-30' WHERE id=?").run(second.body.data.id);
  const lateApproval = await patch(CHECKER, { entity: "bill", id: second.body.data.id, action: "approve", reason: "approving into a closed month" });
  assert.equal(lateApproval.status, 409, `an approval into a locked month must be refused: ${JSON.stringify(lateApproval)}`);
  assert.equal(String(lateApproval.body.error), "period_locked");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_entries").get().c), 2, "still only the pre-lock journal");
  assert.equal(String(sqlite.prepare("SELECT status FROM finance_bills WHERE id=?").get(second.body.data.id).status), "draft",
    "and the bill is not marked approved either");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM finance_journal_posting_claims WHERE source_id=?").get(second.body.data.id).c), 0,
    "no posting claim was taken, so a later retry is still possible once the period reopens");
});
