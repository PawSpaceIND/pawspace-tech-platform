/*
 * Pet Taxi ride reservation and booking, round 2 (26 Sep 2026 staging). EXECUTED.
 *
 * The real scheduling route and the real POST /api/taxi-ride-bookings run behind the same gateway modules
 * worker/index.ts runs, against node:sqlite loaded with the staging roster and fleet
 * (scripts/uat-staging-provider-capacity.sql), with a signed customer session - the path /v2/taxi takes
 * after "Reserve". They pin three round-2 defects:
 *
 *   - the scheduler gave rides to drivers with no car (uatcap_taxi_ft, taxi_imran) and the customer was
 *     told "No Citroen eC3 is free for this 3-hour Taxi window in blr" while a car was free;
 *   - a pickup at Mysore Palace, 147 km away, was booked because the customer typed a Bengaluru PIN;
 *   - pressing Reserve again after a lost answer showed "Base final balance ₹NaN": the idempotent replay
 *     answered with a different contract from the first response.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import * as h from "./helpers/stay-taxi-latency-harness.mjs";

installWorkersHooks("__TAXI_R2_BOOKING_DB__", "__TAXI_R2_BOOKING_ENV__");
h.stubGeocoding();
const scheduling = await import("../app/api/uat-scheduling/route.ts");
const rideBookings = await import("../app/api/taxi-ride-bookings/route.ts");
const rides = await import("../lib/taxi-ride-governance.ts");

const world = () => h.stayWorld({ dbGlobal: "__TAXI_R2_BOOKING_DB__", envGlobal: "__TAXI_R2_BOOKING_ENV__" });
const customer = { id: h.CUSTOMER, name: "Stay Latency", primaryPhone: "9000099001" };
const INDIRANAGAR = { latitude: 12.9784, longitude: 77.6408 }, KORAMANGALA = { latitude: 12.9352, longitude: 77.6245 };
const MYSORE_PALACE = { latitude: 12.3052, longitude: 76.6552 };

/** A server quote exactly as POST /api/taxi-commercial freezes it (route pricing already done). */
const quote = (w, { origin = INDIRANAGAR, originLabel = "12, 100 Feet Road, Indiranagar, Bengaluru", scheduledStart, passengerCount = 1, luggageCount = 0 }) =>
  rides.createTaxiRideQuote(w.db, { originLabel, destinationLabel: "Koramangala 5th Block, Bengaluru", origin, destination: KORAMANGALA, passengerCount, petCount: 1, luggageCount, scheduledStart, tripType: "one_way", ridePurpose: "regular", waitingMinutes: 0, distanceKm: 8.07, estimatedDurationMinutes: 25, routeProvider: "google_routes_uat" });

/** What the /v2/taxi Reserve button does: reserve a driver through the scheduler, then book the ride. */
async function reserveAndBook(w, q, { vehicleClass = "citroen_ec3", sendVehicleClass = true, serviceAddress, servicePincode = "560038" } = {}) {
  const group = `taxi-v2-${h.CUSTOMER}-${q.quoteId}-${vehicleClass}`;
  const reserve = await h.timed(w, h.schedulingRequest(w, { clientRequestId: group, petIds: [h.PETS.dog], serviceCode: "pet_taxi", scheduledStart: q.scheduledStart, scheduledEnd: q.scheduledEnd, occurrences: 1, ...(sendVehicleClass ? { vehicleClass } : {}), ...(serviceAddress ? { serviceAddress, servicePincode } : {}) }), scheduling.POST);
  const provider = reserve.body?.data?.provider, option = q.fareOptions[vehicleClass];
  const body = { idempotencyKey: group, groupId: group, scheduleGroupId: group, taxiQuoteId: q.quoteId, vehicleClass, customer, pets: [{ sourceId: h.PETS.dog, name: "Bruno", species: "dog" }], cityId: "blr", zoneId: "blr-east", scheduledStart: q.scheduledStart, scheduledEnd: q.scheduledEnd, provider: provider ? { id: provider.id, name: provider.name, model: provider.model } : null, totalAmount: Number(option.quotedTotal), amountDueNow: Number(option.bookingFee), channel: "customer_app" };
  const booking = provider ? await h.timed(w, h.taxiRideBookingRequest(w, body), rideBookings.POST) : null;
  return { reserve, booking, body, provider };
}

test("round 2: the scheduler only assigns a driver who can take a free car, so a free car is never refused", async () => {
  const w = await world();
  // taxi_rahul is the highest-ranked east driver. Take away every car he may drive: he is still a live
  // pet_taxi profile, exactly like uatcap_taxi_ft before the capacity seed and taxi_imran on staging.
  w.sqlite.prepare("DELETE FROM taxi_driver_vehicle_eligibility WHERE provider_id='taxi_rahul'").run();
  const q = await quote(w, { scheduledStart: h.ist(3, 10) });
  const { reserve, booking, provider } = await reserveAndBook(w, q);
  assert.equal(reserve.status, 200, JSON.stringify(reserve.body));
  assert.notEqual(provider?.id, "taxi_rahul", "a driver with no car is not assigned");
  assert.equal(booking?.status, 201, `the ride is booked on a free car: ${JSON.stringify(booking?.body)}`);
  assert.equal(booking.body.data.reservedVehicle.vehicleClass, "citroen_ec3");
});

