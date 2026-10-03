/*
 * "PawSpace pays 18% GST on the amount it makes" (owner decision A, 27 Sept 2026) in every return, and a booking's customer tax
 * invoice (decision B) filed exactly once. Driven through the REAL completion, register, statutory package, monthly close,
 * GSTR-1, GSTR-3B, GSTR-9C and tax-payable reconciliation.
 *
 *   Inclusive fee 300: taxable 254.24, GST 45.76. Own supply 1,000: taxable 847.46, GST 152.54.
 *   Funeral / memorial: no GST, outside GST under Schedule III by default (GSTR-1 Table 8 non-GST, GSTR-3B 3.1(e)).
 *   Every filed line: tax = rate x taxable value, within 1 paisa. Per service: amount made, GST, net income (254.24 and 847.46).
 *   A booking with a customer tax invoice files the invoice (b2b when the customer gave a GSTIN), is never counted again from
 *   the payout record or the canonical ledger, and a difference between the two is a variance showing both numbers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__AMOUNT_MADE_DB__", "__AMOUNT_MADE_ENV__");
const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const returns = await import("../lib/gst-returns.ts");
const close = await import("../lib/finance-monthly-close.ts");
const supplies = await import("../lib/service-output-tax.ts");
const payments = await import("../lib/gst-tax-payments.ts");

const PROD_ENV = { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" };
const ENTITY = "SEEDFE-TKPET", REG = "SEEDTR-TKPET-KA", POLICY = "SEEDTP-TKPET-1", GSTIN = "29AAICT7352F1Z0";
const SELLER = { legalName: "TK PETCARE SOLUTIONS PRIVATE LIMITED", gstin: GSTIN, stateCode: "29", state: "Karnataka", address: "Jayanagar 9th Block, Bengaluru, Karnataka 560041" };
const MAKER = "maker@pawspace.in", CHECKER = "checker@pawspace.in", FINANCE = "finance@pawspace.in";
// This case verifies same-period amounts, not the governed UTC-ledger/IST-return variance.
// A recent completed noon-UTC fixture belongs to the same month in both calendars.
const fixtureClock = new Date();
const NOW = Date.UTC(fixtureClock.getUTCFullYear(), fixtureClock.getUTCMonth(), fixtureClock.getUTCDate() - 1, 12);
const IST = 330 * 60_000, PERIOD = new Date(NOW + IST).toISOString().slice(0, 7);
const [Y, M] = PERIOD.split("-").map(Number), START = Date.UTC(Y, M - 1, 1) - IST, END = Date.UTC(M === 12 ? Y + 1 : Y, M === 12 ? 0 : M, 1) - IST;
const FY = M >= 4 ? String(Y) : String(Y - 1);
const scope = { entityId: ENTITY, registrationId: REG, periodCode: PERIOD, reason: "monthly filing" };
const r2 = (value) => Math.round(Number(value) * 100) / 100;

async function filingWorld({ seller = false } = {}) {
  const { sqlite, db } = world("__AMOUNT_MADE_DB__", "__AMOUNT_MADE_ENV__", PROD_ENV);
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,name TEXT,provider_model TEXT NOT NULL);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE payroll_runs (id TEXT PRIMARY KEY,period_start INTEGER,period_end INTEGER,status TEXT);
    CREATE TABLE employee_payroll_results (id TEXT PRIMARY KEY,run_id TEXT,employee_id TEXT,gross_earnings REAL);
    CREATE TABLE boarding_host_settlement_ledger (booking_id TEXT,provider_id TEXT,payout_amount REAL,eligible_at INTEGER);
  `);
  await gstAccounting.ensureGstAccountingTables(db);
  // Approved inclusive economics apply only to this disposable fixture.
  const { saveGstSetting } = await import("../lib/gst-setting.ts");
  await saveGstSetting(db, { cityId: "*", ratePercent: 18, method: "extract_inclusive", effectiveFrom: "2024-01-01", reason: "Owner-approved inclusive finance fixture", actorId: "finance.fixture@pawspace.test" });
  await returns.ensureGstReturnTables(db);
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'IN','active','founder',1,1,1)").run(ENTITY, SELLER.legalName);
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'IN-KA','gstin',?,'active','2020-01-01',NULL,'founder',1,1,1)").run(REG, ENTITY, GSTIN);
  if (seller) {
    sqlite.prepare("INSERT INTO tax_policy_versions (id,entity_id,version,status,effective_from,effective_to,policy_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES (?,?,1,'active','2024-01-01',NULL,?,'SEED-GST-APPROVAL','founder',1,1,1)")
      .run(POLICY, ENTITY, JSON.stringify({ seller: SELLER, defaultComponents: [{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }] }));
    sqlite.prepare("INSERT INTO finance_document_series (id,entity_id,document_type,prefix,next_number,padding,policy_id,status,updated_at) VALUES ('SERIES-TKP',?,'invoice','TKP/{FY}/',1,5,?,'active',1)").run(ENTITY, POLICY);
  }
  for (const [service, model] of [["grooming", "commission_groomer"], ["boarding", "commission_standard"], ["funeral_memorial", "commission_standard"]]) {
    const draft = await terms.saveCommercialTerm(db, { serviceCode: service, engagementModel: model, providerSharePct: 0.70, effectiveFrom: "2024-01-01", reason: `${service} owner model terms`, actorId: MAKER });
    await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: `APR-${service}`, actorId: CHECKER });
  }
  sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-FT','Ravi','full_time')").run();
  return { sqlite, db };
}
function booking(sqlite, id, { service, provider, customer = `CUS-${id}` }) {
  const start = new Date(NOW - 3600_000).toISOString();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,pet_ids_json,city_id,zone_id,service_code,package_code,package_name,provider_id,scheduled_start,scheduled_end,status,total_amount,currency,pricing_json,created_at,updated_at) VALUES (?,?,'[]','blr','blr-east',?,'pkg','Package',?,?,?,'completed',1000,'INR','{}',1,1)").run(id, customer, service, provider, start, start);
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,1000,1000,'INR','upi','prepaid','captured','razorpay',?,'{}',1,1)").run(`PAY-${id}`, id, customer, `idem-${id}`);
}
/* The three shapes: a commission grooming job, an own-supply boarding stay (full-time host) and a funeral booking. */
async function completeThree(sqlite, db) {
  booking(sqlite, "BK-COMM", { service: "grooming", provider: "PRV-G" });
  booking(sqlite, "BK-OWN", { service: "boarding", provider: "PRV-FT" });
  booking(sqlite, "BK-FUN", { service: "funeral_memorial", provider: "PRV-VENDOR" });
  for (const id of ["BK-COMM", "BK-OWN", "BK-FUN"]) await completion.resolveServiceCompletionFinance(db, { bookingId: id, actorId: FINANCE, completedAt: NOW });
}
async function fileMonth(db) {
  return {
    pkg: await gstAccounting.generateStatutoryPackage(db, scope, MAKER),
    view: await close.monthlyCloseView(db, { period: PERIOD, actorId: FINANCE }),
    gstr1: await returns.generateGstr1(db, scope, MAKER),
    gstr3b: await returns.generateGstr3b(db, scope, MAKER),
    reconciliation: await payments.taxPayableReconciliation(db, { periodCode: PERIOD }),
  };
}
/* rate x value, within 1 paisa per line, on every filed line and every bucket of GSTR-1 (a bucket adds its lines). */
function assertRateTimesValue(gstr1, register) {
  for (const line of register.lines.filter((l) => l.lineDetail && l.section === "taxable")) {
    const parts = line.invoice ? line.invoice.lines.filter((x) => x.role === "taxable").map((x) => [x.taxableValue, x.ratePercent, x.gst]) : [[line.taxableValue, line.ratePercent, line.gst]];
    for (const [value, rate, tax] of parts) assert.ok(Math.abs(r2(value * rate / 100) - tax) <= 0.01, `${line.supplyKey}: ${tax} is ${rate}% of ${value}`);
  }
  for (const bucket of gstr1.payload.b2cs) assert.ok(Math.abs(r2(bucket.txval * bucket.rt / 100) - r2(bucket.iamt + bucket.camt + bucket.samt)) <= 0.01, `b2cs ${bucket.pos} ${bucket.rt}%`);
  for (const invoice of gstr1.payload.b2b.flatMap((entry) => entry.inv)) for (const item of invoice.itms) assert.ok(Math.abs(r2(item.itm_det.txval * item.itm_det.rt / 100) - r2(item.itm_det.iamt + item.itm_det.camt + item.itm_det.samt)) <= 0.01);
  assert.equal(register.rateCheck.holds, true, JSON.stringify(register.rateCheck.mismatches));
}

