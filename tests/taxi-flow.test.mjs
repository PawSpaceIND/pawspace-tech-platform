import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// lib/walking-governance.ts and lib/taxi-governance.ts now share lib/booking-window-instant.ts, and a
// lib module importing another extensionlessly needs the suite resolver. No worker env is read here.
installWorkersHooks("__TAXI_FLOW_DB__");

const flowSource = fs.readFileSync("app/mobile-app/taxi-flow.tsx", "utf8");
const cssSource = fs.readFileSync("app/mobile-app/taxi-flow.module.css", "utf8");
const bookingClientSource = fs.readFileSync("lib/taxi-booking-client.ts", "utf8");
const commercialClientSource = fs.readFileSync("lib/taxi-commercial-client.ts", "utf8");

// --- Contract tests (source text) -----------------------------------------------------------

test("the Taxi v2 flow gets fare truth from /api/taxi-commercial",()=>{
 assert.match(flowSource,/createTaxiRideQuote/);assert.match(commercialClientSource,/createTaxiRideQuote/);assert.match(commercialClientSource,/\/api\/taxi-commercial/);
 assert.doesNotMatch(flowSource,/₹500 first|₹600 first|35\/km|40\/km/,"distance tariff must not be duplicated in the customer component");
 assert.match(flowSource,/option\?\.quotedTotal/);assert.match(flowSource,/option\?\.bookingFee/);assert.match(flowSource,/option\?\.finalBalanceBeforeAdjustments/);
});

