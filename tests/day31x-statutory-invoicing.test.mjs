/*
 * Day-31 wave 7: statutory invoicing - the GST document series and the tax on each line.
 *
 * tax policy + registration -> classification -> place of supply -> serial -> invoice + tax ledger.
 *
 * lib/statutory-invoicing.ts had no test importing it. This issues the legal document a customer
 * is given and the tax ledger a return is filed from, so its failures are the kind you learn about
 * from a notice: a duplicated or skipped invoice number in a series that must be continuous, tax
 * computed from a rate nobody configured, or an invoice written into a period already closed and
 * filed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31X_SINV_DB__", "__D31X_SINV_ENV__");

const ENTITY = "PAWSPACE-IN";
const GSTIN = "29AABCP1234C1ZX";          // 29 = Karnataka
const CUSTOMER = "CUS-SINV-001";
const ACTOR = "finance@pawspace.in";
const DATE = "2026-09-15";
const FY = "2026-27";

async function seedStatutory({ padding = 6, prefix = "PS/26-27/" } = {}) {
  const { sqlite, db } = world("__D31X_SINV_DB__", "__D31X_SINV_ENV__");
  const inv = await import("../lib/statutory-invoicing.ts");
  await inv.ensureStatutoryInvoiceTables(db);
  const now = Date.now();

  sqlite.prepare("INSERT INTO tax_policy_versions (id,entity_id,version,status,effective_from,effective_to,policy_json,approved_by,approved_at,created_at,updated_at) VALUES ('POL-1',?,1,'active','2026-04-01',NULL,'{}',?,?,?,?)")
    .run(ENTITY, ACTOR, now, now, now);
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES ('REG-1',?,'IN-29','gst',?,'active','2026-04-01',NULL,?,?,?,?)")
    .run(ENTITY, GSTIN, ACTOR, now, now, now);
  sqlite.prepare("INSERT INTO tax_classifications (id,policy_id,service_code,classification_code,place_of_supply_rule,input_tax_rule,tax_component_json,created_at) VALUES ('TC-1','POL-1','grooming','998729','performance_based','eligible',?,?)")
    // The classification declares the tax ONCE. componentsForSupply() sums the GST components to
    // a single rate and derives the intra split (CGST+SGST) or the inter form (IGST) from it -
    // listing all three would declare 36%, not 18%.
    .run(JSON.stringify([{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }]), now);

  await inv.saveStatutorySeries(db, {
    entityId: ENTITY, gstin: GSTIN, documentType: "invoice", financialYear: FY,
    prefix, padding, policyId: "POL-1",
  }, ACTOR);
  return { sqlite, db, inv };
}

let evt = 0;
const issue = (inv, db, overrides = {}) => inv.issueInvoiceStatutory(db, {
  entityId: ENTITY, customerId: CUSTOMER, issueDate: DATE,
  sourceType: "booking", sourceId: `BK-${++evt}`, sourceEventKey: `evt-${evt}`,
  serviceState: "29", recipientState: "29", currency: "INR",
  lines: [{ lineKey: "1", description: "Grooming", serviceCode: "grooming", taxableAmount: 1000 }],
  reason: "Day-31 statutory invoice", ...overrides,
}, ACTOR);

test("an intra-state supply is taxed CGST + SGST and never IGST as well", async () => {
  const { sqlite, db, inv } = await seedStatutory();
  const invoice = await issue(inv, db);
  assert.equal(Number(invoice.subtotal), 1000);
  assert.equal(Number(invoice.tax_total), 180, "9% + 9% on Rs 1,000");
  assert.equal(Number(invoice.total), 1180);

  const components = sqlite.prepare("SELECT component,amount FROM finance_tax_ledger WHERE source_id=? ORDER BY component").all(invoice.id);
  assert.deepEqual(components.map((c) => c.component), ["CGST", "SGST"],
    "an intra-state supply must not also post IGST");
  assert.equal(components.reduce((s, c) => s + Number(c.amount), 0), 180,
    "the ledger must post exactly the tax the invoice charged");
});

test("an inter-state supply is taxed IGST and never CGST/SGST as well", async () => {
  const { sqlite, db, inv } = await seedStatutory();
  const invoice = await issue(inv, db, { serviceState: "27", recipientState: "27" });   // Maharashtra
  const components = sqlite.prepare("SELECT component,amount FROM finance_tax_ledger WHERE source_id=? ORDER BY component").all(invoice.id);
  assert.deepEqual(components.map((c) => c.component), ["IGST"]);
  assert.equal(Number(invoice.tax_total), 180, "18% IGST is the same total, split differently");
});

test("a tax head is filed under ONE code however its classification was authored", async () => {
  /*
   * These codes go straight into finance_tax_ledger.component, and both gst-returns.ts and
   * gst-accounting.ts summarise a return with `GROUP BY component`. SQLite groups TEXT
   * case-sensitively and the column has no COLLATE NOCASE, so a mixture splits one tax head
   * across two lines of a GST return.
   *
   * The mixture came from the classification's own spelling, not from anything the caller
   * controls: listing CGST+SGST gave "CGST","SGST" intra but a derived lowercase "igst" inter,
   * while listing IGST gave "IGST" inter but derived lowercase "cgst","sgst" intra. Two services
   * taxed identically filed under differently-cased heads.
   */
  const { componentsForSupply } = await import("../lib/tax-pos-resolver.ts");
  const authorings = [
    ["CGST+SGST", [{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }]],
    ["IGST only", [{ code: "IGST", rate: 18 }]],
    ["lower case", [{ code: "cgst", rate: 9 }, { code: "sgst", rate: 9 }]],
    ["mixed case", [{ code: "Cgst", rate: 9 }, { code: "Sgst", rate: 9 }]],
  ];
  for (const [label, configured] of authorings) {
    assert.deepEqual(componentsForSupply(configured, "intra").map((c) => c.code), ["CGST", "SGST"],
      `intra-state heads must be canonical however the classification was authored (${label})`);
    assert.deepEqual(componentsForSupply(configured, "inter").map((c) => c.code), ["IGST"],
      `inter-state head must be canonical however the classification was authored (${label})`);
    assert.equal(componentsForSupply(configured, "intra").reduce((s, c) => s + c.rate, 0), 18,
      `${label}: canonicalising the code must not change the rate`);
    assert.equal(componentsForSupply(configured, "inter").reduce((s, c) => s + c.rate, 0), 18);
  }

  const withCess = componentsForSupply([{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }, { code: "PetCess", rate: 1 }], "inter");
  assert.deepEqual(withCess.map((c) => c.code), ["IGST", "PetCess"],
    "a non-GST component keeps the code it was configured with");
});