test("every return files the amount PawSpace makes: 254.24 / 45.76 on commission, 847.46 / 152.54 on own supply, funeral outside GST", async () => {
  const { sqlite, db } = await filingWorld();
  await completeThree(sqlite, db);
  await supplies.assignPeriodServiceOwnership(db, { periodCode: PERIOD, entityId: ENTITY, registrationId: REG, reason: "Every service supply of the month is filed by the seller" }, FINANCE);
  const register = await supplies.serviceVerticalOutputTax(db, START, END, { entityId: ENTITY, registrationId: REG });
  const byBooking = Object.fromEntries(register.lines.map((l) => [l.bookingId, [l.treatment, l.section, l.taxableValue, l.gst, l.exemptValue, l.amountMade]]));
  assert.deepEqual(byBooking["BK-COMM"], ["commission", "taxable", 254.24, 45.76, 0, 300]);
  assert.deepEqual(byBooking["BK-OWN"], ["own_supply", "taxable", 847.46, 152.54, 0, 1000], "GST is extracted from the full amount paid");
  assert.deepEqual(byBooking["BK-FUN"], ["non_gst", "non_gst", 0, 0, 300, 300], "outside GST under Schedule III, the default funeral treatment");

  const { pkg, view, gstr1, gstr3b, reconciliation } = await fileMonth(db);
  assert.equal(pkg.summary.gstModel.label, "GST @18% on the amount PawSpace makes");
  assert.match(pkg.summary.gstModel.note, /^Owner-approved method, 27 Sept 2026/);
  assert.deepEqual([pkg.summary.serviceTaxableValue, pkg.summary.serviceOutputTax, pkg.summary.serviceNonGstValue, pkg.summary.serviceExemptValue], [1101.7, 198.3, 300, 0]);
  const services = Object.fromEntries(pkg.summary.byService.map((s) => [s.serviceCode, [s.amountMade, s.gst, s.netIncome]]));
  assert.deepEqual(services, { grooming: [300, 45.76, 254.24], boarding: [1000, 152.54, 847.46], funeral_memorial: [300, 0, 300] }, "amount made, GST and net income per service: the books keep 254.24 and 847.46");
  assert.deepEqual([view.gst.outputTax, view.gst.serviceTaxableValue, view.gst.serviceNonGstValue, view.gst.gstModel], [198.3, 1101.7, 300, "GST @18% on the amount PawSpace makes"]);
  assert.deepEqual(gstr1.payload.b2cs, [{ sply_ty: "INTRA", pos: "29", typ: "OE", rt: 18, txval: 1101.7, iamt: 0, camt: 99.15, samt: 99.15, csamt: 0 }]);
  assert.equal(gstr1.payload.gt, 1101.7, "turnover counts the service supplies filed (Schedule III funeral is not a supply)");
  assert.equal(gstr1.payload.cur_gt, 1101.7);
  const hsn = Object.fromEntries(gstr1.payload.hsn.data.map((h) => [h.hsn_sc, [h.txval, h.camt, h.samt]]));
  assert.deepEqual(hsn, { "998599": [254.24, 22.88, 22.88], "998612": [847.46, 76.27, 76.27] }, "the fee under 998599, the stay under 998612; nothing outside GST in the HSN summary");
  assert.deepEqual(gstr1.payload.nil, { inv: [{ sply_ty: "INTRAB2C", expt_amt: 0, nil_amt: 0, ngsup_amt: 300 }] });
  assert.deepEqual(gstr3b.payload.sup_details.osup_det, { txval: 1101.7, iamt: 0, camt: 99.15, samt: 99.15, csamt: 0 }, "3.1(a): value AND tax on the amount made");
  assert.deepEqual([gstr3b.payload.sup_details.osup_nongst, gstr3b.payload.sup_details.osup_nil_exmp], [{ txval: 300 }, { txval: 0 }], "3.1(e), not 3.1(c)");
  assert.deepEqual([reconciliation.gst.filedServiceGst, reconciliation.gst.serviceTaxableValue, reconciliation.gst.accrued], [198.3, 1101.7, 198.3]);
  assert.deepEqual(reconciliation.gst.byService.map((s) => [s.serviceCode, s.amountMade, s.gst, s.netIncome]), [["boarding", 1000, 152.54, 847.46], ["funeral_memorial", 300, 0, 300], ["grooming", 300, 45.76, 254.24]]);
  assert.equal(reconciliation.gst.gstModel.label, "GST @18% on the amount PawSpace makes");
  assertRateTimesValue(gstr1, register);
});

