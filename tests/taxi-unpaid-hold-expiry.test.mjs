/*
 * Unpaid Pet Taxi holds expire (round 2, 26 Sep 2026).
 *
 * The ride flow tells the customer "Vehicle and driver held for 3 hours. Pay the 50% booking fee to confirm
 * the ride." Nothing ever ended the hold: an abandoned unpaid ride kept its car and driver for good (round 2
 * left PS-UAT-TAXI-MUIJKK7K-D991, MUILFO0D-9F16 and MUIM2SO2-9F66 holding cars on staging). These EXECUTE
 * lib/taxi-unpaid-hold-expiry.ts against a real SQLite-backed D1 with the real finance, fleet and lifecycle
 * schema, and read the released rows back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, seedCanonicalTrip, futurePickup } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__TAXI_HOLD_EXPIRY_DB__", "__TAXI_HOLD_EXPIRY_ENV__");
const finance = await import("../lib/taxi-finance-governance.ts");
const rides = await import("../lib/taxi-ride-governance.ts");
const fleet = await import("../lib/taxi-fleet-governance.ts");
const expiry = await import("../lib/taxi-unpaid-hold-expiry.ts");

const HOUR = 3_600_000;
async function world() {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__TAXI_HOLD_EXPIRY_DB__ = db;
  globalThis.__TAXI_HOLD_EXPIRY_ENV__ = {};
  return { sqlite, db };
}
/** A Taxi v2 ride hold reserved `ageHours` ago on its own car: fee unpaid, driver and car held for the window. */
async function hold(w, { id, car, ageHours, pickupInMinutes = 26 * 60, paymentStatus = "created", providerId = "taxi_rahul" }) {
  const scheduledStart = futurePickup(pickupInMinutes);
  const trip = seedCanonicalTrip(w.sqlite, { bookingId: id, tripId: `TRIP-${id}`, reservationId: `RES-${id}`, groupId: `GRP-${id}`, customerId: `CUST-${id}`, providerId, scheduledStart });
  await finance.ensureTaxiFinanceTables(w.db);
  await rides.ensureTaxiRideTables(w.db);
  const created = Date.now() - ageHours * HOUR;
  w.sqlite.prepare("UPDATE canonical_bookings SET status='payment_pending',created_at=?,updated_at=? WHERE id=?").run(created, created, id);
  w.sqlite.prepare("UPDATE provider_work_orders SET status='payment_pending' WHERE booking_id=?").run(id);
  w.sqlite.prepare("UPDATE booking_payments SET status=?,mode='split_50_50',amount_due_now=224.5 WHERE booking_id=?").run(paymentStatus, id);
  w.sqlite.prepare("UPDATE scheduling_reservations SET status='assigned' WHERE group_id=?").run(trip.groupId);
  w.sqlite.prepare("INSERT INTO taxi_payment_schedules (booking_id,customer_id,total_amount,booking_fee_amount,balance_amount,status,created_at,updated_at) VALUES (?,?,449,224.5,224.5,'booking_fee_pending',?,?)").run(id, trip.customerId, created, created);
  w.sqlite.prepare("INSERT INTO taxi_fleet_reservations (id,vehicle_id,provider_id,quote_id,booking_id,scheduled_start,scheduled_end,status,created_at,updated_at,city_id) VALUES (?,?,?,?,?,?,?,'confirmed',?,?,'blr')")
    .run(`TFR-${id}`, car, providerId, `TRQ-${id}`, id, trip.scheduledStart, trip.scheduledEnd, created, created);
  return trip;
}
const state = (w, id) => ({
  booking: String(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(id).status),
  car: String(w.sqlite.prepare("SELECT status FROM taxi_fleet_reservations WHERE booking_id=?").get(id).status),
  driver: String(w.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(`GRP-${id}`).status),
  payment: String(w.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(id).status),
});

test("an unpaid Pet Taxi hold is released 3 hours after it was reserved, and a younger one keeps its car", async () => {
  const w = await world();
  const old = await hold(w, { id: "BKG-HOLD-OLD", car: "TXF-CITROEN-9179", ageHours: 3.2 });
  await hold(w, { id: "BKG-HOLD-YOUNG", car: "TXF-CITROEN-9188", ageHours: 1 });
  const result = await expiry.releaseExpiredTaxiHolds(w.db);
  assert.deepEqual(result.bookings, ["BKG-HOLD-OLD"]);
  assert.deepEqual(state(w, "BKG-HOLD-OLD"), { booking: "cancelled", car: "released", driver: "cancelled", payment: "cancelled" });
  assert.deepEqual(state(w, "BKG-HOLD-YOUNG"), { booking: "payment_pending", car: "confirmed", driver: "assigned", payment: "created" }, "a hold inside its 3 hours is untouched");
  // The released car is bookable again for the same window.
  const free = await fleet.availableTaxiFleet(w.db, { vehicleClass: "citroen_ec3", providerId: "taxi_rahul", cityId: "blr", scheduledStart: old.scheduledStart, scheduledEnd: old.scheduledEnd });
  assert.ok(free.some((car) => String(car.id) === "TXF-CITROEN-9179"), "capacity really comes back");
  const request = w.sqlite.prepare("SELECT status,approved_refund_amount,requested_by FROM taxi_cancellation_requests WHERE booking_id=?").get("BKG-HOLD-OLD");
  assert.deepEqual({ ...request }, { status: "cancelled", approved_refund_amount: 0, requested_by: expiry.TAXI_HOLD_EXPIRY_ACTOR });
  assert.ok(w.sqlite.prepare("SELECT event_type FROM taxi_trip_events WHERE booking_id=?").all("BKG-HOLD-OLD").some((row) => row.event_type === "ride_hold_expired_before_payment"));
  // A second run finds nothing more to do.
  assert.deepEqual((await expiry.releaseExpiredTaxiHolds(w.db)).bookings, []);
});

