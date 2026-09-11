/*
 * Day-31 wave 4: the trainer monthly incentive engine.
 *
 * completed training bookings -> monthly order value -> revenue ladder -> Meet & Greet conversions
 * -> petrol / special / review components -> the amount a real person is paid.
 *
 * lib/trainer-incentive-engine.ts had no test importing it. It computes what a trainer earns, so
 * an error here is money a colleague did or did not receive, and it is discovered by them, not by
 * a monitor.
 *
 * The engine's own header records that a sibling engine once dropped the last day of the month
 * because `new Date(year,month,0)` is midnight LOCAL - identical data paid 8,500 under TZ=UTC and
 * 4,500 under TZ=Asia/Kolkata, a 47% underpayment, because a tiered ladder loses a step rather
 * than a shave. Every date boundary below is therefore exercised deliberately, and the suite is
 * meant to be run under an India timezone as well as UTC.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31W_TRN_DB__", "__D31W_TRN_ENV__");

const TRAINER = "TRAINER-INC-001";
const OTHER_TRAINER = "TRAINER-INC-002";
const MONTH = "2026-09-01";
const MONTH_END = "2026-09-30";

async function seedTrainer() {
  const { sqlite, db } = world("__D31W_TRN_DB__", "__D31W_TRN_ENV__");
  const engine = await import("../lib/trainer-incentive-engine.ts");
  await engine.ensureTrainerIncentiveTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,package_code TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,scheduled_start TEXT,scheduled_end TEXT)");
  return { sqlite, db, engine };
}

let bookingSeq = 0;
const addBooking = (sqlite, { amount, day = "15", status = "completed", provider = TRAINER, packageCode = "obedience-6", service = "dog_training", month = "09" }) => {
  const id = `BK-TRN-${++bookingSeq}`;
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,package_code,provider_id,status,total_amount,currency,scheduled_start,scheduled_end) VALUES (?,?,'blr',?,?,?,?,?,'INR',?,?)")
    .run(id, "CUS-1", service, packageCode, provider, status, amount, `2026-${month}-${day}T04:00:00.000Z`, `2026-${month}-${day}T06:00:00.000Z`);
  return id;
};

const compute = (engine, db) => engine.computeTrainerMonthlyIncentive(db, { trainerId: TRAINER, monthStart: MONTH, actorId: "finance@pawspace.in" });

test("the revenue ladder pays 20% of everything above Rs 1,40,000", async () => {
  /*
   * The rule as the business states it, checked at the published worked example: an order value of
   * Rs 1,60,000 earns Rs 4,000.
   */
  const { sqlite, db, engine } = await seedTrainer();
  addBooking(sqlite, { amount: 160000 });
  const result = await compute(engine, db);
  assert.equal(result.orderValue, 160000);
  assert.equal(result.revenueIncentive, 4000, "(1,60,000 - 1,40,000) x 20%");
  assert.equal(result.total, 4000, "with no other component, the incentive is the revenue ladder");
});

test("the threshold is a floor, not a cliff either side of it", async () => {
  for (const [orderValue, expected] of [[139999, 0], [140000, 0], [140001, 0.2], [200000, 12000]]) {
    const { sqlite, db, engine } = await seedTrainer();
    addBooking(sqlite, { amount: orderValue });
    const result = await compute(engine, db);
    assert.equal(result.revenueIncentive, Math.round(expected * 100) / 100,
      `an order value of ${orderValue} must earn ${expected}`);
  }
});

test("work on the LAST day of the month is paid for", async () => {
  /*
   * The regression the engine's header documents. On a tiered ladder losing the final day does not
   * shave the payout, it drops a step - so this is asserted on an amount that straddles the
   * threshold, where the difference is the whole incentive rather than a rounding.
   */
  const { sqlite, db, engine } = await seedTrainer();
  addBooking(sqlite, { amount: 100000, day: "01" });
  addBooking(sqlite, { amount: 60000, day: MONTH_END.slice(-2) });
  const result = await compute(engine, db);
  assert.equal(result.orderValue, 160000, `the 30th must be inside September (TZ=${process.env.TZ || "unset"})`);
  assert.equal(result.revenueIncentive, 4000);
});

test("work on the FIRST day of the month is paid for, and neighbouring months are not", async () => {
  const { sqlite, db, engine } = await seedTrainer();
  addBooking(sqlite, { amount: 150000, day: "01" });
  addBooking(sqlite, { amount: 90000, day: "31", month: "08" });
  addBooking(sqlite, { amount: 90000, day: "01", month: "10" });
  const result = await compute(engine, db);
  assert.equal(result.orderValue, 150000, "August and October work belongs to August and October");
  assert.equal(result.revenueIncentive, 2000);
});