test("a booking with a customer tax invoice files the invoice exactly once, owned by the seller that issued it", async () => {
  const { sqlite, db } = await filingWorld({ seller: true });
  await completeThree(sqlite, db);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices").get().n, 3, "each completion issued its invoice");
  // No assignment step: an invoiced booking belongs to the legal entity and registration that issued its invoice.
  const register = await supplies.serviceVerticalOutputTax(db, START, END, { entityId: ENTITY, registrationId: REG });
  assert.deepEqual(register.lines.map((l) => [l.bookingId, Boolean(l.invoice), l.taxableValue, l.gst]).sort(), [["BK-COMM", true, 254.24, 45.76], ["BK-FUN", true, 0, 0], ["BK-OWN", true, 847.46, 152.54]]);
  assert.deepEqual(register.bookingInvoices, { count: 3, taxableValue: 1101.7, gst: 198.3, exemptValue: 300 });
  assert.equal(register.invoiceVariances.count, 0);
  assert.equal(register.alsoOnCanonicalInvoice.count, 0, "the old double-count flag is gone for invoices issued by this flow");

  const { pkg, view, gstr1, gstr3b } = await fileMonth(db);
  assert.deepEqual([pkg.summary.ledgerOutputTax, pkg.summary.serviceOutputTax, pkg.summary.outputTax], [0, 198.3, 198.3], "counted once: the invoice's ledger rows are not added to the register's");
  assert.deepEqual(pkg.variance, []);
  assert.equal(view.gst.outputTax, 198.3, "the monthly close does not add the invoices' tax_total to the register");
  assert.deepEqual([gstr1.summary.canonicalOutputTax, gstr1.summary.totalOutputTax, gstr1.summary.b2cInvoices], [0, 198.3, 2]);
  assert.deepEqual(gstr1.payload.b2cs, [{ sply_ty: "INTRA", pos: "29", typ: "OE", rt: 18, txval: 1101.7, iamt: 0, camt: 99.15, samt: 99.15, csamt: 0 }], "b2cs aggregated by place of supply and rate from the invoice lines");
  const hsn = Object.fromEntries(gstr1.payload.hsn.data.map((h) => [h.hsn_sc, [h.desc, h.txval, h.camt, h.samt]]));
  assert.deepEqual(hsn, { "998599": ["Other support services n.e.c.", 254.24, 22.88, 22.88], "998612": ["Animal husbandry services", 847.46, 76.27, 76.27] }, "Table 12 from the invoice lines, never the provider's collected charges");
  assert.deepEqual(gstr1.payload.nil, { inv: [{ sply_ty: "INTRAB2C", expt_amt: 0, nil_amt: 0, ngsup_amt: 300 }] });
  assert.ok(gstr1.summary.sacCodes.every((s) => s.source === "invoice"));
  assert.deepEqual(gstr3b.payload.sup_details.osup_det, { txval: 1101.7, iamt: 0, camt: 99.15, samt: 99.15, csamt: 0 });
  assert.equal(gstr3b.summary.totalOutputTax, 198.3);
  const gstr9c = await returns.generateGstr9c(db, { entityId: ENTITY, registrationId: REG, financialYear: FY, reason: "annual" }, MAKER);
  assert.deepEqual([gstr9c.summary.booksTaxable, gstr9c.summary.booksOutputTax], [1101.7, 198.3], "the annual books count each booking once too");
  assertRateTimesValue(gstr1, register);
  // Assigning an invoiced supply to another legal entity is refused: the invoice's issuer files it.
  const refused = await supplies.assignServiceSupplyOwnership(db, { supplyKey: "booking:BK-COMM", entityId: ENTITY, registrationId: REG, reason: "Trying to reassign an invoiced booking" }, FINANCE).then(() => null, (error) => error);
  assert.equal(refused?.status, 409);
});

