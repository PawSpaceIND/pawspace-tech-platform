/**
 * Pet Taxi fare, reserve and ride booking, and the customer checkout that opens the Razorpay order, on STAGING.
 * Round-2 (26 Sep) customers waited 8-16 s for a fare and 26-36 s to reserve, and a Boarding checkout took 12 s.
 * Each D1 call was ~250 ms away then, and a warm fare made 16 sequential D1 calls, a ride booking 65 and a first
 * checkout 21: the Taxi ride tables were set up on every fare and twice per ride booking (a CREATE batch and twelve
 * ALTERs), the fleet tables on every car hold (a CREATE batch, twelve ALTERs and nine seed writes), and the reads
 * before each write ran one after another.
 *
 * These EXECUTE the real routes behind the real gateway modules (as worker/index.ts runs them) against
 * node:sqlite loaded with the staging roster, with every D1 call counted and, for the timing cases, delayed;
 * Google Geocoding, Google Routes and Razorpay are deterministic stubs (h.stubTaxiMaps). They pin a bounded D1
 * budget and the SAME outcomes as before the change for the same sequence of customer actions - captured on the
 * previous code: every fare, the refusals, the driver assigned, the car held from the fleet, replays, the class
 * that runs out, the checkout order and the rows left behind. The drivers and cars are the test's own
 * (h.OWN_TAXI_ROSTER). TAXI_CAPTURE=1 prints every observed outcome instead of asserting it: that is how the
 * expectations below were taken, by running this file against the code before the change. Change one only for an
 * intended change of behaviour or copy, never to let a latency change pass.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import * as h from "./helpers/stay-taxi-latency-harness.mjs";

installWorkersHooks("__TAXI_LATENCY_DB__", "__TAXI_LATENCY_ENV__");
h.stubTaxiMaps();
const commercial = await import("../app/api/taxi-commercial/route.ts");
const scheduling = await import("../app/api/uat-scheduling/route.ts");
const taxiRide = await import("../app/api/taxi-ride-bookings/route.ts");
const checkout = await import("../app/api/customer-checkout/route.ts");

const world = () => h.stayWorld({ dbGlobal: "__TAXI_LATENCY_DB__", envGlobal: "__TAXI_LATENCY_ENV__", ownRoster: true, taxiRoster: true, env: h.CHECKOUT_ENV });
const CAPTURE = Boolean(process.env.TAXI_CAPTURE);
const same = (actual, expected, label) => CAPTURE ? console.log(`CAPTURE ${label} ${JSON.stringify(actual)}`) : assert.deepEqual(actual, expected, label);
const customer = { id: h.CUSTOMER, name: "Stay Latency", primaryPhone: "9000099001" };
const [PICKUP, RETURN_DROP, AIRPORT, WHITEFIELD] = [h.TAXI_PLACES.pickup[0], h.TAXI_PLACES.returnDrop[0], h.TAXI_PLACES.airport[0], h.TAXI_PLACES.whitefield[0]];
/** 20 round trips is 5 s at staging's ~250 ms per D1 call when the Worker is not placed beside D1. */
const LATENCY_MS = 40;
// Wall-clock checks get headroom for a busy test machine (CPU time, not D1 round trips); the D1 call
// budgets stay exact, so a regression in round trips still fails.
const CPU_SLACK_MS = 500;

