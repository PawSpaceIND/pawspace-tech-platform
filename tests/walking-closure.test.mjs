/**
 * Dog Walking CLOSURE — EXECUTED. One canonical booking carried the whole way: customer quote →
 * walker acceptance → governed handover → geofenced start → route proof → completion → sandbox
 * payment → settlement → reconciliation, plus the recovery path and the gateway's authority split.
 *
 * WHAT THIS FILE USED TO BE. Six tests, every assertion a regex over source files. "closes one
 * canonical customer to walker to Ops to Finance path" read four files and checked that each one
 * mentioned the next. Nothing in it ever created a booking.
 *
 * This file runs the journey. The point of a closure suite is that the SAME booking id, the SAME
 * money and the SAME completed history survive every hand-off, so almost every assertion here is
 * about continuity between stages rather than about a single function's refusal.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import {
  customerSessionCookie, freshSqlite, makeD1, metresNorth, nextKey, refusal,
  seedActiveCommercialTerm, seedDoorstep, seedWalkingBooking, stayUrl,
} from "./helpers/stay-harness.mjs";

installWorkersHooks("__WALK_CLOSE_DB__", "__WALK_CLOSE_ENV__");

const governance = await import("../lib/walking-governance.ts");
const lifecycle = await import("../lib/walking-lifecycle.ts");
const proof = await import("../lib/walking-proof-governance.ts");
const finance = await import("../lib/walking-finance-governance.ts");
const ops = await import("../lib/walking-ops-governance.ts");
const recoveryGovernance = await import("../lib/walking-recovery-governance.ts");

const DOORSTEP = { latitude: 12.9611, longitude: 77.6387 };
const WALKER = "walk_nisha";
const REPLACEMENT = "walk_asha";
const REVIEWER = "trust.reviewer@pawspace.test";
const FINANCE_STAFF = "finance.checker@pawspace.test";
const OPS_STAFF = "ops.duty@pawspace.test";
const SHA = "b".repeat(64);

async function world({ walkCount = 1, ...options } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__WALK_CLOSE_DB__ = db;
  globalThis.__WALK_CLOSE_ENV__ = {};
  await seedActiveCommercialTerm(db, { serviceCode: "dog_walking" });
  const booking = await seedWalkingBooking(db, sqlite, { providerId: WALKER, walkCount, ...options });
  seedDoorstep(sqlite, {
    bookingId: booking.bookingId, customerId: booking.customerId, providerId: WALKER, ...DOORSTEP,
  });
  // The gateway's denial path writes an audit row, and it only calls ensureGatewayTables() on the
  // staff-email branch -- a platform-session customer reaches the audit insert without it. On a real
  // database lib/server-auth.ts has already created this table; the fixture supplies it the same way,
  // with the DDL copied verbatim from lib/api-gateway.ts.
  sqlite.exec("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)");
  const walk = (action, extra) => lifecycle.mutateWalkingBooking(db, {
    bookingId: booking.bookingId, action, actorId: WALKER, idempotencyKey: nextKey(), ...extra,
  });
  return { sqlite, db, booking, walk };
}

// ---------------------------------------------------------------------------------------------
test("Dog Walking closes one canonical customer to walker to Ops to Finance path", async () => {
  const { db, booking, walk } = await world();
  const sessionId = booking.sessionId;

  // 1. CUSTOMER. A quote is priced by the server and binds the booking that follows.
  const quote = await governance.createWalkingQuote(db, {
    packageCode: "walking-30", mode: "once", petCount: 1, walkCount: 1, paymentMode: "pay_after_service",
    scheduledStart: booking.sessions[0].scheduledStart, scheduledEnd: booking.sessions[0].scheduledEnd,
  });
  const governed = await governance.governWalkingBooking(db, {
    quoteId: quote.quoteId, packageCode: quote.packageCode, packageName: quote.packageName,
    petCount: 1, walkCount: 1, weekdays: [], scheduledStart: quote.scheduledStart, scheduledEnd: quote.scheduledEnd,
    submittedTotal: quote.totalAmount, submittedAmountDueNow: 0, paymentMode: "pay_after_service",
    reservations: [{
      id: booking.sessions[0].reservationId, provider_id: WALKER, occurrence_number: 1,
      scheduled_start: quote.scheduledStart, scheduled_end: quote.scheduledEnd,
    }],
  });
  assert.equal(governed.providerId, WALKER);
  assert.equal(governed.amountDueNow, 0, "the customer pays nothing up front");

  // 2. WALKER. Acceptance, governed handover, geofenced start.
  assert.equal((await walk("accept")).status, "assigned");
  await walk("confirm_handover", { sessionId, handoverMethod: "owner" });
  const started = await walk("start_walk", { sessionId, ...metresNorth(DOORSTEP, 30) });
  assert.equal(started.status, "in_progress");
  assert.equal(started.telemetryMode, "deterministic_sandbox");

  // 3. PROOF. Route evidence and a scanned photo, both through the governed workflow.
  for (const step of [0, 1]) {
    await proof.mutateWalkingProof(db, {
      bookingId: booking.bookingId, action: "record_location_sample", actorId: WALKER, idempotencyKey: nextKey(),
      sessionId, latitude: 12.9612 + step / 10_000, longitude: 77.6388, accuracyMeters: 10,
    });
  }
  const grant = await proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "prepare_media", actorId: WALKER, idempotencyKey: nextKey(),
    sessionId, purpose: "walking_update", mimeType: "image/jpeg", sizeBytes: 88_000, sha256: SHA,
  });
  await proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "sandbox_finalize_media", actorId: WALKER, idempotencyKey: nextKey(),
    uploadToken: grant.upload.token, storageObjectId: "walking-object-closure",
  });
  await proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "record_media_scan", actorId: REVIEWER, idempotencyKey: nextKey(),
    mediaRef: grant.mediaRef, scanResult: "clean",
  });
  await proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "record_photo_update", actorId: WALKER, idempotencyKey: nextKey(),
    sessionId, mediaRef: grant.mediaRef, note: "Happy dog at the park gate",
  });

  // 4. COMPLETION. Money becomes DUE; nothing is captured.
  const completed = await walk("complete_walk", { sessionId });
  assert.equal(completed.paymentStatus, "due");
  assert.equal(completed.liveMoney, false);
  assert.equal(completed.amount, quote.totalAmount, "the amount owed is the amount quoted");

  // 5. FINANCE. Sandbox payment, settlement readiness, reconciliation.
  const money = (action, extra = {}) => finance.mutateWalkingFinance(db, {
    bookingId: booking.bookingId, action, actorId: FINANCE_STAFF, idempotencyKey: nextKey(), ...extra,
  });
  const paid = await money("record_session_payment", { sessionId, paymentReference: "SBX-CLOSURE-1" });
  assert.equal(paid.amount, quote.totalAmount);
  await money("prepare_settlement");
  const reconciled = await money("reconcile");
  assert.equal(reconciled.completedDueTotal, quote.totalAmount);
  assert.equal(reconciled.paidTotal, quote.totalAmount);
  assert.equal(reconciled.unpaidCompletedTotal, 0);
  assert.equal(reconciled.netPaidTotal, quote.totalAmount);

  // 6. THE POINT OF CLOSURE. One booking id carried the whole way, and every stage's rows agree.
  assert.equal(governed.quoteId, quote.quoteId);
  assert.equal(completed.bookingId, booking.bookingId);
  assert.equal(reconciled.bookingId, booking.bookingId);
  const finalBooking = await db.prepare("SELECT status,total_amount FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first();
  assert.equal(finalBooking.status, "completed");
  assert.equal(Number(finalBooking.total_amount), quote.totalAmount, "the price never changed after the quote");

  // 7. OPERATIONS sees the same booking, with no exception left except the un-approved settlement.
  const snapshot = await ops.getWalkingOpsSnapshot(db);
  const entry = snapshot.bookings.find((row) => row.id === booking.bookingId);
  assert.equal(entry.status, "completed");
  assert.equal(entry.completedPaymentDue, 0, "nothing is left owing");
  assert.ok(!entry.exceptionFlags.includes("route_missing"));
  assert.ok(!entry.exceptionFlags.includes("media_blocked"), "scanned proof does not block the booking");
  assert.deepEqual(entry.exceptionFlags, ["settlement_not_ready"], "the only open item is the payout no policy exists for");
  assert.equal(entry.reconciliation.status, "attention_required");
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking completion is server-gated by canonical route evidence", async () => {
  const { db, booking, walk } = await world();
  const sessionId = booking.sessionId;
  await walk("accept");
  await walk("confirm_handover", { sessionId, handoverMethod: "secure_key" });
  await walk("start_walk", { sessionId, ...DOORSTEP });

  // The walker asserting the walk happened is not evidence.
  const noProof = await refusal(walk("complete_walk", { sessionId }));
  assert.equal(noProof?.status, 409);
  assert.match(noProof.message, /at least two canonical sandbox route samples/);

  // Nor are the lifecycle's own event types a way to fake route evidence.
  const faked = await refusal(walk("walk_event", { sessionId, walkEventType: "route_location_sample" }));
  assert.equal(faked?.status, 409);
  assert.match(faked.message, /must use the governed Walking proof workflow/);
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM walking_session_events WHERE session_id=? AND event_type='route_location_sample'").bind(sessionId).first()).n),
    0,
    "the refused shortcut wrote no route sample",
  );

  // Evidence recorded through the governed workflow does unlock completion.
  for (const step of [0, 1]) {
    await proof.mutateWalkingProof(db, {
      bookingId: booking.bookingId, action: "record_location_sample", actorId: WALKER, idempotencyKey: nextKey(),
      sessionId, latitude: 12.9612 + step / 10_000, longitude: 77.6388, accuracyMeters: 15,
    });
  }
  const completed = await walk("complete_walk", { sessionId });
  assert.equal(completed.status, "completed");
  assert.equal(completed.routeSamples, 2, "completion records exactly the evidence it was given");
  assert.equal(completed.gpsConnected, true);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking customer cancellation reaches canonical management without touching money", async () => {
  const { db, booking, walk } = await world({ bookingId: "BKG-WALK-CLOSE-CANCEL", walkCount: 2 });
  await walk("accept");

  // The customer can only REQUEST. Approval, refunds and settlement are Finance's.
  const requested = await finance.mutateWalkingFinance(db, {
    bookingId: booking.bookingId, action: "request_cancel", actorId: booking.customerId,
    idempotencyKey: nextKey(), reason: "Family emergency, cancelling the rest",
  });
  assert.equal(requested.status, "policy_review_required");
  assert.equal(requested.refundPolicy, "configuration_required");

  // Nothing moved: the booking, its walks and its money are exactly where they were.
  assert.equal((await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status, "assigned");
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM walking_refund_ledger WHERE booking_id=?").bind(booking.bookingId).first()).n),
    0,
    "a customer request opens no refund",
  );

  // Operations sees the request as a policy review, not as a decision already taken.
  const snapshot = await ops.getWalkingOpsSnapshot(db);
  const entry = snapshot.bookings.find((row) => row.id === booking.bookingId);
  assert.ok(entry.exceptionFlags.includes("cancellation_policy_review"));
  assert.equal(entry.cancellation.status, "policy_review_required");
  assert.equal(entry.cancellation.approved_refund_amount, null);

  // Finance approving is a separate, explicit, differently-authored act.
  const approved = await finance.mutateWalkingFinance(db, {
    bookingId: booking.bookingId, action: "approve_cancel", actorId: FINANCE_STAFF,
    idempotencyKey: nextKey(), reason: "Approved under goodwill", approvedRefundAmount: 0,
  });
  assert.equal(approved.status, "cancelled");
  assert.equal(approved.refundStatus, "not_required", "nothing had been paid, so nothing is refunded");
  assert.equal((await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status, "cancelled");
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking recovery acceptance is explicit and preserves completed history", async () => {
  const { db, sqlite, booking, walk } = await world({ bookingId: "BKG-WALK-CLOSE-REC", walkCount: 2 });
  await walk("accept");

  // Walk 1 happens and is paid for.
  const done = booking.sessions[0].sessionId;
  await walk("confirm_handover", { sessionId: done, handoverMethod: "owner" });
  await walk("start_walk", { sessionId: done, ...DOORSTEP });
  for (const n of [1, 2]) {
    sqlite.prepare("INSERT INTO walking_session_events (id,booking_id,session_id,provider_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,'route_location_sample',?,'{}',?)")
      .run(`RSC-${n}`, booking.bookingId, done, WALKER, WALKER, Date.now());
  }
  await walk("complete_walk", { sessionId: done });
  await finance.mutateWalkingFinance(db, {
    bookingId: booking.bookingId, action: "record_session_payment", actorId: FINANCE_STAFF,
    idempotencyKey: nextKey(), sessionId: done, paymentReference: "SBX-CLOSE-REC-1",
  });

  // The walker then drops out.
  await walk("walker_unavailable", { reason: "Walker injured before the second walk" });
  await ops.mutateWalkingOps(db, {
    bookingId: booking.bookingId, action: "assign_replacement", actorId: OPS_STAFF,
    idempotencyKey: nextKey(), providerId: REPLACEMENT, reason: "Eligible replacement for the remaining walk",
  });

  // Operations offering is NOT the replacement being on the job.
  assert.equal((await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status, "reassignment_offered");
  const beforeAcceptance = await refusal(lifecycle.mutateWalkingBooking(db, {
    bookingId: booking.bookingId, action: "confirm_handover", actorId: REPLACEMENT, idempotencyKey: nextKey(),
    sessionId: booking.sessions[1].sessionId, handoverMethod: "owner",
  }));
  assert.equal(beforeAcceptance?.status, 409);
  assert.match(beforeAcceptance.message, /Walker acceptance is required before handover/);

  const accepted = await recoveryGovernance.acceptWalkingReplacement(db, {
    bookingId: booking.bookingId, providerId: REPLACEMENT, actorId: REPLACEMENT, idempotencyKey: nextKey(),
  });
  assert.equal(accepted.status, "assigned");
  assert.equal(accepted.bookingId, booking.bookingId, "recovery kept the same canonical booking");

  // The completed walk, its walker, its reservation and its paid charge all survived.
  assert.equal((await db.prepare("SELECT provider_id,status FROM walking_sessions WHERE id=?").bind(done).first()).provider_id, WALKER);
  assert.equal((await db.prepare("SELECT status FROM scheduling_reservations WHERE id=?").bind(booking.sessions[0].reservationId).first()).status, "completed");
  const charge = await db.prepare("SELECT status,amount,reference FROM walking_session_payment_events WHERE session_id=?").bind(done).first();
  assert.equal(charge.status, "sandbox_paid");
  assert.equal(charge.reference, "SBX-CLOSE-REC-1");
  assert.equal(Number(charge.amount), booking.perWalkAmount);

  await ops.mutateWalkingOps(db, {
    bookingId: booking.bookingId, action: "close_recovery", actorId: OPS_STAFF,
    idempotencyKey: nextKey(), reason: "Replacement walker confirmed for the remaining walk",
  });
  assert.equal((await db.prepare("SELECT status FROM walking_recovery_cases WHERE booking_id=?").bind(booking.bookingId).first()).status, "resolved");

  // The replacement then runs the remaining walk on the SAME booking.
  const second = booking.sessions[1].sessionId;
  const asReplacement = (action, extra) => lifecycle.mutateWalkingBooking(db, {
    bookingId: booking.bookingId, action, actorId: REPLACEMENT, idempotencyKey: nextKey(), sessionId: second, ...extra,
  });
  await asReplacement("confirm_handover", { handoverMethod: "building_staff" });
  const restarted = await asReplacement("start_walk", DOORSTEP);
  assert.equal(restarted.status, "in_progress");
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking recovery can close after the replacement has started without moving the booking backward", async () => {
  const { db, sqlite, booking, walk } = await world({ bookingId: "BKG-WALK-CLOSE-ACTIVE", walkCount: 2 });
  await walk("accept");

  const done = booking.sessions[0].sessionId;
  await walk("confirm_handover", { sessionId: done, handoverMethod: "owner" });
  await walk("start_walk", { sessionId: done, ...DOORSTEP });
  for (const n of [1, 2]) {
    sqlite.prepare("INSERT INTO walking_session_events (id,booking_id,session_id,provider_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,'route_location_sample',?,'{}',?)")
      .run(`RSA-${n}`, booking.bookingId, done, WALKER, WALKER, Date.now());
  }
  await walk("complete_walk", { sessionId: done });
  await walk("walker_unavailable", { reason: "Walker injured before the second walk" });
  await ops.mutateWalkingOps(db, {
    bookingId: booking.bookingId, action: "assign_replacement", actorId: OPS_STAFF,
    idempotencyKey: nextKey(), providerId: REPLACEMENT, reason: "Eligible replacement for the remaining walk",
  });
  await recoveryGovernance.acceptWalkingReplacement(db, {
    bookingId: booking.bookingId, providerId: REPLACEMENT, actorId: REPLACEMENT, idempotencyKey: nextKey(),
  });

  const second = booking.sessions[1].sessionId;
  const asReplacement = (action, extra) => lifecycle.mutateWalkingBooking(db, {
    bookingId: booking.bookingId, action, actorId: REPLACEMENT, idempotencyKey: nextKey(), sessionId: second, ...extra,
  });
  await asReplacement("confirm_handover", { handoverMethod: "building_staff" });
  await asReplacement("start_walk", DOORSTEP);
  assert.equal((await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status, "in_progress");

  const closed = await ops.mutateWalkingOps(db, {
    bookingId: booking.bookingId, action: "close_recovery", actorId: OPS_STAFF,
    idempotencyKey: nextKey(), reason: "Replacement walker is actively serving the recovered walk",
  });
  assert.equal(closed.status, "resolved");
  assert.equal(closed.bookingStatus, "in_progress");
  assert.equal((await db.prepare("SELECT status FROM walking_recovery_cases WHERE booking_id=?").bind(booking.bookingId).first()).status, "resolved");
  assert.equal((await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status, "in_progress");

  for (const n of [3, 4]) {
    sqlite.prepare("INSERT INTO walking_session_events (id,booking_id,session_id,provider_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,'route_location_sample',?,'{}',?)")
      .run(`RSA-${n}`, booking.bookingId, second, REPLACEMENT, REPLACEMENT, Date.now());
  }
  await asReplacement("complete_walk", {});
  assert.equal((await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status, "completed");
  const entry = (await ops.getWalkingOpsSnapshot(db)).bookings.find((row) => row.id === booking.bookingId);
  assert.ok(!entry.exceptionFlags.includes("walker_recovery"), "a resolved recovery does not remain in the high-priority queue");
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking recovery can close after the recovered programme has completed", async () => {
  const { db, sqlite, booking, walk } = await world({ bookingId: "BKG-WALK-CLOSE-COMPLETE", walkCount: 2 });
  await walk("accept");

  const first = booking.sessions[0].sessionId;
  await walk("confirm_handover", { sessionId: first, handoverMethod: "owner" });
  await walk("start_walk", { sessionId: first, ...DOORSTEP });
  for (const n of [1, 2]) {
    sqlite.prepare("INSERT INTO walking_session_events (id,booking_id,session_id,provider_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,'route_location_sample',?,'{}',?)")
      .run(`RSCOMP-${n}`, booking.bookingId, first, WALKER, WALKER, Date.now());
  }
  await walk("complete_walk", { sessionId: first });
  await walk("walker_unavailable", { reason: "Walker unavailable for the final walk" });
  await ops.mutateWalkingOps(db, {
    bookingId: booking.bookingId, action: "assign_replacement", actorId: OPS_STAFF,
    idempotencyKey: nextKey(), providerId: REPLACEMENT, reason: "Replacement covers the final walk",
  });
  await recoveryGovernance.acceptWalkingReplacement(db, {
    bookingId: booking.bookingId, providerId: REPLACEMENT, actorId: REPLACEMENT, idempotencyKey: nextKey(),
  });

  const second = booking.sessions[1].sessionId;
  const asReplacement = (action, extra) => lifecycle.mutateWalkingBooking(db, {
    bookingId: booking.bookingId, action, actorId: REPLACEMENT, idempotencyKey: nextKey(), sessionId: second, ...extra,
  });
  await asReplacement("confirm_handover", { handoverMethod: "building_staff" });
  await asReplacement("start_walk", DOORSTEP);
  for (const n of [3, 4]) {
    sqlite.prepare("INSERT INTO walking_session_events (id,booking_id,session_id,provider_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,'route_location_sample',?,'{}',?)")
      .run(`RSCOMP-${n}`, booking.bookingId, second, REPLACEMENT, REPLACEMENT, Date.now());
  }
  await asReplacement("complete_walk", {});
  assert.equal((await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status, "completed");

  const closed = await ops.mutateWalkingOps(db, {
    bookingId: booking.bookingId, action: "close_recovery", actorId: OPS_STAFF,
    idempotencyKey: nextKey(), reason: "Recovered programme completed successfully",
  });
  assert.equal(closed.status, "resolved");
  assert.equal(closed.bookingStatus, "completed");
  assert.equal((await db.prepare("SELECT status FROM canonical_bookings WHERE id=?").bind(booking.bookingId).first()).status, "completed");
  assert.equal((await db.prepare("SELECT status FROM walking_recovery_cases WHERE booking_id=?").bind(booking.bookingId).first()).status, "resolved");
  const entry = (await ops.getWalkingOpsSnapshot(db)).bookings.find((row) => row.id === booking.bookingId);
  assert.ok(!entry.exceptionFlags.includes("walker_recovery"));
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking gateway routes every gate to the correct authority", async () => {
  const { db, booking } = await world({ bookingId: "BKG-WALK-CLOSE-GATE" });
  const gateway = await import("../lib/api-gateway.ts");
  const env = { DB: db };
  const { cookie } = await customerSessionCookie(db, {
    principalKey: "+919800000000", customerId: booking.customerId,
  });

  /**
   * Asked as a real signed-in CUSTOMER, on a non-preview origin. The interesting question at closure
   * is not which permission string the gateway picked but whether this actor gets through, so each
   * case below asserts the outcome a customer would actually experience.
   */
  const asCustomer = async (path, action) => {
    const init = action
      ? { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ action }) }
      : { headers: { cookie } };
    const decision = await gateway.authorizeApiRequest(new Request(stayUrl(path), init), env);
    return decision instanceof Response ? decision.status : (decision.permission ?? "public");
  };
  const anonymous = async (path, action) => {
    const init = action
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }
      : {};
    const decision = await gateway.authorizeApiRequest(new Request(stayUrl(path), init), env);
    return decision instanceof Response ? decision.status : (decision.permission ?? "public");
  };

  // Pricing a walk is public; everything else requires a session.
  assert.equal(await anonymous("/api/walking-commercial"), "public");
  assert.equal(await anonymous("/api/walking-bookings", "create"), 401, "an anonymous caller cannot book");
  assert.equal(await anonymous("/api/walking-ops", "assign_replacement"), 401);

  // A customer owns their own booking and their own cancellation request.
  assert.equal(await asCustomer("/api/walking-bookings", "create"), "scheduling.book");
  assert.equal(await asCustomer("/api/walking-lifecycle?scope=customer"), "scheduling.book");
  assert.equal(await asCustomer("/api/walking-finance", "request_cancel"), "scheduling.book");
  assert.equal(await asCustomer("/api/walking-proof", "acknowledge_incident"), "scheduling.book");

  // A customer owns none of the walker's work, none of Finance's money, and none of Operations.
  for (const [path, action] of [
    ["/api/walking-lifecycle", "start_walk"],
    ["/api/walking-lifecycle", "no_show"],
    ["/api/walking-finance", "approve_cancel"],
    ["/api/walking-finance", "record_session_payment"],
    ["/api/walking-finance", "record_refund"],
    ["/api/walking-finance", "prepare_settlement"],
    ["/api/walking-finance", "reconcile"],
    ["/api/walking-proof", "record_media_scan"],
    ["/api/walking-proof", "revoke_media"],
    ["/api/walking-proof", "resolve_incident"],
    ["/api/walking-ops", "assign_replacement"],
    ["/api/walking-ops", "close_recovery"],
  ]) {
    assert.equal(await asCustomer(path, action), 403, `${path} ${action} must be refused to a customer`);
  }

  // The reads are separated the same way: a customer cannot read the staff or Finance views.
  assert.equal(await asCustomer("/api/walking-lifecycle"), 403, "the staff booking view is not the customer view");
  assert.equal(await asCustomer("/api/walking-finance"), 403);
  assert.equal(await asCustomer("/api/walking-ops"), 403);

  /**
   * The split that matters most is INSIDE the staff surfaces: a walker holding bookings.view must not
   * be able to clear their own malware scan, revoke their own evidence, resolve their own incident or
   * touch Operations. Refusing the customer proves nothing about that, because a customer holds
   * neither permission -- so these cases use real signed-in staff of each role.
   */
  const now = Date.now();
  // ensureGatewayTables() runs only once a staff email is present, so one request from an unknown
  // staff address is what creates app_users and role_definitions.
  await gateway.authorizeApiRequest(
    new Request(stayUrl("/api/walking-ops"), { headers: { "oai-authenticated-user-email": "nobody@pawspace.test" } }),
    env,
  );
  const staff = async (email, roleCode) => {
    await db.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
      .bind(`U-${roleCode}`, email, roleCode, roleCode, now, now).run();
    return async (path, action) => {
      const headers = { "oai-authenticated-user-email": email };
      const init = action
        ? { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ action }) }
        : { headers };
      const decision = await gateway.authorizeApiRequest(new Request(stayUrl(path), init), env);
      return decision instanceof Response ? decision.status : (decision.permission ?? "public");
    };
  };
  const asWalker = await staff("walker@pawspace.test", "service_provider");
  const asFinance = await staff("finance@pawspace.test", "finance");

  // A walker does their own work and captures their own evidence.
  for (const action of ["start_walk", "complete_walk"]) {
    assert.equal(await asWalker("/api/walking-lifecycle", action), "bookings.view", action);
  }
  for (const action of ["prepare_media", "record_location_sample", "record_photo_update", "report_incident"]) {
    assert.equal(await asWalker("/api/walking-proof", action), "bookings.view", action);
  }

  // A walker adjudicates nothing: not their own scan, not their own revocation, not their own incident.
  for (const action of ["sandbox_finalize_media", "record_media_scan", "revoke_media", "resolve_incident"]) {
    assert.equal(await asWalker("/api/walking-proof", action), 403, `a walker must not self-serve ${action}`);
  }
  assert.equal(await asWalker("/api/walking-lifecycle", "no_show"), 403, "declaring a no-show is a staff decision");
  assert.equal(await asWalker("/api/walking-ops", "assign_replacement"), 403);
  assert.equal(await asWalker("/api/walking-finance", "record_session_payment"), 403);

  // Finance owns the money and nothing else.
  for (const action of ["approve_cancel", "record_session_payment", "record_refund", "prepare_settlement", "reconcile"]) {
    assert.equal(await asFinance("/api/walking-finance", action), "finance.manage", action);
  }
  assert.equal(await asFinance("/api/walking-finance"), "finance.view");
  assert.equal(await asFinance("/api/walking-ops", "assign_replacement"), 403, "Finance does not run Operations");
  assert.equal(await asFinance("/api/walking-proof", "record_media_scan"), 403);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking closure remains UAT-only and does not claim production launch", async () => {
  const { db, booking, walk } = await world({ bookingId: "BKG-WALK-CLOSE-UAT" });
  const sessionId = booking.sessionId;
  await walk("accept");
  await walk("confirm_handover", { sessionId, handoverMethod: "owner" });
  await walk("start_walk", { sessionId, ...DOORSTEP });
  for (const step of [0, 1]) {
    await proof.mutateWalkingProof(db, {
      bookingId: booking.bookingId, action: "record_location_sample", actorId: WALKER, idempotencyKey: nextKey(),
      sessionId, latitude: 12.9612 + step / 10_000, longitude: 77.6388, accuracyMeters: 12,
    });
  }
  // Media is private and scan-gated: nothing is servable straight after upload. Captured here, while
  // the walk is still active, because a closed session is not open for proof capture at all.
  const grant = await proof.mutateWalkingProof(db, {
    bookingId: booking.bookingId, action: "prepare_media", actorId: WALKER, idempotencyKey: nextKey(),
    sessionId, purpose: "walking_complete", mimeType: "image/webp", sizeBytes: 12_000, sha256: SHA,
  });
  assert.equal(grant.upload.mode, "sandbox_contract");
  assert.equal(grant.upload.adapterConnected, false);
  const asset = await db.prepare("SELECT access_status,storage_key FROM service_media_assets WHERE id=?").bind(grant.mediaId).first();
  assert.equal(asset.access_status, "pending_upload");
  assert.doesNotMatch(asset.storage_key, /^https?:/);

  const completed = await walk("complete_walk", { sessionId });

  // Every surface that could overstate the build says the same thing.
  assert.equal(completed.liveMoney, false);
  const proofSnapshot = await proof.getWalkingProofSnapshot(db, booking.bookingId);
  assert.equal(proofSnapshot.sandboxOnly, true);
  assert.equal(proofSnapshot.routeEnvironment, "sandbox_unverified");
  assert.equal(proofSnapshot.productionGpsConnected, false);
  assert.deepEqual(proofSnapshot.communications, { mode: "queued_only", liveDelivery: false });

  const opsSnapshot = await ops.getWalkingOpsSnapshot(db);
  assert.equal(opsSnapshot.readiness.productionReady, false);
  assert.equal(opsSnapshot.readiness.engineeringGate, "gate_5_closed_uat_contract");

  // Notifications are QUEUED, never delivered.
  const notifications = await db.prepare("SELECT DISTINCT status FROM walking_customer_notifications WHERE booking_id=?").bind(booking.bookingId).all();
  assert.deepEqual(notifications.results.map((row) => row.status), ["queued"], "nothing was ever marked delivered");

  // Payment rows are sandbox-gated and no gateway reference is invented.
  const payment = await db.prepare("SELECT gateway,status,reference FROM walking_session_payment_events WHERE session_id=?").bind(sessionId).first();
  assert.equal(payment.gateway, "uat_sandbox");
  assert.equal(payment.status, "due");
  assert.equal(payment.reference, null);
});
