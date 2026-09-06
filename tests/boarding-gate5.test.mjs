/**
 * Boarding Gate 5 — EXECUTED. The Operations exception queue, host recovery, and the closure claim.
 *
 * WHAT THIS FILE USED TO BE. Ten tests of regexes over `lib/boarding-ops-governance.ts`, the ops
 * route and two team pages. The exception queue was "verified" by asserting that each of the twelve
 * flag names appeared in the source — which is true of a file that computes none of them.
 *
 * Every test below drives real state into a real SQLite-backed D1 and asserts that the snapshot
 * derives the flag from it, or drives the real recovery transitions and reads the rows back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, refusal, nextKey, seedBoardingStay, validCarePlan, stayUrl } from "./helpers/stay-harness.mjs";

installWorkersHooks("__BOARDING_G5_DB__", "__BOARDING_G5_ENV__");

const ops = await import("../lib/boarding-ops-governance.ts");
const lifecycle = await import("../lib/boarding-stay-lifecycle.ts");
const finance = await import("../lib/boarding-finance-governance.ts");
const proof = await import("../lib/boarding-proof-governance.ts");

const HOST = "host_maya_rohan";
const OPS = "ops.lead@pawspace.test";
const CHECKER = "finance.checker@pawspace.test";

const liveWindow = () => ({
  scheduledStart: new Date(Date.now() - 3_600_000).toISOString(),
  scheduledEnd: new Date(Date.now() + 7_200_000).toISOString(),
});

async function opsWorld(options = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__BOARDING_G5_DB__ = db;
  globalThis.__BOARDING_G5_ENV__ = {};
  const seeded = await seedBoardingStay(db, sqlite, { window: liveWindow(), ...options });
  await ops.ensureBoardingOpsTables(db);
  await finance.ensureBoardingFinanceTables(db);
  await proof.ensureBoardingProofTables(db);

  const stayAct = (action, extra = {}) => lifecycle.mutateBoardingStay(db, {
    stayId: seeded.stayId, action, actorId: extra.actorId ?? HOST, idempotencyKey: nextKey("G5-STAY"), ...extra,
  });
  const opsAct = (action, extra = {}) => ops.mutateBoardingOps(db, {
    stayId: seeded.stayId, action, actorId: extra.actorId ?? OPS,
    idempotencyKey: extra.idempotencyKey ?? nextKey("G5"), ...extra,
  });
  const financeAct = (action, extra = {}) => finance.mutateBoardingFinance(db, {
    bookingId: seeded.bookingId, action, actorId: extra.actorId ?? OPS, idempotencyKey: nextKey("G5-FIN"), ...extra,
  });
  const flagsFor = async () => {
    const snapshot = await ops.getBoardingOpsSnapshot(db);
    const stay = snapshot.stays.find((row) => String(row.id) === seeded.stayId);
    assert.ok(stay, "the seeded stay is in the Operations queue");
    return { snapshot, stay, flags: stay.exceptionFlags };
  };
  return { sqlite, db, ...seeded, stayAct, opsAct, financeAct, flagsFor };
}

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 5 reports a sandbox contract, not a production launch", async () => {
  const world = await opsWorld();
  const snapshot = await ops.getBoardingOpsSnapshot(world.db);

  assert.equal(snapshot.readiness.productionReady, false, "closing Gate 5 is not a production launch");
  assert.equal(snapshot.readiness.engineeringGate, "gate_5_closed_uat_contract");
  assert.equal(snapshot.readiness.finance, "sandbox_governed");
  assert.equal(snapshot.readiness.media, "private_scan_gated_contract");

  // Each external dependency reports its real state. A gate that claims a disconnected adapter is
  // live is the failure this whole suite exists to prevent.
  const external = snapshot.readiness.externalDependencies;
  assert.equal(external.payments, "sandbox_only");
  assert.equal(external.objectStorage, "disconnected");
  assert.equal(external.tax, "configuration_required");
  for (const [name, value] of Object.entries(external)) {
    assert.equal(/^(live|production|connected)$/.test(String(value)), false, `${name} must not claim a live dependency, got ${value}`);
  }
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 5 derives the care-plan and check-in flags from real stay state", async () => {
  const world = await opsWorld();

  // Accepted, no care plan, and the window has already opened.
  await world.stayAct("accept");
  const accepted = await world.flagsFor();
  assert.ok(accepted.flags.includes("care_plan_required"), `expected care_plan_required, got ${accepted.flags}`);
  assert.ok(accepted.flags.includes("checkin_due"), `expected checkin_due, got ${accepted.flags}`);

  await world.stayAct("submit_care_plan", { carePlan: validCarePlan(), actorId: world.customerId });
  const planned = await world.flagsFor();
  assert.ok(!planned.flags.includes("care_plan_required"), "a ready care plan clears the flag");

  await world.stayAct("check_in");
  const checkedIn = await world.flagsFor();
  assert.ok(!checkedIn.flags.includes("checkin_due"), "checking in clears checkin_due");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 5 raises checkout_due only once the stay window has run out", async () => {
  const world = await opsWorld();
  await world.stayAct("accept");
  await world.stayAct("submit_care_plan", { carePlan: validCarePlan(), actorId: world.customerId });
  await world.stayAct("check_in");

  const during = await world.flagsFor();
  assert.ok(!during.flags.includes("checkout_due"), "a stay still inside its window is not overdue");

  // Move the window's end into the past — real state, not a flag written by hand.
  await world.db.prepare("UPDATE boarding_stays SET check_out_at=? WHERE id=?")
    .bind(new Date(Date.now() - 60_000).toISOString(), world.stayId).run();
  const after = await world.flagsFor();
  assert.ok(after.flags.includes("checkout_due"), `expected checkout_due, got ${after.flags}`);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 5 escalates incidents by severity", async () => {
  for (const [severity, expected] of [["attention", "care_incident"], ["urgent", "urgent_incident"], ["emergency", "emergency_incident"]]) {
    const world = await opsWorld({ bookingId: `BKG-G5-${severity}` });
    await world.stayAct("accept");
    await world.stayAct("submit_care_plan", { carePlan: validCarePlan(), actorId: world.customerId });
    await world.stayAct("check_in");

    await proof.mutateBoardingProof(world.db, {
      stayId: world.stayId, action: "report_incident", actorId: HOST, idempotencyKey: nextKey("G5-INC"),
      severity, summary: `${severity} incident`, actionTaken: "vet contacted",
    });

    const { flags } = await world.flagsFor();
    assert.ok(flags.includes(expected), `${severity} must raise ${expected}, got ${flags}`);
  }
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 5 surfaces the finance exceptions Operations has to chase", async () => {
  const world = await opsWorld({ amount: 2000, amountDueNow: 2000 });

  await world.financeAct("request_cancel", { reason: "customer asked to cancel" });
  const inReview = await world.flagsFor();
  assert.ok(inReview.flags.includes("cancellation_policy_review"), `expected cancellation_policy_review, got ${inReview.flags}`);

  await world.financeAct("approve_cancel", { actorId: CHECKER, approvedRefundAmount: 500, reason: "partial refund approved" });
  const pendingRefund = await world.flagsFor();
  assert.ok(pendingRefund.flags.includes("refund_pending"), `expected refund_pending, got ${pendingRefund.flags}`);

  await world.financeAct("record_refund", { actorId: CHECKER, refundReference: "SBX-G5-1" });
  const settled = await world.flagsFor();
  assert.ok(!settled.flags.includes("refund_pending"), "a recorded refund clears the pending flag");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 5 flags a completed stay whose host settlement is not ready", async () => {
  const world = await opsWorld({ amount: 2000, amountDueNow: 2000 });
  await world.db.prepare("UPDATE boarding_stays SET status='completed',check_out_status='complete' WHERE id=?").bind(world.stayId).run();
  await world.db.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").bind(world.bookingId).run();

  const unsettled = await world.flagsFor();
  assert.ok(unsettled.flags.includes("settlement_not_ready"), `expected settlement_not_ready, got ${unsettled.flags}`);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 5 recovery requires a recovery-pending stay and an eligible replacement", async () => {
  const world = await opsWorld();

  // No recovery open yet: a replacement cannot be assigned into a healthy stay.
  const premature = await refusal(world.opsAct("assign_replacement", { providerId: "host_priya_dev", reason: "swapping hosts" }));
  assert.equal(premature?.status, 409);
  assert.match(premature.message, /requires a recovery-pending Boarding stay/);

  await world.stayAct("decline", { reason: "cannot host this week" });

  const noHost = await refusal(world.opsAct("assign_replacement", { reason: "swapping hosts" }));
  assert.equal(noHost?.status, 400);
  assert.match(noHost.message, /Replacement host and assignment reason are required/);

  const ineligible = await refusal(world.opsAct("assign_replacement", { providerId: "host_not_real", reason: "swapping hosts" }));
  assert.equal(ineligible?.status, 409);
  assert.match(ineligible.message, /not currently eligible for this exact stay/);

  const assigned = await world.opsAct("assign_replacement", { providerId: "host_priya_dev", reason: "original host withdrew" });
  assert.ok(assigned);

  const stay = await world.db.prepare("SELECT host_provider_id,status FROM boarding_stays WHERE id=?").bind(world.stayId).first();
  assert.equal(stay.host_provider_id, "host_priya_dev", "the replacement host owns the stay now");

  const booking = await world.db.prepare("SELECT provider_id,status FROM canonical_bookings WHERE id=?").bind(world.bookingId).first();
  assert.equal(booking.provider_id, "host_priya_dev", "and the canonical booking follows, so the two cannot drift");
  assert.notEqual(booking.status, "cancelled", "recovery never cancels the customer's booking");
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 5 will not close a recovery the replacement host has not accepted", async () => {
  const world = await opsWorld();
  await world.stayAct("decline", { reason: "cannot host this week" });
  await world.opsAct("assign_replacement", { providerId: "host_priya_dev", reason: "original host withdrew" });

  const early = await refusal(world.opsAct("close_recovery", { reason: "closing it out" }));
  assert.equal(early?.status, 409);
  assert.match(early.message, /must accept the recovered stay before Operations can close recovery/);

  await lifecycle.mutateBoardingStay(world.db, {
    stayId: world.stayId, action: "accept", actorId: "host_priya_dev", idempotencyKey: nextKey("G5-ACC"),
  });

  const reasonless = await refusal(world.opsAct("close_recovery"));
  assert.equal(reasonless?.status, 400);
  assert.match(reasonless.message, /recovery closure reason is required/);

  const closed = await world.opsAct("close_recovery", { reason: "replacement host confirmed" });
  assert.ok(closed);

  const cases = await world.db.prepare("SELECT status FROM boarding_recovery_cases WHERE stay_id=?").bind(world.stayId).all();
  assert.ok(cases.results.every((row) => String(row.status) !== "open"), "closing recovery leaves no open case behind");

  const again = await refusal(world.opsAct("close_recovery", { reason: "again" }));
  assert.equal(again?.status, 409);
  assert.match(again.message, /No open Boarding recovery case exists/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 5 requires an Operations note to say something", async () => {
  const world = await opsWorld();

  const empty = await refusal(world.opsAct("add_note", { note: "" }));
  assert.equal(empty?.status, 400);
  assert.match(empty.message, /meaningful Operations note is required/);

  const noise = await refusal(world.opsAct("add_note", { note: "ok" }));
  assert.equal(noise?.status, 400);

  const noted = await world.opsAct("add_note", { note: "Spoke to the host; arriving an hour late." });
  assert.ok(noted);
});

// ---------------------------------------------------------------------------------------------
test("Boarding Gate 5 refuses an unknown stay, an unknown action and an incomplete request", async () => {
  const world = await opsWorld();

  const unknown = await refusal(ops.mutateBoardingOps(world.db, {
    stayId: "BSTAY-NOPE", action: "add_note", actorId: OPS, idempotencyKey: nextKey("G5"), note: "hello there",
  }));
  assert.equal(unknown?.status, 404);
  assert.match(unknown.message, /Canonical Boarding stay not found/);

  const unsupported = await refusal(world.opsAct("delete_stay"));
  assert.equal(unsupported?.status, 400);
  assert.match(unsupported.message, /Unsupported Boarding Operations action/);

  const incomplete = await refusal(ops.mutateBoardingOps(world.db, {
    stayId: world.stayId, action: "add_note", actorId: "", idempotencyKey: "",
  }));
  assert.equal(incomplete?.status, 400);
  assert.match(incomplete.message, /actor and idempotency key are required/);
});

// ---------------------------------------------------------------------------------------------
test("Boarding operations API is a guarded route", async () => {
  const world = await opsWorld();
  const gateway = await import("../lib/api-gateway.ts");

  const decision = await gateway.authorizeApiRequest(
    new Request(stayUrl("/api/boarding-ops"), { method: "POST", headers: { "content-type": "application/json" } }),
    { DB: world.db },
  );
  if (decision instanceof Response) {
    assert.equal(decision.status, 401, "the gateway refuses an unauthenticated Operations action outright");
  } else {
    assert.ok(decision.permission, "a Boarding Operations action is never public");
  }

  const route = await import("../app/api/boarding-ops/route.ts");
  const anonymous = await route.POST(new Request(stayUrl("/api/boarding-ops"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stayId: world.stayId, action: "assign_replacement", providerId: "host_priya_dev", reason: "anonymous swap", idempotencyKey: nextKey("G5-API") }),
  }));
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `an anonymous replacement assignment is refused: ${anonymous.status}`);
  const stay = await world.db.prepare("SELECT host_provider_id FROM boarding_stays WHERE id=?").bind(world.stayId).first();
  assert.equal(stay.host_provider_id, HOST, "a refused request must not have reassigned the host");
});