test("a near-term unpaid ride is released at its pickup time even inside the 3 hours", async () => {
  const w = await world();
  await hold(w, { id: "BKG-HOLD-PICKUP-PASSED", car: "TXF-CITROEN-9179", ageHours: 0.5, pickupInMinutes: 20 });
  // The sweep runs after the pickup time: an unpaid ride cannot start, so its hold only blocks others.
  const result = await expiry.releaseExpiredTaxiHolds(w.db, { asOf: Date.now() + 30 * 60_000 });
  assert.deepEqual(result.bookings, ["BKG-HOLD-PICKUP-PASSED"]);
  assert.equal(state(w, "BKG-HOLD-PICKUP-PASSED").car, "released");
});

test("a hold with money collected or a checkout in flight is never expired", async () => {
  const w = await world();
  await hold(w, { id: "BKG-HOLD-CAPTURED", car: "TXF-CITROEN-9179", ageHours: 5, paymentStatus: "captured" });
  await hold(w, { id: "BKG-HOLD-PAYING", car: "TXF-CITROEN-9188", ageHours: 4 });
  w.sqlite.exec("CREATE TABLE IF NOT EXISTS payment_intents (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  w.sqlite.prepare("INSERT INTO payment_intents (id,booking_id,state,created_at,updated_at) VALUES ('PI-PAYING','BKG-HOLD-PAYING','CREATED',?,?)").run(Date.now() - 4 * HOUR, Date.now() - 5 * 60_000);
  const result = await expiry.releaseExpiredTaxiHolds(w.db);
  assert.deepEqual(result.bookings, []);
  assert.equal(state(w, "BKG-HOLD-CAPTURED").car, "confirmed", "collected money keeps the ride");
  assert.equal(state(w, "BKG-HOLD-PAYING").car, "confirmed", "a checkout touched in the last 15 minutes waits for the next run");
  // Once that checkout has gone quiet, the hold is released.
  const later = await expiry.releaseExpiredTaxiHolds(w.db, { asOf: Date.now() + 20 * 60_000 });
  assert.deepEqual(later.bookings, ["BKG-HOLD-PAYING"]);
  // A payment the gateway authorized hours ago (capture not yet recorded) keeps its ride too.
  await hold(w, { id: "BKG-HOLD-AUTHORIZED", car: "TXF-XUV-OWNER", ageHours: 6 });
  w.sqlite.prepare("INSERT INTO payment_intents (id,booking_id,state,created_at,updated_at) VALUES ('PI-AUTHORIZED','BKG-HOLD-AUTHORIZED','AUTHORIZED',?,?)").run(Date.now() - 6 * HOUR, Date.now() - 5 * HOUR);
  assert.deepEqual((await expiry.releaseExpiredTaxiHolds(w.db, { asOf: Date.now() + 20 * 60_000 })).bookings, []);
  assert.equal(state(w, "BKG-HOLD-AUTHORIZED").booking, "payment_pending");
});

test("a capture that lands first keeps its ride: the release claim only matches a still-unpaid booking", async () => {
  const w = await world();
  await hold(w, { id: "BKG-HOLD-RACE", car: "TXF-CITROEN-9179", ageHours: 4 });
  // The fee is captured between the sweep's read and its release batch.
  w.db.onSql("UPDATE canonical_bookings SET status='cancelled'", () => { w.sqlite.prepare("UPDATE booking_payments SET status='captured' WHERE booking_id=?").run("BKG-HOLD-RACE"); });
  const result = await expiry.releaseExpiredTaxiHolds(w.db);
  assert.deepEqual(result.bookings, []);
  assert.deepEqual(state(w, "BKG-HOLD-RACE"), { booking: "payment_pending", car: "confirmed", driver: "assigned", payment: "captured" }, "nothing was released for a paid ride");
});

test("the five-minute background scheduler runs the Taxi hold expiry", async () => {
  const w = await world();
  await hold(w, { id: "BKG-HOLD-SCHEDULED", car: "TXF-CITROEN-9179", ageHours: 3.5 });
  const source = fs.readFileSync(new URL("../lib/background-scheduler.ts", import.meta.url), "utf8");
  assert.match(source, /import\("\.\/taxi-unpaid-hold-expiry"\)\.then\(\(\{releaseExpiredTaxiHolds\}\)=>releaseExpiredTaxiHolds\(db,\{asOf,limit:20\}\)\)/);
  assert.match(source, /const names=\[[^\]]*"taxiUnpaidHoldExpiry"/); // Other tasks may follow Taxi; the registration must remain.
  // The scheduler's task, executed on its own (the full scheduler also runs every other sweep).
  const task = await import("../lib/taxi-unpaid-hold-expiry.ts").then(({ releaseExpiredTaxiHolds }) => releaseExpiredTaxiHolds(w.db, { asOf: Date.now(), limit: 20 }));
  assert.deepEqual(task.bookings, ["BKG-HOLD-SCHEDULED"]);
});