// Captured by running this file with TAXI_CAPTURE=1 against the code before the change, on h.OWN_TAXI_ROSTER.
const EXPECTED = {
  "fare one way": [201,6.03,13,"citroen_ec3","google_routes_uat",[true,536.05,0,0,536.05,268.02,268.03,null],[true,641.2,0,0,641.2,320.6,320.6,null]],
  "fare round trip, 90 min wait": [201,12.62,28,"citroen_ec3","google_routes_uat",[true,766.7,450,0,1216.7,608.35,608.35,null],[true,904.8,600,0,1504.8,752.4,752.4,null]],
  "fare airport": [201,35.35,76,"citroen_ec3","google_routes_uat",[true,2300,0,0,2300,1150,1150,null],[true,2600,0,0,2600,1300,1300,null]],
  "fare 4 pax 3 pets 4 bags": [201,6.03,13,"xuv","google_routes_uat",[false,536.05,0,0,536.05,268.02,268.02,"Citroen eC3 is not eligible for this ride: more_than_3_passengers,more_than_3_luggage_items"],[true,641.2,0,0,641.2,320.6,320.6,null]],
  "fare no passenger (handler)": [201,15.92,35,"citroen_ec3","google_routes_uat",[true,882.2,0,300,1182.2,591.1,591.1,null],[true,1036.8,0,300,1336.8,668.4,668.4,null]],
  "fare same pickup and drop": [400,"Pet Taxi requires distinct complete pickup and drop addresses"],
  "fare pickup in the past": [400,"Pet Taxi requires a future pickup date and time"],
  "fare no drop address": [400,"Pickup address, drop address, pickup date and time are required"],
  "fare round trip without a return drop": [400,"Round trip requires a return drop address"],
  "fare unsupported trip type": [400,"Unsupported Pet Taxi trip type"],
  "fare unplaceable drop": [409,"Pet Taxi pickup and drop-off must resolve to verified map coordinates before quoting"],
  "fare both legs refused": [503,"Pet Taxi route service is temporarily unavailable. Please try again later."],
  "fare return leg refused": [409,"Pet Taxi route could not be calculated from the supplied addresses"],
  "stored round-trip quote": {"origin_label":"100 Feet Road, Indiranagar, Bengaluru 560038","destination_label":"Koramangala 5th Block, Bengaluru 560095","return_drop_label":"MG Road, Ashok Nagar, Bengaluru 560001","origin_latitude":12.9719,"origin_longitude":77.6412,"destination_latitude":12.9352,"destination_longitude":77.6245,"return_drop_latitude":12.9756,"return_drop_longitude":77.6069,"passenger_count":1,"pet_count":1,"luggage_count":0,"trip_type":"round_trip","ride_purpose":"regular","waiting_minutes":90,"distance_km":12.62,"estimated_duration_minutes":28,"reservation_minutes":180,"route_provider":"google_routes_uat","fare_options_json":"{\"citroen_ec3\":{\"vehicleClass\":\"citroen_ec3\",\"vehicleLabel\":\"Citroen eC3\",\"tripType\":\"round_trip\",\"ridePurpose\":\"regular\",\"distanceKm\":12.62,\"passengerCount\":1,\"petCount\":1,\"luggageCount\":0,\"waitingMinutes\":90,\"distanceFare\":766.7,\"waitingCharge\":450,\"handlerCharge\":0,\"quotedTotal\":1216.7,\"bookingFee\":608.35,\"finalBalanceBeforeAdjustments\":608.35,\"bookingFeePercent\":50,\"reservationMinutes\":180,\"recommendation\":{\"recommendedVehicle\":\"citroen_ec3\",\"citroenEligible\":true,\"reasons\":[]},\"eligible\":true,\"features\":[\"AC\",\"Pet-care trained driver\",\"Carefree pet ride\",\"Pet restraint available\",\"GPS trip tracking\",\"Masked calling\"]},\"xuv\":{\"vehicleClass\":\"xuv\",\"vehicleLabel\":\"XUV\",\"tripType\":\"round_trip\",\"ridePurpose\":\"regular\",\"distanceKm\":12.62,\"passengerCount\":1,\"petCount\":1,\"luggageCount\":0,\"waitingMinutes\":90,\"distanceFare\":904.8,\"waitingCharge\":600,\"handlerCharge\":0,\"quotedTotal\":1504.8,\"bookingFee\":752.4,\"finalBalanceBeforeAdjustments\":752.4,\"bookingFeePercent\":50,\"reservationMinutes\":180,\"recommendation\":{\"recommendedVehicle\":\"citroen_ec3\",\"citroenEligible\":true,\"reasons\":[]},\"eligible\":true,\"features\":[\"AC\",\"Pet-care trained driver\",\"Extra cabin & luggage space\",\"Pet restraint available\",\"GPS trip tracking\",\"Masked calling\"]}}","recommended_vehicle_class":"citroen_ec3","payment_mode":"split_50_50","status":"open"},
  "first reserve": ["assigned","taxi_lat_first",false],
  "first booking": [201,"payment_pending",false,268.02,"TXF-CITROEN-9179"],
  "first booking replay": [200,"payment_pending",true,268.02,"TXF-CITROEN-9179"],
  "second reserve": ["assigned","taxi_lat_second",false],
  "second booking": [201,"payment_pending",false,268.02,"TXF-CITROEN-9188"],
  "second booking replay": [200,"payment_pending",true,268.02,"TXF-CITROEN-9188"],
  "third reserve": ["assigned","taxi_lat_fourth",false],
  "third booking": [409,"No Citroen eC3 is free for this 3-hour Taxi window in blr"],
  xuv: [["assigned","taxi_lat_third",false],[201,"payment_pending",false,320.6,"TXF-XUV-OWNER"]],
  "xuv-only ride": [["assigned","taxi_lat_first",false],[201,"payment_pending",false,320.6,"TXF-XUV-OWNER"]],
  "refusal wrong driver": [409,"Canonical Taxi driver assignment changed; refresh availability"],
  "refusal wrong fare": [409,"Pet Taxi fare or 50% booking fee does not match the server quote"],
  "refusal wrong booking fee": [409,"Pet Taxi fare or 50% booking fee does not match the server quote"],
  "refusal another customer": [403,"Customer ownership denied"],
  "refusal unknown channel": [400,"Unsupported Pet Taxi booking channel"],
  "refusal details changed": [409,"Pet Taxi ride details changed after quote"],
  "refusal a group that is already booked": [200,"payment_pending",true,268.02,"TXF-CITROEN-9179"],
  "refusal cross-sell without its stay": [400,"Boarding cross-sell requires the source Boarding booking"],
  "refusal cross-sell with a stay that is not a Boarding one": [409,"Boarding cross-sell source booking is invalid"],
  "refusal assisted without consent": [400,"Assisted Pet Taxi requires customer consent evidence"],
  "after the refusals": [201,"payment_pending",false,268.02,"TXF-CITROEN-9179"],
  "quote already used": [["assigned","taxi_lat_second",false],[409,"A valid open Pet Taxi ride quote is required"]],
  "checkout start": [201,true,"awaiting_payment","order_taxiLatency1",26802,"first_instalment",536.05,268.03],
  "checkout start again": [201,true,"awaiting_payment","order_taxiLatency1",26802,"first_instalment",536.05,268.03],
  "checkout status": [200,"awaiting_confirmation","created",268.02,"first_instalment",536.05],
  "checkout of another customer's booking": [404,"Booking payment was not found for your account."],
  "razorpay orders": 1,
  fleet: ["TXF-CITROEN-9179:confirmed","TXF-CITROEN-9188:confirmed","TXF-XUV-OWNER:confirmed","TXF-XUV-OWNER:confirmed","TXF-CITROEN-9179:confirmed","TXF-CITROEN-9179:confirmed"],
  quotes: ["open:1","used:6"],
  money: ["taxi_lat_first:citroen_ec3:payment_pending:536.05:created:536.05:268.02:split_50_50:268.02:268.03:booking_fee_pending:citroen_ec3:TXF-CITROEN-9179:536.05:268.02:scheduled:payment_pending","taxi_lat_second:citroen_ec3:payment_pending:536.05:created:536.05:268.02:split_50_50:268.02:268.03:booking_fee_pending:citroen_ec3:TXF-CITROEN-9188:536.05:268.02:scheduled:payment_pending","taxi_lat_third:xuv:payment_pending:641.2:created:641.2:320.6:split_50_50:320.6:320.6:booking_fee_pending:xuv:TXF-XUV-OWNER:641.2:320.6:scheduled:payment_pending","taxi_lat_first:xuv:payment_pending:641.2:created:641.2:320.6:split_50_50:320.6:320.6:booking_fee_pending:xuv:TXF-XUV-OWNER:641.2:320.6:scheduled:payment_pending","taxi_lat_first:citroen_ec3:payment_pending:536.05:created:536.05:268.02:split_50_50:268.02:268.03:booking_fee_pending:citroen_ec3:TXF-CITROEN-9179:536.05:268.02:scheduled:payment_pending","taxi_lat_first:citroen_ec3:payment_pending:536.05:created:536.05:268.02:split_50_50:268.02:268.03:booking_fee_pending:citroen_ec3:TXF-CITROEN-9179:536.05:268.02:scheduled:payment_pending"],
  intents: ["26802:CREATED:ORDER_CREATED:order_taxiLatency1:SUCCEEDED:1"],
  links: ["order_taxiLatency1:active"],
};

