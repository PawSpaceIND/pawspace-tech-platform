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
 *
 * Pet Sitting and Pet Taxi had the same gap after the Boarding fix (round-2 transactions audit): their
 * record_refund only flipped the service ledger row to sandbox_recorded. The later sections drive the real
 * Sitting and Taxi finance modules through the same canonical chain.
 *
 * Training had it too: a completed sandbox refund only moved training_refund_instructions and the
 * cancellation case. The last section drives the real Training cancellation module through the chain, and
 * pins that one refund reference is one refund across every service.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { seedCanonicalStayBooking, seedSittingBooking } from "./helpers/stay-harness.mjs";
import { seedCanonicalTrip } from "./helpers/taxi-harness.mjs";

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

// ---------------------------------------------------------------------------------------------------
// Pet Sitting and Pet Taxi go through the same canonical chain.

/** The canonical facts one recorded refund must leave behind, whichever service recorded it. */
function assertRefundInBooks(sqlite, { bookingId, paymentId, refundId, reference, amount, paymentStatus, service }) {
  const refundCase = sqlite.prepare("SELECT status,gateway_reference,amount,payment_id,policy_json FROM booking_refund_cases WHERE id=?").get(refundId);
  assert.ok(refundCase, `${service}: the recorded refund must be a canonical refund case`);
  assert.deepEqual({ status: refundCase.status, reference: refundCase.gateway_reference, amount: Number(refundCase.amount), paymentId: refundCase.payment_id },
    { status: "processed", reference, amount, paymentId }, `${service}: the case is processed under the typed reference`);
  assert.equal(JSON.parse(refundCase.policy_json).service, service);

  const rec = sqlite.prepare("SELECT refunded_amount,gateway_status,reconciliation_status,variance_amount FROM payment_reconciliation_records WHERE payment_id=?").get(paymentId);
  assert.ok(rec, `${service}: reconciliation must hold the refund`);
  assert.equal(Number(rec.refunded_amount), amount, `${service}: reconciliation refunded_amount`);
  assert.equal(rec.gateway_status, paymentStatus);
  assert.equal(rec.reconciliation_status, "matched", `${service}: a refund within the money collected is no overage`);
  assert.equal(Number(rec.variance_amount), 0);
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(paymentId).status, paymentStatus, `${service}: the booking payment follows the refund`);

  const posting = sqlite.prepare("SELECT event,amount,reversal_reference FROM collection_ledger_postings WHERE group_key=?").get(`COLL-refund_completed-${reference}`);
  assert.ok(posting, `${service}: the collection ledger must reverse the collection under the refund reference`);
  assert.equal(Number(posting.amount), amount);
  assert.equal(posting.reversal_reference, reference);
  const journal = sqlite.prepare("SELECT COUNT(*) lines,COALESCE(SUM(debit),0) debit,COALESCE(SUM(credit),0) credit FROM finance_journal_entries WHERE source_type='refund_completed' AND source_id=?").get(reference);
  assert.deepEqual({ lines: Number(journal.lines), debit: Number(journal.debit), credit: Number(journal.credit) }, { lines: 2, debit: amount, credit: amount }, `${service}: a balanced refund journal`);

  const events = sqlite.prepare("SELECT detail_json FROM booking_lifecycle_events WHERE booking_id=? AND event_type='refund_processed'").all(bookingId);
  assert.equal(events.length, 1, `${service}: one refund_processed timeline event`);
  assert.equal(JSON.parse(events[0].detail_json).gatewayRefundId, reference);
}

/** booking_refund_cases as staging already has it: drizzle 0012 plus the policy column the Boarding module added. */
const STAGING_REFUND_CASES = "CREATE TABLE booking_refund_cases (id TEXT PRIMARY KEY NOT NULL,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL DEFAULT 0 NOT NULL,reason TEXT NOT NULL,status TEXT DEFAULT 'requested' NOT NULL,requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,policy_json TEXT NOT NULL DEFAULT '{}')";

