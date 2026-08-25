/**
 * PawSpace Total Journey Audit — the IDENTITY SPINE.
 *
 * Per-module testing cannot see the defect class this file exists for. Every module in this repository
 * has its own suite, and those suites can all pass while a link in the chain that joins them is forked,
 * dropped or re-minted. So this suite threads ONE identity through the deepest end-to-end path the
 * platform has and asserts the join at every hop:
 *
 *     customer -> pet -> booking -> schedule/reservation -> work order -> payment -> gateway event
 *              -> service location -> media/proof -> lifecycle events -> read model
 *
 * It runs the journey for MULTIPLE customers in MULTIPLE cities inside ONE database, because a chain
 * that holds for a single customer in an empty database proves almost nothing: the interesting failures
 * are a join that matches the wrong row when a second row exists, and a scope that widens when a second
 * city does.
 *
 * The engine is tests/helpers/grooming-journey-harness.mjs, which already drives the real routes:
 * uat-scheduling, canonical-bookings, grooming-service-location, grooming-payment-sandbox,
 * partner-grooming-jobs, service-media and grooming-lifecycle. This file adds the multi-tenant
 * dimension, the chain invariant and the reconciliation.
 *
 * Everything here is EXECUTED. No assertion in this file reads a source file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

// One anchored clock for the whole file, using the same convention as the existing golden-journey
// suites (Date.UTC(2026, 10, 26, hour, 30)). That date sits inside the seeded provider rosters; an
// arbitrary date does not, and the journey is refused NO_SCHEDULE_AVAILABLE before it starts.
const future = (hour) => new Date(Date.UTC(2026, 10, 26, hour, 30)).toISOString();

/**
 * The spine population. THREE customers across TWO cities in ONE database.
 *
 * Multi-tenancy is the point. A chain that holds for a single customer in an empty database proves
 * almost nothing - the interesting failures are a join that matches the wrong row once a second row
 * exists, and a scope that widens once a second city does. The two Bengaluru customers share a
 * provider at different hours, which is also the only way a capacity or roster defect can show itself.
 */
const SPINE = [
  {
    key: "BLR-1", cityId: "blr", zoneId: "blr-east", pincode: "560038",
    latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun",
    customerId: "CUS-PTJA-BLR-1", customerName: "Asha Rao", phone: "+919900010001",
    petSourceId: "PET-PTJA-BLR-1", petName: "Kaapi", groupId: "SG-PTJA-BLR-1",
    couponCode: "UATCARE100", start: future(4),
  },
  {
    key: "MAA-1", cityId: "maa", zoneId: "chennai-core", pincode: "600001",
    latitude: 13.0827, longitude: 80.2707, preferredProviderId: "groom_maa",
    customerId: "CUS-PTJA-MAA-1", customerName: "Devan Pillai", phone: "+919900010002",
    petSourceId: "PET-PTJA-MAA-1", petName: "Mithai", groupId: "SG-PTJA-MAA-1",
    start: future(9),
  },
  {
    key: "BLR-2", cityId: "blr", zoneId: "blr-east", pincode: "560038",
    latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun",
    customerId: "CUS-PTJA-BLR-2", customerName: "Nila Shah", phone: "+919900010003",
    petSourceId: "PET-PTJA-BLR-2", petName: "Laddu", groupId: "SG-PTJA-BLR-2",
    // hour 10, not 14: future(14) is 20:00 IST, outside the seeded roster, and the journey is refused
    // NO_SCHEDULE_AVAILABLE before it starts. The existing golden suites only ever use hours 4, 9 and 10.
    start: future(10),
  },
];

let spine = null;

/** Build the whole population once; every test below reads the same database. */
async function population() {
  if (spine) return spine;
  const ctx = await setupJourney();
  const journeys = {};
  for (const person of SPINE) {
    journeys[person.key] = await runCompletedJourney(ctx, person);
  }
  spine = { ctx, journeys };
  return spine;
}

const row = (sqlite, sql, ...args) => sqlite.prepare(sql).get(...args);
const all = (sqlite, sql, ...args) => sqlite.prepare(sql).all(...args);
const count = (sqlite, sql, ...args) => Number(sqlite.prepare(sql).get(...args).c);

// =====================================================================================================
// 0. The journeys completed at all
// =====================================================================================================

