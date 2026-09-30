import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { customerSessionCookie, freshSqlite, makeD1, nextKey, refusal, seedCanonicalTrip, taxiUrl } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__TAXI_CUSTODY_FINANCE_DB__", "__TAXI_CUSTODY_FINANCE_ENV__");
const finance = await import("../lib/taxi-finance-governance.ts");
const route = await import("../app/api/taxi-finance/route.ts");
const MAKER = "customer@pawspace.test", CHECKER = "finance.checker@pawspace.test";

async function world({ bookingStatus = "assigned", sqlite = freshSqlite() } = {}) {
  const db = makeD1(sqlite);
  globalThis.__TAXI_CUSTODY_FINANCE_DB__ = db;
  globalThis.__TAXI_CUSTODY_FINANCE_ENV__ = { NODE_ENV: "test", APP_ENV: "staging", PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" };
  const trip = seedCanonicalTrip(sqlite, { tripStatus: "vehicle_assigned", workOrderStatus: "accepted" });
  sqlite.prepare("UPDATE canonical_bookings SET status=?").run(bookingStatus);
  await finance.ensureTaxiFinanceTables(db);
  if (bookingStatus !== "payment_pending") sqlite.prepare("INSERT INTO taxi_trip_payment_events (id,booking_id,trip_id,amount,status,created_at,updated_at) VALUES ('PAID-1',?,?,449,'sandbox_paid',?,?)")
    .run(trip.bookingId, trip.tripId, Date.now(), Date.now());
  sqlite.prepare("INSERT INTO taxi_fleet_reservations (id,vehicle_id,provider_id,quote_id,booking_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('FLEET-1','VEH-1',?,'QUOTE-1',?,?,?,'confirmed',?,?)")
    .run(trip.providerId, trip.bookingId, trip.scheduledStart, trip.scheduledEnd, Date.now(), Date.now());
  return { sqlite, db, trip };
}
const act = (w, action, extra = {}) => finance.mutateTaxiFinance(w.db, {
  bookingId: w.trip.bookingId, action, actorId: action === "request_cancel" ? MAKER : CHECKER,
  idempotencyKey: nextKey(action), reason: "Synthetic cancellation probe", approvedRefundAmount: 0, ...extra,
});
function custody(w, markerOnly = false) {
  w.sqlite.prepare("UPDATE taxi_trips SET status=?,pickup_verification_status='uat_confirmed'")
    .run(markerOnly ? "vehicle_assigned" : "pickup_confirmed");
}
function snapshot(w) {
  return Object.fromEntries(["canonical_bookings", "taxi_trips", "provider_work_orders", "scheduling_reservations",
    "taxi_fleet_reservations", "booking_payments", "taxi_trip_events", "taxi_cancellation_requests",
    "taxi_cancellation_approval_claims", "taxi_refund_ledger", "taxi_finance_action_keys", "booking_refund_cases"]
    .map(table => [table, w.sqlite.prepare(`SELECT * FROM ${table}`).all()]));
}

for (const markerOnly of [false, true]) {
  for (const approvedRefundAmount of [0, 100]) {
    test(`Finance cannot approve post-handover cancellation (markerOnly=${markerOnly}, refund=${approvedRefundAmount})`, async () => {
      const w = await world();
      await act(w, "request_cancel");
      custody(w, markerOnly);
      const before = snapshot(w), rejected = await refusal(act(w, "approve_cancel", { approvedRefundAmount }));
      assert.equal(rejected?.status, 409);
      assert.match(rejected.message, /pickup|hand.?over|operationally resolved/i);
      assert.deepEqual(snapshot(w), before);
      w.sqlite.close();
    });
  }
  test(`customer cancellation request is refused after handover (markerOnly=${markerOnly})`, async () => {
    const w = await world(); custody(w, markerOnly);
    const before = snapshot(w), rejected = await refusal(act(w, "request_cancel"));
    assert.equal(rejected?.status, 409);
    assert.deepEqual(snapshot(w), before);
    w.sqlite.close();
  });
}

test("approval transaction cannot race a pickup confirmed after its initial read", async () => {
  const w = await world(); await act(w, "request_cancel");
  const before = snapshot(w);
  w.db.onSql("INSERT INTO taxi_cancellation_approval_claims", () => custody(w));
  assert.equal((await refusal(act(w, "approve_cancel", { approvedRefundAmount: 100 })))?.status, 409);
  assert.deepEqual(snapshot(w), before, "the failed transaction produces no cancellation, refund or receipt");
  w.sqlite.close();
});

test("paid cancellation request transaction rechecks custody after its initial read", async () => {
  const w = await world();
  w.db.onSql("INSERT INTO taxi_cancellation_requests", () => custody(w));
  assert.equal((await refusal(act(w, "request_cancel")))?.status, 409);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM taxi_cancellation_requests").get().n, 0);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM taxi_finance_action_keys").get().n, 0);
  w.sqlite.close();
});