/** A fare as the customer sees it (ids, expiry and timestamps aside). */
const fare = (r) => r.status !== 201 ? [r.status, reason(r.body)] : [r.status, r.body.data.distanceKm, r.body.data.estimatedDurationMinutes, r.body.data.recommendedVehicleClass, r.body.data.routeSource,
  ...["citroen_ec3", "xuv"].map((v) => { const o = r.body.data.fareOptions[v]; return [o.eligible, o.distanceFare, o.waitingCharge, o.handlerCharge, o.quotedTotal, o.bookingFee, o.finalBalanceBeforeAdjustments, o.ineligibleReason ?? null]; })];
/** A refusal's reason; a JSON body carried as the message is read through, so only the reason is compared. */
const reason = (body) => { const text = body?.error ?? body; try { return JSON.parse(text).error ?? text; } catch { return text; } };
const reserveOutcome = (r) => r.status === 200 ? [r.body.data.status, r.body.data.provider?.id, r.body.data.duplicatePrevented ?? false] : [r.status, reason(r.body)];
// The money of each booking is compared from its rows below, where a replay and a first answer agree.
const bookingOutcome = (r) => r == null ? null : r.status < 300 ? [r.status, r.body.data.status, r.body.data.duplicatePrevented, r.body.data.amountDueNow, r.body.data.reservedVehicle?.vehicle_id ?? r.body.data.reservedVehicle?.id ?? null] : [r.status, reason(r.body)];
const checkoutOutcome = (r) => r.status < 300 ? [r.status, r.body.data.connected, r.body.data.status, r.body.data.orderId ?? null, r.body.data.amountPaise ?? null, r.body.data.stage ?? null, r.body.data.bookingTotal ?? null, r.body.data.outstandingBalance ?? null] : [r.status, reason(r.body)];

