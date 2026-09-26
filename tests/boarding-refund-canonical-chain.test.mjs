/**
 * STAFF-05 — an approved and recorded Boarding refund reaches the books.
 *
 * Boarding refunds lived only in boarding_refund_ledger: approve_cancel wrote a 'sandbox_pending' row and
 * record_refund flipped it to 'sandbox_recorded' with a typed reference. Nothing else moved. The finance
 * journal kept only the capture, payment reconciliation said refunded 0, the booking payment stayed
 * 'captured', BCC listed no refund and the customer saw no amount. A refund done in the Razorpay dashboard
 * instead found no canonical refund case and became an orphan_gateway_refund exception.
 *
 * These tests drive the real Boarding finance module and the real refund webhook against one database.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__BOARDING_REFUND_DB__", "__BOARDING_REFUND_ENV__");

const REQUESTER = "customer.care@pawspace.in";
const APPROVER = "finance.manager@pawspace.in";

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => {
      sqlite.exec("BEGIN");
      try { const out = []; for (const item of list) out.push(await item.run()); sqlite.exec("COMMIT"); return out; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/** A paid Boarding stay (₹total captured through Razorpay) with a cancellation awaiting policy review. */
async function paidStay({ total = 699, captured = total } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT,method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,idempotency_key TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,schedule_group_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT)");
  sqlite.exec("CREATE TABLE boarding_stays (id TEXT PRIMARY KEY,booking_id TEXT,host_provider_id TEXT,status TEXT,check_in_status TEXT,check_out_status TEXT,pet_count INTEGER,city_id TEXT,zone_id TEXT,check_in_at TEXT,check_out_at TEXT,billed_units INTEGER,care_plan_status TEXT,updated_at INTEGER)");
  const now = Date.now(), start = new Date(now + 20 * 86_400_000).toISOString(), end = new Date(now + 23 * 86_400_000).toISOString();
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-R','idem','CUS-R','[]','[]','blr','blr-east','boarding','boarding-24h','Luxury Stay','SG-R','host-1',?,?,'confirmed','customer_app',?,'INR','{}','seed',?,?)").run(start, end, total, now, now);
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-R','BK-R','CUS-R',?,?,'INR','netbanking','prepaid','captured','razorpay_sandbox','pidem','{}',?,?)").run(total, total, now, now);
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('WO-R','BK-R','host-1','SG-R',?,?,'assigned',?)").run(start, end, now);
  sqlite.prepare("INSERT INTO scheduling_reservations VALUES ('RES-R','SG-R','host-1',?,?,'confirmed')").run(start, end);
  sqlite.prepare("INSERT INTO boarding_stays VALUES ('STAY-R','BK-R','host-1','confirmed','pending','pending',1,'blr','blr-east',?,?,3,'ready',?)").run(start, end, now);
  const db = makeD1(sqlite);
  globalThis.__BOARDING_REFUND_DB__ = db;
  globalThis.__BOARDING_REFUND_ENV__ = {};
  const reconciliation = await import("../lib/grooming-payment-reconciliation.ts");
  await reconciliation.ensurePaymentReconciliationTables(db);
  sqlite.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES ('PAY-R','BK-R','razorpay','sandbox',?,?,0,'INR','captured','matched',0,'evt-capture',?)").run(total, captured, now);
  const finance = await import("../lib/boarding-finance-governance.ts");
  const act = (action, actorId, extra = {}) => finance.mutateBoardingFinance(db, { bookingId: "BK-R", action, actorId, idempotencyKey: `${action}-${actorId}-${extra.refundReference || extra.approvedRefundAmount || ""}`, reason: "Customer cannot travel", ...extra });
  await act("request_cancel", REQUESTER);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM boarding_cancellation_requests WHERE status='policy_review_required'").get().n, 1, "a paid stay's cancellation waits for policy review");
  return { sqlite, db, act, reconciliation };
}

test("an approved Boarding refund opens a canonical refund case that nothing sends to the gateway on its own", async () => {
  const { sqlite, act } = await paidStay();
  const approved = await act("approve_cancel", APPROVER, { approvedRefundAmount: 699 });
  const refundCase = sqlite.prepare("SELECT * FROM booking_refund_cases WHERE booking_id='BK-R'").get();
  assert.ok(refundCase, "approve_cancel must open the canonical refund case BCC, Finance queues and the webhook read");
  assert.equal(refundCase.id, approved.refundId, "the case shares the Boarding ledger row's id");
  assert.equal(refundCase.status, "approved");
  assert.equal(Number(refundCase.amount), 699);
  assert.equal(refundCase.payment_id, "PAY-R");
  assert.equal(refundCase.requested_by, REQUESTER);
  assert.equal(refundCase.approved_by, APPROVER);
  const policy = JSON.parse(refundCase.policy_json);
  assert.equal(policy.automatic, false, "the automatic refund sweep must not pick this case up");
  assert.equal(approved.warning, undefined, "a refund within the booking value carries no warning");
});

