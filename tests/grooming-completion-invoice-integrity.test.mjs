import test from "node:test";
import assert from "node:assert/strict";
import { fixtureChecklist } from "./helpers/partner-checklist-fixture.mjs";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

function configuration(label, offset = 3) {
  const start = new Date(Date.now() + offset * 86400000);
  start.setUTCHours(4, 30, 0, 0);
  return { customerId: `R02-CUS-${label}`, customerName: `R02 Test ${label}`,
    phone: "+919900000101", petSourceId: `R02-PET-${label}`, petName: "R02 dog",
    cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716,
    longitude: 77.5946, preferredProviderId: "groom_arun", groupId: `R02-GROUP-${label}`,
    start: start.toISOString() };
}

test("R02: two completed Grooming bookings at the same millisecond retain distinct invoice records", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const ctx = await setupJourney(); t.after(ctx.close);
  const first = await runCompletedJourney(ctx, configuration("FIRST", 3));
  const second = await runCompletedJourney(ctx, configuration("SECOND", 4));
  assert.equal(first.completed.status, 200, JSON.stringify(first.completed.body));
  assert.equal(second.completed.status, 200, JSON.stringify(second.completed.body));
  const rows = ctx.sqlite.prepare("SELECT * FROM booking_invoices WHERE booking_id IN (?,?)").all(first.bookingId, second.bookingId);
  assert.equal(rows.length, 2, "both completed bookings need their own durable invoice record");
  assert.equal(new Set(rows.map(row => row.invoice_number)).size, 2);
  for (const row of rows) assert.equal(ctx.sqlite.prepare("SELECT invoice_id FROM booking_tax_readiness WHERE booking_id=?").get(row.booking_id).invoice_id, row.id);
});

test("R02: Finance issuing an invoice before completion commits cannot leave a phantom invoice link", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const { issueGroomingInvoice } = await import("../lib/grooming-invoice.ts");
  let issued;
  ctx.db.beforeBatch = async (items) => {
    if (!items.some(item => String(item._sql).includes("UPDATE canonical_bookings SET status='completed'"))) return;
    ctx.db.beforeBatch = null;
    const booking = ctx.sqlite.prepare("SELECT id FROM canonical_bookings WHERE customer_id=?").get("R02-CUS-ISSUED");
    await issueGroomingInvoice(ctx.db, { bookingId: booking.id, actorId: "closure-admin@pawspace.test", reason: "R02 approved local invoice race rehearsal" });
    issued = ctx.sqlite.prepare("SELECT * FROM booking_invoices WHERE booking_id=?").get(booking.id);
  };
  const result = await runCompletedJourney(ctx, configuration("ISSUED"));
  assert.ok(issued, "the real invoice issuer must run before the completion batch");
  assert.equal(result.completed.status, 200, JSON.stringify(result.completed.body));
  const current = ctx.sqlite.prepare("SELECT * FROM booking_invoices WHERE booking_id=?").get(result.bookingId);
  assert.deepEqual(current, issued, "completion cannot overwrite a previously issued invoice");
  const tax = ctx.sqlite.prepare("SELECT * FROM booking_tax_readiness WHERE booking_id=?").get(result.bookingId);
  assert.equal(tax.invoice_id, issued.id, "tax readiness must reference the actual stored invoice, not the ignored candidate");
  const event = ctx.sqlite.prepare("SELECT detail_json FROM booking_lifecycle_events WHERE booking_id=? AND event_type='service_completed' ORDER BY occurred_at DESC LIMIT 1").get(result.bookingId);
  assert.equal(JSON.parse(event.detail_json).invoiceNumber, issued.invoice_number);
});