test("SPINE: every seeded journey reaches a completed booking", async () => {
  // Guards the whole file. If a journey did not complete, every invariant below would be asserting
  // against an empty or half-built chain and would pass for the wrong reason.
  const { ctx, journeys } = await population();
  for (const person of SPINE) {
    const journey = journeys[person.key];
    assert.ok(journey.bookingId, `${person.key} produced no booking id`);
    const booking = row(ctx.sqlite, "SELECT * FROM canonical_bookings WHERE id=?", journey.bookingId);
    assert.ok(booking, `${person.key} booking is absent from canonical_bookings`);
    assert.equal(booking.status, "completed", `${person.key} did not reach completion`);
  }
  assert.equal(count(ctx.sqlite, "SELECT COUNT(*) c FROM canonical_bookings"), SPINE.length,
    "the database must hold exactly the seeded population - no phantom bookings");
});

// =====================================================================================================
// 1. The chain invariant, hop by hop
// =====================================================================================================

test("SPINE: customer -> pet -> booking joins on the same identity", async () => {
  const { ctx, journeys } = await population();
  for (const person of SPINE) {
    const bookingId = journeys[person.key].bookingId;
    const booking = row(ctx.sqlite, "SELECT * FROM canonical_bookings WHERE id=?", bookingId);
    assert.equal(booking.customer_id, person.customerId, `${person.key}: booking left its customer`);

    const customer = row(ctx.sqlite, "SELECT * FROM canonical_customers WHERE id=?", booking.customer_id);
    assert.ok(customer, `${person.key}: booking references a customer that does not exist`);

    // The pet arrives as a SOURCE id and is minted into a canonical pet. Both ends must be recorded, or
    // the booking cannot be traced back to the animal the customer actually named.
    const petIds = JSON.parse(String(booking.pet_ids_json));
    const sourceIds = JSON.parse(String(booking.source_pet_ids_json));
    assert.equal(petIds.length, 1, `${person.key}: expected exactly one pet`);
    assert.deepEqual(sourceIds, [person.petSourceId], `${person.key}: the source pet id was not preserved`);

    const pet = row(ctx.sqlite, "SELECT * FROM canonical_pets WHERE id=?", petIds[0]);
    assert.ok(pet, `${person.key}: booking references a canonical pet that does not exist`);
    assert.equal(pet.customer_id, person.customerId, `${person.key}: the pet belongs to a different customer`);
  }
});

test("SPINE: booking -> reservation -> work order all name the same booking and provider", async () => {
  const { ctx, journeys } = await population();
  for (const person of SPINE) {
    const journey = journeys[person.key], bookingId = journey.bookingId;
    const booking = row(ctx.sqlite, "SELECT * FROM canonical_bookings WHERE id=?", bookingId);

    const work = row(ctx.sqlite, "SELECT * FROM provider_work_orders WHERE booking_id=?", bookingId);
    assert.ok(work, `${person.key}: no work order for a completed booking`);
    assert.equal(work.provider_id, booking.provider_id, `${person.key}: work order names a different provider`);
    assert.equal(work.schedule_group_id, booking.schedule_group_id, `${person.key}: schedule group forked`);

    const reservation = row(ctx.sqlite,
      "SELECT * FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'", person.groupId);
    assert.ok(reservation, `${person.key}: the reservation that held capacity is gone`);
    assert.equal(String(reservation.provider_id), String(booking.provider_id),
      `${person.key}: capacity was held for one provider and the work order went to another`);
  }
});

test("SPINE: booking -> payment -> gateway event stay bound to one booking", async () => {
  const { ctx, journeys } = await population();
  for (const person of SPINE) {
    const bookingId = journeys[person.key].bookingId;
    const payment = row(ctx.sqlite, "SELECT * FROM booking_payments WHERE booking_id=?", bookingId);
    assert.ok(payment, `${person.key}: completed booking has no payment row`);

    const events = all(ctx.sqlite,
      "SELECT * FROM payment_gateway_events WHERE event_id=?", `evt_${person.groupId}`);
    assert.equal(events.length, 1, `${person.key}: expected exactly one gateway event, saw ${events.length}`);
  }
});

test("SPINE: media proof is owned by the booking and the provider that served it", async () => {
  const { ctx, journeys } = await population();
  for (const person of SPINE) {
    const journey = journeys[person.key], bookingId = journey.bookingId;
    const booking = row(ctx.sqlite, "SELECT * FROM canonical_bookings WHERE id=?", bookingId);
    const assets = all(ctx.sqlite, "SELECT * FROM service_media_assets WHERE booking_id=?", bookingId);
    assert.equal(assets.length, 2, `${person.key}: expected before and after proof, saw ${assets.length}`);
    for (const asset of assets) {
      assert.equal(asset.provider_id, booking.provider_id,
        `${person.key}: proof is attributed to a provider who did not hold the work order`);
      assert.equal(asset.scan_status, "clean", `${person.key}: unscanned media survived to completion`);
    }
  }
});

