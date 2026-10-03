/*
 * The series' next number is already on another invoice (for example one issued by hand under the same number). Issuing the
 * booking's invoice must refuse with the reason, never throw: the completion stands, the booking stays on Finance's
 * missing-invoices list, and Finance's "Issue missing invoices" run still finishes, lists the booking and writes its audit row.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__INVOICE_COLLISION_DB__", "__INVOICE_COLLISION_ENV__");
const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const returns = await import("../lib/gst-returns.ts");
const invoices = await import("../lib/booking-tax-invoice.ts");
const statutory = await import("../lib/statutory-invoicing.ts");

const ENTITY = "SEEDFE-TKPET", REG = "SEEDTR-TKPET-KA", POLICY = "SEEDTP-TKPET-1", GSTIN = "29AAICT7352F1Z0";
const SELLER = { legalName: "TK PETCARE SOLUTIONS PRIVATE LIMITED", gstin: GSTIN, stateCode: "29", state: "Karnataka", address: "Jayanagar 9th Block, Bengaluru, Karnataka 560041" };
const MAKER = "maker@pawspace.in", CHECKER = "checker@pawspace.in", FINANCE = "finance@pawspace.in";
const IST = 330 * 60_000, NOW = Date.now();
const TODAY = new Date(NOW + IST).toISOString().slice(0, 10);
const fyShort = (date) => { const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)), s = m >= 4 ? y : y - 1; return `${String(s % 100).padStart(2, "0")}-${String((s + 1) % 100).padStart(2, "0")}`; };

async function invoiceWorld() {
  const { sqlite, db } = world("__INVOICE_COLLISION_DB__", "__INVOICE_COLLISION_ENV__", { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" });
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT,primary_phone TEXT);
    CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,name TEXT,provider_model TEXT NOT NULL);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  await gstAccounting.ensureGstAccountingTables(db);
  // Approved inclusive economics apply only to this disposable fixture.
  const { saveGstSetting } = await import("../lib/gst-setting.ts");
  await saveGstSetting(db, { cityId: "*", ratePercent: 18, method: "extract_inclusive", effectiveFrom: "2024-01-01", reason: "Owner-approved inclusive finance fixture", actorId: "finance.fixture@pawspace.test" });
  await returns.ensureGstReturnTables(db);
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'IN','active','founder',1,1,1)").run(ENTITY, SELLER.legalName);
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'IN-KA','gstin',?,'active','2024-01-01',NULL,'founder',1,1,1)").run(REG, ENTITY, GSTIN);
  sqlite.prepare("INSERT INTO tax_policy_versions (id,entity_id,version,status,effective_from,effective_to,policy_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES (?,?,1,'active','2024-01-01',NULL,?,'SEED-GST-APPROVAL','founder',1,1,1)")
    .run(POLICY, ENTITY, JSON.stringify({ seller: SELLER, defaultComponents: [{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }] }));
  sqlite.prepare("INSERT INTO finance_document_series (id,entity_id,document_type,prefix,next_number,padding,policy_id,status,updated_at) VALUES ('SERIES-TKP',?,'invoice','TKP/{FY}/',1,5,?,'active',1)").run(ENTITY, POLICY);
  const draft = await terms.saveCommercialTerm(db, { serviceCode: "grooming", engagementModel: "commission_groomer", providerSharePct: 0.70, effectiveFrom: "2024-01-01", reason: "grooming owner model terms", actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: "APR-grooming", actorId: CHECKER });
  return { sqlite, db };
}
function booking(sqlite, id) {
  const start = new Date(NOW - 2 * 3600_000).toISOString(), customer = `CUS-${id}`;
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,pet_ids_json,city_id,zone_id,service_code,package_code,package_name,provider_id,scheduled_start,scheduled_end,status,total_amount,currency,pricing_json,created_at,updated_at) VALUES (?,?,'[]','blr','blr-east','grooming','pkg','Full groom','PRV-G',?,?,'completed',1000,'INR','{}',1,1)").run(id, customer, start, start);
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers VALUES (?,'blr','Asha Rao','9000000001')").run(customer);
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,1000,1000,'INR','upi','prepaid','captured','razorpay',?,'{}',1,1)").run(`PAY-${id}`, id, customer, `idem-${id}`);
}

test("a series number already used by a hand-issued invoice is refused, never thrown, and the backfill run still finishes and is audited", async () => {
  const { sqlite, db } = await invoiceWorld();
  booking(sqlite, "BK-K");
  sqlite.prepare("INSERT INTO finance_invoices (id,invoice_number,entity_id,customer_id,source_type,source_id,source_event_key,policy_id,registration_id,issue_date,currency,subtotal,tax_total,total,status,tax_snapshot_json,document_reference,created_by,created_at) VALUES ('INV-HAND',?,?,'CUS-Z','manual','M-1','manual:M-1',?,?,?,'INR',100,18,118,'issued','{}',NULL,'finance',1)")
    .run(`TKP/${fyShort(TODAY)}/00001`, ENTITY, POLICY, REG, TODAY);

  const fact = await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-K", actorId: FINANCE, completedAt: NOW });
  assert.equal(fact.gstLiability, 45.76, "the completion stands");

  const outcome = await invoices.issueBookingInvoice(db, { bookingId: "BK-K", actorId: FINANCE });
  assert.equal(outcome.status, "refused");
  assert.equal(outcome.key, "invoice_number_taken");
  assert.match(outcome.message, /already on another invoice/);

  const backfill = await invoices.issueMissingBookingInvoices(db, { actorId: FINANCE, reason: "issue the missing invoices" });
  assert.equal(backfill.counts.issued, 0);
  assert.deepEqual(backfill.notIssued.map((row) => [row.bookingId, row.status]), [["BK-K", "refused"]]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM gst_accounting_audit_events WHERE entity_type='booking_invoice_backfill'").get().n, 1, "the run is audited");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices WHERE source_type='booking'").get().n, 0, "nothing half-issued");
});

test("an unexpected failure for one booking never stops Finance's backfill run: the others are issued and the run is audited", async () => {
  const { sqlite, db } = await invoiceWorld();
  booking(sqlite, "BK-A");
  booking(sqlite, "BK-B");
  // A plain database failure (not a refusal) on writing a booking's invoice: first for both, so neither is issued at completion.
  const failFor = (ids) => { sqlite.exec("DROP TRIGGER IF EXISTS fail_invoice"); sqlite.exec(`CREATE TRIGGER fail_invoice BEFORE INSERT ON finance_invoices WHEN NEW.source_id IN (${ids.map((id) => `'${id}'`).join(",")}) BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;`); };
  failFor(["BK-A", "BK-B"]);
  await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-A", actorId: FINANCE, completedAt: NOW - 60_000 });
  await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-B", actorId: FINANCE, completedAt: NOW });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices WHERE source_type='booking'").get().n, 0);
  failFor(["BK-B"]);
  const backfill = await invoices.issueMissingBookingInvoices(db, { actorId: FINANCE, reason: "issue the missing invoices" });
  assert.deepEqual(backfill.issued.map((row) => row.bookingId), ["BK-A"]);
  assert.deepEqual(backfill.notIssued.map((row) => [row.bookingId, row.status]), [["BK-B", "refused"]]);
  assert.doesNotMatch(JSON.stringify(backfill), /disk I\/O/, "internal error text is logged, not returned");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM gst_accounting_audit_events WHERE entity_type='booking_invoice_backfill'").get().n, 1);
});

const manualInvoice = (db, n, issueDate, extra = {}) => statutory.issueInvoiceStatutory(db, { entityId: ENTITY, registrationId: REG, customerId: `CUS-M${n}`, issueDate, sourceType: "manual", sourceId: `M-${n}`, sourceEventKey: `manual:M-${n}`, recipientState: "29", serviceState: "29", recipientRegistered: false, lines: [{ lineKey: "service", serviceCode: "grooming", description: "Grooming", taxableAmount: 100 }], ...extra }, FINANCE);
function classifyGrooming(sqlite) {
  sqlite.prepare("INSERT INTO tax_classifications (id,policy_id,service_code,classification_code,tax_component_json,place_of_supply_rule,input_tax_rule,created_at) VALUES ('TC-G',?,'grooming','998612',?,'service_location','standard',1)").run(POLICY, JSON.stringify([{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }]));
}

test("an amount received that is not a number is refused, not stored", async () => {
  const { sqlite, db } = await invoiceWorld();
  classifyGrooming(sqlite);
  await assert.rejects(manualInvoice(db, 1, "2026-09-01", { amountReceived: "one hundred" }), /invoice_amount_received_invalid/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices").get().n, 0);
});

test("a series without {FY} continues its counter into the next financial year instead of repeating a number", async () => {
  const { sqlite, db } = await invoiceWorld();
  classifyGrooming(sqlite);
  sqlite.prepare("UPDATE finance_document_series SET prefix='TKX/' WHERE id='SERIES-TKP'").run();
  const march = await manualInvoice(db, 1, "2026-03-31");
  const april = await manualInvoice(db, 2, "2026-04-01");
  assert.deepEqual([march.invoice_number, april.invoice_number], ["TKX/00001", "TKX/00002"]);
});