const quote = (w, body) => h.timed(w, h.taxiQuoteRequest(w, body), commercial.POST);
/** Price, then reserve the driver (lib/taxi-booking-client.ts reserveTaxiSchedule): the booking body the flow sends next. */
async function reserveRide(w, label, { day = 3, hour = 15, vehicleClass = "citroen_ec3", party = {}, latency = 0, quoted = null } = {}) {
  const q = quoted ?? await quote(w, { scheduledStart: h.ist(day, hour), ...party });
  const tq = q.body.data, group = `taxi:${label}`;
  w.latency.ms = latency;
  const reserve = await h.timed(w, h.schedulingRequest(w, { clientRequestId: group, petIds: [h.PETS.dog], serviceCode: "pet_taxi", occurrences: 1, scheduledStart: tq.scheduledStart, scheduledEnd: tq.scheduledEnd }), scheduling.POST);
  w.latency.ms = 0;
  const driver = reserve.body?.data?.provider, option = tq.fareOptions[vehicleClass];
  const body = { idempotencyKey: group, scheduleGroupId: group, groupId: group, taxiQuoteId: tq.quoteId, vehicleClass, customer, pets: [{ sourceId: h.PETS.dog, name: "Bruno", species: "dog", vaccinationStatus: "verified" }], cityId: "blr", zoneId: "blr-east", scheduledStart: tq.scheduledStart, scheduledEnd: tq.scheduledEnd, provider: driver && { id: driver.id, name: driver.name, model: driver.model }, totalAmount: Number(option.quotedTotal), amountDueNow: Number(option.bookingFee), channel: "customer_app" };
  return { quote: q, reserve, body };
}
/** The whole Reserve press: driver, then the ride booking (lib/taxi-booking-client.ts createCanonicalTaxiRideBooking). */
async function ride(w, label, options = {}) {
  const reserved = await reserveRide(w, label, options);
  w.latency.ms = options.latency ?? 0;
  const booking = reserved.reserve.status === 200 ? await h.timed(w, h.taxiRideBookingRequest(w, reserved.body), taxiRide.POST) : null;
  w.latency.ms = 0;
  return { ...reserved, booking };
}
const pay = (w, bookingId, action = "start") => h.timed(w, h.checkoutRequest(w, { action, bookingId }), checkout.POST);