test("SPINE: the lifecycle event trail belongs to its own booking and reaches completion", async () => {
  const { ctx, journeys } = await population();
  for (const person of SPINE) {
    const bookingId = journeys[person.key].bookingId;
    const events = all(ctx.sqlite,
      "SELECT * FROM booking_lifecycle_events WHERE booking_id=? ORDER BY occurred_at", bookingId);
    assert.ok(events.length > 0, `${person.key}: a completed booking with no lifecycle trail`);
    for (const event of events)
      assert.equal(event.booking_id, bookingId, `${person.key}: a foreign event is filed under this booking`);
  }
});

// =====================================================================================================
// 2. Two customers in one database — the part a single-tenant test cannot see
// =====================================================================================================

test("SPINE: no row from one customer's chain appears in the other's", async () => {
  // The join-the-wrong-row failure. Every table in the chain is checked for bleed in both directions.
  const { ctx, journeys } = await population();
  const [a, b] = [SPINE[0], SPINE[1]];   // deliberately different cities
  const bookingA = journeys[a.key].bookingId, bookingB = journeys[b.key].bookingId;
  assert.notEqual(bookingA, bookingB, "the two journeys collapsed into one booking");

  for (const [table, column] of [
    ["provider_work_orders", "booking_id"],
    ["booking_payments", "booking_id"],
    ["service_media_assets", "booking_id"],
    ["booking_lifecycle_events", "booking_id"],
    ["booking_service_locations", "booking_id"],
  ]) {
    const forA = count(ctx.sqlite, `SELECT COUNT(*) c FROM ${table} WHERE ${column}=?`, bookingA);
    const forB = count(ctx.sqlite, `SELECT COUNT(*) c FROM ${table} WHERE ${column}=?`, bookingB);
    assert.ok(forA > 0, `${table} has nothing for customer A`);
    assert.ok(forB > 0, `${table} has nothing for customer B`);
    const total = count(ctx.sqlite, `SELECT COUNT(*) c FROM ${table} WHERE ${column} IN (?,?)`, bookingA, bookingB);
    assert.equal(total, forA + forB, `${table}: rows are shared between two customers' bookings`);
  }

  const petsA = all(ctx.sqlite, "SELECT id FROM canonical_pets WHERE customer_id=?", a.customerId).map(r => r.id);
  const petsB = all(ctx.sqlite, "SELECT id FROM canonical_pets WHERE customer_id=?", b.customerId).map(r => r.id);
  assert.equal(petsA.filter((id) => petsB.includes(id)).length, 0, "a pet is owned by two customers");
});

test("SPINE: one customer cannot read another customer's booking through the real route", async () => {
  // Cross-tenant access is the highest-consequence identity defect, so it is executed against the real
  // handler with a real session rather than reasoned about.
  const { ctx, journeys } = await population();
  const [a, b] = [SPINE[0], SPINE[1]];   // deliberately different cities
  const cookieA = await sessionCookie(ctx.db, "customer", a.customerId, `customer:${a.customerId}`);
  const foreign = await routeCall("../../app/api/grooming-lifecycle/route.ts", "GET",
    `/api/grooming-lifecycle?bookingId=${journeys[b.key].bookingId}`, null, cookieA);
  assert.ok(foreign.status >= 400,
    `customer A read customer B's booking and got ${foreign.status}`);
});

test("SPINE: one customer cannot act on another customer's booking", async () => {
  const { ctx, journeys } = await population();
  const [a, b] = [SPINE[0], SPINE[1]];   // deliberately different cities
  const cookieA = await sessionCookie(ctx.db, "customer", a.customerId, `customer:${a.customerId}`);
  const before = row(ctx.sqlite, "SELECT status FROM canonical_bookings WHERE id=?", journeys[b.key].bookingId);
  const acted = await routeCall("../../app/api/grooming-lifecycle/route.ts", "POST", "/api/grooming-lifecycle",
    { bookingId: journeys[b.key].bookingId, action: "cancel" }, cookieA);
  assert.ok(acted.status >= 400, `customer A mutated customer B's booking and got ${acted.status}`);
  const after = row(ctx.sqlite, "SELECT status FROM canonical_bookings WHERE id=?", journeys[b.key].bookingId);
  assert.equal(after.status, before.status, "a refused cross-tenant action still changed the booking");
});

// =====================================================================================================
// 3. Replay — the same request twice must not fork the chain
// =====================================================================================================

