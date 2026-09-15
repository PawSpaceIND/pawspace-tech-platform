/*
 * R3-D / F9 - training GST was outside every PawSpace output-tax figure. [P1, tax UNDERSTATEMENT]
 *
 * The runtime audit suspected this and could not prove it: issuing a training invoice is correctly
 * refused until the package is FULLY_PAID, so the auditor could not get one issued inside the session.
 * This establishes it properly - the package is paid in full and the invoice is issued through the real
 * engine - and then asks the four statutory figures whether they can see it.
 *
 * serviceVerticalOutputTax() is the ONE function every PawSpace output-tax figure is derived from
 * (monthly close, statutory package, GSTR-1, GSTR-3B, GSTR-9). It read booking_invoices, and only
 * sitting, boarding, walking, taxi and grooming write that table - lib/training-finance.ts issues into
 * training_finance_invoices. So the GST on every training package was missing from all of them. An
 * understatement of output tax is the direction that gets a company a demand notice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__R3D_TRAIN_DB__");

const trainingFinance = await import("../lib/training-finance.ts");
const serviceTax = await import("../lib/service-output-tax.ts");
const returns = await import("../lib/gst-returns.ts");
const accounting = await import("../lib/gst-accounting.ts");
const close = await import("../lib/finance-monthly-close.ts");

const ENTITY = "ent_r3d_t";
const REG = "taxreg_r3d_t";
const GSTIN = "29AABCP1234A1Z5";
const IST = 330 * 60_000;
const istMs = (y, m, d) => Date.UTC(y, m - 1, d) - IST;
/* The engine stamps issued_at with Date.now(), so the tax period under test is derived from the invoice
 * the engine actually issued rather than pinned to a date the clock may have moved past. */
function periodOf(issuedAt) {
  const period = new Date(Number(issuedAt) + IST).toISOString().slice(0, 7);
  const [y, m] = period.split("-").map(Number);
  return { period, startMs: istMs(y, m, 1), endMs: istMs(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1), year: y, month: m };
}
const ACTOR = "r3d.finance@pawspace.test";

