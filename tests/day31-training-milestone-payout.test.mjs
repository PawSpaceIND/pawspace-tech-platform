/*
 * Day-31 cross-module test 4: the five-day commission payout hold on a training programme.
 *
 * training programme + sessions -> milestone detection -> the five-day cooling-off clock ->
 * finance approval -> idempotency.
 *
 * The rule (commit 494687d "enforce five-day commission payout milestones"): a commission trainer
 * is paid half the package commission once half the sessions are done and the rest on completion,
 * and each half becomes approvable only FIVE DAYS after its milestone is reached. The hold is the
 * whole point of the rule - it is the window in which a customer complaint can still stop the
 * money - so what this file attacks is whether the clock can be made to start early.
 *
 * Sessions do not complete in sequence order in real life. A customer reschedules session 3 and
 * the trainer runs 4 and 5 first. That is the case below.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31_TCM_DB__", "__D31_TCM_ENV__");

const BOOKING = "TRN-D31-001";
const PROGRAMME = "TPRG-D31-001";
const PROVIDER = "TRAINER-D31-001";
const DAY = 86400000;
const TOTAL_SESSIONS = 6;
const PACKAGE_VALUE = 24000;     // Rs 24,000 programme
const COMMISSION_PCT = 50;       // trainer keeps 50% -> Rs 12,000, paid Rs 6,000 + Rs 6,000

async function seedProgramme() {
  const { sqlite, db } = world("__D31_TCM_DB__", "__D31_TCM_ENV__");
  const payout = await import("../lib/training-commission-payout.ts");
  await payout.ensureTrainingCommissionPayoutTables(db);

  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT NOT NULL,provider_id TEXT,total_amount REAL NOT NULL,currency TEXT DEFAULT 'INR',scheduled_start TEXT,status TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_model TEXT NOT NULL,status TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_compensation_profiles (provider_id TEXT PRIMARY KEY,engagement_model TEXT NOT NULL DEFAULT 'full_time',default_commission_mode TEXT,default_commission_value REAL,razorpayx_contact_id TEXT,razorpayx_fund_account_id TEXT,status TEXT NOT NULL DEFAULT 'active',reason TEXT,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS training_programmes (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,plan_code TEXT NOT NULL,plan_name TEXT NOT NULL,pet_ids_json TEXT NOT NULL,requirements_json TEXT NOT NULL DEFAULT '[]',meet_booking_id TEXT,status TEXT NOT NULL DEFAULT 'scheduled',total_sessions INTEGER NOT NULL,completed_sessions INTEGER NOT NULL DEFAULT 0,no_show_sessions INTEGER NOT NULL DEFAULT 0,cancelled_sessions INTEGER NOT NULL DEFAULT 0,pricing_snapshot_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS training_sessions (id TEXT PRIMARY KEY,programme_id TEXT NOT NULL,booking_id TEXT NOT NULL,schedule_reservation_id TEXT NOT NULL UNIQUE,sequence_no INTEGER NOT NULL,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'locked',attendance_json TEXT NOT NULL DEFAULT '{}',homework_json TEXT NOT NULL DEFAULT '{}',progress_json TEXT NOT NULL DEFAULT '{}',evidence_json TEXT NOT NULL DEFAULT '[]',started_at INTEGER,completed_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(programme_id,sequence_no))");

  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,provider_id,total_amount,scheduled_start,status) VALUES (?,?,?,'dog_training',?,?,?,'confirmed')")
    .run(BOOKING, "CUS-D31", "blr", PROVIDER, PACKAGE_VALUE, new Date(now).toISOString());
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,provider_model,status) VALUES (?,?,?,'commission','accepted')")
    .run("WO-D31", BOOKING, PROVIDER);
  sqlite.prepare("INSERT INTO provider_compensation_profiles (provider_id,engagement_model,default_commission_mode,default_commission_value,status,updated_by,created_at,updated_at) VALUES (?,'commission','percent',?,'active','finance@pawspace.in',?,?)")
    .run(PROVIDER, COMMISSION_PCT, now, now);
  sqlite.prepare("INSERT INTO training_programmes (id,booking_id,customer_id,provider_id,city_id,zone_id,plan_code,plan_name,pet_ids_json,total_sessions,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(PROGRAMME, BOOKING, "CUS-D31", PROVIDER, "blr", "blr-east", "obedience-6", "Obedience 6", '["PET-1"]', TOTAL_SESSIONS, now, now);
  for (let seq = 1; seq <= TOTAL_SESSIONS; seq++) {
    sqlite.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'locked',?,?)")
      .run(`TS-${seq}`, PROGRAMME, BOOKING, `RES-D31-${seq}`, seq, PROVIDER, new Date(now).toISOString(), new Date(now).toISOString(), now, now);
  }
  return { sqlite, db, payout, now };
}

/** Mark one session complete at a real moment in time. */
const complete = (sqlite, seq, at) =>
  sqlite.prepare("UPDATE training_sessions SET status='completed',completed_at=?,updated_at=? WHERE programme_id=? AND sequence_no=?")
    .run(at, at, PROGRAMME, seq);