test("a customer who gave a GSTIN gets a b2b entry for the invoice, never a b2cs line", async () => {
  const { sqlite, db } = await filingWorld({ seller: true });
  sqlite.prepare("INSERT INTO finance_customer_tax_profiles (customer_id,registration_reference,customer_type,place_of_supply,status,updated_at) VALUES ('CUS-B2B','29AABCU9603R1ZM','business','29','active',1)").run();
  booking(sqlite, "BK-B2B", { service: "grooming", provider: "PRV-G", customer: "CUS-B2B" });
  await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-B2B", actorId: FINANCE, completedAt: NOW });
  const number = sqlite.prepare("SELECT invoice_number,issue_date FROM finance_invoices").get();
  const gstr1 = await returns.generateGstr1(db, scope, MAKER);
  assert.deepEqual(gstr1.payload.b2b, [{ ctin: "29AABCU9603R1ZM", inv: [{ inum: number.invoice_number, idt: number.issue_date, val: 1000, pos: "29", rchrg: "N", inv_typ: "R", itms: [{ num: 1, itm_det: { txval: 254.24, iamt: 0, camt: 22.88, samt: 22.88, csamt: 0, rt: 18 } }] }] }], "invoice by invoice, with the amount the customer paid as its value");
  assert.deepEqual(gstr1.payload.b2cs, []);
  assert.deepEqual([gstr1.summary.b2bInvoices, gstr1.summary.totalOutputTax], [1, 45.76]);
});