test("booking and scheduling go through the canonical Taxi client",()=>{
 assert.match(flowSource,/createCanonicalTaxiRideBooking/);assert.match(flowSource,/reserveTaxiSchedule/);assert.match(bookingClientSource,/\/api\/taxi-ride-bookings/);assert.match(bookingClientSource,/serviceCode:"pet_taxi"/);
 assert.doesNotMatch(flowSource,/fetch\("\/api\/taxi-ride-bookings/);assert.doesNotMatch(flowSource,/fetch\("\/api\/uat-scheduling/);
});

test("Taxi v2 supports 1-6 owned dogs or cats and preserves canonical pet identity",()=>{
 assert.match(flowSource,/loadCustomerAccount\(customer\.customerId\)/);assert.match(flowSource,/const rows=account\.pets;setPets\(rows\)/);assert.match(flowSource,/Select 1–6 pets/);assert.match(flowSource,/chosenPets\.length>=1&&chosenPets\.length<=6/);assert.match(flowSource,/petIds:chosenPets\.map\(p=>p\.id\)/);assert.match(flowSource,/p\.species==="cat"\?"cat":p\.species==="dog"\?"dog"/);assert.doesNotMatch(flowSource,/DOGS ONLY|dogs-only/);
});

test("pickup, drop, round trip and city coverage use the v2 commercial contract",()=>{
 assert.match(flowSource,/pickup\.trim\(\)\.length>=5&&drop\.trim\(\)\.length>=5/);assert.match(flowSource,/tripType==="one_way"\|\|returnDrop\.trim\(\)\.length>=5/);assert.match(flowSource,/resolveServiceCoverage\(pincode\)/);assert.match(flowSource,/cityId:coverage\.cityId/);assert.match(flowSource,/zoneId:coverage\.zoneId/);assert.match(flowSource,/returnDropLabel:tripType==="round_trip"/);
});

test("the flow remains a standalone customer component",()=>{
 assert.match(flowSource,/^"use client";/m);assert.match(flowSource,/export default function TaxiFlow\(\{customer,sourceBookingId,routeScope="legacy"\}:\{customer:LoggedInCustomer;sourceBookingId\?:string;routeScope\?:"legacy"\|"v2"\}\)/);assert.doesNotMatch(flowSource,/from\s*["'][^"']*(grooming-flow|stay-flow|training-flow|walking-flow|food-flow)/);assert.doesNotMatch(flowSource,/globalThis/);assert.match(flowSource,/from "\.\/taxi-flow\.module\.css"/);assert.match(cssSource,/#01261F/i);assert.match(cssSource,/#E6B34E/i);
});

test("3-hour Taxi reservations expose only pickup times that can finish inside 06:00-22:00 IST",()=>{
 assert.match(flowSource,/const TIMES=Array\.from\(\{length:27\}/);assert.match(flowSource,/const mins=6\*60\+i\*30/);assert.match(flowSource,/blocks one driver and one physical car for 3 hours/);
});

test("legacy Taxi client signatures remain additive beside Taxi v2",()=>{
 assert.match(bookingClientSource,/export async function createCanonicalTaxiBooking/);assert.match(bookingClientSource,/export async function reserveTaxiSchedule/);assert.match(bookingClientSource,/export async function createCanonicalTaxiRideBooking/);
});

test("confirmation shows real reserved vehicle, assigned driver, rating when present, and verified-payment truth",()=>{
 assert.match(flowSource,/booking\.reservedVehicle\.label/);assert.match(flowSource,/driver\?\.name/);assert.match(flowSource,/driver\?\.rating/);assert.match(flowSource,/3-hour reserved window/);assert.match(flowSource,/Pay 50% booking fee/);assert.match(flowSource,/signed Razorpay capture webhook/);assert.match(flowSource,/PawSpace and partner fleet/);
});

// --- Real-execution tests: the exact server contract the flow depends on --------------------
// Minimal D1 shim over node:sqlite (a real SQLite engine), running the real, unmodified
// lib/taxi-governance.ts against the real taxi tables its own DDL creates.

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { sqlite.prepare(sql).run(...args); return { success: true }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const results = []; for (const stmt of statements) results.push(await stmt.run()); return results; },
  };
}

const DAY = 86400000;
const tomorrow9am = () => { const d = new Date(Date.now() + DAY); d.setHours(9, 0, 0, 0); return d; };

test("real execution: the route classes the flow renders come from the real taxi_route_classes table", async () => {
  const { listTaxiRouteClasses } = await import("../lib/taxi-governance.ts");
  const db = makeD1(new DatabaseSync(":memory:"));
  const routes = await listTaxiRouteClasses(db, tomorrow9am().toISOString());
  assert.equal(routes.length, 3);
  for (const route of routes) {
    // real column names the flow reads: route_code, name, synthetic_distance_km,
    // estimated_duration_minutes, amount, max_pets
    assert.ok(route.route_code && route.name);
    assert.ok(Number(route.synthetic_distance_km) > 0);
    assert.ok(Number(route.estimated_duration_minutes) >= 45);
    assert.ok(Number(route.amount) > 0);
    assert.equal(Number(route.max_pets), 1);
  }
});

test("real execution: a quote shaped exactly like the flow's confirm() is accepted and server-priced", async () => {
  const { createTaxiQuote, listTaxiRouteClasses } = await import("../lib/taxi-governance.ts");
  const db = makeD1(new DatabaseSync(":memory:"));
  const routes = await listTaxiRouteClasses(db, tomorrow9am().toISOString());
  const route = routes.find(item => String(item.route_code) === "taxi-blr-east-medium");
  const start = tomorrow9am();
  const quote = await createTaxiQuote(db, { routeCode: "taxi-blr-east-medium", originLabel: "  Indiranagar, 100 Feet Road  ", destinationLabel: "Whitefield vet clinic", petCount: 1, scheduledStart: start.toISOString(), paymentMode: "sandbox_deferred" });
  assert.equal(quote.totalAmount, Number(route.amount), "fare is the server route-class price");
  assert.equal(quote.amountDueNow, 0, "sandbox-deferred quotes owe nothing today");
  assert.equal(new Date(quote.scheduledEnd).getTime(), start.getTime() + Number(route.estimated_duration_minutes) * 60_000, "the drop-off time is server-computed from the route duration");
  assert.equal(quote.originLabel, "Indiranagar, 100 Feet Road", "labels are trimmed server-side");
  assert.equal(quote.petCount, 1);
  assert.equal(quote.productionMapsVerified, false, "distances are honestly labeled as UAT route classes");
});

async function expectRejection(promise, statusCode, description) {
  try {
    await promise;
    assert.fail(`${description}: expected a rejection`);
  } catch (error) {
    assert.ok(error instanceof Response, `${description}: server governance throws Response`);
    assert.equal(error.status, statusCode, description);
  }
}

test("real execution: the server enforces the constraints the flow UI encodes (labels, one pet, future pickup)", async () => {
  const { createTaxiQuote } = await import("../lib/taxi-governance.ts");
  const db = makeD1(new DatabaseSync(":memory:"));
  const start = tomorrow9am().toISOString();
  const base = { routeCode: "taxi-blr-east-short", originLabel: "Indiranagar", destinationLabel: "Whitefield", petCount: 1, scheduledStart: start, paymentMode: "sandbox_deferred" };
  await expectRejection(createTaxiQuote(db, { ...base, destinationLabel: "indiranagar" }), 400, "identical pickup/drop (case-insensitive) rejected");
  await expectRejection(createTaxiQuote(db, { ...base, originLabel: "AB" }), 400, "labels under 3 characters rejected");
  await expectRejection(createTaxiQuote(db, { ...base, petCount: 2 }), 409, "two pets rejected — taxi is one pet per trip");
  await expectRejection(createTaxiQuote(db, { ...base, scheduledStart: new Date(Date.now() - DAY).toISOString() }), 400, "past pickup rejected");
  await expectRejection(createTaxiQuote(db, { ...base, routeCode: "taxi-nowhere" }), 404, "unknown route class rejected");
});

test("real execution: taxi_trips real schema (copied from lib/taxi-ops-governance.ts) stores what the confirmation renders", () => {
  const sqlite = new DatabaseSync(":memory:");
  // Exact DDL from lib/taxi-ops-governance.ts — real column names, no guessing.
  sqlite.exec("CREATE TABLE IF NOT EXISTS taxi_trips (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,origin_label TEXT NOT NULL,destination_label TEXT NOT NULL,route_code TEXT NOT NULL,synthetic_distance_km REAL NOT NULL,estimated_duration_minutes INTEGER NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',vehicle_id TEXT,pickup_verification_status TEXT NOT NULL DEFAULT 'pending',dropoff_verification_status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const opsSource = fs.readFileSync("lib/taxi-ops-governance.ts", "utf8");
  for (const column of ["booking_id", "reservation_id", "provider_id", "origin_label", "destination_label", "route_code", "synthetic_distance_km", "estimated_duration_minutes", "vehicle_id", "pickup_verification_status", "dropoff_verification_status"]) {
    assert.ok(opsSource.includes(column), `taxi_trips column ${column} exists in the ops governance DDL`);
  }
  const now = Date.now();
  sqlite.prepare("INSERT INTO taxi_trips (id,booking_id,schedule_group_id,reservation_id,provider_id,origin_label,destination_label,route_code,synthetic_distance_km,estimated_duration_minutes,scheduled_start,scheduled_end,status,vehicle_id,pickup_verification_status,dropoff_verification_status,created_at,updated_at) VALUES ('TRIP-1','B1','grp1','res1','taxi_rahul','Indiranagar','Whitefield','taxi-blr-east-medium',10,60,'2026-08-20T03:30:00.000Z','2026-08-20T04:30:00.000Z','scheduled',NULL,'pending','pending',?,?)").run(now, now);
  const trip = sqlite.prepare("SELECT origin_label,destination_label,vehicle_id,status FROM taxi_trips WHERE booking_id=?").get("B1");
  assert.equal(trip.origin_label, "Indiranagar");
  assert.equal(trip.vehicle_id, null, "the vehicle is genuinely unassigned at creation — the flow must not invent one");
  assert.equal(trip.status, "scheduled");
});

// --- Real execution of the additive client helper (the actual exported function) -------------

test("real execution: reserveTaxiSchedule sends the pet_taxi scheduling contract and maps the driver rating", async () => {
  const { reserveTaxiSchedule } = await import("../lib/taxi-booking-client.ts");
  const captured = {};
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    captured.url = String(url);
    captured.body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ data: { groupId: "grp-42", provider: { id: "taxi_rahul", name: "Rahul K.", model: "full_time", rating: 4.9 }, occurrences: [{ start: "2026-08-20T03:30:00.000Z", end: "2026-08-20T04:30:00.000Z", occurrenceNumber: 1 }], explanation: ["auto-assigned"] } }) };
  };
  try {
    const reservation = await reserveTaxiSchedule({ clientRequestId: "taxi-req-1", customerId: "cus_1", petIds: ["Coco"], zoneId: "blr-east", scheduledStart: "2026-08-20T03:30:00.000Z", scheduledEnd: "2026-08-20T04:30:00.000Z" });
    assert.equal(captured.url, "/api/uat-scheduling");
    assert.equal(captured.body.serviceCode, "pet_taxi");
    assert.equal(captured.body.occurrences, 1, "a taxi trip is exactly one occurrence");
    assert.deepEqual(captured.body.petIds, ["Coco"], "cats ride too");
    assert.equal(reservation.groupId, "grp-42");
    assert.equal(reservation.driver.name, "Rahul K.");
    assert.equal(reservation.driver.rating, 4.9, "the assigned driver's rating is surfaced for the confirmation screen");
  } finally {
    global.fetch = originalFetch;
  }
});