const milestone = (sqlite, code) =>
  sqlite.prepare("SELECT status,payout_amount,reached_at,due_at FROM training_commission_payout_milestones WHERE booking_id=? AND milestone_code=?").get(BOOKING, code);

test("half the sessions completed opens the first milestone at half the commission", async () => {
  const { sqlite, db, payout, now } = await seedProgramme();
  for (const seq of [1, 2, 3]) complete(sqlite, seq, now);
  await payout.syncTrainingCommissionPayoutMilestones(db, now);

  const first = milestone(sqlite, "first_50_percent");
  assert.ok(first, "reaching half the sessions must open the first milestone");
  assert.equal(first.payout_amount, 6000, "half of 50% of Rs 24,000");
  assert.equal(first.status, "waiting_5_days");
  assert.equal(Number(first.due_at) - Number(first.reached_at), 5 * DAY);
  assert.equal(milestone(sqlite, "final_50_percent"), undefined, "the programme is not finished");
});

test("the five-day hold genuinely holds - finance cannot approve inside it", async () => {
  const { sqlite, db, payout, now } = await seedProgramme();
  for (const seq of [1, 2, 3]) complete(sqlite, seq, now);
  await payout.syncTrainingCommissionPayoutMilestones(db, now);

  await assert.rejects(
    () => payout.approveTrainingCommissionMilestone(db, {
      bookingId: BOOKING, milestoneCode: "first_50_percent", idempotencyKey: "early-1",
      actorId: "finance@pawspace.in", reason: "Day-31 early approval attempt", asOf: now + 5 * DAY - 1000,
    }),
    (error) => { assert.equal(error.status, 409); return true; },
    "the money must not be approvable one second before the hold expires",
  );

  const approved = await payout.approveTrainingCommissionMilestone(db, {
    bookingId: BOOKING, milestoneCode: "first_50_percent", idempotencyKey: "ontime-1",
    actorId: "finance@pawspace.in", reason: "Day-31 approval after the five-day hold", asOf: now + 5 * DAY,
  });
  assert.equal(approved.status, "instruction_ready_sandbox");
  assert.equal(approved.amount, 6000);
  assert.equal(approved.livePayout, false, "sandbox only - no live money on this path");
});

test("approving the same milestone twice pays once", async () => {
  const { sqlite, db, payout, now } = await seedProgramme();
  for (const seq of [1, 2, 3]) complete(sqlite, seq, now);
  await payout.syncTrainingCommissionPayoutMilestones(db, now);
  const args = {
    bookingId: BOOKING, milestoneCode: "first_50_percent", idempotencyKey: "dup-1",
    actorId: "finance@pawspace.in", reason: "Day-31 duplicate approval", asOf: now + 6 * DAY,
  };
  const first = await payout.approveTrainingCommissionMilestone(db, args);
  const second = await payout.approveTrainingCommissionMilestone(db, args);
  assert.equal(first.duplicatePrevented, false);
  assert.equal(second.duplicatePrevented, true);
});

test("sessions completed OUT OF ORDER must not start the five-day clock early", async () => {
  /*
   * THE ATTACK. A 6-session programme; the half-way milestone is the 3rd completion.
   * The customer reschedules session 3, so the trainer runs 4 and 5 first and only gets to
   * session 1 nineteen days later. The milestone is genuinely reached on day 19 - that is the
   * moment the 3rd session was completed - so the money may not be approvable until day 24.
   */
  const { sqlite, db, payout, now } = await seedProgramme();
  complete(sqlite, 4, now);
  complete(sqlite, 5, now + DAY);
  complete(sqlite, 1, now + 19 * DAY);   // the third completion, and the real milestone moment
  const reachedAt = now + 19 * DAY;

  await payout.syncTrainingCommissionPayoutMilestones(db, reachedAt);
  const first = milestone(sqlite, "first_50_percent");
  assert.ok(first, "three of six sessions is the half-way milestone however they were sequenced");

  assert.equal(Number(first.reached_at), reachedAt,
    "the milestone is reached at the THIRD completion, not at the earliest-numbered one");
  assert.equal(first.status, "waiting_5_days",
    "the hold must be running on the day the milestone is reached, not already expired");

  await assert.rejects(
    () => payout.approveTrainingCommissionMilestone(db, {
      bookingId: BOOKING, milestoneCode: "first_50_percent", idempotencyKey: "ooo-1",
      actorId: "finance@pawspace.in", reason: "Day-31 out-of-order clock attack", asOf: reachedAt + DAY,
    }),
    (error) => { assert.equal(error.status, 409); return true; },
    "one day after the milestone the five-day window is still open - the money must not move",
  );
});
