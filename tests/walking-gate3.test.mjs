/**
 * Dog Walking Gate 3 — EXECUTED. Sandbox payment recording, cancellation with segregation of duties,
 * the refund ledger, walker settlement readiness and reconciliation.
 *
 * WHAT THIS FILE USED TO BE. Eight tests, every assertion a regex over the source of
 * `lib/walking-finance-governance.ts`, the route and two workspace pages. "settlement waits for
 * completed and paid sessions without inventing payout or tax" asserted that
 * `payout_rule_status TEXT NOT NULL DEFAULT 'rule_pending'` appeared in the DDL — a default the INSERT
 * always overrides anyway, and no evidence at all that settlement waits for anything.
 *
 * Each test below drives the real `mutateWalkingFinance` against a real SQLite-backed D1, over walks
 * genuinely completed through `mutateWalkingBooking`, and asserts on the money rows it wrote.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import {
  freshSqlite, makeD1, nextKey, refusal, seedActiveCommercialTerm, seedDoorstep, seedWalkingBooking,
} from "./helpers/stay-harness.mjs";

installWorkersHooks("__WALK_G3_DB__", "__WALK_G3_ENV__");

const lifecycle = await import("../lib/walking-lifecycle.ts");
const finance = await import("../lib/walking-finance-governance.ts");

const DOORSTEP = { latitude: 12.9611, longitude: 77.6387 };
const CUSTOMER = "CUST-WALK-1";
const FINANCE_STAFF = "finance.checker@pawspace.test";

async function walkingWorld(options = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__WALK_G3_DB__ = db;
  globalThis.__WALK_G3_ENV__ = {};
  await seedActiveCommercialTerm(db, { serviceCode: "dog_walking" });
  const booking = await seedWalkingBooking(db, sqlite, options);
  seedDoorstep(sqlite, {
    bookingId: booking.bookingId, customerId: booking.customerId, providerId: booking.providerId, ...DOORSTEP,
  });
  await lifecycle.mutateWalkingBooking(db, {
    bookingId: booking.bookingId, action: "accept", actorId: booking.providerId, idempotencyKey: nextKey(),
  });
  return { sqlite, db, booking };
}

/** Take one walk of a seeded booking all the way to a payment-DUE event. */
async function completeWalk(db, sqlite, booking, index = 0) {
  const { sessionId } = booking.sessions[index];
  const act = (action, extra) => lifecycle.mutateWalkingBooking(db, {
    bookingId: booking.bookingId, action, actorId: booking.providerId, idempotencyKey: nextKey(), sessionId, ...extra,
  });
  await act("confirm_handover", { handoverMethod: "owner" });
  await act("start_walk", DOORSTEP);
  for (const n of [1, 2]) {
    sqlite.prepare("INSERT INTO walking_session_events (id,booking_id,session_id,provider_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,'route_location_sample',?,'{}',?)")
      .run(`RS3-${index}-${n}-${crypto.randomUUID().slice(0, 6)}`, booking.bookingId, sessionId, booking.providerId, booking.providerId, Date.now());
  }
  await act("complete_walk");
  return sessionId;
}