test("an invoice that differs from the payout record by more than 1 paisa is a variance showing both numbers", async () => {
  const { sqlite, db } = await filingWorld({ seller: true });
  // Preserve the existing deliberately divergent 12% legacy scenario in this disposable world.
  // Issue a reconciled inclusive invoice first, then simulate a drifted payout register without rewriting it.
  const { saveGstSetting } = await import("../lib/gst-setting.ts");
  await saveGstSetting(db, { cityId: "*", ratePercent: 12, method: "extract_inclusive", effectiveFrom: "2024-01-01", reason: "Synthetic historical variance fixture", actorId: FINANCE });
  sqlite.prepare("INSERT INTO tax_classifications (id,policy_id,service_code,classification_code,tax_component_json,place_of_supply_rule,input_tax_rule,created_at) VALUES ('FIN-FEE',?,'platform_commission','998599',?,'default_recipient_or_service','standard',1)").run(POLICY, JSON.stringify([{ code: "CGST", rate: 6 }, { code: "SGST", rate: 6 }]));
  booking(sqlite, "BK-COMM", { service: "grooming", provider: "PRV-G" });
  await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-COMM", actorId: FINANCE, completedAt: NOW });
  const issued = { ...sqlite.prepare("SELECT * FROM finance_invoices WHERE source_event_key='booking-invoice:BK-COMM'").get() };
  assert.equal(issued.subtotal, 267.86);
  assert.equal(issued.tax_total, 32.14);
  sqlite.prepare("UPDATE provider_payout_computations SET taxable_commission=254.24,platform_gst=45.76,gst_rate=18 WHERE booking_id='BK-COMM'").run();
  const pkg = await gstAccounting.generateStatutoryPackage(db, scope, MAKER);
  assert.deepEqual({ ...sqlite.prepare("SELECT * FROM finance_invoices WHERE id=?").get(issued.id) }, issued, "filing preserves the issued snapshot despite register drift");
  const variance = pkg.variance.find((v) => v.type === "booking_invoice_differs_from_register");
  assert.ok(variance, JSON.stringify(pkg.variance));
  assert.equal(variance.count, 1);
  const [difference] = variance.supplies;
  assert.deepEqual(difference.differences, ["taxable_value", "gst"]);
  assert.deepEqual([difference.register.taxableValue, difference.register.gst, difference.invoice.taxableValue, difference.invoice.gst], [254.24, 45.76, 267.86, 32.14], "both numbers, nothing silently picked");
  assert.equal(pkg.summary.serviceOutputTax, 32.14, "the return files the legal document the customer holds");
  assert.equal(pkg.summary.ledgerCheck.agrees, true, "the completion books still match the unchanged issued invoice");
});

