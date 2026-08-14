/**
 * PHASE 2 — D2 (P2): cancellation/refund double-refund floor for WALKING, FOOD and PET TAXI.
 *
 * Sitting and Boarding already carry the proven contract (lib/sitting-finance-governance.ts:66-67 atomic
 * claim + :25/:38 UNIQUE index; boarding identical) and are covered by tests/refund-approval-race.test.mjs.
 * D2 brings the three previously-vulnerable services to parity:
 *
 *   (1) approve_cancel now runs the status claim FIRST and ALONE —
 *         UPDATE ..._cancellation_requests SET status='approved' ... WHERE id=? AND status='policy_review_required'
 *       gated by `if (meta.changes !== 1) throw <409>`. Before the fix the UPDATE sat inside the same batch
 *       as the refund INSERT and carried NO status predicate (WHERE id=?), and the INSERT was conditional
 *       only on amount>0, so two approvers who both read the request while it was still awaiting review both
 *       inserted a refund.
 *   (2) ensure*FinanceTables now creates CREATE UNIQUE INDEX ..._one_refund_per_request ON
 *         <ledger>(cancellation_request_id) — the database floor under the claim.
 *
 * WHAT THIS TEST IS — HONESTY ABOUT node:sqlite. node:sqlite executes statements synchronously and
 * serialized; it cannot produce OS-level parallelism. Two of the invariants below are therefore asserted
 * against a *deterministic interleave* simulated by a barrier in the D1 shim (exactly the ordering two
 * Workers hitting one D1 would produce — the same technique the repo's refund-approval-race suite uses),
 * and against the *structural guarantee* (UNIQUE index + meta.changes gate). Every statement, guard and
 * batch executed is the real, unmodified governance module; only the barrier is simulated.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__D2_DB__", "__D2_ENV__");

const COLLECTED = 10000, REFUND = 4000;

/**
 * A D1 shim that can hold the first approval CLAIM until released. It parks whichever run() matches the
 * claim SQL: the first racer parks AT the claim boundary before it mutates anything; if a second racer
 * reaches the same boundary while the first is parked, both had read the still-pending request — that is
 * the race, recorded as `overlapped`. Matching the statement (not a batch) holds for the post-fix shape
 * where the claim runs alone.
 */