test("an unpaid hold cannot be released when custody changed after its initial read", async () => {
  const w = await world({ bookingStatus: "payment_pending" });
  w.db.onSql("UPDATE canonical_bookings SET status='cancelled'", () => custody(w));
  assert.equal((await refusal(act(w, "request_cancel")))?.status, 409);
  assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings").get().status, "payment_pending");
  assert.equal(w.sqlite.prepare("SELECT status FROM taxi_fleet_reservations").get().status, "confirmed");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM taxi_cancellation_requests").get().n, 0);
  w.sqlite.close();
});

test("failure writing the approval receipt rolls back cancellation/refund and allows an exact-key retry", async () => {
  const w = await world(); await act(w, "request_cancel");
  const before = snapshot(w), idempotencyKey = nextKey("approval");
  w.db.onSql("INSERT INTO taxi_finance_action_keys", () => { throw new Error("injected receipt interruption"); });
  await assert.rejects(act(w, "approve_cancel", { approvedRefundAmount: 100, idempotencyKey }), /injected receipt interruption/);
  assert.deepEqual(snapshot(w), before);
  const approved = await act(w, "approve_cancel", { approvedRefundAmount: 100, idempotencyKey });
  assert.equal(approved.status, "cancelled");
  const committed = snapshot(w), replay = await act(w, "approve_cancel", { approvedRefundAmount: 100, idempotencyKey });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.refundId, approved.refundId);
  assert.deepEqual(snapshot(w), committed);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM taxi_refund_ledger").get().n, 1);
  w.sqlite.close();
});

test("maker/checker and refund ceiling remain enforced before pickup", async () => {
  const w = await world(); await act(w, "request_cancel");
  const before = snapshot(w);
  assert.equal((await refusal(act(w, "approve_cancel", { actorId: MAKER })))?.status, 409);
  assert.equal((await refusal(act(w, "approve_cancel", { approvedRefundAmount: 450 })))?.status, 409);
  assert.deepEqual(snapshot(w), before);
  assert.equal((await act(w, "approve_cancel", { approvedRefundAmount: 0 })).refundStatus, "not_required");
  w.sqlite.close();
});