/** A paid Pet Sitting booking (₹total captured through Razorpay) with a cancellation awaiting policy review. */
async function paidSitting({ total = 2000 } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__BOARDING_REFUND_DB__ = db;
  globalThis.__BOARDING_REFUND_ENV__ = {};
  sqlite.exec(STAGING_REFUND_CASES);
  const seeded = await seedSittingBooking(db, sqlite, { bookingId: "BK-SIT-R", customerId: "CUS-SIT-R", amount: total, amountDueNow: total });
  const paymentId = `PAY-${seeded.bookingId}`;
  const reconciliation = await import("../lib/grooming-payment-reconciliation.ts");
  await reconciliation.ensurePaymentReconciliationTables(db);
  sqlite.prepare("UPDATE booking_payments SET gateway='razorpay_sandbox' WHERE id=?").run(paymentId);
  sqlite.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES (?,?,'razorpay','sandbox',?,?,0,'INR','captured','matched',0,'evt-capture',?)").run(paymentId, seeded.bookingId, total, total, Date.now());
  const finance = await import("../lib/sitting-finance-governance.ts");
  let seq = 0;
  const selected={};
  const act = async (action, actorId, extra = {}) => {
    const field={approve_cancel:'cancellationRequestId',record_refund:'refundId',apply_date_change:'dateChangeRequestId'}[action];
    const result=await finance.mutateSittingFinance(db,{bookingId:seeded.bookingId,action,actorId,idempotencyKey:`sit-${action}-${++seq}`,reason:"Customer cannot host the sitter",...(field?{[field]:selected[field]}:{}),...extra});
    if(action==='request_cancel')selected.cancellationRequestId=result.requestId;
    if(action==='approve_cancel')selected.refundId=result.refundId;
    return result;
  };
  await act("request_cancel", REQUESTER);
  return { sqlite, db, act, reconciliation, bookingId: seeded.bookingId, paymentId };
}

test("an approved Pet Sitting refund opens its canonical case and recording it reaches the books", async () => {
  const { sqlite, act, bookingId, paymentId } = await paidSitting();
  const approved = await act("approve_cancel", APPROVER, { approvedRefundAmount: 1500 });
  const refundCase = sqlite.prepare("SELECT status,amount,payment_id,requested_by,approved_by,policy_json FROM booking_refund_cases WHERE id=?").get(approved.refundId);
  assert.ok(refundCase, "approve_cancel must open the canonical refund case with the Sitting ledger row's id");
  assert.deepEqual({ status: refundCase.status, amount: Number(refundCase.amount), paymentId: refundCase.payment_id, requestedBy: refundCase.requested_by, approvedBy: refundCase.approved_by },
    { status: "approved", amount: 1500, paymentId, requestedBy: REQUESTER, approvedBy: APPROVER });
  assert.equal(JSON.parse(refundCase.policy_json).automatic, false, "nothing sends it to the gateway on its own");

  const recorded = await act("record_refund", APPROVER, { refundReference: "rfnd_sitting_1" });
  assert.equal(recorded.status, "sandbox_recorded");
  assert.equal(recorded.refundPosted, true);
  assert.equal(sqlite.prepare("SELECT status,reference FROM sitting_refund_ledger WHERE id=?").get(approved.refundId).status, "sandbox_recorded");
  assertRefundInBooks(sqlite, { bookingId, paymentId, refundId: approved.refundId, reference: "rfnd_sitting_1", amount: 1500, paymentStatus: "partially_refunded", service: "pet_sitting" });
});