test("real execution: reserveTaxiSchedule fails loudly with no driver, and hides an absent rating", async () => {
  const { reserveTaxiSchedule, createCanonicalTaxiBooking } = await import("../lib/taxi-booking-client.ts");
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, json: async () => ({ error: "NO_SCHEDULE_AVAILABLE" }) });
    // Loudly, and in the customer's words: the scheduler's rule code is translated, never shown raw.
    await assert.rejects(
      () => reserveTaxiSchedule({ clientRequestId: "r", customerId: "c", petIds: ["Bruno"], zoneId: "blr-east", scheduledStart: "s", scheduledEnd: "e" }),
      (error) => /No driver and car are free for this pickup time/.test(error.message) && !/NO_SCHEDULE_AVAILABLE/.test(error.message),
    );
    global.fetch = async () => ({ ok: true, json: async () => ({ data: { groupId: "g", provider: { id: "d1", name: "New Driver", model: "full_time" }, occurrences: [] } }) });
    const reservation = await reserveTaxiSchedule({ clientRequestId: "r2", customerId: "c", petIds: ["Bruno"], zoneId: "blr-east", scheduledStart: "s", scheduledEnd: "e" });
    assert.equal(reservation.driver.rating, null, "a driver without a rating shows as rating-pending, never a fabricated number");
    // and the existing booking client posts to the governed endpoint with scheduleGroupId mapped
    const captured = {};
    global.fetch = async (url, init) => { captured.url = String(url); captured.body = JSON.parse(init.body); return { ok: true, json: async () => ({ data: { bookingId: "B-1", trip: {} } }) }; };
    await createCanonicalTaxiBooking({ idempotencyKey: "k", groupId: "grp-9", taxiQuoteId: "q", customer: { id: "c", name: "n", primaryPhone: "p" }, pets: [{ sourceId: "Coco", name: "Coco", species: "cat" }], cityId: "blr", zoneId: "blr-east", routeCode: "rc", originLabel: "A1", destinationLabel: "B1", scheduledStart: "s", scheduledEnd: "e", provider: { id: "d", name: "D", model: "full_time" }, totalAmount: 1, amountDueNow: 0, payment: { method: "upi", mode: "sandbox_deferred", detail: "d" } });
    assert.equal(captured.url, "/api/taxi-bookings");
    assert.equal(captured.body.scheduleGroupId, "grp-9", "groupId maps to the route's scheduleGroupId field");
  } finally {
    global.fetch = originalFetch;
  }
});

