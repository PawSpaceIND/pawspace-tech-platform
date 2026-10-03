/*
 * Finance's "Issue missing invoices" (owner decision B): completed bookings that got no invoice at completion - because a piece
 * of configuration was missing then - are issued once it is fixed, in open months and within 30 days of completion (Rule 47).
 * Older ones and ones in a closed month are listed with the reason, never issued. Driven through the REAL completion, the REAL
 * backlog and the REAL GST route (finance.manage), with a fixed "today" so the 30-day rule is exact whenever the suite runs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__INVOICE_BACKFILL_DB__", "__INVOICE_BACKFILL_ENV__");
const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const invoices = await import("../lib/booking-tax-invoice.ts");
const gstRoute = await import("../app/api/gst-accounting/route.ts");

const ENTITY = "SEEDFE-TKPET", POLICY = "SEEDTP-TKPET-1", GSTIN = "29AAICT7352F1Z0";
const SELLER = { legalName: "TK PETCARE SOLUTIONS PRIVATE LIMITED", gstin: GSTIN, stateCode: "29", state: "Karnataka", address: "Jayanagar 9th Block, Bengaluru, Karnataka 560041" };
const FINANCE = "finance.staff@pawspace.in", MANAGER = "ops.manager@pawspace.in";
const at = (iso) => Date.parse(iso);
const AS_OF = at("2026-09-10T12:00:00+05:30");

async function backlogWorld() {
  const { sqlite, db } = world("__INVOICE_BACKFILL_DB__", "__INVOICE_BACKFILL_ENV__", { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" });
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  await gstAccounting.ensureGstAccountingTables(db);
  // Approved inclusive economics apply only to this disposable fixture.
  const { saveGstSetting } = await import("../lib/gst-setting.ts");
  await saveGstSetting(db, { cityId: "*", ratePercent: 18, method: "extract_inclusive", effectiveFrom: "2024-01-01", reason: "Owner-approved inclusive finance fixture", actorId: "finance.fixture@pawspace.test" });
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'IN','active','founder',1,1,1)").run(ENTITY, SELLER.legalName);
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES ('SEEDTR-TKPET-KA',?,'IN-KA','gstin',?,'active','2024-01-01',NULL,'founder',1,1,1)").run(ENTITY, GSTIN);
  sqlite.prepare("INSERT INTO tax_policy_versions (id,entity_id,version,status,effective_from,effective_to,policy_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES (?,?,1,'active','2024-01-01',NULL,?,'APR','founder',1,1,1)").run(POLICY, ENTITY, JSON.stringify({ seller: SELLER }));
  const draft = await terms.saveCommercialTerm(db, { serviceCode: "grooming", engagementModel: "commission_groomer", providerSharePct: 0.70, effectiveFrom: "2024-01-01", reason: "grooming owner model terms", actorId: "maker@pawspace.in" });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: "APR-GROOM", actorId: "checker@pawspace.in" });
  await seedActors(sqlite, db, [{ id: "USR-FIN", email: FINANCE, role: "finance" }, { id: "USR-MGR", email: MANAGER, role: "manager" }]);
  return { sqlite, db };
}
async function completed(sqlite, db, id, completedAt) {
  const start = new Date(completedAt - 3600_000).toISOString();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,pet_ids_json,city_id,zone_id,service_code,package_code,package_name,provider_id,scheduled_start,scheduled_end,status,total_amount,currency,pricing_json,created_at,updated_at) VALUES (?,?,'[]','blr','blr-east','grooming','pkg','Full groom','PRV-G',?,?,'completed',1000,'INR','{}',1,1)").run(id, `CUS-${id}`, start, start);
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,1000,1000,'INR','upi','prepaid','captured','razorpay',?,'{}',1,1)").run(`PAY-${id}`, id, `CUS-${id}`, `idem-${id}`);
  await completion.resolveServiceCompletionFinance(db, { bookingId: id, actorId: "finance@pawspace.in", completedAt });
}
const saveSeries = (db) => gstAccounting.saveConfiguration(db, { action: "save_series", entityId: ENTITY, documentType: "invoice", prefix: "TKP/{FY}/", padding: 5, policyId: POLICY, reason: "One series a year for customer invoices" }, FINANCE);
const byBooking = (backlog) => Object.fromEntries(backlog.rows.map((row) => [row.bookingId, [row.status, row.key ?? null]]));

test("the backlog issues what is ready in open months and lists, without issuing, what is too old or in a closed month", async () => {
  const { sqlite, db } = await backlogWorld();
  await completed(sqlite, db, "BK-RECENT", at("2026-09-05T11:00:00+05:30"));
  await completed(sqlite, db, "BK-OLD", at("2026-08-01T11:00:00+05:30"));
  await completed(sqlite, db, "BK-CLOSED", at("2026-08-25T11:00:00+05:30"));
  sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES ('2026-08','locked','{}',?,?,?)").run(AS_OF, FINANCE, AS_OF);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices").get().n, 0, "no invoice series yet, so nothing was issued at completion");

  let backlog = await invoices.bookingInvoiceBacklog(db, { asOf: AS_OF });
  assert.deepEqual(byBooking(backlog), { "BK-RECENT": ["refused", "invoice_series"], "BK-OLD": ["too_late", null], "BK-CLOSED": ["period_locked", null] });
  assert.match(backlog.rows.find((r) => r.bookingId === "BK-RECENT").message, /No invoice number series/);
  assert.match(backlog.rows.find((r) => r.bookingId === "BK-OLD").message, /more than 30 days ago: listed, not issued \(Rule 47\)/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM tax_classifications").get().n, 0, "the backlog is read only: nothing is seeded by looking");

  await saveSeries(db);
  backlog = await invoices.bookingInvoiceBacklog(db, { asOf: AS_OF });
  assert.deepEqual(byBooking(backlog)["BK-RECENT"], ["ready", null]);
  const run = await invoices.issueMissingBookingInvoices(db, { actorId: FINANCE, reason: "Series set up; issue the missing invoices", asOf: AS_OF });
  assert.deepEqual(run.issued.map((o) => [o.bookingId, o.invoiceNumber, o.completedOn]), [["BK-RECENT", "TKP/26-27/00001", "2026-09-05"]], "dated the IST completion day");
  assert.deepEqual(run.notIssued.map((o) => [o.bookingId, o.status]).sort(), [["BK-CLOSED", "period_locked"], ["BK-OLD", "too_late"]]);
  assert.equal(sqlite.prepare("SELECT issue_date FROM finance_invoices WHERE source_id='BK-RECENT'").get().issue_date, "2026-09-05");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices WHERE source_id IN ('BK-OLD','BK-CLOSED')").get().n, 0);
  const again = await invoices.issueMissingBookingInvoices(db, { actorId: FINANCE, reason: "Second click on issue missing invoices", asOf: AS_OF });
  assert.equal(again.counts.issued, 0, "idempotent: nothing is issued twice");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM gst_accounting_audit_events WHERE entity_type='booking_invoice_backfill' AND action='issued_missing'").get().n, 2, "every run is audited with its reason");
  // The issue itself refuses a closed month even when asked directly.
  const direct = await invoices.issueBookingInvoice(db, { bookingId: "BK-CLOSED", actorId: FINANCE, asOf: at("2026-08-26T12:00:00+05:30") });
  assert.equal(direct.status, "period_locked");
});

test("only finance.manage may issue missing invoices through the GST route, with a reason", async () => {
  const { sqlite, db } = await backlogWorld();
  const now = Date.now();
  await completed(sqlite, db, "BK-TODAY", now);
  await saveSeries(db);
  const post = (email, body) => gstRoute.POST(asActor(email, "/api/gst-accounting", { method: "POST", body: JSON.stringify(body) }));
  assert.equal((await post(MANAGER, { action: "issue_missing_booking_invoices", reason: "Operations should not issue invoices" })).status, 403);
  const short = await post(FINANCE, { action: "issue_missing_booking_invoices", reason: "short" });
  assert.equal(short.status, 400);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices").get().n, 0);
  const done = await post(FINANCE, { action: "issue_missing_booking_invoices", reason: "Issue the day's missing customer invoices" });
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal((await done.json()).data.counts.issued, 1);
  const listing = await gstRoute.GET(asActor(FINANCE, "/api/gst-accounting"));
  const data = (await listing.json()).data;
  assert.deepEqual(data.bookingInvoices.rows, [], "nothing left to issue");
  assert.equal(data.invoices[0].amount_received, 1000, "the screen reads the amount the customer paid");
  assert.equal(data.serviceSacs.seller.legalName, SELLER.legalName);
  assert.deepEqual(data.funeralGstTreatment.current.treatment, "schedule_iii");
});