test("a Pet Sitting refund approved before canonical cases existed still reaches the books, once", async () => {
  const { sqlite, db, act, reconciliation, bookingId, paymentId } = await paidSitting();
  const approved = await act("approve_cancel", APPROVER, { approvedRefundAmount: 2000 });
  sqlite.prepare("DELETE FROM booking_refund_cases WHERE id=?").run(approved.refundId); // approved by the previous build
  await act("record_refund", APPROVER, { refundReference: "rfnd_sitting_2" });
  assertRefundInBooks(sqlite, { bookingId, paymentId, refundId: approved.refundId, reference: "rfnd_sitting_2", amount: 2000, paymentStatus: "refunded", service: "pet_sitting" });

  const late = await reconciliation.processGatewayEvent(db, {
    provider: "razorpay", environment: "sandbox", eventId: "evt-sitting-refund-late", eventType: "refund.processed", bookingId,
    amountSubunits: 200000, gatewayRefundId: "rfnd_sitting_2", payloadHash: "sha256:sit-late", signatureVerified: true,
  });
  assert.equal(late.ignored, true, `the gateway's own refund.processed is recognised as already counted: ${JSON.stringify(late)}`);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE event='refund_completed'").get().n, 1);
  assert.equal(Number(sqlite.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE payment_id=?").get(paymentId).refunded_amount), 2000);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM payment_reconciliation_exceptions").get().n, 0, "no orphan refund, no overage");
});