const money = (db, booking, action, extra = {}) => finance.mutateWalkingFinance(db, {
  bookingId: booking.bookingId, action, actorId: FINANCE_STAFF, idempotencyKey: nextKey(), ...extra,
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking Gate 3 treats completed walks as payment-due until sandbox payment is recorded", async () => {
  const { db, sqlite, booking } = await walkingWorld();
  const sessionId = await completeWalk(db, sqlite, booking);

  const due = await db.prepare("SELECT status,reference FROM walking_session_payment_events WHERE session_id=?").bind(sessionId).first();
  assert.equal(due.status, "due");
  assert.equal(due.reference, null);

  const missingReference = await refusal(money(db, booking, "record_session_payment", { sessionId }));
  assert.equal(missingReference?.status, 400);
  assert.match(missingReference.message, /session and sandbox payment reference are required/);

  const unknownSession = await refusal(money(db, booking, "record_session_payment", { sessionId: "WSESS-NOPE", paymentReference: "SBX-1" }));
  assert.equal(unknownSession?.status, 404);
  assert.match(unknownSession.message, /payment-due event not found/);

  const paid = await money(db, booking, "record_session_payment", { sessionId, paymentReference: "SBX-WALK-1" });
  assert.equal(paid.status, "sandbox_paid");
  assert.equal(paid.amount, booking.perWalkAmount);
  assert.equal(paid.liveMoney, false, "recording a sandbox payment never claims live money");
  assert.equal(paid.aggregateStatus, "paid", "the only completed walk being paid settles the booking payment");

  const after = await db.prepare("SELECT status,reference FROM walking_session_payment_events WHERE session_id=?").bind(sessionId).first();
  assert.equal(after.status, "sandbox_paid");
  assert.equal(after.reference, "SBX-WALK-1");

  const aggregate = await db.prepare("SELECT status,detail_json FROM booking_payments WHERE booking_id=?").bind(booking.bookingId).first();
  assert.equal(aggregate.status, "paid");
  const detail = JSON.parse(aggregate.detail_json);
  assert.equal(detail.source, "walking_session_ledger");
  assert.equal(detail.liveMoney, false);
  assert.equal(detail.unpaid, 0);

  // A DIFFERENT sandbox reference on an already-paid session is reported as a duplicate, not a
  // second payment.
  const twice = await money(db, booking, "record_session_payment", { sessionId, paymentReference: "SBX-WALK-2" });
  assert.equal(twice.duplicatePayment, true);
  assert.equal(twice.reference, "SBX-WALK-1", "the original reference stands");
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking sandbox payment references cannot be replayed across sessions", async () => {
  const { db, sqlite, booking } = await walkingWorld({ bookingId: "BKG-WALK-REF", walkCount: 2 });
  const first = await completeWalk(db, sqlite, booking, 0);
  const second = await completeWalk(db, sqlite, booking, 1);

  await money(db, booking, "record_session_payment", { sessionId: first, paymentReference: "SBX-SHARED" });
  const replayed = await refusal(money(db, booking, "record_session_payment", { sessionId: second, paymentReference: "SBX-SHARED" }));
  assert.equal(replayed?.status, 409);
  assert.match(replayed.message, /sandbox payment reference was already used/);
  assert.equal(
    (await db.prepare("SELECT status FROM walking_session_payment_events WHERE session_id=?").bind(second).first()).status,
    "due",
    "a refused replay leaves the second walk unpaid",
  );

  // A payment event in any state other than due or sandbox_paid is not payable. No action writes such
  // a state today, so the row is put there directly -- the guard exists precisely for states this
  // module does not itself produce, and without covering it the guard could be deleted unnoticed.
  await db.prepare("UPDATE walking_session_payment_events SET status='void' WHERE session_id=?").bind(second).run();
  const notPayable = await refusal(money(db, booking, "record_session_payment", { sessionId: second, paymentReference: "SBX-VOID" }));
  assert.equal(notPayable?.status, 409);
  assert.match(notPayable.message, /payment event is not payable/);
  assert.equal(
    (await db.prepare("SELECT reference FROM walking_session_payment_events WHERE session_id=?").bind(second).first()).reference,
    null,
    "a refused payment records no reference",
  );

  await db.prepare("UPDATE walking_session_payment_events SET status='due' WHERE session_id=?").bind(second).run();
  const partial = await money(db, booking, "record_session_payment", { sessionId: second, paymentReference: "SBX-SECOND" });
  assert.equal(partial.aggregateStatus, "paid", "both completed walks paid and no sessions open settles the booking");
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking cancellation preserves completed charges and never invents a refund", async () => {
  const { db, sqlite, booking } = await walkingWorld({ bookingId: "BKG-WALK-CANCEL", walkCount: 2 });
  const done = await completeWalk(db, sqlite, booking, 0);
  await money(db, booking, "record_session_payment", { sessionId: done, paymentReference: "SBX-CANCEL-1" });

  const noReason = await refusal(finance.mutateWalkingFinance(db, {
    bookingId: booking.bookingId, action: "request_cancel", actorId: CUSTOMER, idempotencyKey: nextKey(), reason: "x",
  }));
  assert.equal(noReason?.status, 400);
  assert.match(noReason.message, /A reason is required/);

  const requested = await finance.mutateWalkingFinance(db, {
    bookingId: booking.bookingId, action: "request_cancel", actorId: CUSTOMER,
    idempotencyKey: nextKey(), reason: "Travelling next week",
  });
  assert.equal(requested.status, "policy_review_required");
  assert.equal(requested.refundPolicy, "configuration_required", "no refund is computed at request time");
  assert.equal(requested.bookingPreserved, true);
  assert.equal(requested.approvedRefundAmount, undefined, "a request never carries a refund amount");

  // A second request while one is pending is refused.
  const duplicate = await refusal(finance.mutateWalkingFinance(db, {
    bookingId: booking.bookingId, action: "request_cancel", actorId: CUSTOMER,
    idempotencyKey: nextKey(), reason: "Asking again",
  }));
  assert.equal(duplicate?.status, 409);
  assert.match(duplicate.message, /already pending or approved/);

  // Segregation of duties: the requester cannot approve their own refund.
  const selfApproved = await refusal(finance.mutateWalkingFinance(db, {
    bookingId: booking.bookingId, action: "approve_cancel", actorId: CUSTOMER, idempotencyKey: nextKey(),
    reason: "Approving my own request", approvedRefundAmount: 0,
  }));
  assert.equal(selfApproved?.status, 409);
  assert.match(selfApproved.message, /the cancellation requester cannot approve their own refund/);

  // The refund amount must be explicit and cannot exceed what was actually sandbox-paid.
  const implicit = await refusal(money(db, booking, "approve_cancel", { reason: "Approved by Finance" }));
  assert.equal(implicit?.status, 409);
  assert.match(implicit.message, /must be explicit and cannot exceed sandbox-paid completed walks/);

  const overRefund = await refusal(money(db, booking, "approve_cancel", { reason: "Approved by Finance", approvedRefundAmount: booking.perWalkAmount + 1 }));
  assert.equal(overRefund?.status, 409);
  assert.match(overRefund.message, /cannot exceed sandbox-paid completed walks/);

  const approved = await money(db, booking, "approve_cancel", { reason: "Approved by Finance", approvedRefundAmount: 100 });
  assert.equal(approved.status, "cancelled");
  assert.equal(approved.completedWalkChargesPreserved, true);
  assert.equal(approved.approvedRefundAmount, 100);
  assert.equal(approved.refundStatus, "sandbox_pending", "approval opens a ledger entry, it does not move money");

  // The completed walk keeps its sandbox-paid charge; only the outstanding walk is pulled back.
  assert.equal((await db.prepare("SELECT status FROM walking_session_payment_events WHERE session_id=?").bind(done).first()).status, "sandbox_paid");
  assert.equal((await db.prepare("SELECT status FROM walking_sessions WHERE id=?").bind(done).first()).status, "completed");
  assert.equal((await db.prepare("SELECT status FROM walking_sessions WHERE id=?").bind(booking.sessions[1].sessionId).first()).status, "cancelled");
  assert.equal((await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status, "cancelled");

  const ledger = await db.prepare("SELECT amount,status,reference,policy_source FROM walking_refund_ledger WHERE booking_id=?").bind(booking.bookingId).first();
  assert.equal(Number(ledger.amount), 100);
  assert.equal(ledger.status, "sandbox_pending");
  assert.equal(ledger.reference, null, "no gateway reference is invented at approval");
  assert.equal(ledger.policy_source, "explicit_finance_approval", "the refund is traceable to a human decision, not a policy engine");

  // A closed booking cannot be cancelled again.
  const again = await refusal(money(db, booking, "approve_cancel", { reason: "Once more", approvedRefundAmount: 0 }));
  assert.equal(again?.status, 409);
  assert.match(again.message, /cannot be cancelled again/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking approval with no sandbox-paid walks opens no refund at all", async () => {
  const { db, booking } = await walkingWorld({ bookingId: "BKG-WALK-NOREFUND" });
  await finance.mutateWalkingFinance(db, {
    bookingId: booking.bookingId, action: "request_cancel", actorId: CUSTOMER,
    idempotencyKey: nextKey(), reason: "Nothing has happened yet",
  });

  const approved = await money(db, booking, "approve_cancel", { reason: "Nothing was paid", approvedRefundAmount: 0 });
  assert.equal(approved.status, "cancelled");
  assert.equal(approved.refundId, null);
  assert.equal(approved.refundStatus, "not_required");
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM walking_refund_ledger WHERE booking_id=?").bind(booking.bookingId).first()).n),
    0,
    "a zero refund writes no ledger row",
  );
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking refund ledger is sandbox-only and replay resistant", async () => {
  const { db, sqlite, booking } = await walkingWorld({ bookingId: "BKG-WALK-REFUND", walkCount: 2 });
  const done = await completeWalk(db, sqlite, booking, 0);
  await money(db, booking, "record_session_payment", { sessionId: done, paymentReference: "SBX-R-1" });
  await finance.mutateWalkingFinance(db, {
    bookingId: booking.bookingId, action: "request_cancel", actorId: CUSTOMER,
    idempotencyKey: nextKey(), reason: "Moving cities",
  });
  await money(db, booking, "approve_cancel", { reason: "Approved", approvedRefundAmount: 200 });

  const noReference = await refusal(money(db, booking, "record_refund", {}));
  assert.equal(noReference?.status, 400);
  assert.match(noReference.message, /Sandbox refund reference is required/);

  const recorded = await money(db, booking, "record_refund", { refundReference: "SBX-REFUND-1" });
  assert.equal(recorded.status, "sandbox_recorded");
  assert.equal(recorded.amount, 200);

  const row = await db.prepare("SELECT status,reference FROM walking_refund_ledger WHERE booking_id=?").bind(booking.bookingId).first();
  assert.equal(row.status, "sandbox_recorded");
  assert.equal(row.reference, "SBX-REFUND-1");

  // Nothing is pending any more, so a second record has nothing to act on.
  const none = await refusal(money(db, booking, "record_refund", { refundReference: "SBX-REFUND-2" }));
  assert.equal(none?.status, 409);
  assert.match(none.message, /No Dog Walking sandbox refund is pending/);

  // A refund reference already spent on another booking cannot be reused.
  const other = await walkingWorld({ bookingId: "BKG-WALK-REFUND-2" });
  await other.db.prepare("INSERT INTO walking_refund_ledger (id,booking_id,cancellation_request_id,amount,currency,status,reference,policy_source,created_by,created_at,updated_at) VALUES ('RF-A',?,NULL,50,'INR','sandbox_recorded','SBX-TAKEN','explicit_finance_approval',?,?,?)")
    .bind(other.booking.bookingId, FINANCE_STAFF, Date.now(), Date.now()).run();
  await other.db.prepare("INSERT INTO walking_refund_ledger (id,booking_id,cancellation_request_id,amount,currency,status,reference,policy_source,created_by,created_at,updated_at) VALUES ('RF-B',?,NULL,50,'INR','sandbox_pending',NULL,'explicit_finance_approval',?,?,?)")
    .bind(other.booking.bookingId, FINANCE_STAFF, Date.now(), Date.now()).run();
  const reused = await refusal(money(other.db, other.booking, "record_refund", { refundReference: "SBX-TAKEN" }));
  assert.equal(reused?.status, 409);
  assert.match(reused.message, /refund reference was already used/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking settlement waits for completed and paid walks without inventing payout or tax", async () => {
  const { db, sqlite, booking } = await walkingWorld({ bookingId: "BKG-WALK-SETTLE", walkCount: 2 });

  const early = await refusal(money(db, booking, "prepare_settlement", {}));
  assert.equal(early?.status, 409);
  assert.match(early.message, /only after all canonical walks complete/);

  const first = await completeWalk(db, sqlite, booking, 0);
  const second = await completeWalk(db, sqlite, booking, 1);
  await money(db, booking, "record_session_payment", { sessionId: first, paymentReference: "SBX-S-1" });

  const unpaid = await refusal(money(db, booking, "prepare_settlement", {}));
  assert.equal(unpaid?.status, 409);
  assert.match(unpaid.message, /must be sandbox-paid before settlement readiness/);
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM walking_walker_settlement_ledger WHERE booking_id=?").bind(booking.bookingId).first()).n),
    0,
    "a refused settlement writes no ledger row",
  );

  await money(db, booking, "record_session_payment", { sessionId: second, paymentReference: "SBX-S-2" });
  const prepared = await money(db, booking, "prepare_settlement", {});
  assert.equal(prepared.status, "not_ready", "settlement readiness is not approval");
  assert.equal(prepared.grossPaidValue, booking.perWalkAmount * 2);
  assert.equal(prepared.payoutRule, "rule_pending");
  assert.equal(prepared.tax, "configuration_required");
  assert.equal(prepared.payout, "not_instructed");

  const row = await db.prepare("SELECT * FROM walking_walker_settlement_ledger WHERE booking_id=?").bind(booking.bookingId).first();
  assert.equal(row.provider_id, booking.providerId);
  assert.equal(Number(row.gross_paid_value), booking.perWalkAmount * 2);
  // Nothing downstream of the gross value is invented: no base payout, no incentive, no penalty, no tax.
  for (const column of ["base_payout", "travel_allowance", "incentives", "penalties", "payout_amount", "approved_by", "payout_reference"]) {
    assert.equal(row[column], null, `${column} must stay unset until policy and approval exist`);
  }
  assert.equal(row.payout_rule_status, "rule_pending");
  assert.equal(row.tax_status, "configuration_required");
  assert.equal(row.approval_status, "not_ready");
  assert.equal(row.payout_status, "not_instructed");
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking reconciliation exposes paid, unpaid, refund and settlement truth", async () => {
  const { db, sqlite, booking } = await walkingWorld({ bookingId: "BKG-WALK-RECON", walkCount: 2 });
  const first = await completeWalk(db, sqlite, booking, 0);
  const second = await completeWalk(db, sqlite, booking, 1);
  await money(db, booking, "record_session_payment", { sessionId: first, paymentReference: "SBX-RC-1" });

  const partial = await money(db, booking, "reconcile", {});
  assert.equal(partial.status, "attention_required", "an unpaid completed walk is never reported as balanced");
  assert.equal(partial.completedDueTotal, booking.perWalkAmount * 2);
  assert.equal(partial.paidTotal, booking.perWalkAmount);
  assert.equal(partial.unpaidCompletedTotal, booking.perWalkAmount);
  assert.equal(partial.refundTotal, 0);
  assert.equal(partial.netPaidTotal, booking.perWalkAmount);
  assert.equal(partial.taxState, "configuration_required");

  await money(db, booking, "record_session_payment", { sessionId: second, paymentReference: "SBX-RC-2" });
  await money(db, booking, "prepare_settlement", {});
  const settled = await money(db, booking, "reconcile", {});
  assert.equal(settled.unpaidCompletedTotal, 0);
  assert.equal(settled.paidTotal, booking.perWalkAmount * 2);
  assert.equal(settled.settlementState, "not_ready");
  assert.equal(settled.status, "attention_required", "unapproved settlement and unconfigured tax still need attention");

  const stored = await db.prepare("SELECT booking_total,paid_total,unpaid_completed_total,net_paid_total,settlement_amount,detail_json,checked_by FROM walking_finance_reconciliation WHERE booking_id=? ORDER BY created_at DESC LIMIT 1").bind(booking.bookingId).first();
  assert.equal(Number(stored.booking_total), booking.perWalkAmount * 2);
  assert.equal(Number(stored.paid_total), booking.perWalkAmount * 2);
  assert.equal(Number(stored.unpaid_completed_total), 0);
  assert.equal(Number(stored.net_paid_total), booking.perWalkAmount * 2);
  assert.equal(stored.settlement_amount, null, "reconciliation reports no payout amount because none exists");
  assert.equal(stored.checked_by, FINANCE_STAFF);
  assert.equal(JSON.parse(stored.detail_json).sandboxOnly, true);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking reconciliation counts settled refunds only, and idempotency keys are honoured", async () => {
  const { db, sqlite, booking } = await walkingWorld({ bookingId: "BKG-WALK-NET", walkCount: 2 });
  const done = await completeWalk(db, sqlite, booking, 0);
  await money(db, booking, "record_session_payment", { sessionId: done, paymentReference: "SBX-N-1" });
  await finance.mutateWalkingFinance(db, {
    bookingId: booking.bookingId, action: "request_cancel", actorId: CUSTOMER,
    idempotencyKey: nextKey(), reason: "Relocating",
  });
  await money(db, booking, "approve_cancel", { reason: "Approved", approvedRefundAmount: 149 });

  // The refund is APPROVED but still sandbox_pending, so it has not moved money yet.
  const beforeRecord = await money(db, booking, "reconcile", {});
  assert.equal(beforeRecord.refundTotal, 0, "an approved but unrecorded refund is not yet money out");
  assert.equal(beforeRecord.netPaidTotal, booking.perWalkAmount);

  await money(db, booking, "record_refund", { refundReference: "SBX-N-REFUND" });
  const afterRecord = await money(db, booking, "reconcile", {});
  assert.equal(afterRecord.refundTotal, 149);
  assert.equal(afterRecord.netPaidTotal, booking.perWalkAmount - 149);

  // Replaying a finance idempotency key returns the remembered result without writing again.
  const key = nextKey();
  const once = await finance.mutateWalkingFinance(db, {
    bookingId: booking.bookingId, action: "reconcile", actorId: FINANCE_STAFF, idempotencyKey: key,
  });
  const twice = await finance.mutateWalkingFinance(db, {
    bookingId: booking.bookingId, action: "reconcile", actorId: FINANCE_STAFF, idempotencyKey: key,
  });
  assert.equal(twice.duplicatePrevented, true);
  assert.equal(twice.reconciliationId, once.reconciliationId, "a replay returns the same reconciliation, not a new one");

  const unsupported = await refusal(money(db, booking, "audit_everything", {}));
  assert.equal(unsupported?.status, 400);
  assert.match(unsupported.message, /Unsupported Dog Walking finance action/);

  const missingBooking = await refusal(finance.mutateWalkingFinance(db, {
    bookingId: "BKG-NOPE", action: "reconcile", actorId: FINANCE_STAFF, idempotencyKey: nextKey(),
  }));
  assert.equal(missingBooking?.status, 404);
  assert.match(missingBooking.message, /Canonical Dog Walking booking not found/);
});