test("the invoice number series is continuous, unique and correctly padded", async () => {
  const { sqlite, db, inv } = await seedStatutory({ padding: 6, prefix: "PS/26-27/" });
  const numbers = [];
  for (let i = 0; i < 5; i++) numbers.push((await issue(inv, db)).invoice_number);

  assert.deepEqual(numbers, ["PS/26-27/000001", "PS/26-27/000002", "PS/26-27/000003", "PS/26-27/000004", "PS/26-27/000005"],
    "a GST series must be consecutive with no gap and no repeat");
  assert.equal(new Set(numbers).size, 5);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM finance_invoice_serial_claims WHERE financial_year=?").get(FY).n, 5,
    "every serial must be claimed exactly once",
  );
});

test("the same source event issues one invoice, not two", async () => {
  /*
   * The upstream money event retries. A second invoice for the same event would be a duplicate
   * legal document against one supply, and would consume a serial that can never be explained.
   */
  const { sqlite, db, inv } = await seedStatutory();
  const first = await issue(inv, db, { sourceEventKey: "evt-fixed" });
  const second = await issue(inv, db, { sourceEventKey: "evt-fixed" });
  assert.equal(second.id, first.id);
  assert.equal(second.invoice_number, first.invoice_number);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices").get().n, 1);
  assert.equal(sqlite.prepare("SELECT next_number FROM finance_document_series_v2").get().next_number, 2,
    "a replay must not burn a second serial");
});

test("no invoice may be written into a period that is already closed", async () => {
  const { sqlite, db, inv } = await seedStatutory();
  sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES ('2026-09','locked','{}',?,?,?)")
    .run(Date.now(), ACTOR, Date.now());
  await assert.rejects(() => issue(inv, db), /period_locked/,
    "a filed period is closed - a late invoice must be refused, not slipped in");
});

test("an unconfigured tax rate is refused rather than charged as zero", async () => {
  /*
   * The dangerous default. Falling back to 0% on an unknown service would issue a legal document
   * understating tax, and the platform would owe the difference regardless.
   */
  const { sqlite, db, inv } = await seedStatutory();
  await assert.rejects(
    () => issue(inv, db, { lines: [{ lineKey: "1", description: "Boarding", serviceCode: "boarding", taxableAmount: 1000 }] }),
    /tax_classification/,
    "a service with no classification must stop the invoice",
  );

  sqlite.prepare("INSERT INTO tax_classifications (id,policy_id,service_code,classification_code,place_of_supply_rule,input_tax_rule,tax_component_json,created_at) VALUES ('TC-BAD','POL-1','boarding','998729','performance_based','eligible',?,?)")
    .run(JSON.stringify([{ code: "CGST" }]), Date.now());
  await assert.rejects(
    () => issue(inv, db, { lines: [{ lineKey: "1", description: "Boarding", serviceCode: "boarding", taxableAmount: 1000 }] }),
    /tax_component_rate/,
    "a component with no rate is not a rate of zero",
  );
});

