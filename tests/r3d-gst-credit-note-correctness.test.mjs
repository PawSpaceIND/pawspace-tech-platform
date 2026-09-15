/*
 * R3-D / F3 - GSTR-3B ignored credit notes; the annual return did not. [P1, tax correctness]
 *
 * One entity, one registration, one month. A canonical invoice of Rs 10,000 (CGST 9% + SGST 9% =
 * 1,800) and one credit note of Rs 2,000 + Rs 360 tax against it.
 *
 *   generate_gstr3b   ->  totalOutputTax 1800, netTaxPayable 1800      <- WRONG, the month is filed on this
 *   monthly close     ->  gst.netPayable    1800                       <- WRONG, agrees with the wrong number
 *   generate_gstr1    ->  cdnurCount 1                                 <- GSTR-1 DOES see the note
 *   annual return     ->  totalAdjustments -360, netTaxPayable 1440    <- right
 *
 * Root cause, in source: lib/gst-returns.ts generateGstr3b summed finance_tax_ledger rows with
 * ledger_type='output' only, while lib/gst-accounting.ts generateAnnualReturn reads 'output' AND
 * 'adjustment'. issueAdjustment posts a credit note as a NEGATIVE 'adjustment' row. So the monthly
 * return - the one tax is actually paid on - overstated output tax by the full value of every credit
 * note and disagreed with the annual return built from the very same ledger.
 *
 * Everything below EXECUTES the real engines against a real SQLite-backed D1: the invoice and the
 * credit note are issued through issueInvoice/issueAdjustment, so the ledger rows are the ones
 * production writes, not fixtures shaped to suit the assertion.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__R3D_GST_DB__");

const accounting = await import("../lib/gst-accounting.ts");
const returns = await import("../lib/gst-returns.ts");
const close = await import("../lib/finance-monthly-close.ts");

const ENTITY = "ent_r3d";
const REGISTRATION = "taxreg_r3d";
const POLICY = "taxpol_r3d";
const GSTIN = "29AABCP1234A1Z5";
const PERIOD = "2026-09";
const ISSUE_DATE = "2026-09-08";
const FY = "2026";
const MAKER = "r3d.maker@pawspace.test";
const round2 = (v) => Math.round(v * 100) / 100;

/** Tables the close and the return generators read but do not own. DDL copied from the owning modules. */
function schema(sqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT, city_id TEXT, scheduled_start TEXT, status TEXT, total_amount REAL);
    CREATE TABLE IF NOT EXISTS food_orders (id TEXT PRIMARY KEY, status TEXT, total_amount REAL, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,invoice_number TEXT,status TEXT,currency TEXT,gross_amount REAL,tax_amount REAL,net_amount REAL,issued_at INTEGER,created_at INTEGER,updated_at INTEGER);
  `);
}

function seedConfiguration(sqlite) {
  const now = Date.UTC(2026, 8, 1);
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,'active',?,?,?,?)")
    .run(ENTITY, "PawSpace India Pvt Ltd", "IN", "board", now, now, now);
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'KA','GSTIN',?,'active','2026-04-01',NULL,'board',?,?,?)")
    .run(REGISTRATION, ENTITY, GSTIN, now, now, now);
  sqlite.prepare("INSERT INTO tax_policy_versions (id,entity_id,version,status,effective_from,effective_to,policy_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES (?,?,1,'active','2026-04-01',NULL,?,?,?,?,?,?)")
    .run(POLICY, ENTITY, JSON.stringify({ regime: "gst_in" }), "BOARD-2026-01", "board", now, now, now);
  sqlite.prepare("INSERT INTO tax_classifications (id,policy_id,service_code,classification_code,tax_component_json,place_of_supply_rule,input_tax_rule,created_at) VALUES ('cls_r3d',?,'pet_grooming','SAC998729',?,'service_location','eligible',?)")
    .run(POLICY, JSON.stringify([{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }]), now);
  for (const [documentType, prefix] of [["invoice", "PS/26-27/"], ["credit_note", "CN/26-27/"], ["debit_note", "DN/26-27/"]]) {
    sqlite.prepare("INSERT INTO finance_document_series (id,entity_id,document_type,prefix,next_number,padding,policy_id,status,updated_at) VALUES (?,?,?,?,1,6,?,'active',?)")
      .run(`ser_${documentType}`, ENTITY, documentType, prefix, POLICY, now);
  }
  sqlite.prepare("INSERT INTO finance_customer_tax_profiles (customer_id,registration_reference,customer_type,place_of_supply,status,updated_at) VALUES ('CUST-R3D',NULL,'consumer','29','approved',?)").run(now);
}

/** The exact scenario the runtime audit drove: one Rs 10,000 invoice, one Rs 2,000 + Rs 360 credit note. */
async function world() {
  const harness = freshCountingD1();
  globalThis.__R3D_GST_DB__ = harness.db;
  await accounting.ensureGstAccountingTables(harness.db);
  await returns.ensureGstReturnTables(harness.db);
  schema(harness.sqlite);
  seedConfiguration(harness.sqlite);

  const invoice = await accounting.issueInvoice(harness.db, {
    entityId: ENTITY, customerId: "CUST-R3D", sourceType: "booking", sourceId: "BKG-R3D",
    sourceEventKey: "evt_r3d_invoice", issueDate: ISSUE_DATE,
    lines: [{ lineKey: "1", description: "Grooming package", serviceCode: "pet_grooming", taxableAmount: 10_000 }],
    reason: "September grooming package",
  }, MAKER);
  assert.equal(Number(invoice.subtotal), 10_000);
  assert.equal(Number(invoice.tax_total), 1_800, "CGST 9% + SGST 9% on an intra-state Karnataka supply");

  const note = await accounting.issueAdjustment(harness.db, {
    invoiceId: String(invoice.id), kind: "credit_note", sourceEventKey: "evt_r3d_credit_note",
    amount: 2_000, taxAmount: 360, reason: "Partial cancellation of the September package",
  }, MAKER);
  assert.equal(Number(note.tax_amount), 360);
  assert.equal(String(note.status), "issued");

  // The ledger truth both returns are built from, asserted before either generator runs.
  const ledger = harness.sqlite.prepare("SELECT ledger_type,ROUND(SUM(amount),2) total FROM finance_tax_ledger GROUP BY ledger_type ORDER BY ledger_type").all().map((r) => ({ ...r }));
  assert.deepEqual(ledger, [{ ledger_type: "adjustment", total: -360 }, { ledger_type: "output", total: 1800 }]);

  return { ...harness, invoice, note };
}

test("F3 GSTR-3B nets the month's credit notes, so the return the tax is paid on is 1440 not 1800", async () => {
  const w = await world();

  const r3b = await returns.generateGstr3b(w.db, { entityId: ENTITY, registrationId: REGISTRATION, periodCode: PERIOD }, MAKER);
  assert.equal(r3b.summary.adjustments, -360, "the month's credit notes must appear on the 3B summary");
  assert.equal(r3b.summary.netTaxPayable, 1440, "1800 output - 360 credit note - 0 ITC");
  assert.equal(r3b.summary.totalOutputTax, 1440, "output tax net of the period's credit notes");

  // The portal payload must be internally consistent: table 3.1(a) is net of credit/debit notes, and
  // its component heads must still add up to the liability being declared.
  const osup = r3b.payload.sup_details.osup_det;
  assert.equal(Math.round((osup.iamt + osup.camt + osup.samt + osup.csamt) * 100) / 100, 1440);
  assert.equal(osup.camt, 720, "CGST 900 less its half of the 360 credit note");
  assert.equal(osup.samt, 720, "SGST 900 less its half of the 360 credit note");
  assert.equal(Math.round(osup.txval * 100) / 100, 8_000, "taxable value net of the Rs 2,000 credit note");
});

test("F3 GSTR-3B and the GSTR-9 annual return agree on the same books", async () => {
  const w = await world();

  const r3b = await returns.generateGstr3b(w.db, { entityId: ENTITY, registrationId: REGISTRATION, periodCode: PERIOD }, MAKER);
  const annual = await accounting.generateAnnualReturn(w.db, { entityId: ENTITY, registrationId: REGISTRATION, financialYear: FY, reason: "FY close" }, MAKER);

  assert.equal(annual.summary.totalAdjustments, -360);
  assert.equal(annual.summary.netTaxPayable, 1440);
  assert.equal(
    r3b.summary.netTaxPayable, annual.summary.netTaxPayable,
    "the monthly return and the annual return are built from the same ledger and must not disagree",
  );
  assert.equal(annual.summary.totalAdjustments, r3b.summary.adjustments,
    "and both read the same credit note out of the same ledger");
  // GSTR-9 keeps output tax GROSS and discloses totalAdjustments beside it; GSTR-3B declares table
  // 3.1(a) net, as the portal form requires. Different presentation, one set of books - so the figure
  // that must reconcile is the money: for a financial year whose only activity is this month, the
  // annual liability IS the month's liability.
  assert.equal(
    round2(annual.summary.totalOutputTax + annual.summary.totalAdjustments),
    r3b.summary.totalOutputTax,
    "gross output plus adjustments (GSTR-9) is the net output GSTR-3B declares",
  );
});

test("F3 the monthly close's GSTR-3B net payable is the same 1440 the return declares", async () => {
  const w = await world();

  const r3b = await returns.generateGstr3b(w.db, { entityId: ENTITY, registrationId: REGISTRATION, periodCode: PERIOD }, MAKER);
  const view = await close.monthlyCloseView(w.db, { period: PERIOD, actorId: MAKER });

  assert.equal(view.gst.netPayable, 1440, "the close must not lock the month on an overstated liability");
  assert.equal(view.gst.netPayable, r3b.summary.netTaxPayable);
  const gstCheck = view.checklist.find((item) => item.key === "gst_computed");
  assert.equal(gstCheck.value, 1440, "the operator-visible checklist figure is the corrected one");
});

test("F3 a debit note increases the month's liability, by the same ledger rule", async () => {
  const w = await world();
  await accounting.issueAdjustment(w.db, {
    invoiceId: String(w.invoice.id), kind: "debit_note", sourceEventKey: "evt_r3d_debit_note",
    amount: 500, taxAmount: 90, reason: "Additional grooming add-on billed later",
  }, MAKER);

  const r3b = await returns.generateGstr3b(w.db, { entityId: ENTITY, registrationId: REGISTRATION, periodCode: PERIOD }, MAKER);
  assert.equal(r3b.summary.adjustments, -270, "credit note -360 plus debit note +90");
  assert.equal(r3b.summary.netTaxPayable, 1530, "1800 - 360 + 90");
  const view = await close.monthlyCloseView(w.db, { period: PERIOD, actorId: MAKER });
  assert.equal(view.gst.netPayable, 1530);
});

test("F3 GSTR-1 still reports the credit note in its own section (unchanged)", async () => {
  const w = await world();
  const r1 = await returns.generateGstr1(w.db, { entityId: ENTITY, registrationId: REGISTRATION, periodCode: PERIOD }, MAKER);
  assert.equal(r1.summary.cdnurCount, 1, "a consumer credit note belongs in CDNUR");
  assert.equal(r1.payload.cdnur[0].itms[0].itm_det.iamt, 360);
});

test("F10 GSTR-3B, the monthly close and the statutory package agree on taxCollectedFromCustomers", async () => {
  const w = await world();

  const r3b = await returns.generateGstr3b(w.db, { entityId: ENTITY, registrationId: REGISTRATION, periodCode: PERIOD }, MAKER);
  const view = await close.monthlyCloseView(w.db, { period: PERIOD, actorId: MAKER });
  const pkg = await accounting.generateStatutoryPackage(w.db, { entityId: ENTITY, registrationId: REGISTRATION, periodCode: PERIOD, reason: "Monthly package" }, MAKER);

  // GSTR-3B used to report only the SERVICE-vertical share under this label while the close reported
  // the ledger plus the service share - two different numbers for the same month under one name.
  assert.equal(r3b.summary.taxCollectedFromCustomers, 1440);
  assert.equal(view.gst.taxCollectedFromCustomers, r3b.summary.taxCollectedFromCustomers, "close vs GSTR-3B");
  assert.equal(pkg.summary.taxCollectedFromCustomers, r3b.summary.taxCollectedFromCustomers, "statutory package vs GSTR-3B");
  assert.equal(pkg.summary.netOutputTax, r3b.summary.totalOutputTax, "and on the net output tax the month is filed on");
});