function racingD1(sqlite, { holdClaimMatching = null } = {}) {
  let claims = 0, parked = false, overlapped = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const matches = (sql) => holdClaimMatching && holdClaimMatching.test(String(sql || ""));
  const statement = (sql, args) => ({
    sql,
    bind: (...bound) => statement(sql, bound),
    first: async () => { await null; const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => {
      if (matches(sql)) {
        claims += 1;
        if (claims === 1) { parked = true; await gate; parked = false; }
        else if (parked) overlapped = true;
      }
      await null;
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
    all: async () => { await null; return { results: sqlite.prepare(sql).all(...args) }; },
  });
  return {
    db: {
      prepare: (sql) => statement(sql, []),
      batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
      exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
    },
    releaseFirstClaim: () => release(),
    claimsReached: () => claims,
    overlapped: () => overlapped,
  };
}

// --- Seeds: minimal canonical state with a sandbox-PAID event so a refund>0 is permitted ------------

async function seedWalking(db, sqlite) {
  const { ensureWalkingFinanceTables, mutateWalkingFinance } = await import("../lib/walking-finance-governance.ts");
  await ensureWalkingFinanceTables(db);
  const now = Date.UTC(2026, 6, 1);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER,idempotency_key TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,status TEXT,scheduled_start TEXT,scheduled_end TEXT)");
  // walking_sessions lives in lib/walking-ops-governance.ts; approve_cancel reads and cancels it.
  sqlite.exec("CREATE TABLE IF NOT EXISTS walking_sessions (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,schedule_group_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,occurrence_number INTEGER NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',handover_status TEXT NOT NULL DEFAULT 'pending',completion_status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at,idempotency_key,pet_ids_json,source_pet_ids_json) VALUES ('BK-W','CUS-1','blr','blr-east','dog_walking','walking-30','Walk','SG-W','PRV-1','2026-08-01T07:00:00.000Z','2026-08-01T07:30:00.000Z','confirmed','customer_app',?,'INR','{}','seed',?,?,'idem-w','[]','[]')").run(COLLECTED, now, now);
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-W','BK-W','CUS-1',?,?,'INR','card','pay_after_service','paid','razorpay','pidem-w','{}',?,?)").run(COLLECTED, COLLECTED, now, now);
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('WO-W','BK-W','PRV-1','accepted',?,?)").run(now, now);
  // A completed, sandbox-PAID walk: totals().paid = COLLECTED, so a REFUND-sized approval is in range.
  sqlite.prepare("INSERT INTO walking_session_payment_events (id,booking_id,session_id,amount,currency,status,gateway,reference,detail_json,created_at,updated_at) VALUES ('WPE-W','BK-W','SESS-W',?,'INR','sandbox_paid','uat_sandbox','SANDBOX-PAY-W','{}',?,?)").run(COLLECTED, now, now);
  return { mutate: mutateWalkingFinance };
}

async function seedTaxi(db, sqlite) {
  const { ensureTaxiFinanceTables, mutateTaxiFinance } = await import("../lib/taxi-finance-governance.ts");
  await ensureTaxiFinanceTables(db);
  const now = Date.UTC(2026, 6, 1);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER,idempotency_key TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,status TEXT,scheduled_start TEXT,scheduled_end TEXT)");
  // taxi_trips is owned by lib/taxi-ops-governance.ts; context() INNER JOINs it and approve_cancel cancels it.
  sqlite.exec("CREATE TABLE IF NOT EXISTS taxi_trips (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,origin_label TEXT NOT NULL,destination_label TEXT NOT NULL,route_code TEXT NOT NULL,synthetic_distance_km REAL NOT NULL,estimated_duration_minutes INTEGER NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',vehicle_id TEXT,pickup_verification_status TEXT NOT NULL DEFAULT 'pending',dropoff_verification_status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at,idempotency_key,pet_ids_json,source_pet_ids_json) VALUES ('BK-T','CUS-1','blr','blr-east','pet_taxi','taxi','Taxi','SG-T','PRV-1','2026-08-01T07:00:00.000Z','2026-08-01T08:00:00.000Z','confirmed','customer_app',?,'INR','{}','seed',?,?,'idem-t','[]','[]')").run(COLLECTED, now, now);
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-T','BK-T','CUS-1',?,?,'INR','card','prepaid','paid','razorpay','pidem-t','{}',?,?)").run(COLLECTED, COLLECTED, now, now);
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('WO-T','BK-T','PRV-1','accepted',?,?)").run(now, now);
  // taxi context() INNER JOINs taxi_trips; a scheduled (not in-progress/arrived/dropoff) trip may cancel.
  sqlite.prepare("INSERT INTO taxi_trips (id,booking_id,schedule_group_id,reservation_id,provider_id,origin_label,destination_label,route_code,synthetic_distance_km,estimated_duration_minutes,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('TRIP-T','BK-T','SG-T','RES-T','PRV-1','A','B','r1',5,20,'2026-08-01T07:00:00.000Z','2026-08-01T08:00:00.000Z','scheduled',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO taxi_trip_payment_events (id,booking_id,trip_id,amount,currency,status,gateway,reference,detail_json,created_at,updated_at) VALUES ('TPE-T','BK-T','TRIP-T',?,'INR','sandbox_paid','uat_sandbox','SANDBOX-PAY-T','{}',?,?)").run(COLLECTED, now, now);
  return { mutate: mutateTaxiFinance };
}

async function seedFood(db, sqlite) {
  const { ensureFoodFinanceTables, mutateFoodFinance } = await import("../lib/food-finance-governance.ts");
  await ensureFoodFinanceTables(db);
  const now = Date.UTC(2026, 6, 1);
  // food_orders and food_order_payments are owned by the food-order module; context() reads/LEFT-JOINs them.
  sqlite.exec("CREATE TABLE IF NOT EXISTS food_orders (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,status TEXT NOT NULL,commercial_status TEXT NOT NULL DEFAULT 'uat_only',inventory_mode TEXT NOT NULL DEFAULT 'uat_seed',delivery_status TEXT NOT NULL DEFAULT 'fulfilment_review_required',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS food_order_payments (id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL DEFAULT 0,currency TEXT NOT NULL DEFAULT 'INR',mode TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'created',gateway TEXT NOT NULL DEFAULT 'uat_sandbox',detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO food_orders (id,idempotency_key,customer_id,city_id,zone_id,status,total_amount,currency,created_by,created_at,updated_at) VALUES ('ORD-F','idem-f','CUS-1','blr','blr-east','confirmed',?,'INR','seed',?,?)").run(COLLECTED, now, now);
  sqlite.prepare("INSERT INTO food_order_payments (id,order_id,customer_id,amount,amount_due_now,currency,mode,status,gateway,detail_json,created_at,updated_at) VALUES ('FPAY-F','ORD-F','CUS-1',?,0,'INR','prepaid','paid','uat_sandbox','{}',?,?)").run(COLLECTED, now, now);
  // A delivered, sandbox-PAID order: totals().paid = COLLECTED, so a REFUND-sized approval is in range.
  sqlite.prepare("INSERT INTO food_order_payment_events (id,order_id,amount,currency,status,gateway,reference,detail_json,created_at,updated_at) VALUES ('FPE-F','ORD-F',?,'INR','sandbox_paid','uat_sandbox','SANDBOX-PAY-F','{}',?,?)").run(COLLECTED, now, now);
  return { mutate: mutateFoodFinance };
}