test("a refund Finance already made in the Razorpay dashboard is recorded against the Sitting ledger without a second reversal", async () => {
  const { sqlite, db, act, reconciliation, bookingId, paymentId } = await paidSitting();
  const approved = await act("approve_cancel", APPROVER, { approvedRefundAmount: 800 });
  const settled = await reconciliation.processGatewayEvent(db, {
    provider: "razorpay", environment: "sandbox", eventId: "evt-sitting-dashboard", eventType: "refund.processed", bookingId,
    amountSubunits: 80000, gatewayRefundId: "rfnd_sitting_dash", payloadHash: "sha256:sit-dash", signatureVerified: true,
  });
  assert.equal(settled.status, "processed", "the gateway refund settles the approved Sitting case");
  const recorded = await act("record_refund", APPROVER, { refundReference: "rfnd_sitting_dash" });
  assert.equal(recorded.status, "sandbox_recorded");
  assert.equal(sqlite.prepare("SELECT status,reference FROM sitting_refund_ledger WHERE id=?").get(approved.refundId).status, "sandbox_recorded",
    "the Sitting ledger must say recorded, not stay pending behind the canonical case");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE event='refund_completed'").get().n, 1, "one reversal");
  assert.equal(Number(sqlite.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE payment_id=?").get(paymentId).refunded_amount), 800);
});

/** A Pet Taxi ride. `captured` = the Razorpay booking fee on its schedule; otherwise paid through the sandbox trip ledger. */
async function paidRide({ total = 1000, captured = null } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__BOARDING_REFUND_DB__ = db;
  globalThis.__BOARDING_REFUND_ENV__ = {};
  sqlite.exec(STAGING_REFUND_CASES);
  const seeded = seedCanonicalTrip(sqlite, { bookingId: "BK-TAXI-R", tripId: "TRIP-R", customerId: "CUS-TAXI-R", amount: total });
  const paymentId = `PAY-${seeded.bookingId}`, now = Date.now();
  const finance = await import("../lib/taxi-finance-governance.ts");
  await finance.ensureTaxiFinanceTables(db);
  const reconciliation = await import("../lib/grooming-payment-reconciliation.ts");
  await reconciliation.ensurePaymentReconciliationTables(db);
  if (captured != null) {
    const { ensureTaxiRideTables } = await import("../lib/taxi-ride-governance.ts");
    await ensureTaxiRideTables(db);
    sqlite.prepare("INSERT INTO taxi_payment_schedules (booking_id,customer_id,total_amount,booking_fee_amount,balance_amount,status,booking_fee_paid_at,booking_fee_reference,created_at,updated_at) VALUES (?,?,?,?,?,'pending_balance',?,'pay_fee',?,?)").run(seeded.bookingId, seeded.customerId, total, captured, total - captured, now, now, now);
    sqlite.prepare("UPDATE booking_payments SET status='captured',gateway='razorpay_sandbox',amount_due_now=?,mode='split_50_50' WHERE id=?").run(captured, paymentId);
    sqlite.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES (?,?,'razorpay','sandbox',?,?,0,'INR','captured','partially_captured',0,'evt-fee',?)").run(paymentId, seeded.bookingId, captured, captured, now);
  } else {
    sqlite.prepare("INSERT INTO taxi_trip_payment_events (id,booking_id,trip_id,amount,currency,status,gateway,reference,created_at,updated_at) VALUES (?,?,?,?,'INR','sandbox_paid','uat_sandbox','SBX-PAID-R',?,?)").run(`TPAY-${seeded.bookingId}`, seeded.bookingId, seeded.tripId, total, now, now);
  }
  let seq = 0;
  const act = (action, actorId, extra = {}) => finance.mutateTaxiFinance(db, { bookingId: seeded.bookingId, action, actorId, idempotencyKey: `taxi-${action}-${++seq}`, reason: "Customer cancelled the ride", ...extra });
  await act("request_cancel", REQUESTER);
  return { sqlite, db, act, reconciliation, bookingId: seeded.bookingId, paymentId };
}

test("an approved Pet Taxi refund of a Razorpay booking fee opens its canonical case and recording it reaches the books", async () => {
  const { sqlite, act, bookingId, paymentId } = await paidRide({ total: 1000, captured: 500 });
  const approved = await act("approve_cancel", APPROVER, { approvedRefundAmount: 500 });
  const refundCase = sqlite.prepare("SELECT status,amount,payment_id,requested_by,approved_by,policy_json FROM booking_refund_cases WHERE id=?").get(approved.refundId);
  assert.ok(refundCase, "approve_cancel must open the canonical refund case with the Taxi ledger row's id");
  assert.deepEqual({ status: refundCase.status, amount: Number(refundCase.amount), paymentId: refundCase.payment_id, requestedBy: refundCase.requested_by, approvedBy: refundCase.approved_by },
    { status: "approved", amount: 500, paymentId, requestedBy: REQUESTER, approvedBy: APPROVER });
  assert.equal(JSON.parse(refundCase.policy_json).service, "pet_taxi");

  const recorded = await act("record_refund", APPROVER, { refundReference: "rfnd_taxi_1" });
  assert.equal(recorded.status, "sandbox_recorded");
  assert.equal(recorded.refundPosted, true);
  assert.equal(sqlite.prepare("SELECT status FROM taxi_refund_ledger WHERE id=?").get(approved.refundId).status, "sandbox_recorded");
  // expected_amount is the booking-fee order, so refunding all of it reads as refunded.
  assertRefundInBooks(sqlite, { bookingId, paymentId, refundId: approved.refundId, reference: "rfnd_taxi_1", amount: 500, paymentStatus: "refunded", service: "pet_taxi" });
});

test("a Pet Taxi ride paid through the sandbox trip ledger refunds against what that ledger collected, not as an overage", async () => {
  const { sqlite, act, bookingId, paymentId } = await paidRide({ total: 449 });
  const approved = await act("approve_cancel", APPROVER, { approvedRefundAmount: 149 });
  await act("record_refund", APPROVER, { refundReference: "rfnd_taxi_2" });
  assertRefundInBooks(sqlite, { bookingId, paymentId, refundId: approved.refundId, reference: "rfnd_taxi_2", amount: 149, paymentStatus: "partially_refunded", service: "pet_taxi" });
  assert.equal(Number(sqlite.prepare("SELECT captured_amount FROM payment_reconciliation_records WHERE payment_id=?").get(paymentId).captured_amount), 449, "collected is the ₹449 the trip ledger holds");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM payment_reconciliation_exceptions WHERE exception_type='refund_overage'").get().n, 0);
  const reconciled = await act("reconcile", APPROVER);
  assert.deepEqual({ paid: reconciled.paidTotal, refund: reconciled.refundTotal, net: reconciled.netPaidTotal }, { paid: 449, refund: 149, net: 300 }, "the Taxi reconciliation is unchanged");
});

// ---------------------------------------------------------------------------------------------------
// Training: a completed sandbox refund reaches the same books.

const TRAINING_REFUND = 12000; // 6 undelivered sessions of a ₹20000, 10-session package

/**
 * A 10-session Training programme paid in full (₹20000 captured through Razorpay) with 4 sessions delivered,
 * and the customer's cancellation calculated under the published no-fee policy. Seeded into `world` when
 * given, so two services' refunds share one set of books.
 */
async function paidTraining(world = null, { bookingId = "BK-TRAIN-R", customerId = "CUS-TRAIN-R" } = {}) {
  const sqlite = world?.sqlite ?? new DatabaseSync(":memory:");
  const db = world?.db ?? makeD1(sqlite);
  if (!world) {
    globalThis.__BOARDING_REFUND_DB__ = db;
    sqlite.exec(STAGING_REFUND_CASES);
  }
  // The Training finance read model the approval refreshes reads the payment environment.
  globalThis.__BOARDING_REFUND_ENV__ = { APP_ENV: "staging", PAWSPACE_PAYMENT_ENV: "sandbox" };
  const programmeId = `PRG-${bookingId}`, paymentId = `PAY-${bookingId}`, now = Date.now();
  seedCanonicalStayBooking(sqlite, { bookingId, customerId, providerId: "trainer-1", serviceCode: "dog_training", packageCode: "plan-10", packageName: "10 Session Doorstep Obedience",
    groupId: `GRP-${bookingId}`, reservationId: `RES-${bookingId}`, amount: 20000, amountDueNow: 20000, status: "in_progress" });
  const cancel = await import("../lib/training-cancellation.ts");
  await (await import("../lib/training-programme.ts")).ensureTrainingProgrammeTables(db);
  await cancel.ensureTrainingCancellationTables(db);
  const reconciliation = await import("../lib/grooming-payment-reconciliation.ts");
  await reconciliation.ensurePaymentReconciliationTables(db);
  sqlite.prepare("UPDATE booking_payments SET gateway='razorpay_sandbox' WHERE id=?").run(paymentId);
  sqlite.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES (?,?,'razorpay','sandbox',20000,20000,0,'INR','captured','matched',0,?,?)").run(paymentId, bookingId, `evt-capture-${bookingId}`, now);
  sqlite.prepare("INSERT INTO training_programmes (id,booking_id,customer_id,provider_id,city_id,zone_id,plan_code,plan_name,pet_ids_json,status,total_sessions,completed_sessions,created_at,updated_at) VALUES (?,?,?,'trainer-1','blr','blr-east','plan-10','10 Session Doorstep Obedience','[\"PET-1\"]','scheduled',10,4,?,?)")
    .run(programmeId, bookingId, customerId, now, now);
  for (let session = 1; session <= 10; session++) {
    sqlite.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,'trainer-1',?,?,?,?,?)")
      .run(`SES-${bookingId}-${session}`, programmeId, bookingId, `RES-${bookingId}-${session}`, session, new Date(now + session * 86_400_000).toISOString(), new Date(now + session * 86_400_000 + 3_600_000).toISOString(), session <= 4 ? "completed" : "locked", now, now);
  }
  await cancel.saveTrainingCancellationPolicy(db, { cityId: "blr", feeType: "none", feeValue: 0, noShowTreatment: "refundable", effectiveFrom: "2026-01-01", reason: "Published no-fee Training policy", actorId: APPROVER });
  const requested = await cancel.requestTrainingCancellation(db, { bookingId, reason: "Customer relocating out of the city", idempotencyKey: `cancel-${bookingId}`, actorId: REQUESTER });
  const approve = () => cancel.approveTrainingCancellation(db, { caseId: requested.caseId, reason: "Relocation confirmed by Finance", actorId: APPROVER });
  const refund = (nextStatus, providerReference) => cancel.updateTrainingRefundSandbox(db, { caseId: requested.caseId, nextStatus, providerReference, reason: `Sandbox refund ${nextStatus}`, actorId: APPROVER });
  const instruction = () => sqlite.prepare("SELECT id,status,provider_reference FROM training_refund_instructions WHERE case_id=?").get(requested.caseId);
  return { sqlite, db, reconciliation, bookingId, paymentId, caseId: requested.caseId, approve, refund, instruction };
}

test("an approved Training refund opens its canonical case and completing it reaches the books", async () => {
  const { sqlite, bookingId, paymentId, caseId, approve, refund, instruction } = await paidTraining();
  const approved = await approve();
  assert.equal(approved.approvedRefund, TRAINING_REFUND);
  const refundId = instruction().id;
  const refundCase = sqlite.prepare("SELECT status,amount,payment_id,requested_by,approved_by,policy_json FROM booking_refund_cases WHERE id=?").get(refundId);
  assert.ok(refundCase, "approval must open the canonical refund case with the Training refund instruction's id");
  assert.deepEqual({ status: refundCase.status, amount: Number(refundCase.amount), paymentId: refundCase.payment_id, requestedBy: refundCase.requested_by, approvedBy: refundCase.approved_by },
    { status: "approved", amount: TRAINING_REFUND, paymentId, requestedBy: REQUESTER, approvedBy: APPROVER });
  const policy = JSON.parse(refundCase.policy_json);
  assert.deepEqual({ service: policy.service, automatic: policy.automatic, cancellationRequestId: policy.cancellationRequestId }, { service: "dog_training", automatic: false, cancellationRequestId: caseId },
    "nothing sends it to the gateway on its own");

  await refund("processing_sandbox");
  assert.equal(sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id=?").get(refundId).status, "approved", "a refund still processing is not in the books");
  assert.equal(Number(sqlite.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE payment_id=?").get(paymentId).refunded_amount), 0);
  const completed = await refund("completed_sandbox", "rfnd_training_1");
  assert.equal(completed.status, "refund_completed_sandbox");
  assert.deepEqual({ ...instruction() }, { id: refundId, status: "completed_sandbox", provider_reference: "rfnd_training_1" });
  assert.equal(sqlite.prepare("SELECT status FROM training_cancellation_cases WHERE id=?").get(caseId).status, "refund_completed_sandbox");
  assertRefundInBooks(sqlite, { bookingId, paymentId, refundId, reference: "rfnd_training_1", amount: TRAINING_REFUND, paymentStatus: "partially_refunded", service: "dog_training" });
});

test("a Training refund approved before canonical cases existed still reaches the books, once", async () => {
  const { sqlite, db, reconciliation, bookingId, paymentId, approve, refund, instruction } = await paidTraining();
  await approve();
  const refundId = instruction().id;
  sqlite.prepare("DELETE FROM booking_refund_cases WHERE id=?").run(refundId); // approved by the previous build
  await refund("processing_sandbox");
  await refund("completed_sandbox", "rfnd_training_2");
  assertRefundInBooks(sqlite, { bookingId, paymentId, refundId, reference: "rfnd_training_2", amount: TRAINING_REFUND, paymentStatus: "partially_refunded", service: "dog_training" });

  await assert.rejects(() => refund("completed_sandbox", "rfnd_training_2"), (error) => { assert.equal(error.status, 409, "a completed refund cannot complete again"); return true; });
  const late = await reconciliation.processGatewayEvent(db, {
    provider: "razorpay", environment: "sandbox", eventId: "evt-training-refund-late", eventType: "refund.processed", bookingId,
    amountSubunits: TRAINING_REFUND * 100, gatewayRefundId: "rfnd_training_2", payloadHash: "sha256:train-late", signatureVerified: true,
  });
  assert.equal(late.ignored, true, `the gateway's own refund.processed is recognised as already counted: ${JSON.stringify(late)}`);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE event='refund_completed'").get().n, 1, "one reversal");
  assert.equal(Number(sqlite.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE payment_id=?").get(paymentId).refunded_amount), TRAINING_REFUND);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM payment_reconciliation_exceptions").get().n, 0, "no orphan refund, no overage");
});

test("a Training refund the gateway already settled is marked completed without a second reversal", async () => {
  const { sqlite, db, reconciliation, bookingId, paymentId, approve, refund, instruction } = await paidTraining();
  await approve();
  await refund("processing_sandbox");
  const settled = await reconciliation.processGatewayEvent(db, {
    provider: "razorpay", environment: "sandbox", eventId: "evt-training-dashboard", eventType: "refund.processed", bookingId,
    amountSubunits: TRAINING_REFUND * 100, gatewayRefundId: "rfnd_training_dash", payloadHash: "sha256:train-dash", signatureVerified: true,
  });
  assert.equal(settled.status, "processed", "the gateway refund settles the approved Training case");
  await refund("completed_sandbox", "rfnd_training_dash");
  assert.equal(instruction().status, "completed_sandbox", "the Training instruction must say completed, not stay behind the canonical case");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE event='refund_completed'").get().n, 1, "one reversal");
  assert.equal(Number(sqlite.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE payment_id=?").get(paymentId).refunded_amount), TRAINING_REFUND);
});

test("one refund reference is one refund across services: reusing a Pet Sitting refund's reference for Training is refused and nothing moves", async () => {
  const sitting = await paidSitting();
  await sitting.act("approve_cancel", APPROVER, { approvedRefundAmount: 1500 });
  await sitting.act("record_refund", APPROVER, { refundReference: "rfnd_shared" });
  const { sqlite, bookingId, paymentId, caseId, approve, refund, instruction } = await paidTraining(sitting, { bookingId: "BK-TRAIN-S", customerId: "CUS-TRAIN-S" });
  await approve();
  await refund("processing_sandbox");
  const refundId = instruction().id;

  // The reversal is keyed by the reference: under a reused one it would count as already posted and the
  // Training refund would never reach the books.
  await assert.rejects(() => refund("completed_sandbox", "rfnd_shared"), (error) => {
    assert.equal(error.status, 409, "a reference another refund already used is refused");
    return true;
  });
  assert.equal(instruction().status, "processing_sandbox", "the Training instruction does not move");
  assert.equal(sqlite.prepare("SELECT status FROM training_cancellation_cases WHERE id=?").get(caseId).status, "refund_processing_sandbox");
  assert.deepEqual({ ...sqlite.prepare("SELECT status,gateway_reference FROM booking_refund_cases WHERE id=?").get(refundId) }, { status: "approved", gateway_reference: null });
  assert.equal(Number(sqlite.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE payment_id=?").get(paymentId).refunded_amount), 0);
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(paymentId).status, "captured");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE event='refund_completed'").get().n, 1, "only the Sitting refund is in the books");

  await refund("completed_sandbox", "rfnd_training_3");
  assertRefundInBooks(sqlite, { bookingId, paymentId, refundId, reference: "rfnd_training_3", amount: TRAINING_REFUND, paymentStatus: "partially_refunded", service: "dog_training" });
  assertRefundInBooks(sqlite, { bookingId: sitting.bookingId, paymentId: sitting.paymentId, refundId: sitting.sqlite.prepare("SELECT id FROM sitting_refund_ledger").get().id, reference: "rfnd_shared", amount: 1500, paymentStatus: "partially_refunded", service: "pet_sitting" });
});