test("round 2: an XUV ride goes only to a driver with a free XUV, and when none is left the refusal says so in plain words", async () => {
  const w = await world();
  // One XUV in the city, and only taxi_meera may drive it.
  w.sqlite.prepare("UPDATE taxi_fleet_vehicles SET active=0 WHERE vehicle_class='xuv' AND id<>'TXF-UAT-XUV-01'").run();
  w.sqlite.prepare("DELETE FROM taxi_driver_vehicle_eligibility WHERE vehicle_id='TXF-UAT-XUV-01' AND provider_id<>'taxi_meera'").run();
  const first = await reserveAndBook(w, await quote(w, { scheduledStart: h.ist(4, 10), passengerCount: 4 }), { vehicleClass: "xuv" });
  assert.equal(first.provider?.id, "taxi_meera", "the only driver who can take the free XUV");
  assert.equal(first.booking?.status, 201, JSON.stringify(first.booking?.body));
  assert.equal(first.booking.body.data.reservedVehicle.id, "TXF-UAT-XUV-01");
  // A second XUV ride in the same window: no driver can take a free XUV, so no driver is reserved at all.
  const second = await reserveAndBook(w, await quote(w, { scheduledStart: h.ist(4, 10), passengerCount: 5 }), { vehicleClass: "xuv" });
  assert.equal(second.reserve.status, 409, JSON.stringify(second.reserve.body));
  assert.equal(second.provider, undefined, "nobody is held for a ride that cannot get a car");
  const { reserveTaxiSchedule } = await import("../lib/taxi-booking-client.ts");
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(second.reserve.body), { status: second.reserve.status, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(() => reserveTaxiSchedule({ clientRequestId: "x", customerId: h.CUSTOMER, petIds: [h.PETS.dog], cityId: "blr", zoneId: "blr-east", scheduledStart: "s", scheduledEnd: "e", vehicleClass: "xuv" }), /No driver and car are free for this pickup time/);
  } finally { globalThis.fetch = original; }
});

test("round 2: a pickup outside Bengaluru is refused on its quoted coordinates, whatever PIN is typed", async () => {
  const w = await world();
  // Quoted from Mysore Palace (the server geocoded it 147 km from the city), then Reserve with Bengaluru PIN 560038.
  const q = await quote(w, { origin: MYSORE_PALACE, originLabel: "Mysore Palace, Mysuru", scheduledStart: h.ist(3, 13) });
  const { booking } = await reserveAndBook(w, q, { serviceAddress: "Mysore Palace, Mysuru", servicePincode: "560038" });
  assert.equal(booking?.status, 409, `the ride must not be booked: ${JSON.stringify(booking?.body)}`);
  assert.match(booking.body.error, /picks up only within Bengaluru/);
  assert.doesNotMatch(booking.body.error, /Zone not found|pincode|D1_ERROR/i);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE service_code='pet_taxi'").get().n), 0, "nothing was booked");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) n FROM taxi_fleet_reservations WHERE status IN ('held','confirmed')").get().n), 0, "no car is held");
  // Non-vacuity: the same ride from Indiranagar with the same PIN books.
  const inside = await reserveAndBook(w, await quote(w, { scheduledStart: h.ist(3, 13) }), { serviceAddress: "12, 100 Feet Road, Indiranagar", servicePincode: "560038" });
  assert.equal(inside.booking?.status, 201, JSON.stringify(inside.booking?.body));
});

test("round 2: pressing Reserve again replays the ride with the same contract, including the base final balance", async () => {
  const w = await world();
  const q = await quote(w, { scheduledStart: h.ist(5, 9, 30) });
  const { booking, body } = await reserveAndBook(w, q);
  assert.equal(booking?.status, 201, JSON.stringify(booking?.body));
  const first = booking.body.data;
  // The first answer was lost (local proxy cut, a closed tab); the customer presses Reserve again.
  const replay = await h.timed(w, h.taxiRideBookingRequest(w, body), rideBookings.POST);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  const again = replay.body.data;
  assert.equal(again.duplicatePrevented, true);
  assert.equal(again.bookingId, first.bookingId);
  assert.ok(Number.isFinite(again.balanceAmount), `balanceAmount must be a number on replay: ${again.balanceAmount}`);
  for (const key of ["bookingId", "customerId", "petIds", "scheduleGroupId", "workOrderId", "paymentId", "status", "amountDueNow", "balanceAmount", "reservedVehicle", "paymentRequired", "confirmationRequiresVerifiedCapture", "liveMoney"]) {
    assert.deepEqual(again[key], first[key], `${key} on replay must equal the first answer`);
  }
  assert.deepEqual(Object.keys(again.trip).sort(), Object.keys(first.trip).sort(), "the trip has the same shape");
  for (const snake of ["origin_label", "scheduled_start", "synthetic_distance_km"]) assert.equal(snake in again.trip, false, `${snake} must not leak into the replayed contract`);
  const { taxiMoney } = await import("../lib/taxi-presentation.ts");
  assert.equal(taxiMoney(again.balanceAmount), taxiMoney(q.fareOptions.citroen_ec3.finalBalanceBeforeAdjustments), "the summary shows the quoted base final balance, never ₹NaN");
});
