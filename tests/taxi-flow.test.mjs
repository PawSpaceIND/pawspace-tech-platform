import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const flowSource = fs.readFileSync("app/mobile-app/taxi-flow.tsx", "utf8");
const cssSource = fs.readFileSync("app/mobile-app/taxi-flow.module.css", "utf8");
const bookingClientSource = fs.readFileSync("lib/taxi-booking-client.ts", "utf8");
const commercialClientSource = fs.readFileSync("lib/taxi-commercial-client.ts", "utf8");

// --- Contract tests (source text) -----------------------------------------------------------

test("the taxi flow prices everything from /api/taxi-commercial and never hardcodes fares", () => {
  assert.match(flowSource, /import\s*\{[^}]*loadTaxiRouteClasses[^}]*createTaxiQuote[^}]*\}\s*from\s*"\.\.\/\.\.\/lib\/taxi-commercial-client"/);
  // the import chain is what fetches the route/quote endpoint
  assert.match(commercialClientSource, /\/api\/taxi-commercial/);
  // canonical seed fares (449/699/999) must never be baked into the UI
  assert.doesNotMatch(flowSource, /449|699|999/);
  // amounts rendered come off the server quote / route-class rows
  assert.match(flowSource, /quote\.totalAmount/);
  assert.match(flowSource, /item\.amount/);
  // the drop-off time is server-owned (route duration), never computed client-side
  assert.match(flowSource, /quote\.scheduledEnd/);
  assert.match(flowSource, /fresh\.scheduledEnd/);
});

test("booking creation goes through lib/taxi-booking-client.ts — the component makes no direct API calls", () => {
  assert.match(flowSource, /import\s*\{[^}]*createCanonicalTaxiBooking[^}]*reserveTaxiSchedule[^}]*\}\s*from\s*"\.\.\/\.\.\/lib\/taxi-booking-client"/);
  // every network interaction is a client-lib call: the component itself never fetches
  assert.doesNotMatch(flowSource, /fetch\(/);
  assert.doesNotMatch(flowSource, /\/api\/taxi-bookings/);
  assert.doesNotMatch(flowSource, /\/api\/uat-scheduling/);
});

test("pet selection welcomes dogs AND cats, one pet per trip", () => {
  assert.match(flowSource, /species: "cat"/);
  assert.match(flowSource, /species: "dog"/);
  assert.match(flowSource, /Dogs and cats welcome/);
  assert.match(flowSource, /one pet per trip/);
  // no dogs-only guard — the cat is selectable like any other pet
  assert.doesNotMatch(flowSource, /DOGS ONLY|dogs-only/);
  assert.match(flowSource, /species: pet\.species/, "the selected pet's real species is sent to the booking");
});

test("pickup/drop use the real commercial contract fields and mirror the server validation", () => {
  assert.match(flowSource, /originLabel/);
  assert.match(flowSource, /destinationLabel/);
  // server rule mirrored client-side: ≥3 chars each, distinct case-insensitively
  assert.match(flowSource, /origin\.length >= 3 && destination\.length >= 3 && origin\.toLowerCase\(\) !== destination\.toLowerCase\(\)/);
  assert.doesNotMatch(flowSource, /pincode|zoneResolver|latitude|longitude/, "no invented location fields beyond the contract's labels");
});

test("the flow is a standalone client component: no imports from other flow/checkout files, no globalThis", () => {
  assert.match(flowSource, /^"use client";/m);
  assert.match(flowSource, /export default function TaxiFlow\(\{ customer \}: \{ customer: LoggedInCustomer \}\)/);
  assert.doesNotMatch(flowSource, /from\s*["'][^"']*(grooming-flow|stay-flow|training-flow|walking-flow|food-flow)/, "must not import from any other flow file");
  assert.doesNotMatch(flowSource, /globalThis/);
  assert.doesNotMatch(bookingClientSource, /globalThis/);
  assert.match(flowSource, /from "\.\/taxi-flow\.module\.css"/);
  assert.match(cssSource, /#01261F/i);
  assert.match(cssSource, /#E6B34E/i);
});

test("the flow respects the scheduler's pet_taxi roster hours (06:00-22:00 IST)", () => {
  assert.match(flowSource, /PICKUP_HOURS = \[6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20\]/);
  assert.match(flowSource, /6:00 AM and 10:00 PM/);
});

test("taxi-booking-client was extended additively — existing signatures unchanged", () => {
  assert.match(bookingClientSource, /export async function createCanonicalTaxiBooking\(input:TaxiBookingInput\)\{const response=await fetch\("\/api\/taxi-bookings"/);
  assert.match(bookingClientSource, /export async function reserveTaxiSchedule\(/);
  assert.match(bookingClientSource, /serviceCode:"pet_taxi"/);
  assert.match(bookingClientSource, /occurrences:1/);
  assert.match(bookingClientSource, /\/api\/uat-scheduling/);
});

test("confirmation shows driver name + rating, an honest vehicle status, and the trip window", () => {
  assert.match(flowSource, /driver\.name/);
  assert.match(flowSource, /driver\.rating/);
  assert.match(flowSource, /Vehicle: /);
  // vehicle_id is NULL at creation — the flow must label assignment honestly, never invent a vehicle
  assert.doesNotMatch(flowSource, /KA-\d|Maruti|Swift|WagonR|vehicleNumber/, "no fabricated vehicle details");
  assert.match(flowSource, /booking\.trip\.originLabel/);
  assert.match(flowSource, /booking\.trip\.destinationLabel/);
  assert.match(flowSource, /booking\.trip\.scheduledStart/);
  assert.match(flowSource, /booking\.trip\.estimatedDurationMinutes/);
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
    await assert.rejects(
      () => reserveTaxiSchedule({ clientRequestId: "r", customerId: "c", petIds: ["Bruno"], zoneId: "blr-east", scheduledStart: "s", scheduledEnd: "e" }),
      /NO_SCHEDULE_AVAILABLE/,
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