async function retryCompletion(ctx, result) {
  const cookie = await sessionCookie(ctx.db, "provider", result.provider.id, `provider:${result.provider.id}`);
  return routeCall("../../app/api/grooming-lifecycle/route.ts", "POST", "/api/grooming-lifecycle",
    { bookingId: result.bookingId, action: "complete", checklist: fixtureChecklist("complete") }, cookie);
}
function assertNoCompletionRows(ctx, bookingId) {
  assert.notEqual(ctx.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status, "completed");
  assert.notEqual(ctx.sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").get(bookingId).status, "completed");
  for (const table of ["booking_invoices", "booking_tax_readiness", "provider_settlement_readiness", "repeat_booking_tasks"])
    assert.equal(ctx.sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE booking_id=?`).get(bookingId).n, 0, table);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM booking_lifecycle_events WHERE booking_id=? AND event_type='service_completed'").get(bookingId).n, 0);
}

test("R02: an invoice-number collision fails closed and completion retry preserves both invoices", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const prepare = ctx.db.prepare;
  let candidate;
  ctx.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.startsWith("INSERT INTO booking_invoices ")) return statement;
    const bind = statement.bind;
    statement.bind = (...args) => { candidate = args; return bind(...args); };
    return statement;
  };
  ctx.db.beforeBatch = async (items) => {
    if (!items.some(item => String(item._sql).includes("UPDATE canonical_bookings SET status='completed'"))) return;
    ctx.db.beforeBatch = null;
    assert.ok(candidate, "the actual insert must supply the colliding reference");
    // Explicit competing-record fault in this isolated database, not a hosted invoice.
    ctx.sqlite.prepare("INSERT INTO booking_invoices (id,booking_id,customer_id,invoice_number,status,currency,gross_amount,tax_amount,net_amount,issued_at,created_at,updated_at) VALUES ('R02-OTHER-INVOICE','R02-OTHER-BOOKING','R02-OTHER-CUSTOMER',?,'issued','INR',1,0,1,?,?,?)")
      .run(candidate[3], Date.now(), Date.now(), Date.now());
  };
  const result = await runCompletedJourney(ctx, configuration("COLLISION"));
  assert.equal(result.completed.status, 409, JSON.stringify(result.completed.body));
  assert.equal(result.completed.body.code, "completion_invoice_conflict");
  assertNoCompletionRows(ctx, result.bookingId);
  const journalCount = () => ctx.sqlite.prepare("SELECT COUNT(*) n FROM finance_journal_entries WHERE source_type='service_completion' AND source_id=?").get(result.bookingId).n;
  const beforeRetry = journalCount();
  assert.ok(beforeRetry > 0, "existing pre-finalization finance behavior is explicit");
  const retry = await retryCompletion(ctx, result);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(journalCount(), beforeRetry, "retry must not post the financial journal twice");
  const own = ctx.sqlite.prepare("SELECT * FROM booking_invoices WHERE booking_id=?").get(result.bookingId);
  const other = ctx.sqlite.prepare("SELECT * FROM booking_invoices WHERE id='R02-OTHER-INVOICE'").get();
  assert.ok(own && other);
  assert.notEqual(own.invoice_number, other.invoice_number);
  assert.equal(ctx.sqlite.prepare("SELECT invoice_id FROM booking_tax_readiness WHERE booking_id=?").get(result.bookingId).invoice_id, own.id);
});

test("R02: missing invoice persistence rolls back completion projections and remains retryable", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  let injected = false;
  ctx.db.beforeBatch = async (items) => {
    if (!items.some(item => String(item._sql).includes("UPDATE canonical_bookings SET status='completed'"))) return;
    ctx.db.beforeBatch = null;
    injected = true;
    ctx.sqlite.exec("CREATE TEMP TRIGGER r02_ignore_invoice BEFORE INSERT ON booking_invoices BEGIN SELECT RAISE(IGNORE); END");
  };
  const result = await runCompletedJourney(ctx, configuration("DURABILITY"));
  assert.ok(injected, "the fault must reach the actual completion transaction");
  assert.ok(result.completed.status >= 400, JSON.stringify(result.completed.body));
  assertNoCompletionRows(ctx, result.bookingId);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM provider_lifecycle_records WHERE booking_id=? AND lease_token IS NOT NULL").get(result.bookingId).n, 0, "the failed attempt must release its lease");
  ctx.sqlite.exec("DROP TRIGGER r02_ignore_invoice");
  const retry = await retryCompletion(ctx, result);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const invoice = ctx.sqlite.prepare("SELECT * FROM booking_invoices WHERE booking_id=?").get(result.bookingId);
  assert.ok(invoice);
  assert.equal(ctx.sqlite.prepare("SELECT invoice_id FROM booking_tax_readiness WHERE booking_id=?").get(result.bookingId).invoice_id, invoice.id);
});