test("recording the refund posts the reversal, reconciliation, payment status and timeline in one step", async () => {
  const { sqlite, act } = await paidStay();
  const approved = await act("approve_cancel", APPROVER, { approvedRefundAmount: 699 });
  const recorded = await act("record_refund", APPROVER, { refundReference: "rfnd_boarding_1" });
  assert.equal(recorded.status, "sandbox_recorded");
  assert.equal(recorded.refundPosted, true);

  assert.equal(sqlite.prepare("SELECT status,reference FROM boarding_refund_ledger WHERE id=?").get(approved.refundId).status, "sandbox_recorded");
  const refundCase = sqlite.prepare("SELECT status,gateway_reference FROM booking_refund_cases WHERE id=?").get(approved.refundId);
  assert.deepEqual({ ...refundCase }, { status: "processed", gateway_reference: "rfnd_boarding_1" });

  const rec = sqlite.prepare("SELECT refunded_amount,gateway_status,reconciliation_status,variance_amount FROM payment_reconciliation_records WHERE payment_id='PAY-R'").get();
  assert.equal(Number(rec.refunded_amount), 699, "reconciliation must see the refund");
  assert.equal(rec.gateway_status, "refunded");
  assert.equal(rec.reconciliation_status, "matched");
  assert.equal(Number(rec.variance_amount), 0);
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id='PAY-R'").get().status, "refunded", "the booking payment must say refunded");

  const posting = sqlite.prepare("SELECT event,amount,reversal_reference FROM collection_ledger_postings WHERE group_key='COLL-refund_completed-rfnd_boarding_1'").get();
  assert.ok(posting, "the collection ledger must reverse the collection under the refund reference");
  assert.equal(Number(posting.amount), 699);
  const journal = sqlite.prepare("SELECT COALESCE(SUM(debit),0) debit,COALESCE(SUM(credit),0) credit FROM finance_journal_entries WHERE source_type='refund_completed'").get();
  assert.equal(Number(journal.debit), 699, "the refund must reach the finance journal");
  assert.equal(Number(journal.credit), 699, "and balance");

  const event = sqlite.prepare("SELECT detail_json FROM booking_lifecycle_events WHERE booking_id='BK-R' AND event_type='refund_processed'").get();
  assert.equal(JSON.parse(event.detail_json).gatewayRefundId, "rfnd_boarding_1");
});

test("the gateway's own refund.processed for the recorded refund is recognised, not posted twice", async () => {
  const { sqlite, act, reconciliation } = await paidStay();
  await act("approve_cancel", APPROVER, { approvedRefundAmount: 699 });
  await act("record_refund", APPROVER, { refundReference: "rfnd_boarding_2" });
  const result = await reconciliation.processGatewayEvent(globalThis.__BOARDING_REFUND_DB__, {
    provider: "razorpay", environment: "sandbox", eventId: "evt-refund-late", eventType: "refund.processed", bookingId: "BK-R",
    amountSubunits: 69900, gatewayRefundId: "rfnd_boarding_2", payloadHash: "sha256:late", signatureVerified: true,
  });
  assert.equal(result.ignored, true, `the webhook must see the refund as already counted: ${JSON.stringify(result)}`);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE event='refund_completed'").get().n, 1);
  assert.equal(Number(sqlite.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE payment_id='PAY-R'").get().refunded_amount), 699);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM payment_reconciliation_exceptions").get().n, 0, "no orphan refund, no overage");
});

test("a refund done in the Razorpay dashboard settles the approved Boarding case instead of becoming an orphan", async () => {
  const { sqlite, act, reconciliation } = await paidStay();
  const approved = await act("approve_cancel", APPROVER, { approvedRefundAmount: 300 });
  await reconciliation.processGatewayEvent(globalThis.__BOARDING_REFUND_DB__, {
    provider: "razorpay", environment: "sandbox", eventId: "evt-dashboard-refund", eventType: "refund.processed", bookingId: "BK-R",
    amountSubunits: 30000, gatewayRefundId: "rfnd_dashboard_1", payloadHash: "sha256:dash", signatureVerified: true,
  });
  assert.equal(sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id=?").get(approved.refundId).status, "processed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM payment_reconciliation_exceptions WHERE exception_type='orphan_gateway_refund'").get().n, 0);
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id='PAY-R'").get().status, "partially_refunded");
});

test("a refund above the booking value on an over-collected booking is allowed but never silent (STAFF-04)", async () => {
  const { act } = await paidStay({ total: 499, captured: 998 });
  const approved = await act("approve_cancel", APPROVER, { approvedRefundAmount: 600 });
  assert.equal(approved.status, "cancelled");
  assert.match(String(approved.warning || ""), /more than the booking value of ₹499 because ₹998 was collected/);
});