test("an invoice cannot be issued without an active policy and a valid supplier GSTIN", async () => {
  const { sqlite, db, inv } = await seedStatutory();
  sqlite.exec("UPDATE tax_registrations SET status='inactive'");
  await assert.rejects(() => issue(inv, db), /active_tax_registration/);

  sqlite.exec("UPDATE tax_registrations SET status='active',registration_reference='NOT-A-GSTIN'");
  await assert.rejects(() => issue(inv, db), /valid_supplier_gstin/,
    "a document carrying an invalid GSTIN is not a tax invoice");

  sqlite.exec("UPDATE tax_registrations SET registration_reference='29AABCP1234C1ZX'");
  sqlite.exec("UPDATE tax_policy_versions SET status='superseded'");
  await assert.rejects(() => issue(inv, db), /active_tax_policy/);
});

test("a series that cannot produce a legal number is refused when it is SAVED", async () => {
  /*
   * A GST invoice number is capped at 16 characters. Catching that at issue time would mean
   * discovering it with a customer waiting; the series definition is refused up front instead.
   */
  const { db, inv } = await seedStatutory();
  for (const [label, prefix, padding] of [
    ["too long overall", "PAWSPACE/INVOICES/2026-27/", 6],
    ["padding of zero", "PS/", 0],
    ["padding beyond 12", "PS/", 13],
    ["illegal characters", "PS INV#", 6],
  ]) {
    await assert.rejects(
      () => inv.saveStatutorySeries(db, { entityId: ENTITY, gstin: GSTIN, documentType: "invoice", financialYear: FY, prefix, padding, policyId: "POL-1" }, ACTOR),
      Error,
      `a series that is ${label} must be refused at definition time`,
    );
  }
  await assert.rejects(
    () => inv.saveStatutorySeries(db, { entityId: ENTITY, gstin: "NOT-A-GSTIN", documentType: "invoice", financialYear: FY, prefix: "PS/", padding: 6, policyId: "POL-1" }, ACTOR),
    /invalid_gstin/,
  );
  await assert.rejects(
    () => inv.saveStatutorySeries(db, { entityId: ENTITY, gstin: GSTIN, documentType: "invoice", financialYear: "2026", prefix: "PS/", padding: 6, policyId: "POL-1" }, ACTOR),
    /invalid_financial_year/,
  );
});

test("an issued invoice number can never be voided and reused", async () => {
  /*
   * A void exists to explain a gap in the series, not to recycle a number. Reissuing a number
   * already given to a customer would put two different supplies under one invoice number.
   */
  const { db, inv } = await seedStatutory();
  const issued = await issue(inv, db);
  await assert.rejects(
    () => inv.voidInvoiceSerial(db, {
      entityId: ENTITY, gstin: GSTIN, documentType: "invoice", financialYear: FY,
      invoiceNumber: issued.invoice_number, serialNumber: 1,
      reason: "Day-31 attempt to recycle an issued number",
    }, ACTOR),
    /issued_invoice_number_cannot_be_voided/,
  );
  await assert.rejects(
    () => inv.voidInvoiceSerial(db, {
      entityId: ENTITY, gstin: GSTIN, documentType: "invoice", financialYear: FY,
      invoiceNumber: "PS/26-27/000999", serialNumber: 999, reason: "short",
    }, ACTOR),
    /void_reason_required/,
    "a gap in a statutory series must be explained",
  );
});

test("the financial year is India's, not the calendar year, and each one needs its own series", async () => {
  /*
   * A GST series restarts each financial year, and India's runs April to March. Issuing into a
   * year with no series defined must be refused rather than silently continuing last year's
   * numbering - a number from the wrong year is a defective invoice.
   */
  const { db, inv } = await seedStatutory();
  const march = await issue(inv, db, { issueDate: "2027-03-31", sourceEventKey: "evt-march" });
  assert.match(String(march.tax_snapshot_json), /"financial_year":"2026-27"/, "31 March is still FY 2026-27");

  await assert.rejects(
    () => issue(inv, db, { issueDate: "2027-04-01", sourceEventKey: "evt-april" }),
    /invoice_series/,
    "1 April starts a new financial year, and it has no series yet",
  );

  await inv.saveStatutorySeries(db, {
    entityId: ENTITY, gstin: GSTIN, documentType: "invoice", financialYear: "2027-28",
    prefix: "PS/27-28/", padding: 6, policyId: "POL-1",
  }, ACTOR);
  const april = await issue(inv, db, { issueDate: "2027-04-01", sourceEventKey: "evt-april-2" });
  assert.match(String(april.tax_snapshot_json), /"financial_year":"2027-28"/);
  assert.equal(april.invoice_number, "PS/27-28/000001",
    "the new year's series starts at one rather than continuing the old one");
});

test("an issue date that is not a date cannot produce an invoice number", async () => {
  const { db, inv } = await seedStatutory();
  for (const issueDate of ["2026-13-01", "not-a-date", "2026", ""]) {
    await assert.rejects(
      () => issue(inv, db, { issueDate, sourceEventKey: `evt-bad-${issueDate}` }),
      Error,
      `"${issueDate}" must not resolve to a financial year`,
    );
  }
});
