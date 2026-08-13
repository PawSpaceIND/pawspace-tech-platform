/**
 * QA-A — can two authorised approvers create two refunds for one cancellation?
 *
 * approve_cancel, for Boarding and Pet Sitting, reads the pending request, checks segregation of duties
 * and the collected-funds cap, then sends ONE batch containing:
 *
 *   UPDATE ..._cancellation_requests SET status='approved' ... WHERE id=? AND status='policy_review_required'
 *   ... four more status updates ...
 *   INSERT INTO ..._refund_ledger (...)          <- guarded only by `if (refundId)`, i.e. amount > 0
 *
 * The UPDATE is guarded on the status it expects. The INSERT is not conditional on that UPDATE having
 * changed a row. Two approvers who both read the request while it is still awaiting review therefore
 * both reach the batch, and the second one's UPDATE matches nothing while its INSERT still lands.
 *
 * WHAT THIS TEST IS. node:sqlite is synchronous and single-threaded, so this does not reproduce OS-level
 * parallelism. It reproduces the INTERLEAVING that parallelism produces, deterministically: a barrier in
 * the D1 shim holds the first caller's batch until the second caller has finished reading, which is
 * exactly the ordering two Workers hitting one D1 would produce. What is asserted is observable database
 * state afterwards - how many ledger rows exist and what they total - not the shape of the source.
 *
 * The barrier is the only thing simulated. Every statement, guard and batch is the real module.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__RACE_DB__", "__RACE_ENV__");

const COLLECTED = 10000, REFUND = 4000;

/**
 * A D1 shim that can hold the first `batch()` until released. `reads` resolves once every racer has
 * finished its SELECT phase, which is what makes the interleaving deterministic rather than hopeful.
 */
function racingD1(sqlite, { holdBatchMatching = null } = {}) {
  // Park the batch that performs the APPROVAL, identified by its own SQL. An earlier version parked the
  // first batch to arrive, which was ensure*Tables() creating the schema - so the write was never held,
  // the two calls serialised, and the loser was refused with "no request awaiting policy review". The
  // test passed while proving nothing. Matching on content is what makes the interleaving real.
  let approvalBatches = 0, parked = false, overlapped = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const statement = (sql, args) => ({
    sql,
    bind: (...bound) => statement(sql, bound),
    first: async () => { await null; const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { await null; const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => { await null; return { results: sqlite.prepare(sql).all(...args) }; },
  });
  const db = {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => {
      const isApproval = holdBatchMatching && list.some((item) => holdBatchMatching.test(String(item.sql || "")));
      if (isApproval) {
        approvalBatches += 1;
        if (approvalBatches === 1) { parked = true; await gate; parked = false; }
        // A second approval batch entered while the first was still parked: both racers had already read
        // the pending request. This is the interleaving, recorded where it actually occurs.
        else if (parked) overlapped = true;
      }
      const out = [];
      for (const item of list) out.push(await item.run());
      return out;
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
  return { db, releaseFirstBatch: () => release(), approvalBatchCount: () => approvalBatches, overlapped: () => overlapped };
}

/** Booking + captured payment + a stay + a cancellation request awaiting policy review. */
async function seedBoarding(db, sqlite) {
  const { ensureBoardingFinanceTables, mutateBoardingFinance } = await import("../lib/boarding-finance-governance.ts");
  await ensureBoardingFinanceTables(db);
  const now = Date.UTC(2026, 6, 1);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER,idempotency_key TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at,idempotency_key,pet_ids_json,source_pet_ids_json) VALUES ('BK-R','CUS-1','blr','blr-east','boarding','pkg','Stay','SG-R','PRV-1','2026-08-01T09:00:00.000Z','2026-08-03T09:00:00.000Z','confirmed','customer_app',?,'INR','{}','seed',?,?,'idem-r','[]','[]')").run(COLLECTED, now, now);
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-R','BK-R','CUS-1',?,?,'INR','card','prepaid','captured','razorpay','pidem-r','{}',?,?)").run(COLLECTED, COLLECTED, now, now);
  // context() INNER JOINs boarding_stays; a confirmed, not-yet-checked-in stay is the state in which a
  // cancellation is allowed to be approved automatically.
  sqlite.prepare("INSERT INTO boarding_stays (id,booking_id,customer_id,host_provider_id,city_id,zone_id,package_code,check_in_at,check_out_at,billed_units,pet_count,status,care_plan_status,check_in_status,check_out_status,extension_status,created_at,updated_at) VALUES ('STAY-R','BK-R','CUS-1','PRV-1','blr','blr-east','pkg','2026-08-01T09:00:00.000Z','2026-08-03T09:00:00.000Z',2,1,'confirmed','ready','pending','pending','none',?,?)").run(now, now);
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,status TEXT,scheduled_start TEXT,scheduled_end TEXT)");
  return { mutate: mutateBoardingFinance };
}

async function seedSitting(db, sqlite) {
  const { ensureSittingFinanceTables, mutateSittingFinance } = await import("../lib/sitting-finance-governance.ts");
  await ensureSittingFinanceTables(db);
  const now = Date.UTC(2026, 6, 1);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER,idempotency_key TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at,idempotency_key,pet_ids_json,source_pet_ids_json) VALUES ('BK-S','CUS-1','blr','blr-east','pet_sitting','pkg','Sit','SG-S','PRV-1','2026-08-01T09:00:00.000Z','2026-08-03T09:00:00.000Z','confirmed','customer_app',?,'INR','{}','seed',?,?,'idem-s','[]','[]')").run(COLLECTED, now, now);
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-S','BK-S','CUS-1',?,?,'INR','card','prepaid','captured','razorpay','pidem-s','{}',?,?)").run(COLLECTED, COLLECTED, now, now);
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('WO-S','BK-S','PRV-1','accepted',?,?)").run(now, now);
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,status TEXT,scheduled_start TEXT,scheduled_end TEXT)");
  return { mutate: mutateSittingFinance };
}

