/**
 * C-06 — a BLR Training cancellation must stop at the POLICY boundary, mutating nothing.
 *
 * requestTrainingCancellation() can refuse for four different reasons, and only one of them is the
 * boundary Revision-3 needs verified:
 *
 *   404 "Canonical Training programme not found"        <- no training_programmes row
 *   409 "Terminal or cancelled ... cannot open"          <- booking/programme already finished
 *   (mispriced calculation)                              <- no sessions to price against
 *   blocked_policy_configuration                         <- THE ONE WE WANT
 *
 * The first three are fixture failures masquerading as a policy result, which is exactly what the
 * UAT demo seed used to produce: its only two dog_training bookings were 'completed' and
 * 'cancelled', with no programme and no sessions at all. The seed now carries UATD-BK-TRAIN-3, a
 * confirmed + captured booking with a live programme and two sessions (one completed, one
 * scheduled), so the request gets all the way to calculate() and is blocked there for the real
 * reason: lib/training-cancellation.ts seeds the BLR policy 'configuration_required', and
 * calculate() returns null for any policy that is not 'published'.
 *
 * No policy is published anywhere in this file. Publishing one would move the case to 'calculated'
 * and destroy the very boundary being verified.
 *
 * This mirrors the seed rows rather than importing the .sql (the generator validates every column
 * against the real DDL at generation time; this asserts the runtime BEHAVIOUR those rows produce).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__C06_DB__", "__C06_ENV__");

const BOOKING = "UATD-BK-TRAIN-3", PROG = "UATD-TPROG-1", CUS = "UATD-CUS-3", AMOUNT = 5999;

const cancellation = await import("../lib/training-cancellation.ts");
const programme = await import("../lib/training-programme.ts");

async function seed() {
  const sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__C06_DB__ = db;
  globalThis.__C06_ENV__ = {};
  // Real DDL from the modules that own these tables — never hand-typed.
  await cancellation.ensureTrainingCancellationTables(db);
  await programme.ensureTrainingProgrammeTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");

  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_name,schedule_group_id,provider_id,status,total_amount,currency,created_at,updated_at) VALUES (?,?,'blr','blr-east','dog_training','Basic Obedience',?,'train_kiran','confirmed',?, 'INR',0,0)")
    .run(BOOKING, CUS, `UATD-GRP-${BOOKING}`, AMOUNT);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,created_at,updated_at) VALUES (?,?,?,?,?,'INR','upi','prepaid','captured','uat_sandbox',0,0)")
    .run(`${BOOKING}-PAY`, BOOKING, CUS, AMOUNT, AMOUNT);
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,status,created_at) VALUES (?,?,'train_kiran','dog_training','blr','blr-east',?,'[]','2026-09-01T04:30:00.000Z','2026-09-01T06:30:00.000Z',1,1,'assigned',0)")
    .run(`${BOOKING}-RES`, `UATD-GRP-${BOOKING}`, CUS);
  sqlite.prepare("INSERT INTO training_programmes (id,booking_id,customer_id,provider_id,city_id,zone_id,plan_code,plan_name,pet_ids_json,status,total_sessions,completed_sessions,created_at,updated_at) VALUES (?,?,?,'train_kiran','blr','blr-east','train-basic-6','Basic Obedience','[]','in_progress',2,1,0,0)")
    .run(PROG, BOOKING, CUS);
  const s = sqlite.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,'train_kiran',?,?,?,0,0)");
  s.run("UATD-TSESS-1", PROG, BOOKING, `${BOOKING}-RES-S1`, 1, "2026-09-01T04:30:00.000Z", "2026-09-01T06:30:00.000Z", "completed");
  s.run("UATD-TSESS-2", PROG, BOOKING, `${BOOKING}-RES-S2`, 2, "2026-09-08T04:30:00.000Z", "2026-09-08T06:30:00.000Z", "scheduled");
  return sqlite;
}

/** Every ledger/money/state surface C-06 must leave untouched. */
function snapshot(sqlite) {
  const count = (t) => {
    const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    return exists ? sqlite.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c : 0;
  };
  return {
    refundInstructions: count("training_refund_instructions"),
    creditNotes: count("training_credit_notes"),
    walletLedger: count("pawspace_wallet_ledger"),
    journal: count("finance_journal_entries"),
    payments: sqlite.prepare("SELECT id,status,amount,amount_due_now FROM booking_payments").all(),
    booking: sqlite.prepare("SELECT id,status FROM canonical_bookings WHERE id=?").get(BOOKING),
    reservation: sqlite.prepare("SELECT id,status FROM scheduling_reservations WHERE group_id=?").get(`UATD-GRP-${BOOKING}`),
    sessions: sqlite.prepare("SELECT id,status FROM training_sessions ORDER BY sequence_no").all(),
    programme: sqlite.prepare("SELECT id,status,completed_sessions,cancelled_sessions FROM training_programmes WHERE id=?").get(PROG),
  };
}