for (const winnerMode of ["pickup", "same_key", "fresh_key"]) {
  test(`two connections preserve the independently committed ${winnerMode} winner`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "taxi-finance-")), path = join(dir, "db.sqlite");
    const first = new DatabaseSync(path), second = new DatabaseSync(path);
    try {
      const w = await world({ sqlite: first }), other = { ...w, sqlite: second, db: makeD1(second) };
      await act(w, "request_cancel");
      const idempotencyKey = nextKey("parallel-approval"), originalBatch = w.db.batch;
      let release, reached;
      const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { reached = resolve; });
      w.db.batch = async statements => {
        // Pause positive-refund approval before BEGIN, while its stale initial read remains valid.
        if (statements.length === 11) { reached(); await gate; }
        return originalBatch(statements);
      };
      const stale = act(w, "approve_cancel", { approvedRefundAmount: 100, idempotencyKey });
      await ready;
      let winner;
      if (winnerMode === "pickup") custody(other);
      else winner = await act(other, "approve_cancel", { approvedRefundAmount: 100,
        idempotencyKey: winnerMode === "same_key" ? idempotencyKey : nextKey("winner") });
      const committed = snapshot(other); release();
      if (winnerMode === "same_key") {
        const replay = await stale;
        assert.equal(replay.duplicatePrevented, true);
        assert.equal(replay.refundId, winner.refundId);
      } else assert.equal((await refusal(stale))?.status, 409);
      assert.deepEqual(snapshot(w), committed);
      assert.equal(first.prepare("SELECT COUNT(*) n FROM taxi_refund_ledger").get().n, winnerMode === "pickup" ? 0 : 1);
    } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("an approval receipt cannot replay a different booking or action", async () => {
  const w = await world(), idempotencyKey = nextKey("scoped");
  await act(w, "request_cancel");
  await act(w, "approve_cancel", { idempotencyKey });
  const before = snapshot(w);
  assert.equal((await refusal(act(w, "request_cancel", { idempotencyKey })))?.status, 409);
  assert.equal((await refusal(act(w, "approve_cancel", { bookingId: "OTHER-BOOKING", idempotencyKey })))?.status, 409);
  assert.deepEqual(snapshot(w), before);
  w.sqlite.close();
});

test("two unpaid hold releases sharing one timestamp cannot claim each other's cancellation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "taxi-hold-")), path = join(dir, "db.sqlite");
  const first = new DatabaseSync(path), second = new DatabaseSync(path);
  try {
    const w = await world({ sqlite: first, bookingStatus: "payment_pending" }), other = { ...w, sqlite: second, db: makeD1(second) };
    const originalBatch = w.db.batch, now = Date.now();
    let release, reached;
    const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { reached = resolve; });
    w.db.batch = async statements => {
      if (statements.length === 9) { reached(); await gate; }
      return originalBatch(statements);
    };
    const input = { bookingId: w.trip.bookingId, groupId: w.trip.groupId, actorId: MAKER, now,
      reason: "Synthetic unpaid hold release", eventType: "ride_hold_cancelled_by_customer" };
    const stale = finance.cancelUnpaidRideHold(w.db, { ...input, requestId: "STALE-REQUEST", idempotencyKey: "STALE-KEY" });
    await ready;
    const winner = await finance.cancelUnpaidRideHold(other.db, { ...input, requestId: "WINNER-REQUEST", idempotencyKey: "WINNER-KEY" });
    assert.equal(winner.status, "cancelled");
    const committed = snapshot(other); release();
    assert.equal(await stale, null);
    assert.deepEqual(snapshot(w), committed);
    assert.equal(first.prepare("SELECT COUNT(*) n FROM taxi_cancellation_requests").get().n, 1);
    assert.equal(first.prepare("SELECT COUNT(*) n FROM taxi_finance_action_keys").get().n, 1);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const identity of [
  { subjectType: "customer", subjectId: "CUST-TAXI-1", action: "approve_cancel" },
  { subjectType: "provider", subjectId: "taxi_rahul", action: "approve_cancel" },
  { subjectType: "customer", subjectId: "OTHER-CUSTOMER", action: "request_cancel" },
]) {
  test(`Finance route refuses ${identity.subjectType}:${identity.subjectId} for ${identity.action}`, async () => {
    const w = await world(); await act(w, "request_cancel");
    const session = await customerSessionCookie(w.db, { principalKey: "+919700000097", customerId: identity.subjectId, subjectType: identity.subjectType });
    const before = snapshot(w);
    const response = await route.POST(new Request(taxiUrl("/api/taxi-finance"), {
      method: "POST", headers: { "content-type": "application/json", cookie: session.cookie },
      body: JSON.stringify({ bookingId: w.trip.bookingId, action: identity.action, idempotencyKey: nextKey("route"), reason: "Synthetic probe", approvedRefundAmount: 0 }),
    }));
    assert.equal(response.status, 403);
    assert.deepEqual(snapshot(w), before);
    w.sqlite.close();
  });
}