/**
 * Drives one cancellation to policy_review_required, then races two DIFFERENT approvers at it with
 * different idempotency keys, holding the winner's write until the loser has read.
 */
async function raceApprovals({ service, bookingId, ledgerTable, requestTable, seed, extraSetup, approvalUpdate }) {
  const sqlite = new DatabaseSync(":memory:");
  const plain = racingD1(sqlite);
  globalThis.__RACE_DB__ = plain.db;
  globalThis.__RACE_ENV__ = {};
  const { mutate } = await seed(plain.db, sqlite);
  if (extraSetup) await extraSetup(plain.db, sqlite, mutate);

  // A requester asks for cancellation. Segregation of duties means the two approvers must both differ
  // from this identity, which is why three distinct staff are used.
  await mutate(plain.db, { bookingId, action: "request_cancel", actorId: "requester@pawspace.in", reason: "Customer asked to cancel the stay", idempotencyKey: "req-1" });
  const pending = sqlite.prepare(`SELECT id,status FROM ${requestTable} WHERE booking_id=?`).get(bookingId);
  assert.ok(pending, `${service}: a cancellation request must exist`);
  assert.equal(pending.status, "policy_review_required", `${service}: it must be awaiting policy review`);

  // Now the race, on a shim that holds the first batch.
  const racing = racingD1(sqlite, { holdBatchMatching: approvalUpdate });
  globalThis.__RACE_DB__ = racing.db;
  const approve = (actorId, idempotencyKey) => mutate(racing.db, { bookingId, action: "approve_cancel", actorId, approvedRefundAmount: REFUND, reason: "Approved per cancellation policy review", idempotencyKey });

  const first = approve("approver.one@pawspace.in", "appr-1");
  const second = approve("approver.two@pawspace.in", "appr-2");
  // Let both racers run until one is parked inside batch() and the other has read the pending request.
  // Enough turns for both racers to read and reach their approval batch; the first parks there.
  for (let tick = 0; tick < 400; tick += 1) await null;
  // PROOF OF INTERLEAVING. With the first batch parked, a second batch can only have been entered by a
  // racer that already read the still-pending request. If this is 1, the second racer never got that far
  // and the test below would be asserting nothing.
  const overlapped = racing.overlapped(), batchesWhileParked = racing.approvalBatchCount();
  racing.releaseFirstBatch();
  const outcomes = await Promise.allSettled([first, second]);
  const rejections = outcomes.filter((o) => o.status === "rejected").map((o) => o.reason);
  const reasons = await Promise.all(rejections.map(async (r) => (r instanceof Response ? `${r.status} ${await r.clone().text()}` : String(r?.message || r)).slice(0, 120)));

  const ledger = sqlite.prepare(`SELECT id,amount,status FROM ${ledgerTable} WHERE booking_id=?`).all(bookingId);
  const requests = sqlite.prepare(`SELECT id,status,approved_refund_amount FROM ${requestTable} WHERE booking_id=?`).all(bookingId);
  return { outcomes, ledger, requests, sqlite, batchesWhileParked, overlapped, reasons };
}