test("PRECONDITION: the BLR training cancellation policy really is unconfigured", async () => {
  const sqlite = await seed();
  const policy = sqlite.prepare("SELECT city_id,status FROM training_cancellation_policies WHERE city_id='blr'").get();
  assert.equal(policy.status, "configuration_required", "the boundary under test exists because the policy is unconfigured");
});

test("PRECONDITION: the fixture cannot fail for any of the three WRONG reasons", async () => {
  const sqlite = await seed();
  assert.ok(sqlite.prepare("SELECT id FROM training_programmes WHERE booking_id=?").get(BOOKING), "programme exists (not a 404)");
  const booking = sqlite.prepare("SELECT status,total_amount FROM canonical_bookings WHERE id=?").get(BOOKING);
  assert.equal(booking.status, "confirmed", "booking is NOT terminal/cancelled");
  assert.ok(booking.total_amount > 0, "total amount > 0");
  const prog = sqlite.prepare("SELECT status FROM training_programmes WHERE id=?").get(PROG);
  assert.ok(!["completed", "completed_with_exceptions", "cancelled"].includes(prog.status), "programme is not terminal");
  const sessions = sqlite.prepare("SELECT status FROM training_sessions WHERE programme_id=?").all(PROG);
  assert.equal(sessions.length, 2, "at least two sessions exist");
  assert.ok(sessions.some((x) => x.status === "completed"), "one completed session");
  assert.ok(sessions.some((x) => x.status === "scheduled"), "one scheduled session");
  const pay = sqlite.prepare("SELECT status,amount_due_now FROM booking_payments WHERE booking_id=?").get(BOOKING);
  assert.equal(pay.status, "captured", "sandbox captured-equivalent payment");
  assert.ok(pay.amount_due_now > 0, "captured amount > 0");
});

test("C-06: the request reaches blocked_policy_configuration — the real policy boundary", async () => {
  await seed();
  const result = await cancellation.requestTrainingCancellation(globalThis.__C06_DB__, {
    bookingId: BOOKING, reason: "Revision-3 C-06 policy boundary verification", idempotencyKey: "c06-uat-1", actorId: "tester@pawspace.in",
  });
  assert.equal(result.status, "blocked_policy_configuration", "blocked on POLICY, not on a missing programme/terminal booking/missing sessions");
  assert.equal(result.calculation, null, "no refund was calculated at all");
  assert.equal(result.liveRefund, false, "and nothing live was attempted");
});

test("C-06: ZERO mutation — refund ledger, wallet, payment, journal, booking, reservation, sessions", async () => {
  const sqlite = await seed();
  const before = snapshot(sqlite);

  await cancellation.requestTrainingCancellation(globalThis.__C06_DB__, {
    bookingId: BOOKING, reason: "Revision-3 C-06 zero-mutation verification", idempotencyKey: "c06-uat-2", actorId: "tester@pawspace.in",
  });

  const after = snapshot(sqlite);
  assert.equal(after.refundInstructions, before.refundInstructions, "zero refund ledger mutation");
  assert.equal(after.refundInstructions, 0, "and no refund instruction exists at all");
  assert.equal(after.creditNotes, before.creditNotes, "zero credit-note mutation");
  assert.equal(after.walletLedger, before.walletLedger, "zero wallet mutation");
  assert.equal(after.journal, before.journal, "zero journal mutation");
  assert.deepEqual(after.payments, before.payments, "zero payment mutation");
  assert.deepEqual(after.booking, before.booking, "booking row unchanged");
  assert.equal(after.booking.status, "confirmed", "booking remains NON-cancelled");
  assert.deepEqual(after.reservation, before.reservation, "reservation unchanged");
  assert.equal(after.reservation.status, "assigned", "the hold is neither released nor cancelled");
  assert.deepEqual(after.sessions, before.sessions, "session states unchanged");
  assert.deepEqual(after.programme, before.programme, "programme row unchanged");
});

test("C-06: replaying the same request is idempotent and still mutates nothing", async () => {
  const sqlite = await seed();
  const first = await cancellation.requestTrainingCancellation(globalThis.__C06_DB__, {
    bookingId: BOOKING, reason: "Revision-3 C-06 replay verification", idempotencyKey: "c06-uat-3", actorId: "tester@pawspace.in",
  });
  const mid = snapshot(sqlite);
  const second = await cancellation.requestTrainingCancellation(globalThis.__C06_DB__, {
    bookingId: BOOKING, reason: "Revision-3 C-06 replay verification", idempotencyKey: "c06-uat-3", actorId: "tester@pawspace.in",
  });
  assert.equal(second.duplicatePrevented, true, "the replay is recognised, not re-opened");
  assert.equal(String(second.status), first.status, "and reports the same blocked status");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM training_cancellation_cases").get().c, 1, "exactly one case row");
  assert.deepEqual(snapshot(sqlite), mid, "the replay mutated nothing further");
});