test("a balanced deliberate ledger drift is reported without rewriting the issued customer invoice", async () => {
  const { sqlite, db } = await filingWorld({ seller: true });
  booking(sqlite, "BK-LEDGER-DRIFT", { service: "grooming", provider: "PRV-G" });
  await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-LEDGER-DRIFT", actorId: FINANCE, completedAt: NOW });
  const issued = { ...sqlite.prepare("SELECT * FROM finance_invoices WHERE source_event_key='booking-invoice:BK-LEDGER-DRIFT'").get() };
  assert.equal(issued.tax_total, 45.76);
  // Synthetic corruption shifts one rupee between revenue and GST; the journal stays balanced.
  const drift = sqlite.prepare("UPDATE finance_journal_entries SET credit=credit+CASE account_code WHEN '2130-GST Payable' THEN 1 ELSE -1 END WHERE source_type='service_completion' AND source_id='BK-LEDGER-DRIFT' AND account_code IN ('2130-GST Payable','4000-Service Revenue')").run();
  assert.equal(drift.changes, 2);
  const totals = sqlite.prepare("SELECT ROUND(SUM(debit),2) debit,ROUND(SUM(credit),2) credit FROM finance_journal_entries WHERE source_type='service_completion' AND source_id='BK-LEDGER-DRIFT'").get();
  assert.equal(totals.debit, totals.credit, "balanced journals alone cannot prove tax reconciliation");
  const pkg = await gstAccounting.generateStatutoryPackage(db, scope, MAKER);
  assert.equal(pkg.summary.ledgerCheck.agrees, false);
  assert.equal(pkg.summary.serviceOutputTax, 45.76, "the return preserves the invoice's tax");
  const variance = pkg.variance.find(v => v.type === "service_gst_vs_ledger_2130");
  assert.ok(variance, JSON.stringify(pkg.variance));
  assert.equal(variance.filedGst, 45.76);
  assert.equal(variance.postedGst, 46.76);
  assert.equal(Math.abs(variance.difference), 1);
  assert.deepEqual({ ...sqlite.prepare("SELECT * FROM finance_invoices WHERE id=?").get(issued.id) }, issued);
});