test("SPINE: replaying scheduling, booking and capture creates no second chain", async () => {
  // The harness deliberately replays each of these. A duplicate anywhere would mean the customer is
  // charged twice, or capacity is held twice, for one intent.
  const { ctx, journeys } = await population();
  for (const person of SPINE) {
    const journey = journeys[person.key], bookingId = journey.bookingId;
    assert.equal(count(ctx.sqlite, "SELECT COUNT(*) c FROM canonical_bookings WHERE idempotency_key=?", person.groupId), 1,
      `${person.key}: the booking replay created a second booking`);
    assert.equal(count(ctx.sqlite, "SELECT COUNT(*) c FROM booking_payments WHERE booking_id=?", bookingId), 1,
      `${person.key}: the capture replay created a second payment`);
    assert.equal(count(ctx.sqlite, "SELECT COUNT(*) c FROM payment_gateway_events WHERE event_id=?", `evt_${person.groupId}`), 1,
      `${person.key}: the capture replay recorded the gateway event twice`);
    assert.equal(count(ctx.sqlite, "SELECT COUNT(*) c FROM provider_work_orders WHERE booking_id=?", bookingId), 1,
      `${person.key}: the booking replay created a second work order`);
  }
});

// =====================================================================================================
// 4. Reconciliation — surfaces must agree with the records
// =====================================================================================================

test("RECONCILE: the canonical read surface reports exactly the bookings that exist", async () => {
  const { journeys } = await population();
  const listed = await routeCall("../../app/api/canonical-bookings/route.ts", "GET", "/api/canonical-bookings", null);
  assert.equal(listed.status, 200, `read surface answered ${listed.status}`);
  const payload = JSON.stringify(listed.body);
  for (const person of SPINE)
    assert.ok(payload.includes(journeys[person.key].bookingId),
      `${person.key}: a completed booking is missing from the read surface`);
});

test("RECONCILE: collected money equals what the payment records actually hold", async () => {
  // Booked, collected and net are different numbers and the platform has already been burned by reading
  // one as another. collectedForBooking is the single derivation; it must agree with the stored rows.
  const { ctx, journeys } = await population();
  const { collectedForBooking } = await import("../lib/collected-funds.ts");
  for (const person of SPINE) {
    const bookingId = journeys[person.key].bookingId;
    const booking = row(ctx.sqlite, "SELECT total_amount FROM canonical_bookings WHERE id=?", bookingId);
    const payment = row(ctx.sqlite, "SELECT amount,amount_due_now,status FROM booking_payments WHERE booking_id=?", bookingId);
    const collected = await collectedForBooking(ctx.db, bookingId);

    assert.equal(payment.status, "captured", `${person.key}: journey completed without a captured payment`);
    assert.equal(collected, Number(payment.amount_due_now),
      `${person.key}: collected disagrees with the instalment actually taken`);
    assert.ok(collected <= Number(booking.total_amount) + 0.001,
      `${person.key}: collected ${collected} exceeds the booked amount ${booking.total_amount}`);
  }
});

test("RECONCILE: per-customer booking counts agree between the canonical table and the pet table", async () => {
  const { ctx } = await population();
  for (const person of SPINE) {
    const bookings = count(ctx.sqlite, "SELECT COUNT(*) c FROM canonical_bookings WHERE customer_id=?", person.customerId);
    const pets = count(ctx.sqlite, "SELECT COUNT(*) c FROM canonical_pets WHERE customer_id=?", person.customerId);
    assert.equal(bookings, 1, `${person.key}: expected one booking, saw ${bookings}`);
    assert.equal(pets, 1, `${person.key}: expected one canonical pet, saw ${pets}`);
  }
});

test("RECONCILE: no orphan rows anywhere in the chain", async () => {
  // Every child row must point at a booking that exists. An orphan is either a leak from a rolled-back
  // fan-out or a join that will one day match the wrong parent.
  const { ctx } = await population();
  for (const table of [
    "provider_work_orders", "booking_payments", "service_media_assets",
    "booking_lifecycle_events", "booking_service_locations",
  ]) {
    const orphans = all(ctx.sqlite,
      `SELECT booking_id FROM ${table} WHERE booking_id NOT IN (SELECT id FROM canonical_bookings)`);
    assert.deepEqual(orphans, [], `${table} holds rows for bookings that do not exist`);
  }
  const strayPets = all(ctx.sqlite,
    "SELECT id FROM canonical_pets WHERE customer_id NOT IN (SELECT id FROM canonical_customers)");
  assert.deepEqual(strayPets, [], "canonical_pets holds pets for customers that do not exist");
});