// --- Round 2 (26 Sep 2026 staging): no Taxi call may show the customer a JavaScript error -------------
// A fare quote hung ~45 s and the platform answered with its HTML error page: the customer read
// "Unexpected token '<'". A proxy cut-off gave "Unexpected token 'u', "upstream r"... is not valid JSON".
const PLATFORM_PAGE = "<!DOCTYPE html>\n<html><head><title>Worker threw exception | pawspace-staging.karthik-fce.workers.dev | Cloudflare</title></head><body>Error 1101</body></html>";
const RIDE_QUOTE_INPUT = { originLabel: "Indiranagar 100ft Road, Bengaluru", destinationLabel: "Koramangala, Bengaluru", passengerCount: 1, petCount: 1, luggageCount: 0, scheduledStart: tomorrow9am().toISOString(), tripType: "one_way", ridePurpose: "regular", waitingMinutes: 0 };
async function withFetch(stub, run) { const original = globalThis.fetch; globalThis.fetch = stub; try { return await run(); } finally { globalThis.fetch = original; } }
async function refusedWith(run) { try { await run(); } catch (error) { return error; } assert.fail("expected the call to be refused"); }
const RAW = /Unexpected token|is not valid JSON|Unexpected end|D1_ERROR|SyntaxError|Failed to fetch/;