test("Pet Taxi fares and refusals are exactly as before: one way, round trip with waiting, airport, XUV-only party, handler", async () => {
  const w = await world();
  const day = (d, hour = 15) => ({ scheduledStart: h.ist(d, hour) });
  const cases = {
    "one way": { ...day(3) },
    "round trip, 90 min wait": { ...day(3, 9), tripType: "round_trip", returnDropLabel: RETURN_DROP, waitingMinutes: 90 },
    airport: { ...day(4), destinationLabel: AIRPORT, ridePurpose: "airport" },
    "4 pax 3 pets 4 bags": { ...day(4, 11), passengerCount: 4, petCount: 3, luggageCount: 4 },
    "no passenger (handler)": { ...day(5), passengerCount: 0, destinationLabel: WHITEFIELD },
    "same pickup and drop": { ...day(5), destinationLabel: PICKUP },
    "pickup in the past": { scheduledStart: new Date(Date.now() - 3_600_000).toISOString() },
    "no drop address": { ...day(5), destinationLabel: "" },
    "round trip without a return drop": { ...day(5), tripType: "round_trip", waitingMinutes: 30 },
    "unsupported trip type": { ...day(5), tripType: "one_way_plus" },
  };
  for (const [label, body] of Object.entries(cases)) same(fare(await quote(w, body)), EXPECTED[`fare ${label}`], `fare ${label}`);
  // Google refuses: an address it cannot place, the outbound leg unavailable, the return leg unroutable.
  const [pickup, drop] = [h.TAXI_PLACES.pickup, h.TAXI_PLACES.drop];
  const isLeg = (leg, from, to) => leg.origin.latitude === from[1] && leg.origin.longitude === from[2] && leg.destination.latitude === to[1] && leg.destination.longitude === to[2];
  try {
    h.taxiMaps.geocode = (address) => address === WHITEFIELD ? { status: "ZERO_RESULTS" } : {};
    same(fare(await quote(w, { ...day(5), destinationLabel: WHITEFIELD })), EXPECTED["fare unplaceable drop"], "fare unplaceable drop");
    h.taxiMaps.geocode = () => ({});
    // The outbound leg answers last, so a leg that answers first cannot decide which refusal the customer reads.
    h.taxiMaps.route = (leg) => isLeg(leg, pickup, drop) ? { status: 503, delayMs: 30 } : { status: 400 };
    same(fare(await quote(w, { ...day(5), tripType: "round_trip", returnDropLabel: RETURN_DROP, waitingMinutes: 30 })), EXPECTED["fare both legs refused"], "fare both legs refused");
    h.taxiMaps.route = (leg) => isLeg(leg, pickup, drop) ? {} : { status: 400 };
    same(fare(await quote(w, { ...day(5), tripType: "round_trip", returnDropLabel: RETURN_DROP, waitingMinutes: 30 })), EXPECTED["fare return leg refused"], "fare return leg refused");
  } finally { h.taxiMaps.geocode = () => ({}); h.taxiMaps.route = () => ({}); }
  // What the fare froze for the booking to govern.
  const stored = w.sqlite.prepare("SELECT origin_label,destination_label,return_drop_label,origin_latitude,origin_longitude,destination_latitude,destination_longitude,return_drop_latitude,return_drop_longitude,passenger_count,pet_count,luggage_count,trip_type,ride_purpose,waiting_minutes,distance_km,estimated_duration_minutes,reservation_minutes,route_provider,fare_options_json,recommended_vehicle_class,payment_mode,status FROM taxi_ride_quotes WHERE trip_type='round_trip' ORDER BY created_at LIMIT 1").get();
  same({ ...stored }, EXPECTED["stored round-trip quote"], "stored round-trip quote");
});

