/*
 * Day-31 wave 14: field productivity and target progress.
 *
 * completed bookings + recorded upgrades + travel legs -> monthly actuals -> progress against a
 * published target.
 *
 * lib/field-productivity.ts had no test importing it. These numbers are what a groomer's
 * performance conversation is held against, so the failures are about a person: an upgrade
 * credited to the wrong groomer, work on the last day of the month not counted, or a target
 * invented for someone nobody set one for.
 *
 * The suite is run under an India timezone as well as UTC, because the module's own header
 * records a sibling engine dropping the final day of the month to a local-midnight Date.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31X_FIELD_DB__", "__D31X_FIELD_ENV__");

const GROOMER = "PRV-FIELD-001";
const OTHER = "PRV-FIELD-002";
const MONTH = "2026-09-01";
const MONTH_END = "2026-09-30";
const ACTOR = "ops@pawspace.in";

async function seedField() {
  const { sqlite, db } = world("__D31X_FIELD_DB__", "__D31X_FIELD_ENV__");
  const field = await import("../lib/field-productivity.ts");
  await field.ensureFieldProductivityTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,scheduled_start TEXT,scheduled_end TEXT)");
  return { sqlite, db, field };
}

let seq = 0;
const addBooking = (sqlite, { day = "15", month = "09", provider = GROOMER, status = "completed", service = "grooming" } = {}) => {
  const id = `BK-FLD-${++seq}`;
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,provider_id,status,total_amount,currency,scheduled_start,scheduled_end) VALUES (?,?,'blr',?,?,?,2000,'INR',?,?)")
    .run(id, "CUS-1", service, provider, status, `2026-${month}-${day}T04:00:00.000Z`, `2026-${month}-${day}T06:00:00.000Z`);
  return id;
};

const progress = (field, db) => field.monthlyTargetProgress(db, { providerId: GROOMER, monthStart: MONTH });

test("only this groomer's own completed work counts", async () => {
  const { sqlite, db, field } = await seedField();
  addBooking(sqlite);
  addBooking(sqlite);
  addBooking(sqlite, { provider: OTHER });
  addBooking(sqlite, { status: "cancelled" });
  addBooking(sqlite, { status: "scheduled" });
  addBooking(sqlite, { service: "boarding" });

  const actual = await field.monthlyFieldProductivity(db, { providerId: GROOMER, monthStartDate: MONTH, monthEndDate: MONTH_END });
  assert.equal(actual.ordersCompleted, 2,
    "a colleague's work, unfinished work and another vertical's work must not appear in this groomer's number");
});

test("the last day of the month is counted, and neighbouring months are not", async () => {
  const { sqlite, db, field } = await seedField();
  addBooking(sqlite, { day: "01" });
  addBooking(sqlite, { day: "30" });
  addBooking(sqlite, { day: "31", month: "08" });
  addBooking(sqlite, { day: "01", month: "10" });

  const actual = await field.monthlyFieldProductivity(db, { providerId: GROOMER, monthStartDate: MONTH, monthEndDate: MONTH_END });
  assert.equal(actual.ordersCompleted, 2, `the 1st and the 30th, and nothing else (TZ=${process.env.TZ || "unset"})`);

  const viaProgress = await progress(field, db);
  assert.equal(viaProgress.ordersCompleted, 2,
    "the month end the progress view derives for itself must agree with the one passed in explicitly");
});

test("an upgrade can only be credited to the groomer who did the booking", async () => {
  const { sqlite, db, field } = await seedField();
  const booking = addBooking(sqlite);
  await assert.rejects(
    () => field.recordBookingUpgrade(db, { bookingId: booking, providerId: OTHER, upgradeValue: 500, reason: "Day-31 upsold a spa add-on", actorId: ACTOR }),
    /does not match the booking's assigned provider/,
    "one groomer must not be able to claim another's upsell",
  );
  await assert.rejects(
    () => field.recordBookingUpgrade(db, { bookingId: "BK-DOES-NOT-EXIST", providerId: GROOMER, upgradeValue: 500, reason: "Day-31 invented booking", actorId: ACTOR }),
    /Canonical booking not found/,
  );
});

test("an upgrade needs an explicit positive value and a real reason", async () => {
  const { sqlite, db, field } = await seedField();
  const booking = addBooking(sqlite);
  for (const upgradeValue of [0, -500, Number.NaN, Infinity]) {
    await assert.rejects(
      () => field.recordBookingUpgrade(db, { bookingId: booking, providerId: GROOMER, upgradeValue, reason: "Day-31 valid reason text", actorId: ACTOR }),
      /explicit positive amount/, `an upgrade value of ${upgradeValue}`);
  }
  await assert.rejects(
    () => field.recordBookingUpgrade(db, { bookingId: booking, providerId: GROOMER, upgradeValue: 500, reason: "upsold", actorId: ACTOR }),
    /real reason/,
    "a number that affects someone's performance review needs a stated reason",
  );
});

test("recorded upgrades roll up into the month's count and value", async () => {
  const { sqlite, db, field } = await seedField();
  const a = addBooking(sqlite), b = addBooking(sqlite);
  await field.recordBookingUpgrade(db, { bookingId: a, providerId: GROOMER, upgradeValue: 500, reason: "Day-31 added a nail trim", actorId: ACTOR });
  await field.recordBookingUpgrade(db, { bookingId: b, providerId: GROOMER, upgradeValue: 750.5, reason: "Day-31 upgraded to a full spa", actorId: ACTOR });

  const actual = await field.monthlyFieldProductivity(db, { providerId: GROOMER, monthStartDate: MONTH, monthEndDate: MONTH_END });
  assert.equal(actual.upgradeCount, 2);
  assert.equal(actual.upgradeValue, 1250.5);
});

test("with no published target, no target is invented", async () => {
  /*
   * The honesty property. A groomer nobody set a target for must not be shown a progress
   * percentage against a number the system made up.
   */
  const { sqlite, db, field } = await seedField();
  addBooking(sqlite);
  const result = await progress(field, db);
  assert.equal(result.targetConfigured, false);
  assert.equal(result.target, null);
  assert.equal(result.ordersProgressPercent, undefined, "no target means no progress percentage at all");
  assert.equal(result.ordersCompleted, 1, "the real actuals are still reported");
});

