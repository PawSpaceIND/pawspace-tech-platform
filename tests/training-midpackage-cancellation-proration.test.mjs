/*
 * MASTER TEST DIRECTIVE 02 - mid-package doorstep training cancellation and proration.
 *
 * Scenario: a 10-session doorstep dog-training package, 4 sessions completed, customer cancels
 * mid-package on relocation while the trainer is en route to session 5.
 *
 * WHAT THIS SUITE ASSERTS is the proration engine that actually exists: lib/training-cancellation.ts
 * with refund_basis 'captured_less_pro_rata_used'. Every number below is read back out of the
 * database after driving the real module - none is restated from a variable the test set.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT, because the product does not do it:
 *
 *   1. A 10% late-cancellation penalty. It cannot be configured. saveTrainingCancellationPolicy
 *      refuses any non-zero fee outright - "PawSpace does not charge cancellation fees" - and
 *      calculate() then hardcodes cancellationFee=0 regardless of policy. Two independent layers.
 *      TRAIN-CANCEL-3 pins that refusal, so the directive's premise is recorded as a product
 *      decision rather than quietly implemented.
 *   2. A "Penalized" session state. Session statuses are completed / no_show / cancelled.
 *   3. Real-time route halting, RazorpayX payout webhooks, a Data Warehouse `churn_mid_package`
 *      event, and a 30-day win-back queue. None of those exist; see the PR description. Writing
 *      tests that pretend to cover them would be worse than not covering them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__TRAIN_CANCEL_DB__", "__TRAIN_CANCEL_ENV__");

const CITY = "blr";
const CUSTOMER = "CUS-TRAIN-RELOCATE";
const TRAINER = "PRV-TRAINER-01";
const BOOKING = "BK-TRAIN-10SESSION";
const PROGRAMME = "PRG-TRAIN-10SESSION";
const STAFF = "training.finance@pawspace.in";

// A 10-session package at 20000 total. Per session 2000. Four delivered.
const TOTAL_SESSIONS = 10;
const COMPLETED = 4;
const PACKAGE_TOTAL = 20000;
const PER_SESSION = PACKAGE_TOTAL / TOTAL_SESSIONS;          // 2000
const EXPECTED_USED = COMPLETED * PER_SESSION;               // 8000
const EXPECTED_REFUND = PACKAGE_TOTAL - EXPECTED_USED;       // 12000, i.e. 6 sessions

function makeD1(sqlite) {
  const stmt = (sql, args) => ({
    bind: (...b) => stmt(sql, b),
    first: async (col) => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : (col ? r[col] : r); },
    run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true, meta: {} }),
  });
  return {
    prepare: (sql) => stmt(sql, []),
    batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/** A fresh world per test: these tests mutate programme and booking status irreversibly. */