test("Pet Taxi: drivers, fleet holds, replays, refusals, the class that runs out and the checkout order are exactly as before", async () => {
  const w = await world();
  const outcomes = {};
  for (const label of ["first", "second", "third"]) {
    const { reserve, booking, body } = await ride(w, label);
    outcomes[`${label} reserve`] = reserveOutcome(reserve);
    outcomes[`${label} booking`] = bookingOutcome(booking);
    if (booking?.status < 300) outcomes[`${label} booking replay`] = bookingOutcome(await h.timed(w, h.taxiRideBookingRequest(w, body), taxiRide.POST));
  }
  const xuv = await ride(w, "xuv", { vehicleClass: "xuv" });
  outcomes.xuv = [reserveOutcome(xuv.reserve), bookingOutcome(xuv.booking)];
  const xuvOnly = await ride(w, "xuv-only", { day: 4, party: { passengerCount: 4, petCount: 1, luggageCount: 0 }, vehicleClass: "xuv" });
  outcomes["xuv-only ride"] = [reserveOutcome(xuvOnly.reserve), bookingOutcome(xuvOnly.booking)];
  // Refusals before any write, in the order the route gives them; none of them may use up the quote or the car.
  const reserved = await reserveRide(w, "refusals", { day: 5 });
  const base = reserved.body;
  const refusals = {
    "wrong driver": { ...base, idempotencyKey: "taxi:refusal-1", provider: { ...base.provider, id: "taxi_lat_second" } },
    "wrong fare": { ...base, idempotencyKey: "taxi:refusal-2", totalAmount: base.totalAmount + 1 },
    "wrong booking fee": { ...base, idempotencyKey: "taxi:refusal-3", amountDueNow: base.amountDueNow - 1 },
    "another customer": { ...base, idempotencyKey: "taxi:refusal-4", customer: { ...customer, id: "CUST-SOMEONE-ELSE" } },
    "unknown channel": { ...base, idempotencyKey: "taxi:refusal-5", channel: "partner_portal" },
    "details changed": { ...base, idempotencyKey: "taxi:refusal-6", pets: [...base.pets, { sourceId: h.PETS.cat, name: "Misty", species: "cat" }] },
    "a group that is already booked": { ...base, idempotencyKey: "taxi:refusal-7", scheduleGroupId: "taxi:first", groupId: "taxi:first" },
    "cross-sell without its stay": { ...base, idempotencyKey: "taxi:refusal-8", channel: "boarding_cross_sell" },
    "cross-sell with a stay that is not a Boarding one": { ...base, idempotencyKey: "taxi:refusal-9", channel: "boarding_cross_sell", sourceBookingId: "PS-UAT-TAXI-NOT-A-STAY" },
    "assisted without consent": { ...base, idempotencyKey: "taxi:refusal-10", channel: "assisted_staff" },
  };
  for (const [label, body] of Object.entries(refusals)) outcomes[`refusal ${label}`] = bookingOutcome(await h.timed(w, h.taxiRideBookingRequest(w, body), taxiRide.POST));
  outcomes["after the refusals"] = bookingOutcome(await h.timed(w, h.taxiRideBookingRequest(w, base), taxiRide.POST));
  // The same quote on a second driver reservation: the quote was used by the booking above.
  const second = await reserveRide(w, "refusals-again", { quoted: reserved.quote });
  outcomes["quote already used"] = [reserveOutcome(second.reserve), bookingOutcome(await h.timed(w, h.taxiRideBookingRequest(w, second.body), taxiRide.POST))];
  // Checkout: the 50% booking fee opens one Razorpay order however often the customer presses Pay.
  const firstBooking = (await ride(w, "pay", { day: 6 })).booking.body.data.bookingId;
  outcomes["checkout start"] = checkoutOutcome(await pay(w, firstBooking));
  outcomes["checkout start again"] = checkoutOutcome(await pay(w, firstBooking));
  const status = await pay(w, firstBooking, "status");
  outcomes["checkout status"] = [status.status, status.body.data.status, status.body.data.confirmation.paymentStatus, status.body.data.confirmation.amountDueNow, status.body.data.confirmation.paymentStage, status.body.data.confirmation.totalAmount];
  outcomes["checkout of another customer's booking"] = checkoutOutcome(await pay(w, "PS-UAT-TAXI-NOT-MINE"));
  outcomes["razorpay orders"] = h.taxiMaps.calls.orders;
  for (const [label, value] of Object.entries(outcomes)) same(value, EXPECTED[label], label);
  const rows = (sql) => w.sqlite.prepare(sql).all().map((row) => Object.values(row).join(":"));
  same(rows("SELECT vehicle_id,status FROM taxi_fleet_reservations ORDER BY scheduled_start,vehicle_id,status"), EXPECTED.fleet, "fleet reservations");
  same(rows("SELECT status,COUNT(*) FROM taxi_ride_quotes GROUP BY status ORDER BY status"), EXPECTED.quotes, "quote states");
  same(rows("SELECT b.provider_id,b.package_code,b.status booking_status,b.total_amount,p.status payment_status,p.amount,p.amount_due_now,p.mode,s.booking_fee_amount,s.balance_amount,s.status schedule_status,d.vehicle_class,d.reserved_vehicle_id,d.initial_total,d.booking_fee_amount detail_fee,t.status trip_status,w.status work_order_status FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id JOIN taxi_payment_schedules s ON s.booking_id=b.id JOIN taxi_ride_booking_details d ON d.booking_id=b.id JOIN taxi_trips t ON t.booking_id=b.id JOIN provider_work_orders w ON w.booking_id=b.id WHERE b.service_code='pet_taxi' ORDER BY b.scheduled_start,b.created_at"), EXPECTED.money, "bookings, payments, fee schedules, ride details, trips and work orders");
  same(rows("SELECT i.amount_paise,i.state,i.order_request_state,i.gateway_order_id,o.status,o.attempts FROM payment_intents i JOIN financial_outbox o ON o.aggregate_id=i.id ORDER BY i.created_at"), EXPECTED.intents, "payment intents and their outbox");
  same(rows("SELECT gateway_order_id,status FROM payment_gateway_links ORDER BY created_at"), EXPECTED.links, "gateway links");
});