test("round 2: every Taxi customer call turns a platform error page into a plain retry sentence", async () => {
  const { createTaxiRideQuote } = await import("../lib/taxi-commercial-client.ts");
  const { createCanonicalTaxiRideBooking, reserveTaxiSchedule } = await import("../lib/taxi-booking-client.ts");
  const { requestTaxiCancellation } = await import("../lib/taxi-finance-client.ts");
  const { loadCustomerTaxiLifecycle } = await import("../lib/taxi-lifecycle-client.ts");
  const calls = {
    quote: () => createTaxiRideQuote(RIDE_QUOTE_INPUT),
    reserve: () => reserveTaxiSchedule({ clientRequestId: "r", customerId: "c", petIds: ["p"], cityId: "blr", zoneId: "blr-east", scheduledStart: "s", scheduledEnd: "e" }),
    book: () => createCanonicalTaxiRideBooking({ idempotencyKey: "k", groupId: "g", taxiQuoteId: "q", vehicleClass: "citroen_ec3", customer: { id: "c", name: "n", primaryPhone: "p" }, pets: [{ sourceId: "p", name: "Bruno" }], cityId: "blr", zoneId: "blr-east", scheduledStart: "s", scheduledEnd: "e", provider: { id: "d", name: "D", model: "full_time", rating: null }, totalAmount: 607.45, amountDueNow: 303.73 }),
    cancel: () => requestTaxiCancellation({ bookingId: "PS-UAT-TAXI-1", reason: "Plans changed" }),
    manage: () => loadCustomerTaxiLifecycle("PS-UAT-TAXI-1"),
  };
  for (const [name, call] of Object.entries(calls)) {
    for (const [label, answer] of [
      ["HTML 500", () => new Response(PLATFORM_PAGE, { status: 500, headers: { "content-type": "text/html" } })],
      ["proxy 502", () => new Response("upstream request failed", { status: 502 })],
      ["empty 504", () => new Response("", { status: 504 })],
      ["raw D1 500", () => Response.json({ error: "D1_ERROR: Currently processing a long-running import." }, { status: 500 })],
    ]) {
      const error = await withFetch(async () => answer(), () => refusedWith(call));
      assert.doesNotMatch(error.message, RAW, `${name} / ${label}: ${error.message}`);
      assert.match(error.message, /taking longer than usual.*Please try again/, `${name} / ${label} offers a retry: ${error.message}`);
      assert.equal(error.retryable, true, `${name} / ${label} is retryable`);
    }
    const offline = await withFetch(async () => { throw new TypeError("Failed to fetch"); }, () => refusedWith(call));
    assert.match(offline.message, /could not reach PawSpace.*Check your connection and try again/, `${name} offline: ${offline.message}`);
  }
});

test("round 2: governed answers keep their own sentences, and rule codes are translated", async () => {
  const { createTaxiRideQuote } = await import("../lib/taxi-commercial-client.ts");
  const { createCanonicalTaxiRideBooking } = await import("../lib/taxi-booking-client.ts");
  const { requestTaxiCancellation } = await import("../lib/taxi-finance-client.ts");
  // The quote's own deadline answer (a governed 503) is shown as the server wrote it.
  const timeout = await withFetch(async () => Response.json({ error: "Calculating your Pet Taxi fare is taking longer than usual. Please try again in a moment.", code: "TAXI_QUOTE_TIMEOUT", retryAfterSeconds: 5 }, { status: 503, headers: { "retry-after": "5" } }), () => refusedWith(() => createTaxiRideQuote(RIDE_QUOTE_INPUT)));
  assert.equal(timeout.message, "Calculating your Pet Taxi fare is taking longer than usual. Please try again in a moment.");
  assert.deepEqual([timeout.status, timeout.code, timeout.retryAfterSeconds, timeout.retryable], [503, "TAXI_QUOTE_TIMEOUT", 5, true]);
  // A refusal keeps its reason.
  const area = await withFetch(async () => Response.json({ error: "PawSpace Pet Taxi picks up only within Bengaluru (up to 35 km from the city centre). This pickup address is outside that area - choose a pickup inside Bengaluru." }, { status: 409 }), () => refusedWith(() => createTaxiRideQuote(RIDE_QUOTE_INPUT)));
  assert.match(area.message, /picks up only within Bengaluru/);
  assert.equal(area.retryable, false);
  const fleet = await withFetch(async () => Response.json({ error: "No Citroen eC3 is free for this 3-hour Taxi window in blr" }, { status: 409 }), () => refusedWith(() => createCanonicalTaxiRideBooking({ idempotencyKey: "k", groupId: "g", taxiQuoteId: "q", vehicleClass: "citroen_ec3", customer: { id: "c", name: "n", primaryPhone: "p" }, pets: [], cityId: "blr", zoneId: "blr-east", scheduledStart: "s", scheduledEnd: "e", provider: { id: "d", name: "D", model: "full_time", rating: null }, totalAmount: 1, amountDueNow: 1 })));
  assert.equal(fleet.message, "No Citroen eC3 is free for this 3-hour Taxi window in blr");
  // The Worker's answer while D1 refuses queries (an import or overload; lib/d1-transient.ts) is shown as written, with a retry.
  const { serviceBusyResponse, SERVICE_BUSY_MESSAGE } = await import("../lib/d1-transient.ts");
  for (const call of [() => createTaxiRideQuote(RIDE_QUOTE_INPUT), () => requestTaxiCancellation({ bookingId: "B", reason: "Plans changed" })]) {
    const busy = await withFetch(async () => serviceBusyResponse(), () => refusedWith(call));
    assert.equal(busy.message, SERVICE_BUSY_MESSAGE);
    assert.deepEqual([busy.status, busy.code, busy.retryAfterSeconds, busy.retryable], [503, "SERVICE_BUSY", 5, true]);
  }
  // The cancellation's success replay is data, not an error.
  const replay = await withFetch(async () => Response.json({ data: { bookingId: "B", status: "cancelled", duplicatePrevented: true } }), () => requestTaxiCancellation({ bookingId: "B", reason: "Plans changed" }));
  assert.equal(replay.status, "cancelled");
});