async function world({ publishPolicy = true, noShowTreatment = "refundable", completed = COMPLETED } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__TRAIN_CANCEL_DB__ = db;
  globalThis.__TRAIN_CANCEL_ENV__ = { APP_ENV: "staging" };

  const cancel = await import("../lib/training-cancellation.ts");
  const programme = await import("../lib/training-programme.ts");
  await cancel.ensureTrainingCancellationTables(db);
  for (const k of Object.keys(programme)) if (/^ensure/.test(k)) await programme[k](db);

  const now = Date.now();
  sqlite.exec(`CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);`);

  sqlite.prepare(`INSERT INTO canonical_bookings VALUES (?,?,?,'blr-indiranagar','dog_training',?, 'in_progress',?,'INR',?,?)`)
    .run(BOOKING, CUSTOMER, CITY, TRAINER, PACKAGE_TOTAL, now, now);
  // Captured in full up front, which is what makes proration meaningful.
  sqlite.prepare(`INSERT INTO booking_payments VALUES ('PAY-TRAIN-1',?,?,?,?, 'INR','captured',?,?)`)
    .run(BOOKING, CUSTOMER, PACKAGE_TOTAL, PACKAGE_TOTAL, now, now);
  sqlite.prepare(`INSERT INTO provider_work_orders VALUES ('WO-TRAIN-1',?,?, 'assigned',?,?)`)
    .run(BOOKING, TRAINER, now, now);
  sqlite.prepare(`INSERT INTO training_programmes
      (id,booking_id,customer_id,provider_id,city_id,zone_id,plan_code,plan_name,pet_ids_json,status,total_sessions,completed_sessions,created_at,updated_at)
      VALUES (?,?,?,?,?, 'blr-indiranagar','plan-10','10 Session Doorstep Obedience','["PET-1"]','scheduled',?,?,?,?)`)
    .run(PROGRAMME, BOOKING, CUSTOMER, TRAINER, CITY, TOTAL_SESSIONS, completed, now, now);

  /* Sessions 1-4 completed. Session 5 is the one the trainer is en route to: it is still 'locked',
   * which is exactly the state the directive's chaos injection describes - in flight, not delivered. */
  for (let i = 1; i <= TOTAL_SESSIONS; i++) {
    sqlite.prepare(`INSERT INTO training_sessions
        (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(`SES-${i}`, PROGRAMME, BOOKING, `RES-${i}`, i, TRAINER,
           new Date(now + i * 86400000).toISOString(), new Date(now + i * 86400000 + 3600000).toISOString(),
           i <= completed ? "completed" : "locked", now, now);
  }

  if (publishPolicy) {
    await cancel.saveTrainingCancellationPolicy(db, {
      cityId: CITY, feeType: "none", feeValue: 0, noShowTreatment,
      effectiveFrom: "2026-01-01", reason: "master directive 02 proration probe", actorId: STAFF,
    });
  }
  return { sqlite, db, cancel };
}

const caseRow = (sqlite) => sqlite.prepare("SELECT * FROM training_cancellation_cases WHERE booking_id=?").get(BOOKING);

test("TRAIN-CANCEL-1: 4 of 10 sessions used - refund is the remaining 6, prorated", async () => {
  const { sqlite, db, cancel } = await world();
  await cancel.requestTrainingCancellation(db, {
    bookingId: BOOKING, reason: "Customer relocating out of the city", idempotencyKey: "IDEM-RELOCATE-1", actorId: CUSTOMER,
  });
  const c = caseRow(sqlite);
  assert.ok(c, "no cancellation case was created");
  assert.equal(Number(c.total_sessions), TOTAL_SESSIONS, "session total did not come from the real session rows");
  assert.equal(Number(c.completed_sessions), COMPLETED, "completed count is wrong");
  assert.equal(Number(c.per_session_value), PER_SESSION, `per-session value should be ${PER_SESSION}`);
  assert.equal(Number(c.used_value), EXPECTED_USED, `4 delivered sessions should consume ${EXPECTED_USED}`);
  assert.equal(Number(c.calculated_refund), EXPECTED_REFUND, `refund should be ${EXPECTED_REFUND} - the 6 undelivered sessions`);
  // Arithmetic closure: nothing may vanish between captured, used and refunded.
  assert.equal(Number(c.used_value) + Number(c.calculated_refund), Number(c.captured_amount),
    "used + refunded does not equal captured - money is unaccounted for");
  assert.equal(Number(c.outstanding_service_value), 0, "a fully captured package should leave nothing outstanding");
});

test("TRAIN-CANCEL-2: the session in flight is NOT charged - only delivered sessions are", async () => {
  /* The directive's chaos: the trainer is en route to session 5. Session 5 is 'locked', not
   * 'completed', so it must not be consumed. Undelivered service is refundable. */
  const { sqlite, db, cancel } = await world();
  await cancel.requestTrainingCancellation(db, {
    bookingId: BOOKING, reason: "Customer relocating out of the city", idempotencyKey: "IDEM-RELOCATE-2", actorId: CUSTOMER,
  });
  const c = caseRow(sqlite);
  assert.equal(Number(c.chargeable_sessions), COMPLETED,
    `the in-flight 5th session was charged: chargeable=${c.chargeable_sessions}, expected ${COMPLETED}`);
  assert.equal(Number(c.used_value), COMPLETED * PER_SESSION);
  const refundedSessions = Number(c.calculated_refund) / PER_SESSION;
  assert.equal(refundedSessions, TOTAL_SESSIONS - COMPLETED, "the refund does not cover 6 whole sessions");
});

test("TRAIN-CANCEL-3: a late-cancellation penalty CANNOT be configured - the product refuses it", async () => {
  /* The directive specifies a 10% penalty on the active session. It is not implementable: this is a
   * deliberate product policy, refused at the policy setter, and calculate() hardcodes
   * cancellationFee=0 regardless. Pinned so the refusal is a recorded decision, and so anyone who
   * later adds a fee has to change this test on purpose. */
  const { db, cancel } = await world({ publishPolicy: false });
  for (const attempt of [
    { feeType: "percent_captured", feeValue: 10 },
    { feeType: "flat", feeValue: 200 },
    { feeType: "none", feeValue: 10 },
  ]) {
    await assert.rejects(
      () => cancel.saveTrainingCancellationPolicy(db, {
        cityId: CITY, ...attempt, noShowTreatment: "refundable",
        effectiveFrom: "2026-01-01", reason: "attempt to configure a penalty", actorId: STAFF,
      }),
      (error) => {
        const status = error instanceof Response ? error.status : error?.status;
        assert.equal(status, 400, `a ${attempt.feeType}/${attempt.feeValue} fee was accepted with status ${status}`);
        return true;
      },
      `a ${attempt.feeType} fee of ${attempt.feeValue} was not refused`);
  }
});

test("TRAIN-CANCEL-4: with no published policy, no refund is calculated - fail closed", async () => {
  /* ensureTrainingCancellationTables seeds the policy as 'configuration_required' precisely so a
   * refund cannot be computed from an unapproved policy. A system that guessed a refund here would
   * be moving money on an assumption. */
  const { sqlite, db, cancel } = await world({ publishPolicy: false });
  await cancel.requestTrainingCancellation(db, {
    bookingId: BOOKING, reason: "Customer relocating out of the city", idempotencyKey: "IDEM-NOPOLICY", actorId: CUSTOMER,
  });
  const c = caseRow(sqlite);
  assert.ok(c, "no case row was written");
  assert.equal(Number(c.calculated_refund), 0, "a refund was calculated with no published policy");
  assert.notEqual(String(c.status), "approved_refund_ready", `case reached ${c.status} without a policy`);
});

test("TRAIN-CANCEL-5: no-show treatment changes the math, and it is policy-driven not hardcoded", async () => {
  /* Non-vacuity for the proration engine. If the numbers above were constants rather than a
   * computation, flipping this policy field would change nothing. */
  const chargeable = await world({ noShowTreatment: "chargeable" });
  chargeable.sqlite.prepare("UPDATE training_sessions SET status='no_show' WHERE sequence_no=5").run();
  await chargeable.cancel.requestTrainingCancellation(chargeable.db, {
    bookingId: BOOKING, reason: "Customer relocating out of the city", idempotencyKey: "IDEM-NOSHOW-C", actorId: CUSTOMER,
  });
  const c1 = caseRow(chargeable.sqlite);
  assert.equal(Number(c1.chargeable_sessions), COMPLETED + 1, "a no-show was not charged under 'chargeable'");
  assert.equal(Number(c1.calculated_refund), PACKAGE_TOTAL - (COMPLETED + 1) * PER_SESSION);

  const refundable = await world({ noShowTreatment: "refundable" });
  refundable.sqlite.prepare("UPDATE training_sessions SET status='no_show' WHERE sequence_no=5").run();
  await refundable.cancel.requestTrainingCancellation(refundable.db, {
    bookingId: BOOKING, reason: "Customer relocating out of the city", idempotencyKey: "IDEM-NOSHOW-R", actorId: CUSTOMER,
  });
  const c2 = caseRow(refundable.sqlite);
  assert.equal(Number(c2.chargeable_sessions), COMPLETED, "a no-show was charged under 'refundable'");
  assert.ok(Number(c2.calculated_refund) > Number(c1.calculated_refund),
    "the two policies produced the same refund - the treatment is not actually applied");
});

test("TRAIN-CANCEL-6: the request is idempotent - a retry does not open a second case", async () => {
  const { sqlite, db, cancel } = await world();
  const input = { bookingId: BOOKING, reason: "Customer relocating out of the city", idempotencyKey: "IDEM-RETRY", actorId: CUSTOMER };
  await cancel.requestTrainingCancellation(db, input);
  await cancel.requestTrainingCancellation(db, input);
  const n = sqlite.prepare("SELECT COUNT(*) n FROM training_cancellation_cases WHERE booking_id=?").get(BOOKING).n;
  assert.equal(Number(n), 1, `a retried cancellation opened ${n} cases`);
});

test("TRAIN-CANCEL-7: a terminal programme cannot open a new cancellation", async () => {
  const { db, cancel, sqlite } = await world();
  sqlite.prepare("UPDATE training_programmes SET status='completed' WHERE id=?").run(PROGRAMME);
  await assert.rejects(
    () => cancel.requestTrainingCancellation(db, {
      bookingId: BOOKING, reason: "Customer relocating out of the city", idempotencyKey: "IDEM-TERMINAL", actorId: CUSTOMER,
    }),
    (error) => {
      assert.equal(error instanceof Response ? error.status : error?.status, 409);
      return true;
    });
});

test("TRAIN-CANCEL-8: the refund instruction is sandbox-only and never marked live", async () => {
  /* Safety posture: this platform has no live payout path enabled. A refund instruction that
   * claimed live execution would be a false record of money having moved. */
  const { sqlite, db, cancel } = await world();
  await cancel.requestTrainingCancellation(db, {
    bookingId: BOOKING, reason: "Customer relocating out of the city", idempotencyKey: "IDEM-SANDBOX", actorId: CUSTOMER,
  });
  const instructions = sqlite.prepare("SELECT * FROM training_refund_instructions WHERE booking_id=?").all(BOOKING);
  for (const row of instructions) {
    assert.equal(Number(row.live), 0, "a refund instruction was marked live");
    assert.match(String(row.execution_mode), /sandbox/, `execution_mode was ${row.execution_mode}`);
  }
  const notes = sqlite.prepare("SELECT * FROM training_credit_notes WHERE booking_id=?").all(BOOKING);
  for (const note of notes) {
    assert.equal(Number(note.live_tax_filing), 0, "a credit note claimed live tax filing");
  }
});

test("TRAIN-CANCEL-9: the cancellation is recorded in the audit ledger with an actor", async () => {
  const { sqlite, db, cancel } = await world();
  await cancel.requestTrainingCancellation(db, {
    bookingId: BOOKING, reason: "Customer relocating out of the city", idempotencyKey: "IDEM-AUDIT", actorId: CUSTOMER,
  });
  const events = sqlite.prepare("SELECT * FROM training_cancellation_events WHERE booking_id=?").all(BOOKING);
  assert.ok(events.length >= 1, "the cancellation wrote no event to the ledger");
  const requested = events.find((e) => String(e.event_type) === "requested");
  assert.ok(requested, `no 'requested' event: ${events.map((e) => e.event_type).join(",")}`);
  assert.equal(String(requested.actor_id), CUSTOMER, "the event does not record who cancelled");
  assert.ok(String(requested.reason).length >= 8, "the event carries no meaningful reason");
});