const SCHEMA_WORK = (call) => /^\s*(CREATE|ALTER|PRAGMA)\b/i.test(call.sql) || /^BATCH (CREATE|INSERT OR IGNORE INTO taxi_fleet_vehicles)/.test(call.sql);
const listing = (result) => result.calls.map((call) => `${call.sequential ? "S" : " "} ${call.sql.slice(0, 110)}`).join("\n");
/**
 * [label, result, D1 calls, round trips]. A round trip is a call that started with nothing else in flight, so a wave
 * of reads started together is one. The wall clock at LATENCY_MS per call is held to the same number of round trips.
 */
function withinBudget([label, result, calls, trips]) {
  assert.ok(result.calls.length <= calls, `${label}: ${result.calls.length} D1 calls (limit ${calls})\n${listing(result)}`);
  assert.ok(result.sequential <= trips, `${label}: ${result.sequential} D1 round trips (limit ${trips})\n${listing(result)}`);
  assert.ok(result.elapsedMs < trips * LATENCY_MS + CPU_SLACK_MS, `${label} took ${Math.round(result.elapsedMs)} ms at ${LATENCY_MS} ms per D1 call (limit ${trips} round trips)`);
  assert.deepEqual(result.calls.filter(SCHEMA_WORK).map((call) => call.sql.slice(0, 80)), [], `${label}: no schema work once the isolate is warm`);
  assert.equal(result.calls.filter((call) => call.sql.startsWith("SELECT s.*,b.status binding_status")).length, 1, `${label}: one session lookup, gateway and route together`);
}
/** Two warm-up rides (a cold isolate, then its first warm request), then the steady state: the ride that is measured. */
async function warmRide(w, { pay: paying = false } = {}) {
  let last;
  for (const [index, day] of [3, 4, 5].entries()) {
    const latency = index === 2 ? LATENCY_MS : 0;
    w.latency.ms = latency;
    const fare = await quote(w, { scheduledStart: h.ist(day, 15) });
    last = { ...(await ride(w, `budget-${day}`, { quoted: fare, latency })), fare };
    w.latency.ms = latency;
    if (paying) last = { ...last, start: await pay(w, last.booking.body.data.bookingId), again: await pay(w, last.booking.body.data.bookingId) };
    w.latency.ms = 0;
  }
  assert.deepEqual([last.fare.status, last.reserve.status, last.booking.status], [201, 200, 201], JSON.stringify(last.booking.body));
  return last;
}

// Before: 16 D1 calls in 16 round trips (4 s at 250 ms per call). The two Google lookups run together, then Routes.
test("a warm Pet Taxi fare makes three D1 calls: the session, the service switch and the quote itself", async () => {
  withinBudget(["fare", (await warmRide(await world())).fare, 3, 3]);
});

// Before: the ride booking made 66 D1 calls in 65 round trips (16 s at 250 ms), so the Reserve press took 26-36 s.
test("a warm Reserve press - driver reservation and ride booking - answers inside 20 D1 round trips (5 s at 250 ms per call)", async () => {
  const last = await warmRide(await world());
  withinBudget(["ride booking", last.booking, 16, 8]);
  const press = last.reserve.elapsedMs + last.booking.elapsedMs, trips = last.reserve.sequential + last.booking.sequential;
  assert.ok(trips <= 20, `the Reserve press made ${trips} D1 round trips: reserve ${last.reserve.sequential} + booking ${last.booking.sequential}`);
  assert.ok(press < 20 * LATENCY_MS + CPU_SLACK_MS, `the Reserve press took ${Math.round(press)} ms at ${LATENCY_MS} ms per D1 call (limit 20 round trips)`);
});

