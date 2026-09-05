/**
 * Pet Sitting Gate 5 — EXECUTED. The Operations exception queue, sitter recovery, and the closure
 * claim.
 *
 * WHAT THIS FILE USED TO BE. Eleven tests of regexes over `lib/sitting-ops-governance.ts`, four
 * routes and two team pages. The fourteen-flag exception queue was "verified" by asserting each flag
 * NAME appeared in the source — equally true of a file that computes none of them.
 *
 * Every test below drives real state into a real SQLite-backed D1 and asserts the snapshot derives
 * the flag from it, or drives the real recovery transitions and reads the rows back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import {
  freshSqlite, makeD1, refusal, nextKey, seedSittingBooking, validSittingCarePlan,
  seedDoorstep, metresNorth, stayUrl,
} from "./helpers/stay-harness.mjs";

installWorkersHooks("__SITTING_G5_DB__", "__SITTING_G5_ENV__");

const ops = await import("../lib/sitting-ops-governance.ts");
const lifecycle = await import("../lib/sitting-lifecycle.ts");
const finance = await import("../lib/sitting-finance-governance.ts");
const proof = await import("../lib/sitting-proof-governance.ts");

const SITTER = "sitter_ananya";
const OPS = "ops.lead@pawspace.test";
const CHECKER = "finance.checker@pawspace.test";

const liveWindow = () => ({
  scheduledStart: new Date(Date.now() - 3_600_000).toISOString(),
  scheduledEnd: new Date(Date.now() + 7_200_000).toISOString(),
});

async function opsWorld(options = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__SITTING_G5_DB__ = db;
  globalThis.__SITTING_G5_ENV__ = {};
  const seeded = await seedSittingBooking(db, sqlite, { window: liveWindow(), ...options });
  const doorstep = seedDoorstep(sqlite, { bookingId: seeded.bookingId, customerId: seeded.customerId });
  await ops.ensureSittingOpsTables(db);
  await finance.ensureSittingFinanceTables(db);
  await proof.ensureSittingProofTables(db);

  const stayAct = (action, extra = {}) => lifecycle.mutateSittingBooking(db, {
    bookingId: seeded.bookingId, action, actorId: extra.actorId ?? SITTER, idempotencyKey: nextKey("SG5-LC"), ...extra,
  });
  const opsAct = (action, extra = {}) => ops.mutateSittingOps(db, {
    bookingId: seeded.bookingId, action, actorId: extra.actorId ?? OPS,
    idempotencyKey: extra.idempotencyKey ?? nextKey("SG5"), ...extra,
  });
  const financeAct = (action, extra = {}) => finance.mutateSittingFinance(db, {
    bookingId: seeded.bookingId, action, actorId: extra.actorId ?? OPS, idempotencyKey: nextKey("SG5-FIN"), ...extra,
  });
  const flagsFor = async () => {
    const snapshot = await ops.getSittingOpsSnapshot(db);
    const row = snapshot.bookings.find((entry) => String(entry.id) === seeded.bookingId);
    assert.ok(row, "the seeded booking is in the Operations queue");
    return { snapshot, row, flags: row.exceptionFlags };
  };
  return { sqlite, db, ...seeded, doorstep, stayAct, opsAct, financeAct, flagsFor };
}

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 5 reports a sandbox contract, not a production launch", async () => {
  const world = await opsWorld();
  const snapshot = await ops.getSittingOpsSnapshot(world.db);

  assert.equal(snapshot.readiness.productionReady, false, "closing Gate 5 is not a production launch");
  assert.equal(snapshot.readiness.engineeringGate, "gate_5_closed_uat_contract");
  assert.equal(snapshot.readiness.finance, "sandbox_governed");

  const external = snapshot.readiness.externalDependencies;
  assert.equal(external.payments, "sandbox_only");
  assert.equal(external.objectStorage, "disconnected");
  assert.equal(external.tax, "configuration_required");
  assert.equal(external.sitterPayout, "rule_pending");
  for (const [name, value] of Object.entries(external)) {
    assert.equal(/^(live|production|connected)$/.test(String(value)), false, `${name} must not claim a live dependency, got ${value}`);
  }
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 5 derives acceptance, care-plan and check-in flags from real state", async () => {
  const world = await opsWorld();

  // A fresh, unexpired offer is not an exception — checked by running it rather than assumed. The
  // queue is for things Operations must act on, and an offer still inside its window is not one.
  const offered = await world.flagsFor();
  assert.deepEqual(offered.flags, [], `a live offer raises nothing, got ${offered.flags}`);

  // Expire the offer and it becomes actionable. Real state, not a flag written by hand. On its own
  // world, because an expired offer can no longer be accepted — the lifecycle refuses it and routes
  // to Operations recovery, which is itself asserted here.
  const stale = await opsWorld({ bookingId: "BKG-SG5-STALE" });
  await stale.db.prepare("UPDATE provider_assignment_offers SET expires_at=? WHERE booking_id=?")
    .bind(Date.now() - 60_000, stale.bookingId).run();
  const overdue = await stale.flagsFor();
  assert.ok(overdue.flags.includes("sitter_acceptance_due"), `expected sitter_acceptance_due, got ${overdue.flags}`);

  const tooLate = await refusal(stale.stayAct("accept"));
  assert.equal(tooLate?.status, 409);
  assert.match(tooLate.message, /offer expired; Operations recovery is required/);

  await world.stayAct("accept");
  const accepted = await world.flagsFor();
  assert.ok(accepted.flags.includes("care_plan_required"), `expected care_plan_required, got ${accepted.flags}`);
  assert.ok(accepted.flags.includes("checkin_due"), `expected checkin_due, got ${accepted.flags}`);
  assert.ok(!accepted.flags.includes("sitter_acceptance_due"), "accepting clears the acceptance flag");

  await world.stayAct("submit_care_plan", { carePlan: validSittingCarePlan(), actorId: world.customerId });
  const planned = await world.flagsFor();
  assert.ok(!planned.flags.includes("care_plan_required"), "a ready care plan clears the flag");

  await world.stayAct("check_in", { ...metresNorth(world.doorstep, 20) });
  const started = await world.flagsFor();
  assert.ok(!started.flags.includes("checkin_due"), "checking in clears checkin_due");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 5 raises checkout_due only once the visit window has run out", async () => {
  const world = await opsWorld();
  await world.stayAct("accept");
  await world.stayAct("submit_care_plan", { carePlan: validSittingCarePlan(), actorId: world.customerId });
  await world.stayAct("check_in", { ...metresNorth(world.doorstep, 20) });

  const during = await world.flagsFor();
  assert.ok(!during.flags.includes("checkout_due"), "a visit still inside its window is not overdue");

  await world.db.prepare("UPDATE canonical_bookings SET scheduled_end=? WHERE id=?")
    .bind(new Date(Date.now() - 60_000).toISOString(), world.bookingId).run();
  const after = await world.flagsFor();
  assert.ok(after.flags.includes("checkout_due"), `expected checkout_due, got ${after.flags}`);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 5 escalates incidents by severity", async () => {
  for (const [severity, expected] of [["attention", "care_incident"], ["urgent", "urgent_incident"], ["emergency", "emergency_incident"]]) {
    const world = await opsWorld({ bookingId: `BKG-SG5-${severity}` });
    await world.stayAct("accept");
    await world.stayAct("submit_care_plan", { carePlan: validSittingCarePlan(), actorId: world.customerId });
    await world.stayAct("check_in", { ...metresNorth(world.doorstep, 20) });

    await proof.mutateSittingProof(world.db, {
      bookingId: world.bookingId, action: "report_incident", actorId: SITTER, idempotencyKey: nextKey("SG5-INC"),
      severity, summary: `${severity} incident`, actionTaken: "vet contacted",
    });

    const { flags } = await world.flagsFor();
    assert.ok(flags.includes(expected), `${severity} must raise ${expected}, got ${flags}`);
  }
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 5 surfaces the finance exceptions Operations has to chase", async () => {
  const world = await opsWorld({ amount: 2000, amountDueNow: 2000 });

  await world.financeAct("request_cancel", { reason: "customer asked to cancel" });
  const inReview = await world.flagsFor();
  assert.ok(inReview.flags.includes("cancellation_policy_review"), `expected cancellation_policy_review, got ${inReview.flags}`);

  await world.financeAct("approve_cancel", { actorId: CHECKER, approvedRefundAmount: 500, reason: "partial refund approved" });
  const pendingRefund = await world.flagsFor();
  assert.ok(pendingRefund.flags.includes("refund_pending"), `expected refund_pending, got ${pendingRefund.flags}`);

  await world.financeAct("record_refund", { actorId: CHECKER, refundReference: "SBX-SG5-1" });
  const settled = await world.flagsFor();
  assert.ok(!settled.flags.includes("refund_pending"), "a recorded refund clears the pending flag");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 5 flags an uncaptured payment and an unsettled completed booking", async () => {
  const unpaid = await opsWorld({ bookingId: "BKG-SG5-UNPAID", paymentStatus: "pending" });
  const attention = await unpaid.flagsFor();
  assert.ok(attention.flags.includes("payment_attention"), `expected payment_attention, got ${attention.flags}`);

  const done = await opsWorld({ bookingId: "BKG-SG5-DONE", amount: 2000, amountDueNow: 2000 });
  await done.db.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").bind(done.bookingId).run();
  const unsettled = await done.flagsFor();
  assert.ok(unsettled.flags.includes("settlement_not_ready"), `expected settlement_not_ready, got ${unsettled.flags}`);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 5 recovery requires a recovery-pending booking and an eligible sitter", async () => {
  const world = await opsWorld();

  const premature = await refusal(world.opsAct("assign_replacement", { providerId: "sitter_dev", reason: "swapping sitters" }));
  assert.equal(premature?.status, 409);
  assert.match(premature.message, /requires a recovery-pending Sitting booking/);

  await world.stayAct("decline", { reason: "cannot take this booking" });

  const recovering = await world.flagsFor();
  assert.ok(recovering.flags.includes("sitter_recovery"), `expected sitter_recovery, got ${recovering.flags}`);

  const noSitter = await refusal(world.opsAct("assign_replacement", { reason: "swapping sitters" }));
  assert.equal(noSitter?.status, 400);
  assert.match(noSitter.message, /Replacement sitter and assignment reason are required/);

  const ineligible = await refusal(world.opsAct("assign_replacement", { providerId: "sitter_not_real", reason: "swapping sitters" }));
  assert.equal(ineligible?.status, 409);
  assert.match(ineligible.message, /not currently eligible for this exact booking/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 5 will not close a recovery nothing has been assigned to", async () => {
  const world = await opsWorld();
  await world.stayAct("decline", { reason: "cannot take this booking" });

  const noReplacement = await refusal(world.opsAct("close_recovery", { reason: "closing it out" }));
  assert.equal(noReplacement?.status, 409);
  // Pinned to THE specific refusal, not an either/or. Sabotage caught the loose version: two guards
  // stand behind this call, and an alternation let one be deleted while the other still fired. The
  // acceptance guard is the one that reaches the caller first, so that is what is asserted.
  assert.match(noReplacement.message, /Replacement sitter must accept the recovered booking before Operations can close recovery/);

  // The customer's booking survives the whole episode — that is what recovery exists to protect.
  const booking = await world.db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(world.bookingId).first();
  assert.notEqual(booking.status, "cancelled");

  // A recovery case is born 'ops_escalation', not 'open' — checked against the DDL rather than
  // assumed from the Boarding shape.
  const cases = await world.db.prepare("SELECT status FROM sitting_recovery_cases WHERE booking_id=?").bind(world.bookingId).all();
  assert.ok(cases.results.length >= 1, "declining opens a recovery case");
  assert.ok(cases.results.every((row) => String(row.status) !== "resolved"), "and it stays unresolved until it is genuinely closed");
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 5 requires an Operations note to say something", async () => {
  const world = await opsWorld();

  const empty = await refusal(world.opsAct("add_note", { note: "" }));
  assert.equal(empty?.status, 400);
  assert.match(empty.message, /meaningful Operations note is required/);

  const noise = await refusal(world.opsAct("add_note", { note: "ok" }));
  assert.equal(noise?.status, 400);

  const noted = await world.opsAct("add_note", { note: "Spoke to the sitter; running fifteen minutes late." });
  assert.ok(noted);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting Gate 5 refuses an unknown booking, an unknown action and an incomplete request", async () => {
  const world = await opsWorld();

  const unknown = await refusal(ops.mutateSittingOps(world.db, {
    bookingId: "BKG-NOPE", action: "add_note", actorId: OPS, idempotencyKey: nextKey("SG5"), note: "hello there",
  }));
  assert.equal(unknown?.status, 404);
  assert.match(unknown.message, /Canonical Sitting booking not found/);

  const unsupported = await refusal(world.opsAct("delete_booking"));
  assert.equal(unsupported?.status, 400);
  assert.match(unsupported.message, /Unsupported Sitting Operations action/);

  const incomplete = await refusal(ops.mutateSittingOps(world.db, {
    bookingId: world.bookingId, action: "add_note", actorId: "", idempotencyKey: "",
  }));
  assert.equal(incomplete?.status, 400);
  assert.match(incomplete.message, /actor and idempotency key are required/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Sitting operations API is a guarded route", async () => {
  const world = await opsWorld();
  const gateway = await import("../lib/api-gateway.ts");

  const decision = await gateway.authorizeApiRequest(
    new Request(stayUrl("/api/sitting-ops"), { method: "POST", headers: { "content-type": "application/json" } }),
    { DB: world.db },
  );
  if (decision instanceof Response) {
    assert.equal(decision.status, 401, "the gateway refuses an unauthenticated Operations action outright");
  } else {
    assert.ok(decision.permission, "a Sitting Operations action is never public");
  }

  const route = await import("../app/api/sitting-ops/route.ts");
  const anonymous = await route.POST(new Request(stayUrl("/api/sitting-ops"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookingId: world.bookingId, action: "assign_replacement", providerId: "sitter_dev", reason: "anonymous swap", idempotencyKey: nextKey("SG5-API") }),
  }));
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `an anonymous replacement assignment is refused: ${anonymous.status}`);
  const booking = await world.db.prepare("SELECT provider_id FROM canonical_bookings WHERE id=?").bind(world.bookingId).first();
  assert.equal(booking.provider_id, SITTER, "a refused request must not have reassigned the sitter");
});
