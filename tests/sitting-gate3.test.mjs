/**
 * Pet Sitting Gate 3 — EXECUTED. Cancellation, the refund ceiling, date changes and sitter settlement.
 *
 * WHAT THIS FILE USED TO BE. Nine tests of regexes over `lib/sitting-finance-governance.ts`, the
 * finance route and two workspaces.
 *
 * Sitting carries the SAME refund ceiling as Boarding — `collectedForBooking` minus what has already
 * been approved — and Boarding is where that ceiling was once wrong: PAWSPACE-QA-001 compared against
 * `total_amount` while the message beside it said "captured booking value". The first test here is
 * therefore built in that defect's shape on the Sitting module: booking total 4000, captured 600.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import {
  freshSqlite, makeD1, refusal, nextKey, seedSittingBooking, validSittingCarePlan,
  seedDoorstep, metresNorth, stayUrl,
} from "./helpers/stay-harness.mjs";

installWorkersHooks("__SITTING_G3_DB__", "__SITTING_G3_ENV__");

const finance = await import("../lib/sitting-finance-governance.ts");
const lifecycle = await import("../lib/sitting-lifecycle.ts");

const MAKER = "ops.maker@pawspace.test";
const CHECKER = "finance.checker@pawspace.test";

async function financeWorld(options = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__SITTING_G3_DB__ = db;
  globalThis.__SITTING_G3_ENV__ = {};
  const seeded = await seedSittingBooking(db, sqlite, options);
  await finance.ensureSittingFinanceTables(db);
  const act = (action, extra = {}) => finance.mutateSittingFinance(db, {
    bookingId: seeded.bookingId, action, actorId: extra.actorId ?? MAKER,
    idempotencyKey: extra.idempotencyKey ?? nextKey("SG3"), ...extra,
  });
  const refunds = async () => (await db.prepare("SELECT * FROM sitting_refund_ledger WHERE booking_id=? ORDER BY rowid").bind(seeded.bookingId).all()).results;
  return { sqlite, db, ...seeded, act, refunds };
}

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 3 caps an approved refund by the money collected, never by the booking total", async () => {
  const world = await financeWorld({ amount: 4000, amountDueNow: 600 });
  await world.db.prepare("UPDATE booking_payments SET amount=600 WHERE booking_id=?").bind(world.bookingId).run();
  await world.act("request_cancel", { reason: "customer plans changed" });

  const overCollected = await refusal(world.act("approve_cancel", {
    actorId: CHECKER, approvedRefundAmount: 4000, reason: "refunding the booking value",
  }));
  assert.equal(overCollected?.status, 409);
  assert.match(overCollected.message, /cannot exceed the amount actually collected/);
  assert.match(overCollected.message, /collected ₹600/, "the ceiling is the captured money, not the 4000 booking total");
  assert.equal((await world.refunds()).length, 0);

  const justOver = await refusal(world.act("approve_cancel", { actorId: CHECKER, approvedRefundAmount: 601, reason: "one rupee over" }));
  assert.equal(justOver?.status, 409);

  const approved = await world.act("approve_cancel", { actorId: CHECKER, approvedRefundAmount: 600, reason: "approved in full" });
  assert.ok(approved);
  const [row] = await world.refunds();
  assert.equal(Number(row.amount), 600);
  assert.equal(row.status, "sandbox_pending");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 3 keeps the refund ceiling per booking, not per approval", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });

  await world.act("request_cancel", { reason: "first request from the customer" });
  await world.act("request_cancel", { actorId: "second.maker@pawspace.test", reason: "second request raised in error" });
  await world.act("approve_cancel", { actorId: CHECKER, approvedRefundAmount: 1500, reason: "partial refund approved" });

  const second = await refusal(world.act("approve_cancel", {
    actorId: "another.checker@pawspace.test", approvedRefundAmount: 1500, reason: "approving the second request",
  }));
  assert.equal(second?.status, 409);
  assert.match(second.message, /collected ₹500/, "the headroom is 2000 - 1500, not the full 2000 again");

  const total = (await world.refunds()).reduce((sum, row) => sum + Number(row.amount), 0);
  assert.equal(total, 1500, "two open requests cannot move more money than was collected");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 3 makes cancellation request-only and never invents a refund", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });

  const requested = await world.act("request_cancel", { reason: "plans changed" });
  assert.equal(requested.status, "policy_review_required");
  assert.equal((await world.refunds()).length, 0);

  const booking = await world.db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(world.bookingId).first();
  assert.notEqual(booking.status, "cancelled");

  const stored = await world.db.prepare("SELECT status,requested_by FROM sitting_cancellation_requests WHERE booking_id=?").bind(world.bookingId).first();
  assert.equal(stored.status, "policy_review_required");
  assert.equal(stored.requested_by, MAKER);

  const reasonless = await refusal(world.act("request_cancel", { reason: "" }));
  assert.equal(reasonless?.status, 400);
  assert.match(reasonless.message, /reason is required/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 3 refuses to let the requester approve their own refund", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });
  await world.act("request_cancel", { reason: "plans changed" });

  const selfApproval = await refusal(world.act("approve_cancel", {
    actorId: MAKER, approvedRefundAmount: 500, reason: "approving my own request",
  }));
  assert.equal(selfApproval?.status, 409);
  assert.match(selfApproval.message, /Segregation of duties/);
  assert.equal((await world.refunds()).length, 0);

  const approved = await world.act("approve_cancel", { actorId: CHECKER, approvedRefundAmount: 500, reason: "reviewed by finance" });
  assert.ok(approved);
  assert.equal((await world.refunds()).length, 1);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 3 sends an in-progress cancellation to Operations instead of approving it", async () => {
  const live = {
    scheduledStart: new Date(Date.now() - 3_600_000).toISOString(),
    scheduledEnd: new Date(Date.now() + 7_200_000).toISOString(),
  };
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000, window: live });
  const doorstep = seedDoorstep(world.sqlite, { bookingId: world.bookingId, customerId: world.customerId });

  const stayAct = (action, extra = {}) => lifecycle.mutateSittingBooking(world.db, {
    bookingId: world.bookingId, action, actorId: extra.actorId ?? world.providerId, idempotencyKey: nextKey("SG3-LC"), ...extra,
  });
  await stayAct("accept");
  await stayAct("submit_care_plan", { carePlan: validSittingCarePlan(), actorId: world.customerId });
  await stayAct("check_in", { ...metresNorth(doorstep, 20) });

  // A DELIBERATE DIVERGENCE FROM BOARDING, found by running both. Boarding accepts the request and
  // blocks the APPROVAL; Sitting blocks the REQUEST itself. Both files carry the same sentence, so no
  // source-text test could have told them apart — and a reader who assumed they matched would write a
  // Sitting test that never reaches its assertion.
  const blockedRequest = await refusal(world.act("request_cancel", { reason: "pet is unsettled" }));
  assert.equal(blockedRequest?.status, 409);
  assert.match(blockedRequest.message, /In-progress Sitting cancellation requires an Operations incident workflow/);

  const blocked = await refusal(world.act("approve_cancel", {
    actorId: CHECKER, approvedRefundAmount: 100, reason: "approving a mid-visit cancellation",
  }));
  assert.equal(blocked?.status, 409);
  assert.match(blocked.message, /Operations incident workflow/);

  const open = await world.db.prepare("SELECT COUNT(*) n FROM sitting_cancellation_requests WHERE booking_id=?").bind(world.bookingId).all();
  assert.equal(Number(open.results[0].n), 0, "a blocked request writes no cancellation row");

  const booking = await world.db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(world.bookingId).first();
  assert.equal(booking.status, "in_progress", "a blocked approval must not end a visit in progress");
  assert.equal((await world.refunds()).length, 0, "and must not move money for it either");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 3 refund ledger is sandbox-only and refuses a reused reference", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });
  await world.act("request_cancel", { reason: "plans changed for the family" });
  await world.act("request_cancel", { actorId: "third.maker@pawspace.test", reason: "raised again by the desk" });
  await world.act("approve_cancel", { actorId: CHECKER, approvedRefundAmount: 600, reason: "approved by finance" });

  const [pending] = await world.refunds();
  assert.equal(pending.status, "sandbox_pending", "an approved refund is pending in sandbox, never paid out here");
  assert.equal(pending.currency, "INR");

  const noReference = await refusal(world.act("record_refund", { actorId: CHECKER }));
  assert.equal(noReference?.status, 400);
  assert.match(noReference.message, /refund reference is required/);

  await world.act("record_refund", { actorId: CHECKER, refundReference: "SBX-SIT-1" });
  assert.equal((await world.refunds())[0].status, "sandbox_recorded");

  await world.act("approve_cancel", { actorId: "fourth.checker@pawspace.test", approvedRefundAmount: 400, reason: "second approval" });
  const replayed = await refusal(world.act("record_refund", { actorId: CHECKER, refundReference: "SBX-SIT-1" }));
  assert.equal(replayed?.status, 409);
  assert.match(replayed.message, /reference was already used/);

  const recorded = (await world.refunds()).filter((row) => row.status === "sandbox_recorded");
  assert.equal(recorded.length, 1, "one reference, one recorded refund");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 3 date changes need a fresh quote, a fresh group and a real replacement slot", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });

  // A date change is a QUOTE REQUEST, not a granted move: it is accepted, parked at
  // commercial_quote_required, and reports that the window has not moved.
  const requested = await world.act("request_date_change", {
    reason: "customer travelling later",
    requestedStart: new Date(Date.now() + 72 * 3_600_000).toISOString(),
    requestedEnd: new Date(Date.now() + 76 * 3_600_000).toISOString(),
  });
  assert.equal(requested.status, "commercial_quote_required");
  assert.equal(requested.stayWindowUnchanged, true);

  const booking = await world.db.prepare("SELECT scheduled_start,scheduled_end,total_amount FROM canonical_bookings WHERE id=?").bind(world.bookingId).first();
  assert.equal(booking.scheduled_start, world.scheduledStart, "the paid window is unchanged until money is agreed");
  assert.equal(booking.scheduled_end, world.scheduledEnd);
  assert.equal(Number(booking.total_amount), 2000, "and it has not been repriced");

  // Applying it without a fresh governed quote must not move the window either.
  const applied = await world.act("apply_date_change", { reason: "applying without a quote" }).then(() => null, (error) => error);
  assert.ok(applied, "apply_date_change without a governed quote must not succeed");
  const after = await world.db.prepare("SELECT scheduled_start,total_amount FROM canonical_bookings WHERE id=?").bind(world.bookingId).first();
  assert.equal(after.scheduled_start, world.scheduledStart, "and the paid window still has not moved");
  assert.equal(Number(after.total_amount), 2000);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 3 sitter settlement waits for checkout and invents neither payout nor tax", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });

  const early = await refusal(world.act("prepare_settlement", { actorId: CHECKER }));
  assert.equal(early?.status, 409);
  assert.match(early.message, /only after canonical checkout/);

  const none = await world.db.prepare("SELECT COUNT(*) n FROM sitting_sitter_settlement_ledger WHERE booking_id=?").bind(world.bookingId).all();
  assert.equal(Number(none.results[0].n), 0, "a refused settlement writes no ledger row");

  await world.db.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").bind(world.bookingId).run();
  const prepared = await world.act("prepare_settlement", { actorId: CHECKER });
  assert.equal(prepared.status, "not_ready");
  assert.equal(prepared.payoutRule, "rule_pending");
  assert.equal(prepared.tax, "configuration_required");
  assert.equal(prepared.payout, "not_instructed");

  const settlement = await world.db.prepare("SELECT * FROM sitting_sitter_settlement_ledger WHERE booking_id=?").bind(world.bookingId).first();
  assert.equal(settlement.payout_rule_status, "rule_pending");
  assert.equal(settlement.tax_status, "configuration_required");
  assert.equal(settlement.approval_status, "not_ready");
  assert.equal(settlement.payout_status, "not_instructed");
  // Not one money field is guessed either.
  for (const column of ["base_payout", "travel_allowance", "incentives", "penalties", "payout_amount"]) {
    assert.equal(settlement[column], null, `${column} must stay unset until a payout rule exists`);
  }
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 3 reconciliation reports the real money state", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });

  const clean = await world.act("reconcile", { actorId: CHECKER });
  assert.equal(clean.netCustomerAmount, 2000);
  assert.equal(clean.refundState, "none");
  assert.equal(clean.settlementState, "not_due");
  assert.equal(clean.taxState, "configuration_required", "tax is unconfigured and says so");

  await world.act("request_cancel", { reason: "plans changed" });
  await world.act("approve_cancel", { actorId: CHECKER, approvedRefundAmount: 750, reason: "partial refund" });

  // An APPROVED refund is not yet money out of the door — it is sandbox_pending. Checked by running
  // it: the net is unchanged at this point, and only the recorded refund moves it. Asserting 1250
  // here would have been wrong about when a refund becomes real.
  const afterApproval = await world.act("reconcile", { actorId: CHECKER });
  assert.equal(afterApproval.netCustomerAmount, 2000, "an approved but unrecorded refund has not moved money yet");
  assert.equal(afterApproval.refundState, "none", "and the reconciliation counts settled money only, not approvals");

  await world.act("record_refund", { actorId: CHECKER, refundReference: "SBX-SIT-RECON" });
  const afterRecorded = await world.act("reconcile", { actorId: CHECKER });
  assert.equal(afterRecorded.netCustomerAmount, 1250, "once recorded, net is what the customer actually kept paying");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 3 refuses an unknown booking, an unknown action and an incomplete request", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });

  const unknown = await refusal(finance.mutateSittingFinance(world.db, {
    bookingId: "BKG-NOT-REAL", action: "request_cancel", actorId: MAKER, idempotencyKey: nextKey("SG3"), reason: "x",
  }));
  assert.equal(unknown?.status, 404);
  assert.match(unknown.message, /Canonical Sitting booking not found/);

  const unknownAction = await refusal(world.act("refund_everything"));
  assert.equal(unknownAction?.status, 400);
  assert.match(unknownAction.message, /Unsupported Sitting finance action/);

  const incomplete = await refusal(finance.mutateSittingFinance(world.db, {
    bookingId: world.bookingId, action: "request_cancel", actorId: "", idempotencyKey: "",
  }));
  assert.equal(incomplete?.status, 400);
  assert.match(incomplete.message, /actor and idempotency key are required/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting finance API is a guarded route, not an open one", async () => {
  const world = await financeWorld({ amount: 2000, amountDueNow: 2000 });
  const gateway = await import("../lib/api-gateway.ts");

  const decision = await gateway.authorizeApiRequest(
    new Request(stayUrl("/api/sitting-finance"), { method: "POST", headers: { "content-type": "application/json" } }),
    { DB: world.db },
  );
  if (decision instanceof Response) {
    assert.equal(decision.status, 401, "the gateway refuses an unauthenticated finance action outright");
  } else {
    assert.ok(decision.permission, "a Sitting finance action is never public");
  }

  const route = await import("../app/api/sitting-finance/route.ts");
  const anonymous = await route.POST(new Request(stayUrl("/api/sitting-finance"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookingId: world.bookingId, action: "approve_cancel", approvedRefundAmount: 2000, reason: "anonymous grab", idempotencyKey: nextKey("SG3-API") }),
  }));
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `an anonymous approval is refused: ${anonymous.status}`);
  assert.equal((await world.refunds()).length, 0, "a refused request must not have moved money");
});