const REPORT = (service, { outcomes, ledger, requests, batchesWhileParked, overlapped, reasons }) =>
  `${service}: outcomes=${outcomes.map((o) => o.status).join(",")} overlapped=${overlapped} approvalBatches=${batchesWhileParked} ledgerRows=${ledger.length} ledgerTotal=${ledger.reduce((sum, row) => sum + Number(row.amount || 0), 0)} approvedRequests=${requests.filter((r) => r.status === "approved").length} rejections=[${reasons.join(" | ")}]`;

test("Boarding: two concurrent approvers must not create two refunds", async () => {
  const result = await raceApprovals({
    service: "Boarding", bookingId: "BK-R",
    ledgerTable: "boarding_refund_ledger", requestTable: "boarding_cancellation_requests",
    approvalUpdate: /UPDATE boarding_cancellation_requests SET status='approved'/,
    seed: seedBoarding,
  });
  const detail = REPORT("Boarding", result);

  console.error(detail);
  assert.equal(result.overlapped, true, `the race did not interleave, so nothing below is proven — ${detail}`);
  assert.equal(result.requests.filter((r) => r.status === "approved").length, 1, `exactly one request may be approved — ${detail}`);
  assert.equal(result.ledger.length, 1, `exactly one refund-ledger row may exist — ${detail}`);
  assert.equal(result.ledger.reduce((sum, row) => sum + Number(row.amount || 0), 0), REFUND, `only one refund amount may be payable — ${detail}`);
  assert.equal(result.outcomes.filter((o) => o.status === "rejected").length, 1, `the losing approver must be refused, not silently succeed — ${detail}`);
});

test("Pet Sitting: two concurrent approvers must not create two refunds", async () => {
  const result = await raceApprovals({
    service: "Pet Sitting", bookingId: "BK-S",
    ledgerTable: "sitting_refund_ledger", requestTable: "sitting_cancellation_requests",
    approvalUpdate: /UPDATE sitting_cancellation_requests SET status='approved'/,
    seed: seedSitting,
  });
  const detail = REPORT("Pet Sitting", result);

  console.error(detail);
  assert.equal(result.overlapped, true, `the race did not interleave, so nothing below is proven — ${detail}`);
  assert.equal(result.requests.filter((r) => r.status === "approved").length, 1, `exactly one request may be approved — ${detail}`);
  assert.equal(result.ledger.length, 1, `exactly one refund-ledger row may exist — ${detail}`);
  assert.equal(result.ledger.reduce((sum, row) => sum + Number(row.amount || 0), 0), REFUND, `only one refund amount may be payable — ${detail}`);
  assert.equal(result.outcomes.filter((o) => o.status === "rejected").length, 1, `the losing approver must be refused, not silently succeed — ${detail}`);
});