// --- Genuine deterministic interleave: two approvers, one held at the claim boundary ----------------

async function raceApprovals({ service, idField, entityId, requestTable, ledgerTable, seed, claimMatcher }) {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__D2_ENV__ = {};
  const plain = racingD1(sqlite);
  globalThis.__D2_DB__ = plain.db;
  const { mutate } = await seed(plain.db, sqlite);

  // A requester (distinct from both approvers — segregation of duties) opens the cancellation.
  await mutate(plain.db, { [idField]: entityId, action: "request_cancel", actorId: "requester@pawspace.in", reason: "Customer asked to cancel", idempotencyKey: "req-1" });
  const pending = sqlite.prepare(`SELECT id,status FROM ${requestTable} WHERE ${idField === "orderId" ? "order_id" : "booking_id"}=?`).get(entityId);
  assert.ok(pending, `${service}: a cancellation request must exist`);
  assert.equal(pending.status, "policy_review_required", `${service}: it must be awaiting policy review`);

  // Two DIFFERENT approvers race with DIFFERENT idempotency keys, on a shim that holds the first claim.
  const racing = racingD1(sqlite, { holdClaimMatching: claimMatcher });
  globalThis.__D2_DB__ = racing.db;
  const approve = (actorId, key) => mutate(racing.db, { [idField]: entityId, action: "approve_cancel", actorId, approvedRefundAmount: REFUND, reason: "Approved per policy review", idempotencyKey: key });

  const first = approve("approver.one@pawspace.in", "appr-1");
  const second = approve("approver.two@pawspace.in", "appr-2");
  for (let tick = 0; tick < 400; tick += 1) await null; // let both read and reach the claim; first parks
  const overlapped = racing.overlapped(), claimsWhileParked = racing.claimsReached();
  racing.releaseFirstClaim();
  const outcomes = await Promise.allSettled([first, second]);
  const rejections = await Promise.all(
    outcomes.filter((o) => o.status === "rejected").map(async (o) => (o.reason instanceof Response ? `${o.reason.status} ${await o.reason.clone().text()}` : String(o.reason?.message || o.reason)).slice(0, 140)),
  );
  const ledger = sqlite.prepare(`SELECT id,amount,status FROM ${ledgerTable} WHERE ${idField === "orderId" ? "order_id" : "booking_id"}=?`).all(entityId);
  const requests = sqlite.prepare(`SELECT id,status,approved_refund_amount,decision_by FROM ${requestTable} WHERE ${idField === "orderId" ? "order_id" : "booking_id"}=?`).all(entityId);
  const detail = `${service}: outcomes=${outcomes.map((o) => o.status).join(",")} overlapped=${overlapped} claimsReached=${claimsWhileParked} ledgerRows=${ledger.length} ledgerTotal=${ledger.reduce((s, r) => s + Number(r.amount || 0), 0)} approved=${requests.filter((r) => r.status === "approved").length} rejections=[${rejections.join(" | ")}]`;
  return { outcomes, ledger, requests, overlapped, claimsWhileParked, rejections, detail };
}