test("only this trainer's own completed training work counts", async () => {
  const { sqlite, db, engine } = await seedTrainer();
  addBooking(sqlite, { amount: 150000 });
  addBooking(sqlite, { amount: 500000, provider: OTHER_TRAINER });
  addBooking(sqlite, { amount: 500000, status: "cancelled" });
  addBooking(sqlite, { amount: 500000, status: "scheduled" });
  addBooking(sqlite, { amount: 500000, service: "grooming" });
  const result = await compute(engine, db);
  assert.equal(result.orderValue, 150000,
    "another trainer's work, unfinished work and another vertical's work must not inflate the ladder");
});

test("a Meet & Greet is not order value - it is paid through its own conversion incentive", async () => {
  const { sqlite, db, engine } = await seedTrainer();
  addBooking(sqlite, { amount: 150000 });
  addBooking(sqlite, { amount: 50000, packageCode: "trainer-meet-greet" });
  const result = await compute(engine, db);
  assert.equal(result.orderValue, 150000, "counting the Meet & Greet in order value would pay for it twice");
});

test("a conversion can only be recorded against this trainer's real Meet & Greet", async () => {
  const { sqlite, db, engine } = await seedTrainer();
  const meetGreet = addBooking(sqlite, { amount: 500, packageCode: "trainer-meet-greet" });
  const someoneElses = addBooking(sqlite, { amount: 500, packageCode: "trainer-meet-greet", provider: OTHER_TRAINER });
  const notAMeetGreet = addBooking(sqlite, { amount: 20000 });
  const converted = addBooking(sqlite, { amount: 20000 });

  await assert.rejects(
    () => engine.recordMeetGreetConversion(db, { trainerId: TRAINER, meetGreetBookingId: someoneElses, convertedBookingId: converted, actorId: "ops@pawspace.in" }),
    /not assigned to this trainer/,
    "a trainer must not claim a colleague's Meet & Greet",
  );
  await assert.rejects(
    () => engine.recordMeetGreetConversion(db, { trainerId: TRAINER, meetGreetBookingId: notAMeetGreet, convertedBookingId: converted, actorId: "ops@pawspace.in" }),
    /not a real Meet & Greet package/,
    "an ordinary booking cannot be reclassified as a Meet & Greet to earn the bonus",
  );
  await assert.rejects(
    () => engine.recordMeetGreetConversion(db, { trainerId: TRAINER, meetGreetBookingId: "BK-DOES-NOT-EXIST", convertedBookingId: converted, actorId: "ops@pawspace.in" }),
    /not found/,
    "an invented booking id must not earn anything",
  );

  const ok = await engine.recordMeetGreetConversion(db, { trainerId: TRAINER, meetGreetBookingId: meetGreet, convertedBookingId: converted, actorId: "ops@pawspace.in" });
  assert.ok(ok, "a genuine conversion must record");
});

test("the same conversion recorded twice is paid once", async () => {
  const { sqlite, db, engine } = await seedTrainer();
  const meetGreet = addBooking(sqlite, { amount: 500, packageCode: "trainer-meet-greet" });
  const converted = addBooking(sqlite, { amount: 20000 });
  const args = { trainerId: TRAINER, meetGreetBookingId: meetGreet, convertedBookingId: converted, actorId: "ops@pawspace.in" };
  await engine.recordMeetGreetConversion(db, args);
  await engine.recordMeetGreetConversion(db, args).catch(() => null);

  const result = await compute(engine, db);
  assert.equal(result.meetGreetConversionCount, 1, "one conversion is one payment");
});

test("the reported total is the sum of the components it reports", async () => {
  const { sqlite, db, engine } = await seedTrainer();
  addBooking(sqlite, { amount: 200000 });
  const meetGreet = addBooking(sqlite, { amount: 500, packageCode: "trainer-meet-greet" });
  const converted = addBooking(sqlite, { amount: 20000 });
  await engine.recordMeetGreetConversion(db, { trainerId: TRAINER, meetGreetBookingId: meetGreet, convertedBookingId: converted, actorId: "ops@pawspace.in" });

  const r = await compute(engine, db);
  const components = r.revenueIncentive + r.meetGreetIncentive + r.petrolAllowance + r.specialIncentive + r.reviewIncentive;
  assert.equal(Math.round(components * 100) / 100, r.total,
    "a payslip line must equal the lines it is made of");
  assert.ok(r.total >= r.revenueIncentive);
});

test("an incentive can only be computed for a real month start", async () => {
  const { db, engine } = await seedTrainer();
  for (const monthStart of ["2026-09-15", "2026-09", "September", "", "2026-09-1"]) {
    await assert.rejects(
      () => engine.computeTrainerMonthlyIncentive(db, { trainerId: TRAINER, monthStart, actorId: "finance@pawspace.in" }),
      /first day of a month/,
      `"${monthStart}" must not be accepted as a payroll month`,
    );
  }
});