test("progress against a published target is the real ratio", async () => {
  const { sqlite, db, field } = await seedField();
  for (let i = 0; i < 12; i++) addBooking(sqlite);
  const booking = addBooking(sqlite);
  await field.recordBookingUpgrade(db, { bookingId: booking, providerId: GROOMER, upgradeValue: 2000, reason: "Day-31 recorded upsell", actorId: ACTOR });
  await field.saveFieldProviderTarget(db, {
    providerId: GROOMER, monthStart: MONTH, ordersTarget: 26, upgradeCountTarget: 4, upgradeValueTarget: 8000,
    reason: "Day-31 published monthly target", actorId: ACTOR,
  });

  const result = await progress(field, db);
  assert.equal(result.targetConfigured, true);
  assert.equal(result.ordersTarget, 26);
  assert.equal(result.ordersProgressPercent, 50, "13 of 26 orders is half the target");
  assert.equal(result.upgradeCountProgressPercent, 25, "1 of 4 upgrades");
  assert.equal(result.upgradeValueProgressPercent, 25, "2,000 of 8,000");
});

test("a target of zero yields no percentage rather than a division by zero", async () => {
  const { sqlite, db, field } = await seedField();
  addBooking(sqlite);
  await field.saveFieldProviderTarget(db, {
    providerId: GROOMER, monthStart: MONTH, ordersTarget: 0, upgradeCountTarget: 0, upgradeValueTarget: 0,
    reason: "Day-31 zero target boundary", actorId: ACTOR,
  }).catch(() => null);
  const result = await progress(field, db);
  if (result.targetConfigured) {
    for (const key of ["ordersProgressPercent", "upgradeCountProgressPercent", "upgradeValueProgressPercent"]) {
      assert.notEqual(result[key], Infinity, `${key} must not be Infinity`);
      assert.ok(result[key] === null || Number.isFinite(result[key]), `${key} must be a real number or null, got ${result[key]}`);
    }
  }
});

test("travel is only counted from legs with a genuinely configured route", async () => {
  /*
   * distanceTravelledKm feeds a reimbursement conversation. A leg whose route never resolved has
   * no trustworthy distance, and counting it would pay for a distance nobody measured.
   */
  const { sqlite, db, field } = await seedField();
  let legSeq = 0;
  const leg = (id, date, km, routeStatus) =>
    sqlite.prepare("INSERT INTO provider_daily_travel_legs (id,provider_id,travel_date,leg_sequence,leg_type,origin_label,destination_label,distance_km,duration_minutes,route_status,computed_at) VALUES (?,?,?,?,'booking','Hub','Customer',?,30,?,?)")
      .run(id, GROOMER, date, ++legSeq, km, routeStatus, Date.now());
  leg("LEG-1", "2026-09-10", 12.5, "configured");
  leg("LEG-2", "2026-09-11", 8.25, "configured");
  leg("LEG-3", "2026-09-12", 999, "route_unavailable");
  leg("LEG-4", "2026-09-13", 999, "configuration_required");

  const actual = await field.monthlyFieldProductivity(db, { providerId: GROOMER, monthStartDate: MONTH, monthEndDate: MONTH_END });
  assert.equal(actual.distanceTravelledKm, 20.75, "only the two legs with a real route");
  assert.equal(actual.daysWithConfiguredRoutes, 2);
});
