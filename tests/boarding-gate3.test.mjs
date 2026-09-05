/**
 * Boarding Gate 3 — EXECUTED. Cancellation, the refund ceiling, date changes and host settlement.
 *
 * WHAT THIS FILE USED TO BE, AND WHY IT MATTERS MORE HERE THAN ANYWHERE ELSE. Seven tests of regexes
 * over `lib/boarding-finance-governance.ts`. One of them used to be
 * `assert.match(source,/approvedRefundAmount/)` and it proved nothing: the identifier appears whether
 * the ceiling is captured funds or the booking price. It sat beside a message reading "within the
 * captured booking value" while the code compared against `total_amount` — PAWSPACE-QA-001. The file
 * READ correct, behaved wrong, and this suite agreed with it. A refund could exceed what the customer
 * had actually paid.
 *
 * So the first test below is deliberately built in the shape of that defect: a booking whose total is
 * 5000 and whose captured payment is 500. Any ceiling taken from the booking rather than the money
 * fails it.
 *
 * Every test drives the real `mutateBoardingFinance` against a real SQLite-backed D1 and reads the
 * refund ledger, the settlement ledger and the reconciliation row back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, refusal, nextKey, seedBoardingStay, validCarePlan, stayUrl } from "./helpers/stay-harness.mjs";

installWorkersHooks("__BOARDING_G3_DB__", "__BOARDING_G3_ENV__");

const finance = await import("../lib/boarding-finance-governance.ts");
const lifecycle = await import("../lib/boarding-stay-lifecycle.ts");

const MAKER = "ops.maker@pawspace.test";
const CHECKER = "finance.checker@pawspace.test";

async function financeWorld(options = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__BOARDING_G3_DB__ = db;
  globalThis.__BOARDING_G3_ENV__ = {};
  const seeded = await seedBoardingStay(db, sqlite, options);
  await finance.ensureBoardingFinanceTables(db);
  const act = (action, extra = {}) => finance.mutateBoardingFinance(db, {
    bookingId: seeded.bookingId, action, actorId: extra.actorId ?? MAKER,
    idempotencyKey: extra.idempotencyKey ?? nextKey("G3"), ...extra,
  });
  const refunds = async () => (await db.prepare("SELECT * FROM boarding_refund_ledger WHERE booking_id=? ORDER BY rowid").bind(seeded.bookingId).all()).results;
  return { sqlite, db, ...seeded, act, refunds };
}

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 3 caps an approved refund by the money collected, never by the booking total", async () => {
  // THE PAWSPACE-QA-001 SHAPE. Booking total 5000, actually captured 500.
  const world = await financeWorld({ amount: 5000, amountDueNow: 500 });
  await world.db.prepare("UPDATE booking_payments SET amount=500 WHERE booking_id=?").bind(world.bookingId).run();
  await world.act("request_cancel", { reason: "family travel cancelled" });

  // A refund of the BOOKING price is the exact defect. It must be refused.
  const overCollected = await refusal(world.act("approve_cancel", {
    actorId: CHECKER, approvedRefundAmount: 5000, reason: "full refund please",
  }));
  assert.equal(overCollected?.status, 409);
  assert.match(overCollected.message, /cannot exceed the amount actually collected/);
  assert.match(overCollected.message, /collected ₹500/, "the ceiling reported is the captured money, not the 5000 booking total");
  assert.equal((await world.refunds()).length, 0, "a refused approval writes no refund row");

  // Right at the collected amount is allowed; a rupee over is not.
  const justOver = await refusal(world.act("approve_cancel", { actorId: CHECKER, approvedRefundAmount: 501, reason: "nearly" }));
  assert.equal(justOver?.status, 409);

  const approved = await world.act("approve_cancel", { actorId: CHECKER, approvedRefundAmount: 500, reason: "approved in full" });
  assert.ok(approved);
  const [row] = await world.refunds();
  assert.equal(Number(row.amount), 500);
  assert.equal(row.status, "sandbox_pending");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 3 keeps the refund ceiling per booking, not per approval", async () => {
  // The second half of the same defect class: the ceiling belongs to the BOOKING. Applied per
  // approval, two cancellation requests each approved a full refund and 200% of the money left.
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });

  // TWO cancellation requests open at once, which the platform allows. This is the exact historical
  // shape: applied per approval, each one could be granted a full refund and 200% of the money left.
  await world.act("request_cancel", { reason: "first request from the customer" });
  await world.act("request_cancel", { actorId: "second.maker@pawspace.test", reason: "second request raised in error" });
  const open = await world.db.prepare("SELECT COUNT(*) n FROM boarding_cancellation_requests WHERE booking_id=? AND status='policy_review_required'").bind(world.bookingId).all();
  assert.equal(Number(open.results[0].n), 2, "the fixture really does have two open requests");

  await world.act("approve_cancel", { actorId: CHECKER, approvedRefundAmount: 1200, reason: "partial refund approved" });

  const second = await refusal(world.act("approve_cancel", {
    actorId: "another.checker@pawspace.test", approvedRefundAmount: 1200, reason: "approving the second request",
  }));
  assert.equal(second?.status, 409);
  assert.match(second.message, /collected ₹800/, "the headroom is 2000 - 1200 already approved, not the full 2000 again");

  const total = (await world.refunds()).reduce((sum, row) => sum + Number(row.amount), 0);
  assert.equal(total, 1200, "two open requests cannot move more money than was collected");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 3 makes cancellation request-only and never invents a refund", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });

  const requested = await world.act("request_cancel", { reason: "plans changed" });
  assert.equal(requested.status, "policy_review_required", "a request opens a review, it does not cancel");
  assert.equal(requested.refundPolicy, "configuration_required", "no refund policy is invented for the customer");
  assert.equal(requested.bookingPreserved, true);
  assert.equal((await world.refunds()).length, 0, "requesting a cancellation creates no refund");

  const booking = await world.db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(world.bookingId).first();
  assert.notEqual(booking.status, "cancelled");

  const stored = await world.db.prepare("SELECT status,requested_by FROM boarding_cancellation_requests WHERE booking_id=?").bind(world.bookingId).first();
  assert.equal(stored.status, "policy_review_required");
  assert.equal(stored.requested_by, MAKER);

  const reasonless = await refusal(world.act("request_cancel", { reason: "" }));
  assert.equal(reasonless?.status, 400);
  assert.match(reasonless.message, /reason is required/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 3 refuses to let the requester approve their own refund", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });
  await world.act("request_cancel", { reason: "plans changed" });

  const selfApproval = await refusal(world.act("approve_cancel", {
    actorId: MAKER, approvedRefundAmount: 500, reason: "approving my own request",
  }));
  assert.equal(selfApproval?.status, 409);
  assert.match(selfApproval.message, /Segregation of duties/);
  assert.equal((await world.refunds()).length, 0);

  // The same amount, from a different approver, is fine — so the refusal above is about WHO, not what.
  const approved = await world.act("approve_cancel", { actorId: CHECKER, approvedRefundAmount: 500, reason: "reviewed" });
  assert.ok(approved);
  assert.equal((await world.refunds()).length, 1);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 3 sends an in-progress cancellation to Operations instead of cancelling it", async () => {
  const live = {
    scheduledStart: new Date(Date.now() - 3_600_000).toISOString(),
    scheduledEnd: new Date(Date.now() + 7_200_000).toISOString(),
  };
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000, window: live });

  const stayAct = (action, extra = {}) => lifecycle.mutateBoardingStay(world.db, {
    stayId: world.stayId, action, actorId: extra.actorId ?? world.providerId, idempotencyKey: nextKey("G3-STAY"), ...extra,
  });
  await stayAct("accept");
  await stayAct("submit_care_plan", { carePlan: validCarePlan(), actorId: world.customerId });
  await stayAct("check_in");

  // The REQUEST is allowed — a customer whose pet is mid-stay can still ask, and Operations needs to
  // see that they asked. It is the APPROVAL that is blocked, which is the distinction a source-text
  // test cannot make: both actions live in the same file and mention the same sentence.
  const requested = await world.act("request_cancel", { reason: "pet is unsettled" });
  assert.equal(requested.status, "policy_review_required");

  const blocked = await refusal(world.act("approve_cancel", {
    actorId: CHECKER, approvedRefundAmount: 100, reason: "approving a mid-stay cancellation",
  }));
  assert.equal(blocked?.status, 409);
  assert.match(blocked.message, /Operations incident workflow/);
  assert.match(blocked.message, /automatic cancellation is blocked/);

  const stay = await world.db.prepare("SELECT status FROM boarding_stays WHERE id=?").bind(world.stayId).first();
  assert.equal(stay.status, "in_progress", "a blocked approval must not end the stay a pet is currently in");
  assert.equal((await world.refunds()).length, 0, "and must not move money for it either");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 3 refund ledger is sandbox-only and refuses a reused reference", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });
  // Two requests opened up front: approving the first closes the booking, so a second request cannot
  // be raised afterwards.
  await world.act("request_cancel", { reason: "plans changed for the family" });
  await world.act("request_cancel", { actorId: "third.maker@pawspace.test", reason: "raised again by the desk" });
  await world.act("approve_cancel", { actorId: CHECKER, approvedRefundAmount: 600, reason: "approved by finance" });

  const [pending] = await world.refunds();
  assert.equal(pending.status, "sandbox_pending", "an approved refund is pending in sandbox, never paid out here");
  assert.equal(pending.policy_source, "explicit_staff_approval", "no refund arrives without a named policy source");
  assert.equal(pending.currency, "INR");

  const noReference = await refusal(world.act("record_refund", { actorId: CHECKER }));
  assert.equal(noReference?.status, 400);
  assert.match(noReference.message, /refund reference is required/);

  const recorded = await world.act("record_refund", { actorId: CHECKER, refundReference: "SBX-REF-1" });
  assert.ok(recorded);
  assert.equal((await world.refunds())[0].status, "sandbox_recorded");

  // A replayed gateway reference must not re-record a second movement of the same money.
  await world.act("approve_cancel", { actorId: "fourth.checker@pawspace.test", approvedRefundAmount: 400, reason: "second approval" });
  const replayed = await refusal(world.act("record_refund", { actorId: CHECKER, refundReference: "SBX-REF-1" }));
  assert.equal(replayed?.status, 409);
  assert.match(replayed.message, /reference was already used/);

  const recordedRows = (await world.refunds()).filter((row) => row.status === "sandbox_recorded");
  assert.equal(recordedRows.length, 1, "one reference, one recorded refund");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 3 host settlement waits for checkout and invents neither payout nor tax", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });

  const early = await refusal(world.act("prepare_settlement", { actorId: CHECKER }));
  assert.equal(early?.status, 409);
  assert.match(early.message, /only after canonical checkout/);

  const rows = await world.db.prepare("SELECT COUNT(*) n FROM boarding_host_settlement_ledger WHERE booking_id=?").bind(world.bookingId).all();
  assert.equal(Number(rows.results[0].n), 0, "a refused settlement writes no ledger row");

  // Drive the stay to a real checkout, then settle.
  await world.db.prepare("UPDATE boarding_stays SET status='completed',check_out_status='complete' WHERE id=?").bind(world.stayId).run();
  await world.db.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").bind(world.bookingId).run();

  const prepared = await world.act("prepare_settlement", { actorId: CHECKER });
  assert.ok(prepared);
  const settlement = await world.db.prepare("SELECT * FROM boarding_host_settlement_ledger WHERE booking_id=?").bind(world.bookingId).first();
  // Every one of these is a refusal to guess. A payout rule, a tax status and an approval that say
  // anything else are money moving on an assumption.
  //
  // TWO EQUIVALENT MUTATIONS, recorded rather than chased. Changing the DDL DEFAULTs for
  // payout_rule_status and tax_status survives, because the INSERT always names both columns
  // explicitly — the defaults are unreachable. Changing the INSERT's values instead turns this test
  // red, which is checked: 'ready' payout rule, 'gst_18' tax, 'ready' approval and 'instructed'
  // payout each fail here. The assertion is on the row that is actually written.
  assert.equal(settlement.payout_rule_status, "rule_pending");
  assert.equal(settlement.tax_status, "configuration_required");
  assert.equal(settlement.approval_status, "not_ready");
  assert.equal(settlement.payout_status, "not_instructed");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 3 reconciliation reports the real money state without clamping it away", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });

  const clean = await world.act("reconcile", { actorId: CHECKER });
  assert.equal(clean.bookingTotal, 2000);
  assert.equal(clean.refundTotal, 0);
  assert.equal(clean.netCustomerAmount, 2000);
  assert.equal(clean.taxState, "configuration_required", "tax is unconfigured and says so");
  assert.equal(clean.settlementState, "not_prepared");

  await world.act("request_cancel", { reason: "plans changed" });
  await world.act("approve_cancel", { actorId: CHECKER, approvedRefundAmount: 750, reason: "partial" });

  const afterRefund = await world.act("reconcile", { actorId: CHECKER });
  assert.equal(afterRefund.refundTotal, 750);
  assert.equal(afterRefund.netCustomerAmount, 1250, "net is what the customer actually kept paying");

  const stored = await world.db.prepare("SELECT COUNT(*) n FROM boarding_finance_reconciliation WHERE booking_id=?").bind(world.bookingId).all();
  assert.ok(Number(stored.results[0].n) >= 1);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 3 refuses an unknown booking, an unknown action and an incomplete request", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });

  const unknownBooking = await refusal(finance.mutateBoardingFinance(world.db, {
    bookingId: "BKG-NOT-REAL", action: "request_cancel", actorId: MAKER, idempotencyKey: nextKey("G3"), reason: "x",
  }));
  assert.equal(unknownBooking?.status, 404);
  assert.match(unknownBooking.message, /Canonical Boarding booking not found/);

  const unknownAction = await refusal(world.act("refund_everything"));
  assert.equal(unknownAction?.status, 400);
  assert.match(unknownAction.message, /Unsupported Boarding finance action/);

  const incomplete = await refusal(finance.mutateBoardingFinance(world.db, {
    bookingId: world.bookingId, action: "request_cancel", actorId: "", idempotencyKey: "",
  }));
  assert.equal(incomplete?.status, 400);
  assert.match(incomplete.message, /actor and idempotency key are required/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding finance API is a guarded route, not an open one", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });
  const gateway = await import("../lib/api-gateway.ts");

  // Built on a NON-preview origin: on localhost this resolves to a superuser holding ["*"] and the
  // distinction would be unobservable.
  const decision = await gateway.authorizeApiRequest(
    new Request(stayUrl("/api/boarding-finance"), { method: "POST", headers: { "content-type": "application/json" } }),
    { DB: world.db },
  );
  if (decision instanceof Response) {
    assert.equal(decision.status, 401, "the gateway refuses an unauthenticated finance action outright");
  } else {
    assert.ok(decision.permission, "a Boarding finance action is never public");
  }

  const route = await import("../app/api/boarding-finance/route.ts");
  const anonymous = await route.POST(new Request(stayUrl("/api/boarding-finance"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookingId: world.bookingId, action: "approve_cancel", approvedRefundAmount: 2000, reason: "anonymous grab", idempotencyKey: nextKey("G3-API") }),
  }));
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `an anonymous approval is refused: ${anonymous.status}`);
  assert.equal((await world.refunds()).length, 0, "a refused request must not have moved money");
});