for (const svc of [
  { service: "Dog Walking", idField: "bookingId", entityId: "BK-W", requestTable: "walking_cancellation_requests", ledgerTable: "walking_refund_ledger", seed: seedWalking, claimMatcher: /UPDATE walking_cancellation_requests SET status='approved'/ },
  { service: "Pet Taxi", idField: "bookingId", entityId: "BK-T", requestTable: "taxi_cancellation_requests", ledgerTable: "taxi_refund_ledger", seed: seedTaxi, claimMatcher: /UPDATE taxi_cancellation_requests SET status='approved'/ },
  { service: "Food", idField: "orderId", entityId: "ORD-F", requestTable: "food_cancellation_requests", ledgerTable: "food_refund_ledger", seed: seedFood, claimMatcher: /UPDATE food_cancellation_requests SET status='approved'/ },
]) {
  test(`D2 ${svc.service}: two interleaved approvers create exactly ONE refund; the loser is refused 409`, async () => {
    const result = await raceApprovals(svc);
    console.error(result.detail);
    // The interleave actually happened — otherwise nothing below is proven.
    assert.equal(result.overlapped, true, `the race did not interleave, so nothing is proven — ${result.detail}`);
    // The atomic claim + changes-gate: exactly one approval, exactly one refund row of exactly REFUND.
    assert.equal(result.requests.filter((r) => r.status === "approved").length, 1, `exactly one cancellation approved — ${result.detail}`);
    assert.equal(result.ledger.length, 1, `exactly one refund-ledger row may exist — ${result.detail}`);
    assert.equal(result.ledger.reduce((s, r) => s + Number(r.amount || 0), 0), REFUND, `the ledger total equals ONE approved refund — ${result.detail}`);
    assert.equal(result.outcomes.filter((o) => o.status === "fulfilled").length, 1, `only one approver succeeds — ${result.detail}`);
    assert.equal(result.outcomes.filter((o) => o.status === "rejected").length, 1, `the loser is refused, not silently succeeding — ${result.detail}`);
    assert.match(result.rejections.join(" "), /409/, `the loser's refusal is a 409 conflict — ${result.detail}`);
    // The winning decision is internally consistent (audit truth intact).
    const approved = result.requests.find((r) => r.status === "approved");
    assert.ok(approved.decision_by, `the winning approver is recorded — ${result.detail}`);
    assert.equal(Number(approved.approved_refund_amount), REFUND, `the recorded amount matches the paid refund — ${result.detail}`);
  });
}

// --- Structural floor: the UNIQUE index exists and the DB itself refuses a second refund ------------

test("D2: the one-refund-per-request UNIQUE index exists and blocks a duplicate refund (walking/food/taxi)", async () => {
  for (const { service, seed, ledgerTable, entityColumn, entityId } of [
    { service: "Dog Walking", seed: seedWalking, ledgerTable: "walking_refund_ledger", entityColumn: "booking_id", entityId: "BK-W" },
    { service: "Pet Taxi", seed: seedTaxi, ledgerTable: "taxi_refund_ledger", entityColumn: "booking_id", entityId: "BK-T" },
    { service: "Food", seed: seedFood, ledgerTable: "food_refund_ledger", entityColumn: "order_id", entityId: "ORD-F" },
  ]) {
    const sqlite = new DatabaseSync(":memory:");
    globalThis.__D2_ENV__ = {};
    const harness = racingD1(sqlite);
    globalThis.__D2_DB__ = harness.db;
    await seed(harness.db, sqlite);

    // (a) the index is present on a clean database — parity with sitting/boarding.
    const index = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name LIKE '%one_refund_per_request%'").get(ledgerTable);
    assert.ok(index, `${service}: the one-refund-per-request index must exist on a clean database`);

    // (b) the database rejects a second refund for the same cancellation request, bypassing all TS.
    const now = Date.UTC(2026, 6, 1);
    const insert = (id) => sqlite.prepare(`INSERT INTO ${ledgerTable} (id,${entityColumn},cancellation_request_id,amount,currency,status,reference,policy_source,created_by,created_at,updated_at) VALUES (?,?,'REQ-SAME',4000,'INR','sandbox_pending',NULL,'explicit_finance_approval','staff@pawspace.in',?,?)`).run(id, entityId, now, now);
    insert("RF-1");
    assert.throws(() => insert("RF-2"), /UNIQUE|constraint/i, `${service}: a second refund for the same cancellation request must be rejected by the database`);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${ledgerTable} WHERE cancellation_request_id='REQ-SAME'`).get().n, 1, `${service}: one refund obligation per cancellation request`);
    console.error(`D2 floor OK — ${service}: index=${index.name}, duplicate INSERT rejected, ledger rows for REQ-SAME=1`);
  }
});