// Before: a first Pay press made 23 D1 calls in 21 round trips (5.3 s at 250 ms, before Razorpay), a repeated one 14 in 14.
test("a warm checkout reads the booking and the amount due once, and a repeated Pay press reuses the order", async () => {
  const last = await warmRide(await world(), { pay: true });
  assert.deepEqual([last.start.status, last.again.status, last.again.body.data.orderId], [201, 201, last.start.body.data.orderId]);
  for (const budget of [["checkout", last.start, 21, 17], ["checkout again", last.again, 12, 10]]) withinBudget(budget);
});

test("the Pet Taxi ride and fleet tables are set up once per isolate; the first fare and booking still create everything", async () => {
  const w = await world();
  const first = await ride(w, "setup-first");
  assert.deepEqual([first.quote.status, first.reserve.status, first.booking.status], [201, 200, 201]);
  assert.ok(first.quote.calls.some((call) => /^BATCH CREATE TABLE IF NOT EXISTS taxi_ride_quotes/.test(call.sql)), "the first fare sets the ride tables up");
  const second = await ride(w, "setup-second", { day: 4 });
  assert.deepEqual([second.quote.status, second.reserve.status, second.booking.status], [201, 200, 201]);
  for (const [label, result] of [["fare", second.quote], ["ride booking", second.booking]])
    assert.deepEqual(result.calls.filter(SCHEMA_WORK).map((call) => call.sql.slice(0, 80)), [], `${label}: the tables were already set up on this isolate`);
});

/** Resolves "timeout" if `promise` has not settled within `ms`: a hang, as the Workers runtime would see it. */
const within = (promise, ms = 500) => Promise.race([promise.then(() => "settled", (error) => `failed: ${error.message}`), new Promise((resolve) => setTimeout(() => resolve("timeout"), ms))]);
for (const [label, load, table] of [
  ["the Pet Taxi ride tables", async () => (await import("../lib/taxi-ride-governance.ts")).ensureTaxiRideTables, "taxi_ride_quotes"],
  ["the Pet Taxi fleet tables", async () => (await import("../lib/taxi-fleet-governance.ts")).ensureTaxiFleetTables, "taxi_fleet_reservations"],
  ["the checkout's payment reconciliation tables", async () => (await import("../lib/grooming-payment-reconciliation.ts")).ensurePaymentReconciliationTables, "payment_gateway_links"],
]) {
  test(`${label}: a set-up cut off mid-way (a cancelled request) never leaves the next request waiting, and a finished one is remembered`, async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { d1 } = await import("./helpers/execution-harness.mjs");
    const ensure = await load(), sqlite = new DatabaseSync(":memory:"), inner = d1(sqlite);
    let cut = true, calls = 0;
    // The first request's set-up never hears back from D1 (its I/O was cancelled with the request); later calls do.
    const db = { prepare: (sql) => { calls++; return inner.prepare(sql); }, batch: (list) => { calls++; if (cut) { cut = false; return new Promise(() => {}); } return inner.batch(list); }, exec: (sql) => inner.exec(sql) };
    void ensure(db);
    assert.equal(await within(ensure(db)), "settled", "the next request runs the idempotent set-up itself instead of waiting on the cancelled one");
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), "and the tables exist");
    const before = calls;
    await ensure(db);
    assert.equal(calls, before, "once a set-up has finished, the isolate does not run it again");
    sqlite.close();
  });
}

test("a round trip's two Google Routes legs are asked at once, and the fare is the same", async () => {
  const w = await world();
  h.taxiMaps.maxRoutesInFlight = 0;
  h.taxiMaps.route = () => ({ delayMs: 20 });
  let result;
  try { result = await quote(w, { scheduledStart: h.ist(3, 9), tripType: "round_trip", returnDropLabel: RETURN_DROP, waitingMinutes: 90 }); } finally { h.taxiMaps.route = () => ({}); }
  assert.equal(h.taxiMaps.maxRoutesInFlight, 2, "the return leg is not waiting for the outbound leg");
  assert.deepEqual(fare(result), EXPECTED["fare round trip, 90 min wait"]);
});