/** A fully paid 4-session training package in Bengaluru, invoiced through the real engine. */
async function world({ totalAmount = 23_600 } = {}) {
  const harness = freshCountingD1();
  globalThis.__R3D_TRAIN_DB__ = harness.db;
  await trainingFinance.ensureTrainingFinanceTables(harness.db);
  await accounting.ensureGstAccountingTables(harness.db);
  await returns.ensureGstReturnTables(harness.db);
  harness.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT, city_id TEXT, service_code TEXT, provider_id TEXT, scheduled_start TEXT, status TEXT, total_amount REAL, currency TEXT);
    CREATE TABLE IF NOT EXISTS food_orders (id TEXT PRIMARY KEY, status TEXT, total_amount REAL, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,invoice_number TEXT,status TEXT,currency TEXT,gross_amount REAL,tax_amount REAL,net_amount REAL,issued_at INTEGER);
  `);
  const t = istMs(2026, 8, 10);
  harness.sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,'active','board',?,?,?)").run(ENTITY, "PawSpace India Pvt Ltd", "IN", t, t, t);
  harness.sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'KA','GSTIN',?,'active','2000-01-01',NULL,'board',?,?,?)").run(REG, ENTITY, GSTIN, t, t, t);

  harness.sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,provider_id,scheduled_start,status,total_amount,currency) VALUES ('BKG-TRN','CUST-TRN','blr','training','PRV-TRN','2026-08-04','completed',?,'INR')").run(totalAmount);
  harness.sqlite.prepare("INSERT INTO training_programmes (id,booking_id,customer_id,provider_id,city_id,zone_id,plan_code,plan_name,pet_ids_json,requirements_json,status,total_sessions,completed_sessions,pricing_snapshot_json,created_at,updated_at) VALUES ('PRG-TRN','BKG-TRN','CUST-TRN','PRV-TRN','blr','blr-central','obedience_4','Obedience 4','[]','[]','delivered',4,4,'{}',?,?)").run(t, t);

  // The governed commercial quote, paid IN FULL - the gate the auditor could not get past.
  harness.sqlite.prepare("INSERT INTO training_commercial_quotes (id,package_code,package_version,pet_count,scheduled_start,payment_mode,discount,total_amount,amount_due_now,minutes_per_session,sessions,validity_days,expires_at,status,created_at) VALUES ('QTE-TRN','obedience_4',1,1,'2026-08-04','full',0,?,?,60,4,30,?,'used',?)").run(totalAmount, totalAmount, t + 86_400_000, t);
  harness.sqlite.prepare("INSERT INTO training_booking_quote_links (quote_id,booking_id,created_at) VALUES ('QTE-TRN','BKG-TRN',?)").run(t);
  harness.sqlite.prepare("INSERT INTO training_quote_payment_attestations (quote_id,status,amount,currency,environment,reference,bound_payment_key,created_at,updated_at) VALUES ('QTE-TRN','FULLY_PAID',?, 'INR','sandbox','TRN-UAT-PAY-R3D','key-r3d',?,?)").run(totalAmount, t, t);

  return harness;
}

test("F9 the suspicion is REAL: a fully paid training invoice issues, and its GST reached nothing", async () => {
  const w = await world();

  const issued = await trainingFinance.issueTrainingInvoice(w.db, { bookingId: "BKG-TRN", reason: "August obedience package, paid in full", actorId: ACTOR });
  assert.equal(issued.status, "issued_uat", "the package is FULLY_PAID so the invoice really does issue");
  assert.match(issued.invoiceNumber, /^TRN-BLR-26-27-\d{6}$/);

  const invoice = w.sqlite.prepare("SELECT tax_amount,taxable_amount,invoice_total,status,issued_at FROM training_finance_invoices WHERE booking_id='BKG-TRN'").get();
  assert.equal(Number(invoice.tax_amount), 3_600, "GST-inclusive 23,600 at 18% carries 3,600 of GST");
  assert.equal(Number(invoice.taxable_amount), 20_000);
  assert.ok(Number(invoice.issued_at) > 0, "and the issue date is stamped, so the invoice belongs to a tax period");

  // It is NOT in booking_invoices - that is the whole defect, and it is asserted, not assumed.
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM booking_invoices").get().n, 0);

  // THE OUTCOME: that 3,600 must now reach every figure PawSpace's output tax is read from.
  const { period, startMs, endMs, year, month } = periodOf(invoice.issued_at);
  const split = await serviceTax.serviceVerticalOutputTax(w.db, startMs, endMs);
  assert.equal(split.trainingOutputTax, 3_600);
  assert.equal(split.pawspaceOwnOutputTax, 3_600, "training is PawSpace's own supply - the trainer is a cost, not a marketplace seller");
  assert.equal(split.totalTaxCollected, 3_600);
  assert.equal(split.invoiceCount, 1);

  const view = await close.monthlyCloseView(w.db, { period, actorId: ACTOR });
  assert.equal(view.gst.outputTax, 3_600, "the monthly close");

  const r3b = await returns.generateGstr3b(w.db, { entityId: ENTITY, registrationId: REG, periodCode: period }, ACTOR);
  assert.equal(r3b.summary.serviceVerticalTax, 3_600, "GSTR-3B");
  assert.equal(r3b.summary.netTaxPayable, 3_600);

  const r1 = await returns.generateGstr1(w.db, { entityId: ENTITY, registrationId: REG, periodCode: period }, ACTOR);
  assert.equal(r1.summary.serviceVerticalTax, 3_600, "GSTR-1");
  assert.equal(r1.summary.totalOutputTax, 3_600);

  const financialYear = String(month >= 4 ? year : year - 1);
  const annual = await accounting.generateAnnualReturn(w.db, { entityId: ENTITY, registrationId: REG, financialYear, reason: "FY close" }, ACTOR);
  assert.equal(annual.summary.serviceOutputTax, 3_600, "GSTR-9");
  assert.equal(annual.summary.monthlyOutputTax[period], 3_600, "and in the month it was issued");
});

test("F9 an unissued training draft is not taxed early, and an issued one lands in its own month", async () => {
  const w = await world();
  const { startMs, endMs } = periodOf(Date.now());

  // refreshTrainingFinanceReadModel writes a DRAFT with tax on it. A draft is not a supply.
  await trainingFinance.refreshTrainingFinanceReadModel(w.db);
  const draft = w.sqlite.prepare("SELECT status,tax_amount,invoice_number FROM training_finance_invoices WHERE booking_id='BKG-TRN'").get();
  assert.equal(String(draft.status), "draft_ready_for_number");
  assert.equal(Number(draft.tax_amount), 3_600, "the draft really does carry the tax that must not be counted yet");
  assert.equal(draft.invoice_number, null);
  assert.equal((await serviceTax.serviceVerticalOutputTax(w.db, startMs, endMs)).trainingOutputTax, 0,
    "an unnumbered draft is not output tax - only an issued invoice is");

  await trainingFinance.issueTrainingInvoice(w.db, { bookingId: "BKG-TRN", reason: "August obedience package, paid in full", actorId: ACTOR });
  assert.equal((await serviceTax.serviceVerticalOutputTax(w.db, startMs, endMs)).trainingOutputTax, 3_600);

  // And a later refresh (which rewrites updated_at) must not move it out of its period.
  await trainingFinance.refreshTrainingFinanceReadModel(w.db);
  assert.equal((await serviceTax.serviceVerticalOutputTax(w.db, startMs, endMs)).trainingOutputTax, 3_600,
    "the period an invoice was issued in cannot drift because a read model was refreshed");
  const previousMonth = await serviceTax.serviceVerticalOutputTax(w.db, startMs - 31 * 86_400_000, startMs);
  assert.equal(previousMonth.trainingOutputTax, 0, "and it belongs to exactly one month");
});

test("F9 training tax adds to the other five verticals rather than replacing them", async () => {
  const w = await world();
  const { period, startMs, endMs } = periodOf(Date.now());
  w.sqlite.prepare("INSERT INTO booking_invoices (id,booking_id,customer_id,invoice_number,status,currency,gross_amount,tax_amount,net_amount,issued_at) VALUES ('bi1','BKG-GRM','CUST-1','GRM-1','issued','INR',1180,180,1000,?)").run(startMs + 3 * 86_400_000);
  await trainingFinance.issueTrainingInvoice(w.db, { bookingId: "BKG-TRN", reason: "August obedience package, paid in full", actorId: ACTOR });

  const split = await serviceTax.serviceVerticalOutputTax(w.db, startMs, endMs);
  assert.equal(split.pawspaceOwnOutputTax, 3_780, "180 of grooming GST plus 3,600 of training GST");
  assert.equal(split.invoiceCount, 2);
  assert.equal(split.grossTotal, 24_780);
  const r3b = await returns.generateGstr3b(w.db, { entityId: ENTITY, registrationId: REG, periodCode: period }, ACTOR);
  assert.equal(r3b.summary.netTaxPayable, 3_780);
});