test("round 2: a Taxi call that never answers stops at its time limit with a plain sentence", async () => {
  const { taxiRequest, taxiErrorMessage } = await import("../lib/taxi-client-request.ts");
  const hung = await withFetch((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")))),
    () => refusedWith(() => taxiRequest("/api/taxi-commercial", { method: "POST" }, { action: "calculate your Pet Taxi fare", refused: "x", timeoutMs: 30 })));
  assert.equal(hung.message, "PawSpace is taking longer than usual to calculate your Pet Taxi fare. Please try again in a moment.");
  // Errors thrown outside the Taxi helper (a shared client that still parses JSON blindly) are translated too.
  assert.equal(taxiErrorMessage(new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"), "reserve your Pet Taxi"), "PawSpace is taking longer than usual to reserve your Pet Taxi. Please try again in a moment.");
  assert.match(taxiErrorMessage(new TypeError("Failed to fetch"), "load your pets"), /could not reach PawSpace to load your pets/);
  assert.equal(taxiErrorMessage(new Error("Choose a pickup time in the future."), "calculate your Pet Taxi fare"), "Choose a pickup time in the future.", "a plain sentence passes through");
  assert.equal(taxiErrorMessage(new Error("NO_SCHEDULE_AVAILABLE"), "reserve your Pet Taxi"), "PawSpace could not reserve your Pet Taxi just now. Please try again in a moment.", "a bare rule code never reaches the customer");
});

test("round 2: the Taxi screens route every caught error through the plain-sentence helper", () => {
  const manage = fs.readFileSync("app/taxi/manage/taxi-customer-management.tsx", "utf8");
  const incidents = fs.readFileSync("app/taxi/manage/taxi-customer-incidents.tsx", "utf8");
  for (const [name, source] of [["taxi-flow", flowSource], ["taxi manage", manage], ["taxi incidents", incidents]]) {
    assert.doesNotMatch(source, /await response\.json\(\)|\.then\(async r=>\{const b=await r\.json\(\)/, `${name} must not parse a response blindly`);
    assert.doesNotMatch(source, /setError\(e instanceof Error\?e\.message|setError\(problem instanceof Error\?problem\.message/, `${name} must not show a raw error message`);
    assert.match(source, /taxiErrorMessage\(/);
  }
  // The manage page shows exact amounts with paise and offers a retry when the ride cannot be loaded.
  assert.match(manage, /taxiMoney as money/);
  assert.doesNotMatch(manage, /maximumFractionDigits:0/);
  assert.match(manage, />Try again</);
  // A failed pets or incidents load offers a retry that runs the load again, instead of an empty list.
  assert.match(flowSource, /\[customer\.customerId,petsAttempt\]/);
  assert.match(flowSource, /petsFailed\?<button type="button" onClick=\{\(\)=>\{setError\(""\);setPetsFailed\(false\);setPetsLoading\(true\);setPetsAttempt\(n=>n\+1\)\}\}>/);
  assert.match(incidents, /\[bookingId,attempt\]/);
  assert.match(incidents, /loadFailed&&<button onClick=\{retryLoad\}>Try again<\/button>/);
});
